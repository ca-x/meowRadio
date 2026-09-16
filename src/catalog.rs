use crate::directory::Directory;
use crate::{
    AppState, auth,
    config::Config,
    error::{AppError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use radiobrowser::{ApiStation, RadioBrowserAPI, StationOrder};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub url: String,
    pub country: String,
    pub countrycode: String,
    pub tags: String,
    pub codec: String,
    pub bitrate: u32,
    pub hls: bool,
    #[serde(default)]
    pub personal: bool,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
}
impl From<ApiStation> for Station {
    fn from(s: ApiStation) -> Self {
        Self {
            id: s.stationuuid,
            name: s.name,
            url: if s.url_resolved.is_empty() {
                s.url
            } else {
                s.url_resolved
            },
            country: s.country,
            countrycode: s.countrycode,
            tags: s.tags,
            codec: s.codec,
            bitrate: s.bitrate,
            hls: s.hls == 1,
            personal: false,
            source_id: None,
            source_name: None,
        }
    }
}
#[derive(Default, Clone, Deserialize)]
pub struct Search {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub codec: String,
    #[serde(default)]
    pub bitrate_min: u16,
}
type DirectoryCache = Option<(Instant, Result<Directory>)>;

type StationCache = HashMap<String, (Instant, Vec<Station>)>;

#[derive(Clone)]
pub struct Catalog {
    pub(crate) config: Config,
    pub(crate) client: reqwest::Client,
    pub(crate) slots: Arc<Semaphore>,
    pub(crate) directory_cache: Arc<Mutex<DirectoryCache>>,
    cache: Arc<Mutex<StationCache>>,
}
impl Catalog {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("meowRadio/", env!("CARGO_PKG_VERSION")));
        if let Some(proxy) = &config.proxy {
            builder = builder.proxy(reqwest::Proxy::all(proxy)?);
        }
        Ok(Self {
            config: config.clone(),
            client: builder.build()?,
            slots: Arc::new(Semaphore::new(8)),
            cache: Default::default(),
            directory_cache: Default::default(),
        })
    }
    async fn fetch(&self, path: String, params: HashMap<String, String>) -> Result<Vec<Station>> {
        let key = format!(
            "{path}{}",
            serde_json::to_string(&params.iter().collect::<std::collections::BTreeMap<_, _>>())
                .unwrap()
        );
        if let Some((at, value)) = self.cache.lock().await.get(&key)
            && at.elapsed() < Duration::from_secs(120)
        {
            return Ok(value.clone());
        }
        let _permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "电台查询繁忙，请稍后重试"))?;
        let stations: Vec<ApiStation> = if self.config.proxy.is_some()
            || self.config.catalog_url.is_some()
        {
            // The crate does not accept a custom HTTP client. This transport preserves
            // its API models while adding explicit proxy, timeout and test-server support.
            let base = self
                .config
                .catalog_url
                .as_deref()
                .unwrap_or("https://de1.api.radio-browser.info");
            self.client
                .post(format!("{}{path}", base.trim_end_matches('/')))
                .json(&params)
                .send()
                .await
                .map_err(|_| AppError::upstream())?
                .error_for_status()
                .map_err(|_| AppError::upstream())?
                .json()
                .await
                .map_err(|_| AppError::upstream())?
        } else {
            let handle = tokio::runtime::Handle::current();
            // Upstream returns non-Send errors/futures; keep them entirely inside this
            // blocking worker, with a deadline on the actual asynchronous operation.
            tokio::task::spawn_blocking(move || {
                handle.block_on(async move {
                    tokio::time::timeout(Duration::from_secs(18), async {
                        let mut api = RadioBrowserAPI::new_from_dns_a("de1.api.radio-browser.info")
                            .await
                            .map_err(|_| ())?;
                        let first = api
                            .send::<_, Vec<ApiStation>>(&path, params.clone())
                            .await
                            .map_err(|_| ());
                        if first.is_ok() {
                            return first;
                        }
                        let mut fallback =
                            RadioBrowserAPI::new_from_dns_a("nl1.api.radio-browser.info")
                                .await
                                .map_err(|_| ())?;
                        fallback.send(&path, params).await.map_err(|_| ())
                    })
                    .await
                    .map_err(|_| ())?
                })
            })
            .await
            .map_err(|_| AppError::upstream())?
            .map_err(|_| AppError::upstream())?
        };
        let result: Vec<Station> = stations.into_iter().map(Station::from).collect();
        let mut cache = self.cache.lock().await;
        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(120));
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(key, (Instant::now(), result.clone()));
        Ok(result)
    }
    pub async fn station(&self, id: &str) -> Result<Station> {
        uuid::Uuid::parse_str(id).map_err(|_| AppError::bad("无效的电台编号"))?;
        self.fetch(format!("/json/stations/byuuid/{id}"), HashMap::new())
            .await?
            .into_iter()
            .next()
            .ok_or(AppError(StatusCode::NOT_FOUND, "电台不存在"))
    }
    pub async fn search(&self, q: Search) -> Result<Vec<Station>> {
        if q.q.len() > 100
            || q.tag.len() > 60
            || q.country.len() > 2
            || q.offset > 10000
            || q.language.len() > 80
            || q.bitrate_min > 320
            || !["", "MP3", "AAC", "AAC+", "OGG", "FLAC"].contains(&q.codec.as_str())
        {
            return Err(AppError::bad("搜索条件过长或页码超出范围"));
        }
        let order = match q.sort.as_str() {
            "" | "popular" => StationOrder::Clickcount,
            "votes" => StationOrder::Votes,
            "name" => StationOrder::Name,
            _ => return Err(AppError::bad("不支持的排序方式")),
        };
        let mut params = HashMap::from([
            ("limit".into(), "24".into()),
            ("offset".into(), q.offset.to_string()),
            ("hidebroken".into(), "true".into()),
            ("order".into(), order.to_string()),
            ("reverse".into(), (q.sort != "name").to_string()),
            ("bitrateMin".into(), q.bitrate_min.to_string()),
        ]);
        for (key, value) in [
            ("name", q.q.trim().to_string()),
            ("tag", q.tag),
            ("countrycode", q.country),
            ("language", q.language),
            ("codec", q.codec),
        ] {
            if !value.is_empty() {
                params.insert(key.into(), value);
            }
        }
        self.fetch("/json/stations/search".into(), params).await
    }
}
pub async fn search(
    State(s): State<AppState>,
    Query(q): Query<Search>,
) -> Result<Json<Vec<Station>>> {
    Ok(Json(s.catalog.search(q).await?))
}
pub async fn favorites(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Station>>> {
    let u = auth::user(&s, &headers).await?;
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT station_json FROM favorites WHERE user_id=? ORDER BY created_at DESC, station_id",
    )
    .bind(u.id)
    .fetch_all(&s.db)
    .await?;
    let values = rows
        .into_iter()
        .map(|r| {
            serde_json::from_str(&r)
                .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "收藏数据读取失败"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(values))
}
pub async fn save(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Station>> {
    let u = auth::user(&s, &headers).await?;
    let station = match crate::personal_sources::owned_station(&s, u.id, &id).await? {
        Some(station) => {
            crate::personal_sources::expected_owner(&headers, u.id)?;
            station
        }
        None => s.catalog.station(&id).await?,
    };
    sqlx::query("INSERT INTO favorites(user_id,station_id,station_json,personal_station_id) VALUES(?,?,?,?) ON CONFLICT(user_id,station_id) DO UPDATE SET station_json=excluded.station_json,personal_station_id=excluded.personal_station_id")
        .bind(u.id).bind(&id).bind(serde_json::to_string(&station).unwrap()).bind(if station.personal { Some(&id) } else { None }).execute(&s.db).await?;
    Ok(Json(station))
}
pub async fn remove(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let u = auth::user(&s, &headers).await?;
    sqlx::query("DELETE FROM favorites WHERE user_id=? AND station_id=?")
        .bind(u.id)
        .bind(id)
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn click(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let personal: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM personal_stations WHERE id=?)")
            .bind(&id)
            .fetch_one(&s.db)
            .await?;
    if personal {
        let user = auth::user(&s, &headers).await?;
        crate::personal_sources::owned_station(&s, user.id, &id)
            .await?
            .ok_or(AppError(StatusCode::NOT_FOUND, "电台不存在"))?;
        return Ok(StatusCode::NO_CONTENT);
    }
    // Resolve before recording, so arbitrary caller-controlled paths never reach upstream.
    s.catalog.station(&id).await?;
    let base = s
        .config
        .catalog_url
        .as_deref()
        .unwrap_or("https://de1.api.radio-browser.info");
    let _ = s
        .catalog
        .client
        .post(format!("{}/json/url/{id}", base.trim_end_matches('/')))
        .send()
        .await;
    Ok(StatusCode::NO_CONTENT)
}
