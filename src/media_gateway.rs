//! Private, per-job HTTP ingress. FFmpeg sees opaque loopback resource URLs only.
use crate::{
    error::{AppError, Result},
    outbound::{Transport, Upstream, validate_media_url},
    source_types::ResolvedSource,
};
use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use url::Url;

type Entries = (HashMap<String, (Url, bool)>, VecDeque<String>);

#[derive(Clone)]
struct Gateway {
    transport: Arc<dyn Transport>,
    headers: HeaderMap,
    base: String,
    entries: Arc<Mutex<Entries>>,
    cancel: CancellationToken,
    slots: Arc<Semaphore>,
    mmsh: bool,
}
impl Gateway {
    fn link(&self, base: &Url, value: &str, playlist: bool) -> Result<String> {
        if value.contains("{$") {
            return Err(AppError::bad("不支持 HLS 变量"));
        }
        let url = base
            .join(value)
            .map_err(|_| AppError::bad("无效媒体资源地址"))?;
        validate_media_url(&url)?;
        let mut entries = self.entries.lock().unwrap();
        if let Some((key, _)) = entries
            .0
            .iter()
            .find(|(_, (u, p))| u == &url && *p == playlist)
        {
            return Ok(format!("{}/{}", self.base, key));
        }
        let key = uuid::Uuid::new_v4().simple().to_string();
        while entries.0.len() >= 4096 {
            if let Some(old) = entries.1.pop_front() {
                entries.0.remove(&old);
            }
        }
        entries.0.insert(key.clone(), (url, playlist));
        entries.1.push_back(key.clone());
        Ok(format!("{}/{}", self.base, key))
    }
}

pub struct LocalInput {
    pub url: String,
    pub tasks: Vec<JoinHandle<()>>,
}

pub async fn start(
    transport: Arc<dyn Transport>,
    source: &ResolvedSource,
    cancel: CancellationToken,
    mmsh: bool,
) -> Result<LocalInput> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| AppError::upstream())?;
    let base = format!(
        "http://{}/{}",
        listener.local_addr().map_err(|_| AppError::upstream())?,
        uuid::Uuid::new_v4().simple()
    );
    let state = Gateway {
        transport,
        headers: source.headers.clone(),
        base: base.clone(),
        entries: Default::default(),
        cancel: cancel.clone(),
        slots: Arc::new(Semaphore::new(16)),
        mmsh,
    };
    let mut upstream = source.url.clone();
    if mmsh {
        // url::Url cannot switch a non-special scheme to an HTTP special scheme in place.
        upstream = Url::parse(&format!("http{}", &upstream[url::Position::AfterScheme..]))
            .map_err(|_| AppError::upstream())?;
    }
    let url = state.link(&upstream, upstream.as_str(), !mmsh)?;
    let route = format!("/{}/{{key}}", base.rsplit('/').next().unwrap());
    let app = Router::new().route(&route, get(resource)).with_state(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(cancel.cancelled_owned())
            .await;
    });
    Ok(LocalInput {
        url: if mmsh {
            url.replacen("http:", "mmsh:", 1)
        } else {
            url
        },
        tasks: vec![task],
    })
}

pub async fn fetch(
    transport: &dyn Transport,
    mut url: Url,
    range: Option<&axum::http::HeaderValue>,
    headers: &HeaderMap,
) -> Result<(Url, Upstream)> {
    for _ in 0..=6 {
        validate_media_url(&url)?;
        let response = transport.get_media(&url, range, headers).await?;
        if matches!(response.status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            let location = response
                .headers
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(AppError::upstream)?;
            url = url.join(location).map_err(|_| AppError::upstream())?;
        } else if response.status.is_success() {
            return Ok((url, response));
        } else {
            return Err(AppError::upstream());
        }
    }
    Err(AppError::bad("媒体重定向次数过多"))
}

async fn resource(
    State(g): State<Gateway>,
    Path(key): Path<String>,
    incoming: HeaderMap,
) -> Result<Response> {
    let _slot = g
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::upstream())?;
    let (url, playlist) = g
        .entries
        .lock()
        .unwrap()
        .0
        .get(&key)
        .cloned()
        .ok_or(AppError(StatusCode::NOT_FOUND, "媒体资源已失效"))?;
    let mut headers = g.headers.clone();
    if g.mmsh {
        for name in ["user-agent", "pragma", "accept"] {
            headers.remove(name);
            for value in incoming.get_all(name) {
                headers.append(axum::http::HeaderName::from_static(name), value.clone());
            }
        }
    }
    let (url, upstream) = tokio::select! {
        _ = g.cancel.cancelled() => return Err(AppError::upstream()),
        result = fetch(g.transport.as_ref(), url, incoming.get(header::RANGE), &headers) => result?,
    };
    if playlist {
        let bytes = tokio::select! {
            _ = g.cancel.cancelled() => return Err(AppError::upstream()),
            result = tokio::time::timeout(Duration::from_secs(12), axum::body::to_bytes(upstream.body, 1024*1024)) => result.map_err(|_| AppError::upstream())?.map_err(|_| AppError::upstream())?,
        };
        let text = std::str::from_utf8(&bytes).map_err(|_| AppError::bad("无效 HLS 播放列表"))?;
        let rewritten = rewrite(text, |value, playlist| g.link(&url, value, playlist))?;
        return Ok((
            [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
            rewritten,
        )
            .into_response());
    }
    let cancel = g.cancel.clone();
    let stream = futures_util::stream::unfold(
        (upstream.body.into_data_stream(), cancel, _slot),
        |(mut body, cancel, permit)| async move {
            let chunk =
                tokio::select! { _ = cancel.cancelled() => None, chunk = body.next() => chunk }?;
            Some((chunk, (body, cancel, permit)))
        },
    );
    let mut response = Body::from_stream(stream).into_response();
    *response.status_mut() = upstream.status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = upstream.headers.get(&name) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    Ok(response)
}

pub fn rewrite(text: &str, mut link: impl FnMut(&str, bool) -> Result<String>) -> Result<String> {
    let text = text.trim_start_matches('\u{feff}');
    if text.lines().next().map(str::trim) != Some("#EXTM3U") {
        return Err(AppError::bad("无效 HLS 播放列表"));
    }
    let master = text
        .lines()
        .any(|l| l.trim().starts_with("#EXT-X-STREAM-INF:"));
    let mut output = String::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with("#EXT-X-CONTENT-STEERING:") || line.starts_with("#EXT-X-DEFINE:") {
            continue;
        }
        if !line.starts_with('#') && !line.is_empty() {
            output.push_str(&link(line, master)?);
        } else if line.starts_with("#EXT-X-") && line.contains(':') {
            let (tag, tail) = line.split_once(':').unwrap();
            output.push_str(tag);
            output.push(':');
            let playlist = matches!(
                tag,
                "#EXT-X-MEDIA" | "#EXT-X-I-FRAME-STREAM-INF" | "#EXT-X-RENDITION-REPORT"
            );
            let mut start = 0;
            let mut quoted = false;
            for (i, c) in tail
                .char_indices()
                .chain(std::iter::once((tail.len(), ',')))
            {
                if c == '"' {
                    quoted = !quoted;
                }
                if c != ',' || quoted {
                    continue;
                }
                if start > 0 {
                    output.push(',');
                }
                let part = &tail[start..i];
                if let Some((name, value)) = part.split_once('=')
                    && name.trim() == "URI"
                {
                    let value = value.trim();
                    if value.len() < 2 || !value.starts_with('"') || !value.ends_with('"') {
                        return Err(AppError::bad("无效 HLS 属性"));
                    }
                    output.push_str(name);
                    output.push_str("=\"");
                    output.push_str(&link(&value[1..value.len() - 1], playlist)?);
                    output.push('"');
                } else {
                    output.push_str(part);
                }
                start = i + 1;
            }
            if quoted {
                return Err(AppError::bad("无效 HLS 属性"));
            }
        } else {
            output.push_str(line);
        }
        output.push('\n');
        if output.len() > 8 * 1024 * 1024 {
            return Err(AppError::bad("HLS 播放列表过大"));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_every_hls_resource_and_preserves_quoted_commas() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://radio.example/key?a=1,2\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-PART:URI=\"part.ts\",DURATION=0.5\nsegment.ts\n";
        let mut seen = Vec::new();
        let out = rewrite(text, |value, _| {
            seen.push(value.to_string());
            Ok(format!("http://127.0.0.1/{}", seen.len()))
        })
        .unwrap_or_else(|_| panic!());
        assert_eq!(seen.len(), 4);
        assert!(!out.contains("radio.example"));
        assert!(out.contains("http://127.0.0.1/4"));
    }
    struct Redirect(std::sync::atomic::AtomicUsize);
    impl Transport for Redirect {
        fn get<'a>(
            &'a self,
            _url: &'a Url,
            _range: Option<&'a axum::http::HeaderValue>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Upstream>> + Send + 'a>>
        {
            Box::pin(async move {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut headers = HeaderMap::new();
                headers.insert(
                    header::LOCATION,
                    axum::http::HeaderValue::from_static("http://127.0.0.1/private"),
                );
                Ok(Upstream {
                    status: StatusCode::FOUND,
                    headers,
                    body: Body::empty(),
                })
            })
        }
    }
    #[tokio::test]
    async fn redirect_private_target_is_rejected_before_second_fetch() {
        let transport = Redirect(std::sync::atomic::AtomicUsize::new(0));
        assert!(
            fetch(
                &transport,
                Url::parse("http://radio.example/live").unwrap(),
                None,
                &HeaderMap::new()
            )
            .await
            .is_err()
        );
        assert_eq!(transport.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    type CaptureRequest = Arc<Mutex<Option<(Url, HeaderMap)>>>;
    struct Capture(CaptureRequest);
    impl Transport for Capture {
        fn get<'a>(
            &'a self,
            _url: &'a Url,
            _range: Option<&'a axum::http::HeaderValue>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Upstream>> + Send + 'a>>
        {
            Box::pin(async { Err(AppError::upstream()) })
        }
        fn get_media<'a>(
            &'a self,
            url: &'a Url,
            _range: Option<&'a axum::http::HeaderValue>,
            headers: &'a HeaderMap,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Upstream>> + Send + 'a>>
        {
            Box::pin(async move {
                *self.0.lock().unwrap() = Some((url.clone(), headers.clone()));
                Ok(Upstream {
                    status: StatusCode::OK,
                    headers: HeaderMap::new(),
                    body: Body::from("MMSH binary fixture"),
                })
            })
        }
    }
    #[tokio::test]
    async fn mmsh_gateway_preserves_handshake_headers_and_original_http_target() {
        let captured = CaptureRequest::default();
        let transport = Arc::new(Capture(captured.clone()));
        let cancel = CancellationToken::new();
        let source = ResolvedSource {
            url: Url::parse("mmsh://radio.example:82/stream?key=secret").unwrap(),
            headers: HeaderMap::new(),
            format: crate::source_types::MediaFormat::Mmsh,
        };
        let input = start(transport, &source, cancel.clone(), true)
            .await
            .unwrap_or_else(|_| panic!("MMSH gateway failed"));
        let response = reqwest::Client::new()
            .get(input.url.replacen("mmsh:", "http:", 1))
            .header("user-agent", "NSPlayer/12")
            .header("pragma", "xPlayStrm=1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "MMSH binary fixture");
        {
            let captured = captured.lock().unwrap();
            let (url, headers) = captured.as_ref().unwrap();
            assert_eq!(url.as_str(), "http://radio.example:82/stream?key=secret");
            assert_eq!(headers["user-agent"], "NSPlayer/12");
            assert_eq!(headers["pragma"], "xPlayStrm=1");
            assert!(!headers.contains_key("host"));
        }
        cancel.cancel();
        for task in input.tasks {
            task.await.unwrap();
        }
    }
}
