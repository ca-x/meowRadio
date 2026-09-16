//! Bounded, data-only resolution of private station URLs. No scripts are executed.
use crate::{
    AppState,
    error::{AppError, Result},
    outbound,
    source_types::{Candidate, MediaFormat, ResolvedSource},
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use futures_util::StreamExt;
use serde_json::Value;
use std::{collections::HashSet, time::Duration};
use url::Url;

const PAGE_LIMIT: usize = 2 * 1024 * 1024;
const SUBSCRIPTION_LIMIT: usize = 5 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(10);
const MAX_CANDIDATES: usize = 512;

pub async fn resolve(s: &AppState, candidate: &Candidate) -> Result<ResolvedSource> {
    tokio::time::timeout(DEADLINE, resolve_inner(s, candidate))
        .await
        .map_err(|_| AppError::upstream())?
}

async fn resolve_inner(s: &AppState, candidate: &Candidate) -> Result<ResolvedSource> {
    let mut url = Url::parse(&candidate.url).map_err(|_| AppError::bad("电台地址无效"))?;
    let headers = source_headers(candidate)?;
    let hint = url
        .query_pairs()
        .find(|(k, _)| k == "cf")
        .map(|(_, v)| v.into_owned());
    let exact_cnr = is_cnr(&url);
    let mut visited = HashSet::new();
    for _ in 0..4 {
        validate(&url)?;
        if let Some(format) = url_format(&url) {
            return Ok(ResolvedSource {
                url,
                headers,
                format,
            });
        }
        if !visited.insert(url.to_string()) {
            return Err(AppError::bad("电台地址解析出现循环"));
        }
        // The official /national response contains current, signed channel URLs.
        // `cf` is the user's local selector; sending it to CNR breaks that API.
        let request_url = cnr_request_url(&url);
        let (base, fetched) = fetch(s, request_url, &headers, PAGE_LIMIT).await?;
        match fetched {
            Fetched::Media(format) => {
                return Ok(ResolvedSource {
                    url: base,
                    headers,
                    format,
                });
            }
            Fetched::Document(body) => {
                let text = std::str::from_utf8(&body)
                    .map_err(|_| AppError::bad("电台响应不是可识别的音频或页面"))?;
                let mut found = extract(text, &base)?;
                found.sort_by_key(|entry| std::cmp::Reverse(score(entry, hint.as_deref())));
                let selected = found.into_iter().find(|entry| {
                    !exact_cnr || hint.as_deref().is_none_or(|h| exact_hint(&entry.url, h))
                });
                url = selected
                    .ok_or_else(|| {
                        AppError::bad("页面未提供可用音频地址，可能需要登录、脚本执行或源已失效")
                    })?
                    .url;
            }
        }
    }
    Err(AppError::bad("电台地址解析层数过多"))
}

/// Distinguish a subscription array from one station URL without downloading an
/// endless stream. Channel API arrays are deliberately not subscription feeds.
pub async fn fetch_subscription(s: &AppState, url: &Url) -> Result<Option<Vec<u8>>> {
    tokio::time::timeout(DEADLINE, async {
        validate(url)?;
        if url_format(url).is_some() {
            return Ok(None);
        }
        let (_, fetched) = fetch(
            s,
            cnr_request_url(url),
            &HeaderMap::new(),
            SUBSCRIPTION_LIMIT,
        )
        .await?;
        let Fetched::Document(body) = fetched else {
            return Ok(None);
        };
        let Ok(Value::Array(rows)) = serde_json::from_slice::<Value>(&body) else {
            return Ok(None);
        };
        // Malformed feeds must reach the importer's all-or-nothing validator.
        // Channel APIs normally expose `url`/`m3u8`, not the feed's `urls` field.
        let is_feed = rows.is_empty() || rows.iter().any(|row| row.get("urls").is_some());
        Ok(is_feed.then_some(body))
    })
    .await
    .map_err(|_| AppError::upstream())?
}

fn source_headers(candidate: &Candidate) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (name, value) in &candidate.headers {
        let name = name.to_ascii_lowercase();
        if !matches!(
            name.as_str(),
            "user-agent" | "referer" | "origin" | "accept"
        ) {
            return Err(AppError::bad("音频请求头不受支持"));
        }
        if value.len() > 2048 {
            return Err(AppError::bad("音频请求头过长"));
        }
        headers.insert(
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| AppError::bad("音频请求头无效"))?,
            HeaderValue::from_str(value).map_err(|_| AppError::bad("音频请求头无效"))?,
        );
    }
    Ok(headers)
}

fn validate(url: &Url) -> Result<()> {
    if matches!(url.scheme(), "http" | "https") {
        outbound::validate_media_url(url)?;
    } else if !matches!(
        url.scheme(),
        "rtmp" | "rtmps" | "rtsp" | "rtsps" | "mms" | "mmst" | "mmsh"
    ) || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::bad("电台地址协议或主机无效"));
    }
    Ok(())
}

fn is_cnr(url: &Url) -> bool {
    url.host_str() == Some("apppc.cnr.cn") && url.path().trim_end_matches('/') == "/national"
}
fn cnr_request_url(url: &Url) -> Url {
    let mut result = url.clone();
    if is_cnr(url) {
        let query: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key != "cf")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        result.set_query(None);
        if !query.is_empty() {
            result.query_pairs_mut().extend_pairs(query);
        }
    }
    result
}

pub(crate) fn url_format(url: &Url) -> Option<MediaFormat> {
    use MediaFormat::*;
    match url.scheme() {
        "rtmp" | "rtmps" => return Some(Rtmp),
        "rtsp" | "rtsps" => return Some(Rtsp),
        "mms" => return Some(Mms),
        "mmst" => return Some(Mmst),
        "mmsh" => return Some(Mmsh),
        "http" | "https" => {}
        _ => return None,
    }
    let path = url.path().to_ascii_lowercase();
    match path.rsplit('.').next()? {
        "m3u8" => Some(Hls),
        "mp3" => Some(Mp3),
        "aac" | "adts" => Some(Aac),
        "ogg" | "oga" | "opus" => Some(Ogg),
        "flac" => Some(Flac),
        "wav" => Some(Wav),
        "wma" | "asf" => Some(Asf),
        "flv" => Some(Flv),
        "ts" => Some(MpegTs),
        "mp4" | "m4a" | "mov" => Some(Mov),
        "webm" | "mkv" => Some(Matroska),
        _ => None,
    }
}

fn mime_format(mime: &str) -> Option<MediaFormat> {
    use MediaFormat::*;
    match mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => Some(Hls),
        "audio/mpeg" | "audio/mp3" => Some(Mp3),
        "audio/aac" | "audio/aacp" => Some(Aac),
        "audio/ogg" | "application/ogg" => Some(Ogg),
        "audio/flac" | "audio/x-flac" => Some(Flac),
        "audio/wav" | "audio/x-wav" => Some(Wav),
        "video/x-flv" => Some(Flv),
        "video/mp2t" => Some(MpegTs),
        "audio/mp4" | "video/mp4" => Some(Mov),
        "audio/webm" | "video/webm" => Some(Matroska),
        "audio/x-ms-wma" | "video/x-ms-asf" => Some(Asf),
        _ => None,
    }
}
fn sniff(bytes: &[u8]) -> Option<MediaFormat> {
    use MediaFormat::*;
    let text = std::str::from_utf8(&bytes[..bytes.len().min(64)])
        .unwrap_or("")
        .trim_start_matches('\u{feff}')
        .trim_start();
    if text.starts_with("#EXTM3U") {
        return Some(Hls);
    }
    if bytes.starts_with(b"ID3") {
        return Some(Mp3);
    }
    if bytes.starts_with(b"OggS") {
        return Some(Ogg);
    }
    if bytes.starts_with(b"fLaC") {
        return Some(Flac);
    }
    if bytes.starts_with(b"FLV") {
        return Some(Flv);
    }
    if bytes.starts_with(&[0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]) {
        return Some(Asf);
    }
    if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some(Matroska);
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return Some(Mov);
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        return Some(Wav);
    }
    if bytes.len() >= 2 && bytes[0] == 0xff {
        if bytes[1] & 0xf6 == 0xf0 {
            return Some(Aac);
        }
        if bytes[1] & 0xe0 == 0xe0 {
            return Some(Mp3);
        }
    }
    None
}

enum Fetched {
    Media(MediaFormat),
    Document(Vec<u8>),
}
async fn fetch(
    s: &AppState,
    mut url: Url,
    headers: &HeaderMap,
    limit: usize,
) -> Result<(Url, Fetched)> {
    for redirect in 0..=6 {
        // Transport checks every DNS answer and pins the dialed address. Never
        // hand redirects to a client which can bypass that per-hop boundary.
        outbound::validate_media_url(&url)?;
        let response = s.outbound.get_media(&url, None, headers).await?;
        if response.status.is_redirection() {
            if redirect == 6 {
                return Err(AppError::bad("电台重定向次数过多"));
            }
            let location = response
                .headers
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(AppError::upstream)?;
            url = url.join(location).map_err(|_| AppError::upstream())?;
            continue;
        }
        if !response.status.is_success() {
            return Err(AppError::upstream());
        }
        if let Some(format) = response
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(mime_format)
        {
            return Ok((url, Fetched::Media(format)));
        }
        let mut bytes = Vec::new();
        let mut stream = response.body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AppError::upstream())?;
            if bytes.len() < 64 {
                let sample: Vec<_> = bytes.iter().chain(chunk.iter()).take(64).copied().collect();
                if let Some(format) = sniff(&sample) {
                    return Ok((url, Fetched::Media(format)));
                }
            }
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(AppError::bad("电台响应超过大小限制"));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((url, Fetched::Document(bytes)));
    }
    Err(AppError::upstream())
}

#[derive(Clone)]
struct Extracted {
    url: Url,
    context: String,
}
fn exact_hint(url: &Url, hint: &str) -> bool {
    url.path_segments()
        .is_some_and(|mut segments| segments.any(|s| s.eq_ignore_ascii_case(hint)))
}
fn score(entry: &Extracted, hint: Option<&str>) -> u8 {
    let Some(hint) = hint.filter(|v| !v.is_empty()) else {
        return u8::from(url_format(&entry.url).is_some());
    };
    if exact_hint(&entry.url, hint) {
        return 4;
    }
    if entry
        .context
        .split('/')
        .any(|v| v.eq_ignore_ascii_case(hint))
    {
        return 3;
    }
    if entry
        .url
        .as_str()
        .to_ascii_lowercase()
        .contains(&hint.to_ascii_lowercase())
    {
        return 2;
    }
    u8::from(url_format(&entry.url).is_some())
}
fn decode(text: &str) -> String {
    text.replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("\\u003d", "=")
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&#x26;", "&")
}
fn add(found: &mut Vec<Extracted>, raw: &str, base: &Url, context: &str, known_key: bool) {
    if found.len() >= MAX_CANDIDATES {
        return;
    }
    let raw = decode(raw);
    if raw.len() > 8192 || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return;
    }
    let Ok(url) = base.join(raw.trim()) else {
        return;
    };
    if validate(&url).is_err() {
        return;
    }
    let path = url.path().to_ascii_lowercase();
    if [
        ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ]
    .iter()
    .any(|ext| path.ends_with(ext))
    {
        return;
    }
    // Resolve explicit config references, not arbitrary text from an API's
    // `msg` field merely because its base URL happens to contain `/api/`.
    let config =
        url.origin() == base.origin() && (path.ends_with(".json") || raw.contains("/api/"));
    if url_format(&url).is_none() && !known_key && !config {
        return;
    }
    if !found.iter().any(|v| v.url == url && v.context == context) {
        found.push(Extracted {
            url,
            context: context.to_owned(),
        });
    }
}
fn json_urls(
    value: &Value,
    base: &Url,
    context: &str,
    known_key: bool,
    depth: usize,
    found: &mut Vec<Extracted>,
) {
    if depth > 32 || found.len() >= MAX_CANDIDATES {
        return;
    }
    match value {
        Value::Object(object) => {
            let labels: Vec<_> = ["id", "name", "code", "alias", "channel"]
                .iter()
                .filter_map(|k| object.get(*k).and_then(Value::as_str))
                .collect();
            let context = format!("{context}/{}", labels.join("/"));
            for (key, value) in object {
                let lower = key.to_ascii_lowercase();
                let known = matches!(
                    lower.as_str(),
                    "url"
                        | "src"
                        | "stream"
                        | "playurl"
                        | "play_url"
                        | "live_url"
                        | "stream_url"
                        | "audio"
                        | "hls"
                        | "m3u8"
                        | "flv"
                        | "file"
                        | "audio_url"
                ) || lower.ends_with("_url");
                json_urls(
                    value,
                    base,
                    &format!("{context}/{key}"),
                    known,
                    depth + 1,
                    found,
                );
            }
        }
        Value::Array(values) => {
            for value in values {
                json_urls(value, base, context, known_key, depth + 1, found);
            }
        }
        Value::String(raw) if !raw.trim().is_empty() => add(found, raw, base, context, known_key),
        _ => {}
    }
}
fn extract(text: &str, base: &Url) -> Result<Vec<Extracted>> {
    let mut found = Vec::new();
    let text = text.trim().trim_start_matches('\u{feff}');
    let json = serde_json::from_str::<Value>(text).ok().or_else(|| {
        // JSONP is parsed as data; its callback is never executed.
        let start = text.find('(')?;
        let end = text.rfind(')')?;
        let callback = &text[..start];
        if callback.is_empty()
            || !callback
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.'))
        {
            return None;
        }
        serde_json::from_str(&text[start + 1..end]).ok()
    });
    if let Some(value) = json {
        if value
            .get("code")
            .and_then(|code| code.as_i64().or_else(|| code.as_str()?.parse().ok()))
            .is_some_and(|code| code < 0)
            || ["succ", "success"]
                .iter()
                .any(|key| value.get(*key) == Some(&Value::Bool(false)))
        {
            return Err(AppError::upstream());
        }
        json_urls(&value, base, "", false, 0, &mut found);
        return Ok(found);
    }
    let decoded = decode(text);
    // Quoted HTML/JS values and plain playlists; never truncate query strings at
    // '&', '=' or '?' (signed streaming URLs rely on their exact values).
    for token in
        decoded.split(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>' | '`'))
    {
        if token.is_empty() {
            continue;
        }
        let token = token.trim_end_matches([',', ';', ')', '}']);
        let token = [
            "https://", "http://", "rtmp://", "rtmps://", "rtsp://", "rtsps://", "mmsh://",
            "mmst://", "mms://",
        ]
        .iter()
        .filter_map(|prefix| token.find(*prefix))
        .min()
        .map_or(token, |at| &token[at..]);
        add(&mut found, token, base, "", false);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config,
        outbound::{Transport, Upstream},
    };
    use axum::{body::Body, http::StatusCode};
    use std::{
        collections::{BTreeMap, HashMap},
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };

    #[derive(Clone)]
    struct Fixture {
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
    }
    impl Fixture {
        fn body(mime: &'static str, body: impl Into<Vec<u8>>) -> Self {
            Self {
                status: StatusCode::OK,
                headers: HeaderMap::from_iter([(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static(mime),
                )]),
                body: body.into(),
            }
        }
        fn redirect(location: &'static str) -> Self {
            Self {
                status: StatusCode::FOUND,
                headers: HeaderMap::from_iter([(
                    header::LOCATION,
                    HeaderValue::from_static(location),
                )]),
                body: Vec::new(),
            }
        }
    }
    struct Mock {
        fixtures: HashMap<String, Fixture>,
        requests: Mutex<Vec<String>>,
        headers: Mutex<Vec<HeaderMap>>,
    }
    impl Transport for Mock {
        fn get_media<'a>(
            &'a self,
            url: &'a Url,
            range: Option<&'a HeaderValue>,
            headers: &'a HeaderMap,
        ) -> Pin<Box<dyn Future<Output = Result<Upstream>> + Send + 'a>> {
            self.headers.lock().unwrap().push(headers.clone());
            self.get(url, range)
        }
        fn get<'a>(
            &'a self,
            url: &'a Url,
            _: Option<&'a HeaderValue>,
        ) -> Pin<Box<dyn Future<Output = Result<Upstream>> + Send + 'a>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(url.to_string());
                // Represents the transport's DNS/public-address boundary.
                if url.host_str() == Some("private.example") {
                    return Err(AppError::bad("private address"));
                }
                let f = self
                    .fixtures
                    .get(url.as_str())
                    .ok_or_else(AppError::upstream)?;
                Ok(Upstream {
                    status: f.status,
                    headers: f.headers.clone(),
                    body: Body::from(f.body.clone()),
                })
            })
        }
    }
    async fn state(
        fixtures: impl IntoIterator<Item = (&'static str, Fixture)>,
    ) -> (AppState, Arc<Mock>) {
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            database: ":memory:".into(),
            catalog_url: None,
            proxy: None,
            secure_cookie: true,
            registration: false,
            relay: true,
        };
        let outbound = Arc::new(Mock {
            fixtures: fixtures.into_iter().map(|(k, v)| (k.into(), v)).collect(),
            requests: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        });
        let state = AppState {
            db: sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap(),
            catalog: crate::catalog::Catalog::new(&config).unwrap(),
            config,
            outbound: outbound.clone(),
            dummy_hash: "unused".into(),
            relay_slots: Arc::new(tokio::sync::Semaphore::new(32)),
            media: Arc::new(crate::media::MediaService::new()),
            source_import_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            source_validation: Arc::new(crate::source_validation::ValidationService::new()),
            recording_upload_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            recordings_dir: Arc::new("unused".into()),
            hls_key: Arc::new([7; 32]),
            auth_attempts: Default::default(),
        };
        (state, outbound)
    }
    fn candidate(url: &str) -> Candidate {
        Candidate {
            url: url.into(),
            headers: BTreeMap::new(),
        }
    }
    async fn resolved(s: &AppState, url: &str) -> ResolvedSource {
        resolve(s, &candidate(url))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
    }

    #[tokio::test]
    async fn direct_formats_and_legacy_need_no_http_fetch() {
        let (s, mock) = state([]).await;
        for (url, format) in [
            ("https://radio.example/live.m3u8?key=kept", MediaFormat::Hls),
            ("https://radio.example/audio.mp3", MediaFormat::Mp3),
            ("rtmp://radio.example/live/radio", MediaFormat::Rtmp),
            ("rtsp://radio.example/live", MediaFormat::Rtsp),
            ("mms://radio.example/live", MediaFormat::Mms),
            ("mmst://radio.example/live", MediaFormat::Mmst),
            ("mmsh://radio.example/live", MediaFormat::Mmsh),
        ] {
            assert_eq!(resolved(&s, url).await.format, format);
        }
        assert!(mock.requests.lock().unwrap().is_empty());
        assert!(
            url_format(&Url::parse("https://radio.example/channel.php?cf=.m3u8").unwrap())
                .is_none()
        );
    }

    #[tokio::test]
    async fn secure_legacy_urls_preserve_scheme_and_headers_without_http_fetch() {
        let (s, mock) = state([]).await;
        for (url, format) in [
            (
                "rtmps://radio.example/live/radio?key=fixture",
                MediaFormat::Rtmp,
            ),
            ("rtsps://radio.example/live?key=fixture", MediaFormat::Rtsp),
        ] {
            let mut candidate = candidate(url);
            candidate
                .headers
                .insert("User-Agent".into(), "StationPlayer/1".into());
            candidate
                .headers
                .insert("Referer".into(), "https://radio.example/".into());
            let source = resolve(&s, &candidate).await.ok().unwrap();
            assert_eq!(source.url.as_str(), url);
            assert_eq!(source.format, format);
            assert_eq!(source.headers[header::USER_AGENT], "StationPlayer/1");
            assert_eq!(source.headers[header::REFERER], "https://radio.example/");
        }
        assert!(mock.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn html_extracts_secure_legacy_schemes() {
        let base = Url::parse("https://radio.example/player").unwrap();
        let sources = extract(
            "<audio src=rtmps://radio.example/live></audio><audio src=rtsps://radio.example/live></audio>",
            &base,
        ).ok().unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].url.scheme(), "rtmps");
        assert_eq!(sources[1].url.scheme(), "rtsps");
    }

    #[tokio::test]
    async fn cnr_live_schema_selects_exact_channel_and_keeps_signature() {
        // Shape from the official /national endpoint, observed 2026-09-16.
        let body = r#"{"data":{"categories":[{"detail":[{"other_info11":[{"url":"https://ngcdn001.cnr.cn/live/zgzs/index.m3u8?key=fixture&time=123"}]},{"other_info11":[{"url":"https://ngcdn003.cnr.cn/live/yyzs/index.m3u8?key=music&time=123"}]}]}]}}"#;
        let (s, mock) = state([(
            "https://apppc.cnr.cn/national",
            Fixture::body("application/json", body),
        )])
        .await;
        let result = resolved(&s, "https://apppc.cnr.cn/national?cf=yyzs").await;
        assert_eq!(
            result.url.as_str(),
            "https://ngcdn003.cnr.cn/live/yyzs/index.m3u8?key=music&time=123"
        );
        assert_eq!(
            *mock.requests.lock().unwrap(),
            ["https://apppc.cnr.cn/national"]
        );
        assert!(
            resolve(&s, &candidate("https://apppc.cnr.cn/national?cf=missing"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn m2o_fjtv_anhui_and_cctv_json_shapes() {
        for (url, body, expected) in [
            (
                "https://m2o.example/channel_info.php?id=2&cf=.m3u8",
                r#"{"data":{"stream":[{"url":"https://media.example/live.flv"},{"url":"https://media.example/live.m3u8?auth=a&b=c"}]}}"#,
                "https://media.example/live.m3u8?auth=a&b=c",
            ),
            (
                "https://mapi-plus.fjtv.net/api/v1/channel.php?node_id=4&cf=aac_xwgb",
                r#"[{"name":"one","m3u8":"https://media.example/aac_other/index.m3u8"},{"name":"two","m3u8":"https://media.example/aac_xwgb/index.m3u8"}]"#,
                "https://media.example/aac_xwgb/index.m3u8",
            ),
            (
                "https://mapi.ahtv.cn/channel.php?is_audio=1&cf=aac_jtgb",
                r#"{"data":{"aac_jtgb":"https://media.example/jtgb.m3u8","aac_xwgb":"https://media.example/xwgb.m3u8"}}"#,
                "https://media.example/jtgb.m3u8",
            ),
            (
                "https://vdn.live.cntv.cn/api2/live.do?client=android&channel=pd://example&cf=audio",
                r#"{"hls_url":{"hls1":"https://media.example/video.m3u8","audio":"https://media.example/sound.m3u8?auth=fixture"}}"#,
                "https://media.example/sound.m3u8?auth=fixture",
            ),
        ] {
            let (s, _) = state([(url, Fixture::body("application/json", body))]).await;
            assert_eq!(resolved(&s, url).await.url.as_str(), expected);
        }
    }

    #[tokio::test]
    async fn jsonp_escaped_urls_are_data_and_preserve_query() {
        let (s, _) = state([(
            "https://radio.example/api",
            Fixture::body(
                "application/javascript",
                r#"callback({"play_url":"https:\/\/media.example\/live.m3u8?a=1\u0026b=2"});"#,
            ),
        )])
        .await;
        assert_eq!(
            resolved(&s, "https://radio.example/api").await.url.as_str(),
            "https://media.example/live.m3u8?a=1&b=2"
        );
    }

    #[tokio::test]
    async fn html_uses_final_redirect_base_and_ignores_images_scripts() {
        let (s,mock) = state([
            ("https://radio.example/page",Fixture::redirect("/station/index.html")),
            ("https://radio.example/station/index.html",Fixture::body("text/html",r#"<script src="/player.js"></script><img src="/cover.jpg"><audio src="../live/radio.mp3?key=1&amp;v=2"></audio>"#)),
        ]).await;
        assert_eq!(
            resolved(&s, "https://radio.example/page")
                .await
                .url
                .as_str(),
            "https://radio.example/live/radio.mp3?key=1&v=2"
        );
        assert_eq!(mock.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn html_can_follow_explicit_same_origin_config_without_executing_js() {
        let (s, _) = state([
            (
                "https://radio.example/page",
                Fixture::body("text/html", r#"<script>fetch('/api/player.json')</script>"#),
            ),
            (
                "https://radio.example/api/player.json",
                Fixture::body("application/json", r#"{"url":"/live.aac"}"#),
            ),
        ])
        .await;
        assert_eq!(
            resolved(&s, "https://radio.example/page")
                .await
                .url
                .as_str(),
            "https://radio.example/live.aac"
        );
    }

    #[tokio::test]
    async fn redirect_private_host_is_checked_by_transport() {
        let (s, mock) = state([(
            "https://radio.example/page",
            Fixture::redirect("https://private.example/secret"),
        )])
        .await;
        assert!(
            resolve(&s, &candidate("https://radio.example/page"))
                .await
                .is_err()
        );
        assert_eq!(mock.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn subscription_shape_does_not_confuse_channel_arrays() {
        let (s, _) = state([
            (
                "https://radio.example/malformed",
                Fixture::body("application/json", r#"[{"name":"station","urls":null}]"#),
            ),
            (
                "https://radio.example/empty",
                Fixture::body("application/json", "[]"),
            ),
            (
                "https://radio.example/feed",
                Fixture::body(
                    "application/json",
                    r#"[{"name":"station","urls":["https://media.example/a.mp3"]}]"#,
                ),
            ),
            (
                "https://radio.example/channels",
                Fixture::body(
                    "application/json",
                    r#"[{"name":"station","url":"https://media.example/a.mp3"}]"#,
                ),
            ),
            (
                "https://radio.example/audio",
                Fixture::body("audio/mpeg", vec![0u8; SUBSCRIPTION_LIMIT + 1]),
            ),
        ])
        .await;
        for (path, expected) in [
            ("feed", true),
            ("malformed", true),
            ("empty", true),
            ("channels", false),
            ("audio", false),
        ] {
            assert_eq!(
                fetch_subscription(
                    &s,
                    &Url::parse(&format!("https://radio.example/{path}")).unwrap()
                )
                .await
                .ok()
                .unwrap()
                .is_some(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn sniff_audio_without_collecting_entire_stream_and_bound_documents() {
        let mut audio = b"ID3".to_vec();
        audio.extend(vec![0; PAGE_LIMIT + 1]);
        let (s, _) = state([
            (
                "https://radio.example/audio",
                Fixture::body("application/octet-stream", audio),
            ),
            (
                "https://radio.example/huge",
                Fixture::body("text/html", vec![b'x'; PAGE_LIMIT + 1]),
            ),
        ])
        .await;
        assert_eq!(
            resolved(&s, "https://radio.example/audio").await.format,
            MediaFormat::Mp3
        );
        assert!(
            resolve(&s, &candidate("https://radio.example/huge"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn unresolvable_js_and_loops_fail_honestly() {
        let (s, _) = state([
            (
                "https://radio.example/js",
                Fixture::body("text/html", r#"<script src="bundle.js"></script>"#),
            ),
            (
                "https://radio.example/loop",
                Fixture::body("application/json", r#"{"url":"/loop"}"#),
            ),
        ])
        .await;
        for path in ["js", "loop"] {
            assert!(
                resolve(&s, &candidate(&format!("https://radio.example/{path}")))
                    .await
                    .is_err()
            );
        }
    }

    #[test]
    fn request_headers_cannot_forward_session_or_override_routing() {
        for name in [
            "cookie",
            "authorization",
            "host",
            "proxy-authorization",
            "range",
        ] {
            let mut candidate = candidate("https://radio.example/live.mp3");
            candidate.headers.insert(name.into(), "secret".into());
            assert!(source_headers(&candidate).is_err());
        }
    }

    #[tokio::test]
    async fn explicit_source_headers_survive_resolution_and_redirects() {
        let (s, mock) = state([
            (
                "https://radio.example/page",
                Fixture::redirect("/api/channel"),
            ),
            (
                "https://radio.example/api/channel",
                Fixture::body(
                    "application/json",
                    r#"{"url":"https://media.example/a.mp3"}"#,
                ),
            ),
        ])
        .await;
        let mut candidate = candidate("https://radio.example/page");
        candidate
            .headers
            .insert("User-Agent".into(), "StationPlayer/1".into());
        candidate
            .headers
            .insert("Referer".into(), "https://radio.example/".into());
        let source = resolve(&s, &candidate).await.ok().unwrap();
        assert_eq!(source.headers[header::USER_AGENT], "StationPlayer/1");
        assert_eq!(mock.headers.lock().unwrap().len(), 2);
        for headers in mock.headers.lock().unwrap().iter() {
            assert_eq!(headers, &source.headers);
            assert!(!headers.contains_key(header::COOKIE));
            assert!(!headers.contains_key(header::AUTHORIZATION));
        }
    }

    #[tokio::test]
    async fn upstream_api_errors_are_not_followed_as_relative_urls() {
        let (s, mock) = state([
            (
                "https://radio.example/api/station",
                Fixture::body(
                    "application/json",
                    r#"{"code":"-1","msg":"服务器异常，请稍后再试"}"#,
                ),
            ),
            (
                "https://radio.example/api/unknown",
                Fixture::body("application/json", r#"{"msg":"Unavailable"}"#),
            ),
        ])
        .await;
        let error = resolve(&s, &candidate("https://radio.example/api/station"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        let error = resolve(&s, &candidate("https://radio.example/api/unknown"))
            .await
            .err()
            .unwrap();
        assert!(error.1.contains("页面未提供"));
        assert_eq!(mock.requests.lock().unwrap().len(), 2);
    }
}
