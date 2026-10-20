//! Owner-scoped subscription snapshots. Import validates the entire snapshot before writing.
use crate::{
    AppState, auth,
    catalog::Station,
    error::{AppError, Result},
    source_types::Candidate,
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::Duration,
};
use url::Url;

pub const MAX_UPLOAD_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug)]
pub struct ImportedStation {
    pub name: String,
    pub categories: Vec<Vec<String>>,
    pub candidates: Vec<Candidate>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedStation {
    name: String,
    #[serde(default)]
    categories: Vec<Vec<String>>,
    urls: Vec<FeedUrl>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum FeedUrl {
    Text(String),
    Structured(Candidate),
}

fn text_field(value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(AppError::bad("名称为空、过长或包含控制字符"));
    }
    Ok(value.to_owned())
}
fn header(name: &str, value: &str) -> Result<(String, String)> {
    if name.chars().any(char::is_control) || value.chars().any(char::is_control) {
        return Err(AppError::bad("请求头包含控制字符"));
    }
    let name = match name.trim().to_ascii_lowercase().as_str() {
        "user-agent" => "User-Agent",
        "referer" => "Referer",
        "origin" => "Origin",
        "accept" => "Accept",
        _ => {
            return Err(AppError::bad(
                "仅支持 User-Agent、Referer、Origin、Accept 请求头",
            ));
        }
    };
    let value = value.trim();
    if value.len() > 2048
        || value.chars().any(char::is_control)
        || axum::http::HeaderValue::from_str(value).is_err()
    {
        return Err(AppError::bad("请求头值无效"));
    }
    Ok((name.into(), value.into()))
}
fn validate_url(value: &str) -> Result<Url> {
    if value.len() > 8192
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        return Err(AppError::bad("电台地址无效"));
    }
    let url = Url::parse(value).map_err(|_| AppError::bad("电台地址无效"))?;
    if ![
        "http", "https", "rtmp", "rtmps", "rtsp", "rtsps", "mms", "mmst", "mmsh",
    ]
    .contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(AppError::bad("不支持的电台地址或地址包含凭据"));
    }
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| !crate::relay::public_ip(ip))
    {
        return Err(AppError::bad("不允许访问本地或私有网络地址"));
    }
    Ok(url)
}
/// Parse a small, explicit legacy option grammar; never pass these strings to a shell.
pub fn parse_candidate(value: &str) -> Result<Candidate> {
    if value.len() > 16384
        || value
            .chars()
            .any(|c| c.is_control() && c != '\r' && c != '\n')
    {
        return Err(AppError::bad("电台地址或参数无效"));
    }
    let value = value.trim();
    let split = value.find(char::is_whitespace).unwrap_or(value.len());
    let url = validate_url(&value[..split])?.to_string();
    let mut remaining = value[split..].trim();
    let mut headers = BTreeMap::new();
    let mut reuse_seen = false;
    let mut headers_seen = false;
    while !remaining.is_empty() {
        let split = remaining
            .find(char::is_whitespace)
            .unwrap_or(remaining.len());
        let option = &remaining[..split];
        remaining = remaining[split..].trim_start();
        match option {
            "-reuse" if !reuse_seen => {
                reuse_seen = true;
                let end = remaining
                    .find(char::is_whitespace)
                    .unwrap_or(remaining.len());
                if !matches!(&remaining[..end], "0" | "1") {
                    return Err(AppError::bad("reuse 参数只允许 0 或 1"));
                }
                remaining = remaining[end..].trim_start();
            }
            "-headers" if !headers_seen => {
                headers_seen = true;
                let quote = remaining
                    .chars()
                    .next()
                    .filter(|c| *c == '"' || *c == '\'')
                    .ok_or_else(|| AppError::bad("headers 参数需要引号"))?;
                let rest = &remaining[1..];
                let end = rest
                    .find(quote)
                    .ok_or_else(|| AppError::bad("headers 参数引号不完整"))?;
                let block = rest[..end].replace("\\r\\n", "\r\n");
                for line in block.split("\r\n").filter(|line| !line.is_empty()) {
                    let (name, value) = line
                        .split_once(':')
                        .ok_or_else(|| AppError::bad("请求头格式无效"))?;
                    let (name, value) = header(name, value)?;
                    if headers.insert(name, value).is_some() {
                        return Err(AppError::bad("请求头重复"));
                    }
                }
                remaining = &rest[end + 1..];
                if !remaining.is_empty() && !remaining.starts_with(char::is_whitespace) {
                    return Err(AppError::bad("参数格式无效"));
                }
                remaining = remaining.trim_start();
            }
            _ => return Err(AppError::bad("不支持的电台参数")),
        }
    }
    Ok(Candidate { url, headers })
}

#[derive(Debug, Serialize)]
pub struct InvalidRecord {
    pub name: String,
    /// One-based entry position in the imported array.
    pub index: usize,
    /// One-based URL position within that entry.
    pub line: usize,
    pub url: String,
    pub reason: String,
}

enum ImportError {
    App(AppError),
    Invalid {
        records: Vec<InvalidRecord>,
        valid_count: usize,
        snapshot_token: String,
    },
}
type ImportResult<T> = std::result::Result<T, ImportError>;
impl From<AppError> for ImportError {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}
impl IntoResponse for ImportError {
    fn into_response(self) -> Response {
        match self {
            Self::App(error) => error.into_response(),
            Self::Invalid { records, valid_count, snapshot_token } => (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({
                "error": "发现无效播放地址", "invalid_records": records, "valid_count": valid_count, "snapshot_token": snapshot_token
            }))).into_response(),
        }
    }
}

fn feed_candidate(value: FeedUrl) -> Result<Candidate> {
    match value {
        FeedUrl::Text(value) => parse_candidate(&value),
        FeedUrl::Structured(value) => {
            let mut candidate = parse_candidate(&value.url)?;
            for (name, value) in value.headers {
                let (name, value) = header(&name, &value)?;
                if candidate.headers.insert(name, value).is_some() {
                    return Err(AppError::bad("请求头重复"));
                }
            }
            Ok(candidate)
        }
    }
}

/// Inspect all address lines, but reject malformed metadata and resource limits outright.
fn inspect_feed(bytes: &[u8]) -> Result<(Vec<ImportedStation>, Vec<InvalidRecord>)> {
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "订阅文件不能超过 5 MiB",
        ));
    }
    let feed: Vec<FeedStation> =
        serde_json::from_slice(bytes).map_err(|_| AppError::bad("订阅 JSON 格式无效"))?;
    if feed.len() > 5000 {
        return Err(AppError::bad("每个订阅最多包含 5000 个电台"));
    }
    let mut result: Vec<ImportedStation> = Vec::new();
    let mut invalid = Vec::new();
    let mut indexes: HashMap<String, usize> = HashMap::new();
    for (entry_index, item) in feed.into_iter().enumerate() {
        let name = text_field(&item.name, 250)?;
        if item.urls.is_empty() || item.urls.len() > 16 || item.categories.len() > 64 {
            return Err(AppError::bad(
                "每个电台需要 1–16 个地址，最多 64 个分类路径",
            ));
        }
        let mut categories = Vec::new();
        for path in item.categories {
            if path.is_empty() || path.len() > 8 {
                return Err(AppError::bad("分类路径需要 1–8 层"));
            }
            let path = path
                .iter()
                .map(|label| text_field(label, 80))
                .collect::<Result<Vec<_>>>()?;
            if !categories.contains(&path) {
                categories.push(path);
            }
        }
        let mut candidates = Vec::new();
        for (line_index, value) in item.urls.into_iter().enumerate() {
            let raw_url = match &value {
                FeedUrl::Text(value) => value,
                FeedUrl::Structured(value) => &value.url,
            };
            // Legacy suffixes may contain sensitive header values; never echo those options.
            let display_url = raw_url.split_whitespace().next().unwrap_or("").to_owned();
            match feed_candidate(value) {
                Ok(candidate) => {
                    if !candidates.iter().any(|c: &Candidate| {
                        c.url == candidate.url && c.headers == candidate.headers
                    }) {
                        candidates.push(candidate);
                    }
                }
                Err(error) => invalid.push(InvalidRecord {
                    name: name.clone(),
                    index: entry_index + 1,
                    line: line_index + 1,
                    url: display_url,
                    reason: error.1.into(),
                }),
            }
        }
        if let Some(index) = indexes.get(&name) {
            let station = &mut result[*index];
            for category in categories {
                if !station.categories.contains(&category) {
                    station.categories.push(category);
                }
            }
            for candidate in candidates {
                if !station
                    .candidates
                    .iter()
                    .any(|c| c.url == candidate.url && c.headers == candidate.headers)
                {
                    station.candidates.push(candidate);
                }
            }
            if station.candidates.len() > 16 || station.categories.len() > 64 {
                return Err(AppError::bad("合并同名电台后超出地址或分类数量限制"));
            }
        } else {
            indexes.insert(name.clone(), result.len());
            result.push(ImportedStation {
                name,
                categories,
                candidates,
            });
        }
    }
    result.retain(|station| !station.candidates.is_empty());
    Ok((result, invalid))
}

/// Strict parser for callers that do not support explicit discard confirmation.
pub fn parse_feed(bytes: &[u8]) -> Result<Vec<ImportedStation>> {
    let (stations, invalid) = inspect_feed(bytes)?;
    if !invalid.is_empty() {
        return Err(AppError::bad("订阅包含无效播放地址"));
    }
    Ok(stations)
}
fn import_feed(
    bytes: &[u8],
    discard_invalid: bool,
    confirmed_snapshot: Option<&str>,
) -> ImportResult<Vec<ImportedStation>> {
    let (stations, records) = inspect_feed(bytes)?;
    let snapshot_token = format!("{:x}", Sha256::digest(bytes));
    // Confirmation only applies to the exact snapshot reviewed by the user.
    if !records.is_empty()
        && (!discard_invalid || confirmed_snapshot != Some(snapshot_token.as_str()))
    {
        return Err(ImportError::Invalid {
            records,
            valid_count: stations.len(),
            snapshot_token,
        });
    }
    Ok(stations)
}

#[derive(Serialize, FromRow)]
pub struct Source {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub url: Option<String>,
    #[serde(skip_serializing)]
    is_subscription: bool,
    pub station_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
const SOURCE_COLUMNS: &str = "s.id,s.label,s.kind,s.url,s.is_subscription,s.created_at,s.updated_at,(SELECT count(*) FROM personal_stations p WHERE p.source_id=s.id) AS station_count";
#[derive(FromRow)]
struct StoredStation {
    id: String,
    user_id: i64,
    source_id: String,
    name: String,
    categories_json: String,
    source_name: String,
}
const STATION_COLUMNS: &str =
    "p.id,p.user_id,p.source_id,p.name,p.categories_json,s.label AS source_name";
fn station(row: &StoredStation) -> Result<Station> {
    let categories: Vec<Vec<String>> = serde_json::from_str(&row.categories_json)
        .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "电台数据读取失败"))?;
    Ok(Station {
        cluster: None,
        id: row.id.clone(),
        name: row.name.clone(),
        url: format!("/api/personal-stations/{}/stream", row.id),
        country: String::new(),
        countrycode: String::new(),
        tags: categories
            .iter()
            .map(|p| p.join(" / "))
            .collect::<Vec<_>>()
            .join(", "),
        codec: "MP3".into(),
        bitrate: 128,
        hls: false,
        geo_lat: None,
        geo_long: None,
        personal: true,
        source_id: Some(row.source_id.clone()),
        source_name: Some(row.source_name.clone()),
    })
}
fn not_found() -> AppError {
    AppError(StatusCode::NOT_FOUND, "私人订阅或电台不存在")
}
pub fn expected_owner(headers: &HeaderMap, user_id: i64) -> Result<()> {
    if headers
        .get("x-meow-owner")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        != Some(user_id)
    {
        return Err(AppError(StatusCode::CONFLICT, "登录账号已变化，请刷新页面"));
    }
    Ok(())
}
pub async fn owned_station(s: &AppState, user_id: i64, id: &str) -> Result<Option<Station>> {
    let row: Option<StoredStation> = sqlx::query_as(&format!("SELECT {STATION_COLUMNS} FROM personal_stations p JOIN personal_sources s ON s.id=p.source_id WHERE p.id=?")) .bind(id).fetch_optional(&s.db).await?;
    match row {
        Some(row) if row.user_id == user_id => Ok(Some(station(&row)?)),
        Some(_) => Err(not_found()),
        None => Ok(None),
    }
}
pub async fn candidates(s: &AppState, user_id: i64, id: &str) -> Result<Vec<Candidate>> {
    let json: String = sqlx::query_scalar(
        "SELECT candidates_json FROM personal_stations WHERE id=? AND user_id=?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(not_found)?;
    serde_json::from_str(&json)
        .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "电台数据读取失败"))
}
async fn source(s: &AppState, user_id: i64, id: &str) -> Result<Source> {
    sqlx::query_as(&format!(
        "SELECT {SOURCE_COLUMNS} FROM personal_sources s WHERE s.id=? AND s.user_id=?"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(not_found)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/personal-sources",
            get(list)
                .post(create)
                .delete(delete_all)
                .layer(DefaultBodyLimit::max(32768)),
        )
        .route(
            "/personal-sources/upload",
            post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route("/personal-sources/{id}", delete(delete_source))
        .route("/personal-sources/{id}/refresh", post(refresh))
        .route("/personal-stations", get(page))
        .route(
            "/personal-stations/explore",
            get(explore).layer(tower_http::compression::CompressionLayer::new()),
        )
        .route("/personal-stations/{id}", delete(delete_station))
}
async fn list(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<Source>>> {
    let user = auth::user(&s, &headers).await?;
    Ok(Json(sqlx::query_as(&format!("SELECT {SOURCE_COLUMNS} FROM personal_sources s WHERE s.user_id=? ORDER BY s.created_at DESC,s.rowid DESC")) .bind(user.id).fetch_all(&s.db).await?))
}
#[derive(Deserialize)]
struct Create {
    label: String,
    url: String,
    #[serde(default)]
    discard_invalid: bool,
    snapshot_token: Option<String>,
}
async fn remote_snapshot(
    s: &AppState,
    label: &str,
    value: &str,
    require_subscription: bool,
    discard_invalid: bool,
    snapshot_token: Option<&str>,
) -> ImportResult<(Vec<ImportedStation>, bool)> {
    let candidate = parse_candidate(value)?;
    let url = Url::parse(&candidate.url).map_err(|_| AppError::bad("电台地址无效"))?;
    // Legacy options and non-HTTP transports describe a single playable source.
    if matches!(url.scheme(), "http" | "https")
        && candidate.headers.is_empty()
        && !value.contains(char::is_whitespace)
        && let Some(bytes) = crate::source_resolver::fetch_subscription(s, &url).await?
    {
        return Ok((import_feed(&bytes, discard_invalid, snapshot_token)?, true));
    }
    if require_subscription {
        return Err(AppError::bad("订阅地址未返回有效 JSON，已保留原有电台").into());
    }
    Ok((
        vec![ImportedStation {
            name: label.to_owned(),
            categories: vec![],
            candidates: vec![candidate],
        }],
        false,
    ))
}
async fn create(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Create>,
) -> ImportResult<(StatusCode, Json<Source>)> {
    let user = auth::user(&s, &headers).await?;
    expected_owner(&headers, user.id)?;
    let _permit = s
        .source_import_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "订阅导入繁忙，请稍后重试"))?;
    let label = text_field(&input.label, 250)?;
    let url = input.url.trim();
    let (stations, is_subscription) = remote_snapshot(
        &s,
        &label,
        url,
        false,
        input.discard_invalid,
        input.snapshot_token.as_deref(),
    )
    .await?;
    let id = replace_snapshot(
        &s,
        user.id,
        None,
        Snapshot {
            label: &label,
            kind: "url",
            url: Some(url),
            is_subscription,
        },
        stations,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(source(&s, user.id, &id).await?)))
}
#[derive(Deserialize)]
struct Upload {
    label: String,
    source_id: Option<String>,
    #[serde(default)]
    discard_invalid: bool,
    snapshot_token: Option<String>,
}
async fn upload(
    State(s): State<AppState>,
    Query(q): Query<Upload>,
    headers: HeaderMap,
    body: Body,
) -> ImportResult<(StatusCode, Json<Source>)> {
    let user = auth::user(&s, &headers).await?;
    expected_owner(&headers, user.id)?;
    let _permit = s
        .source_import_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "订阅导入繁忙，请稍后重试"))?;
    let label = text_field(&q.label, 250)?;
    if let Some(id) = &q.source_id {
        source(&s, user.id, id).await?;
    }
    let bytes = tokio::time::timeout(Duration::from_secs(30), to_bytes(body, MAX_UPLOAD_BYTES))
        .await
        .map_err(|_| AppError(StatusCode::REQUEST_TIMEOUT, "订阅上传超时，请重试"))?
        .map_err(|_| AppError(StatusCode::PAYLOAD_TOO_LARGE, "订阅文件不能超过 5 MiB"))?;
    let stations = import_feed(&bytes, q.discard_invalid, q.snapshot_token.as_deref())?;
    let id = replace_snapshot(
        &s,
        user.id,
        q.source_id.as_deref(),
        Snapshot {
            label: &label,
            kind: "file",
            url: None,
            is_subscription: false,
        },
        stations,
    )
    .await?;
    Ok((
        if q.source_id.is_some() {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(source(&s, user.id, &id).await?),
    ))
}
#[derive(Default, Deserialize)]
struct ImportOptions {
    #[serde(default)]
    discard_invalid: bool,
    snapshot_token: Option<String>,
}
async fn refresh(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(options): Query<ImportOptions>,
    headers: HeaderMap,
) -> ImportResult<Json<Source>> {
    let user = auth::user(&s, &headers).await?;
    expected_owner(&headers, user.id)?;
    let _permit = s
        .source_import_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "订阅导入繁忙，请稍后重试"))?;
    let old = source(&s, user.id, &id).await?;
    let url = old
        .url
        .as_deref()
        .ok_or_else(|| AppError::bad("文件订阅请上传新的 JSON 文件更新"))?;
    let (stations, is_subscription) = remote_snapshot(
        &s,
        &old.label,
        url,
        old.is_subscription,
        options.discard_invalid,
        options.snapshot_token.as_deref(),
    )
    .await?;
    replace_snapshot(
        &s,
        user.id,
        Some(&id),
        Snapshot {
            label: &old.label,
            kind: "url",
            url: Some(url),
            is_subscription,
        },
        stations,
    )
    .await?;
    Ok(Json(source(&s, user.id, &id).await?))
}
struct Snapshot<'a> {
    label: &'a str,
    kind: &'a str,
    url: Option<&'a str>,
    is_subscription: bool,
}

/// A single transaction preserves IDs for retained names and cascades removed favorites.
async fn replace_snapshot(
    s: &AppState,
    user_id: i64,
    existing: Option<&str>,
    metadata: Snapshot<'_>,
    stations: Vec<ImportedStation>,
) -> Result<String> {
    let Snapshot {
        label,
        kind,
        url,
        is_subscription,
    } = metadata;
    let id = existing
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut tx = s.db.begin().await?;
    if existing.is_some() {
        let changed = sqlx::query("UPDATE personal_sources SET label=?,kind=?,url=?,is_subscription=?,updated_at=unixepoch() WHERE id=? AND user_id=?").bind(label).bind(kind).bind(url).bind(is_subscription).bind(&id).bind(user_id).execute(&mut *tx).await?;
        if changed.rows_affected() == 0 {
            return Err(not_found());
        }
    } else {
        let changed = sqlx::query("INSERT INTO personal_sources(id,user_id,label,kind,url,is_subscription) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM personal_sources WHERE user_id=?)<32").bind(&id).bind(user_id).bind(label).bind(kind).bind(url).bind(is_subscription).bind(user_id).execute(&mut *tx).await?;
        if changed.rows_affected() == 0 {
            return Err(AppError::bad("每个账号最多保存 32 个订阅"));
        }
    }
    let old: Vec<(String, String)> =
        sqlx::query_as("SELECT id,name FROM personal_stations WHERE source_id=? AND user_id=?")
            .bind(&id)
            .bind(user_id)
            .fetch_all(&mut *tx)
            .await?;
    let old_by_name: HashMap<_, _> = old
        .iter()
        .map(|(id, name)| (name.as_str(), id.as_str()))
        .collect();
    let mut retained = HashSet::new();
    for (position, item) in stations.into_iter().enumerate() {
        let station_id = old_by_name
            .get(item.name.as_str())
            .map(|id| (*id).to_owned())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        retained.insert(station_id.clone());
        let categories_json = serde_json::to_string(&item.categories).unwrap();
        let candidates_json = serde_json::to_string(&item.candidates).unwrap();
        sqlx::query("INSERT INTO personal_stations(id,user_id,source_id,name,categories_json,candidates_json,position) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,name) DO UPDATE SET categories_json=excluded.categories_json,candidates_json=excluded.candidates_json,position=excluded.position").bind(&station_id).bind(user_id).bind(&id).bind(&item.name).bind(&categories_json).bind(&candidates_json).bind(position as i64).execute(&mut *tx).await?;
        let dto = station(&StoredStation {
            id: station_id.clone(),
            user_id,
            source_id: id.clone(),
            name: item.name,
            categories_json,
            source_name: label.into(),
        })?;
        sqlx::query(
            "UPDATE favorites SET station_json=? WHERE user_id=? AND personal_station_id=?",
        )
        .bind(serde_json::to_string(&dto).unwrap())
        .bind(user_id)
        .bind(&station_id)
        .execute(&mut *tx)
        .await?;
    }
    let mut removed = Vec::new();
    for (station_id, _) in old {
        if !retained.contains(&station_id) {
            sqlx::query("DELETE FROM personal_stations WHERE id=? AND user_id=?")
                .bind(&station_id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            removed.push(station_id);
        }
    }
    tx.commit().await?;
    s.source_validation.cancel_source(user_id, &id);
    for station_id in removed {
        s.media.cancel_station(user_id, &station_id);
    }
    Ok(id)
}

#[derive(Default, Deserialize)]
struct PageQuery {
    #[serde(default = "crate::catalog::default_page_size")]
    page_size: u32,
    #[serde(default)]
    q: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    page: usize,
    source_id: Option<String>,
}
#[derive(Serialize)]
struct Page {
    items: Vec<Station>,
    total: usize,
    page: usize,
    page_size: usize,
    categories: Vec<Vec<String>>,
}
async fn page(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PageQuery>,
) -> Result<Json<Page>> {
    browse(s, headers, q, false).await
}
async fn explore(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PageQuery>,
) -> Result<Json<Page>> {
    browse(s, headers, q, true).await
}
async fn browse(
    s: AppState,
    headers: HeaderMap,
    mut q: PageQuery,
    all: bool,
) -> Result<Json<Page>> {
    let user = auth::user(&s, &headers).await?;
    if ![24, 100, 500, 1000].contains(&q.page_size) {
        return Err(AppError::bad("不支持的分页大小"));
    }
    let page_size = q.page_size as usize;
    q.source_id = q.source_id.filter(|id| !id.is_empty());
    if q.q.chars().count() > 250 || q.category.len() > 3000 {
        return Err(AppError::bad("搜索条件过长"));
    }
    if let Some(id) = &q.source_id {
        source(&s, user.id, id).await?;
    }
    let query = format!(
        "SELECT {STATION_COLUMNS} FROM personal_stations p JOIN personal_sources s ON s.id=p.source_id WHERE p.user_id=? AND (? IS NULL OR p.source_id=?) ORDER BY s.created_at DESC,s.rowid DESC,p.position,p.id"
    );
    let mut rows = sqlx::query_as::<_, StoredStation>(&query)
        .bind(user.id)
        .bind(&q.source_id)
        .bind(&q.source_id)
        .fetch(&s.db);
    let needle = q.q.trim().to_lowercase();
    let category_path = if q.category.starts_with('[') {
        Some(
            serde_json::from_str::<Vec<String>>(&q.category)
                .map_err(|_| AppError::bad("分类路径无效"))?,
        )
    } else {
        None
    };
    let mut categories = Vec::new();
    let mut seen_categories = HashSet::new();
    let mut selected = Vec::with_capacity(page_size);
    let mut last_page = Vec::with_capacity(page_size);
    let mut total = 0usize;
    while let Some(row) = rows.try_next().await? {
        let paths: Vec<Vec<String>> = serde_json::from_str(&row.categories_json)
            .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "分类数据读取失败"))?;
        for path in &paths {
            if seen_categories.insert(path.clone()) {
                categories.push(path.clone());
            }
        }
        let item = station(&row)?;
        let category_matches = q.category.is_empty()
            || paths.iter().any(|p| {
                category_path.as_ref().map_or_else(
                    || p.join(" / ") == q.category || p.join("/") == q.category,
                    |category| p.starts_with(category),
                )
            });
        if category_matches
            && format!("{} {}", item.name, item.tags)
                .to_lowercase()
                .contains(&needle)
        {
            if total.is_multiple_of(page_size) {
                last_page.clear();
            }
            last_page.push(item.clone());
            if all || total / page_size == q.page {
                selected.push(item);
            }
            total += 1;
        }
    }
    let page = if all {
        0
    } else {
        q.page.min(total.saturating_sub(1) / page_size)
    };
    let items = if all || page == q.page {
        selected
    } else {
        last_page
    };
    Ok(Json(Page {
        items,
        total,
        page,
        page_size: if all { total } else { page_size },
        categories,
    }))
}
async fn delete_source(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let user = auth::user(&s, &headers).await?;
    expected_owner(&headers, user.id)?;
    let mut tx = s.db.begin().await?;
    // Acquire the SQLite writer lock before enumerating the stations to cancel.
    let result =
        sqlx::query("UPDATE personal_sources SET updated_at=updated_at WHERE id=? AND user_id=?")
            .bind(&id)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    if result.rows_affected() == 0 {
        return Err(not_found());
    }
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM personal_stations WHERE source_id=? AND user_id=?")
            .bind(&id)
            .bind(user.id)
            .fetch_all(&mut *tx)
            .await?;
    sqlx::query("DELETE FROM personal_sources WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    s.source_validation.cancel_source(user.id, &id);
    for station_id in ids {
        s.media.cancel_station(user.id, &station_id);
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn delete_all(State(s): State<AppState>, headers: HeaderMap) -> Result<StatusCode> {
    let user = auth::user(&s, &headers).await?;
    expected_owner(&headers, user.id)?;
    sqlx::query("DELETE FROM personal_sources WHERE user_id=?")
        .bind(user.id)
        .execute(&s.db)
        .await?;
    s.source_validation.cancel_user(user.id);
    s.media.cancel_user(user.id);
    Ok(StatusCode::NO_CONTENT)
}
async fn delete_station(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let user = auth::user(&s, &headers).await?;
    expected_owner(&headers, user.id)?;
    let source_id: String = sqlx::query_scalar(
        "DELETE FROM personal_stations WHERE id=? AND user_id=? RETURNING source_id",
    )
    .bind(&id)
    .bind(user.id)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(not_found)?;
    s.source_validation.cancel_source(user.id, &source_id);
    s.media.cancel_station(user.id, &id);
    Ok(StatusCode::NO_CONTENT)
}
