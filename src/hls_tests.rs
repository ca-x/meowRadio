use super::*;
use crate::{
    config::Config,
    outbound::{Transport, Upstream},
};
use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, HeaderValue, Request, header},
};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

const STATION: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_STATION: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE: &str = "http://radio.example/live/master.m3u8?source=radio";

#[derive(Clone)]
struct Fixture {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Fixture {
    fn body(content_type: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: StatusCode::OK,
            headers: HeaderMap::from_iter([(
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type),
            )]),
            body: body.into(),
        }
    }
    fn redirect(location: &'static str) -> Self {
        Self {
            status: StatusCode::FOUND,
            headers: HeaderMap::from_iter([(header::LOCATION, HeaderValue::from_static(location))]),
            body: Vec::new(),
        }
    }
}

#[derive(Default)]
struct MockTransport {
    fixtures: HashMap<String, Fixture>,
    requests: Mutex<Vec<(String, Option<HeaderValue>)>>,
}

impl Transport for MockTransport {
    fn get<'a>(
        &'a self,
        url: &'a url::Url,
        range: Option<&'a HeaderValue>,
    ) -> Pin<Box<dyn Future<Output = Result<Upstream>> + Send + 'a>> {
        Box::pin(async move {
            self.requests
                .lock()
                .unwrap()
                .push((url.to_string(), range.cloned()));
            let fixture = self
                .fixtures
                .get(url.as_str())
                .cloned()
                .ok_or_else(AppError::upstream)?;
            Ok(Upstream {
                status: fixture.status,
                headers: fixture.headers,
                body: Body::from(fixture.body),
            })
        })
    }
}

async fn state(
    fixtures: impl IntoIterator<Item = (&'static str, Fixture)>,
) -> (AppState, Arc<MockTransport>) {
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: ":memory:".into(),
        catalog_url: None,
        proxy: None,
        secure_cookie: true,
        registration: false,
        relay: true,
    };
    let db = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!().run(&db).await.unwrap();
    for (id, session) in [(1, "listener"), (2, "other-listener")] {
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES(?,?,?)")
            .bind(id)
            .bind(session)
            .bind("unused-test-hash")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
            .bind(crate::auth::token_hash(session))
            .bind(id)
            .bind(i64::MAX)
            .execute(&db)
            .await
            .unwrap();
    }
    let transport = Arc::new(MockTransport {
        fixtures: fixtures
            .into_iter()
            .map(|(url, value)| (url.into(), value))
            .collect(),
        ..Default::default()
    });
    let state = AppState {
        db,
        catalog: crate::catalog::Catalog::new(&config).unwrap(),
        config,
        dummy_hash: "unused".into(),
        relay_slots: Arc::new(tokio::sync::Semaphore::new(32)),
        recording_upload_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        recordings_dir: Arc::new(std::path::PathBuf::from("unused-recordings")),
        outbound: transport.clone(),
        hls_key: Arc::new([7; 32]),
        auth_attempts: Default::default(),
    };
    (state, transport)
}

fn token(state: &AppState, url: &str, kind: Kind, expires: u64) -> String {
    mint(
        state.hls_key.as_slice(),
        &Claim {
            user: 1,
            station: STATION.into(),
            url: url.into(),
            kind,
            expires,
        },
    )
    .unwrap_or_else(|_| panic!("mint failed"))
}

fn resource_path(token: &str) -> String {
    format!("/api/stream/{STATION}?resource={token}")
}

fn decode_link(state: &AppState, link: &str) -> (String, Kind) {
    let prefix = format!("/api/stream/{STATION}?resource=");
    let token = link
        .strip_prefix(&prefix)
        .expect("all resources must be same-origin relay URLs");
    let (url, kind) =
        resource(state, 1, STATION, token).unwrap_or_else(|_| panic!("rewritten link is invalid"));
    (url.into(), kind)
}

fn uri_attribute(line: &str) -> &str {
    line.split_once("URI=\"")
        .expect("URI attribute")
        .1
        .split_once('"')
        .unwrap()
        .0
}

async fn request(
    state: &AppState,
    uri: &str,
    session: Option<&str>,
    range: Option<&str>,
) -> axum::response::Response {
    let mut request = Request::builder().uri(uri);
    if let Some(session) = session {
        request = request.header(header::COOKIE, format!("meow_session={session}"));
    }
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    crate::app(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn response_text(response: axum::response::Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), 8 * MAX_PLAYLIST)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn tokens_bind_user_station_kind_url_and_expiry() {
    let (state, _) = state([]).await;
    let signed = token(&state, BASE, Kind::Playlist, u64::MAX);
    let (url, kind) =
        resource(&state, 1, STATION, &signed).unwrap_or_else(|_| panic!("valid token rejected"));
    assert_eq!(url.as_str(), BASE);
    assert_eq!(kind, Kind::Playlist);
    assert_eq!(
        resource(&state, 2, STATION, &signed).err().unwrap().0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        resource(&state, 1, OTHER_STATION, &signed).err().unwrap().0,
        StatusCode::FORBIDDEN
    );
    let expired = token(&state, BASE, Kind::Playlist, 0);
    assert_eq!(
        resource(&state, 1, STATION, &expired).err().unwrap().0,
        StatusCode::GONE
    );

    let (payload, signature) = signed.split_once('.').unwrap();
    let mut claim: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
    for (field, value) in [
        ("url", serde_json::json!("http://127.0.0.1/private")),
        ("kind", serde_json::json!("Asset")),
        ("expires", serde_json::json!(0)),
    ] {
        let original = claim[field].clone();
        claim[field] = value;
        let tampered = format!(
            "{}.{signature}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claim).unwrap())
        );
        assert_eq!(
            resource(&state, 1, STATION, &tampered).err().unwrap().0,
            StatusCode::FORBIDDEN
        );
        claim[field] = original;
    }
    for malformed in [
        String::new(),
        "not.a.token".into(),
        format!("{payload}.AAAA"),
        "x".repeat(8001),
    ] {
        assert_eq!(
            resource(&state, 1, STATION, &malformed).err().unwrap().0,
            StatusCode::FORBIDDEN
        );
    }
    let mut restarted = state.clone();
    restarted.hls_key = Arc::new([8; 32]);
    assert_eq!(
        resource(&restarted, 1, STATION, &signed).err().unwrap().0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn master_rewrites_variants_and_quoted_uri_attributes_without_splitting_commas() {
    let (state, _) = state([]).await;
    let base = url::Url::parse(BASE).unwrap();
    let source = "\u{feff}#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"radio\",NAME=\"News, Live\",URI=\"audio/index?sig=a,b\"\r\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI=\"//cdn.example/iframes\"\r\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS=\"mp4a.40.2,avc1.42e01e\"\r\n../variant?sig=x,y\r\n";
    let rewritten =
        rewrite(&state, 1, STATION, &base, source).unwrap_or_else(|_| panic!("rewrite failed"));
    let lines: Vec<_> = rewritten.lines().collect();
    assert_eq!(lines[0], "#EXTM3U");
    assert!(lines[1].contains("NAME=\"News, Live\""));
    assert_eq!(
        decode_link(&state, uri_attribute(lines[1])),
        (
            "http://radio.example/live/audio/index?sig=a,b".into(),
            Kind::Playlist
        )
    );
    assert_eq!(
        decode_link(&state, uri_attribute(lines[2])),
        ("http://cdn.example/iframes".into(), Kind::Playlist)
    );
    assert_eq!(
        lines[3],
        "#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS=\"mp4a.40.2,avc1.42e01e\""
    );
    assert_eq!(
        decode_link(&state, lines[4]),
        (
            "http://radio.example/variant?sig=x,y".into(),
            Kind::Playlist
        )
    );
}

#[tokio::test]
async fn media_rewrites_keys_maps_segments_parts_and_rendition_reports() {
    let (state, _) = state([]).await;
    let source = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key?sig=a,b\",IV=0x01\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXT-X-PART:DURATION=0.25,URI=\"part.m4s\"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"next.m4s\"\n#EXT-X-RENDITION-REPORT:URI=\"../alternate\",LAST-MSN=10\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"http://other.example/steer.json\"\n#EXTINF:5,\nsegment.ts?token=a,b\n";
    let rewritten = rewrite(&state, 1, STATION, &url::Url::parse(BASE).unwrap(), source)
        .unwrap_or_else(|_| panic!("rewrite failed"));
    let lines: Vec<_> = rewritten.lines().collect();
    for (index, expected, kind) in [
        (1, "http://radio.example/live/keys/key?sig=a,b", Kind::Asset),
        (2, "http://radio.example/live/init.mp4", Kind::Asset),
        (3, "http://radio.example/live/part.m4s", Kind::Asset),
        (4, "http://radio.example/live/next.m4s", Kind::Asset),
        (5, "http://radio.example/alternate", Kind::Playlist),
    ] {
        assert_eq!(
            decode_link(&state, uri_attribute(lines[index])),
            (expected.into(), kind)
        );
    }
    assert!(lines[1].ends_with(",IV=0x01"));
    assert!(lines[2].ends_with(",BYTERANGE=\"100@0\""));
    assert!(!rewritten.contains("CONTENT-STEERING"));
    assert_eq!(
        decode_link(&state, lines.last().unwrap()),
        (
            "http://radio.example/live/segment.ts?token=a,b".into(),
            Kind::Asset
        )
    );
}

#[tokio::test]
async fn malformed_oversized_and_unsupported_playlists_fail_closed() {
    let (state, _) = state([]).await;
    let base = url::Url::parse(BASE).unwrap();
    for source in [
        "<html>upstream failure</html>",
        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=unquoted\n",
        "#EXTM3U\n#EXT-X-KEY:URI=\"unterminated\n",
        "#EXTM3U\nfile:///etc/passwd\n",
        "#EXTM3U\nhttp://user:pass@radio.example/segment\n",
        "#EXTM3U\n{$cdn}/segment.ts\n",
        "#EXTM3U\n#EXT-X-KEY:URI=\"data:text/plain,secret\"\n",
    ] {
        assert!(
            rewrite(&state, 1, STATION, &base, source).is_err(),
            "accepted {source}"
        );
    }
    assert!(
        rewrite(
            &state,
            1,
            STATION,
            &base,
            &format!("#EXTM3U\n{}", "x".repeat(MAX_PLAYLIST))
        )
        .is_err()
    );
    assert!(
        rewrite(
            &state,
            1,
            STATION,
            &base,
            &format!("#EXTM3U\nhttps://radio.example/{}", "x".repeat(5000))
        )
        .is_err()
    );
}

#[tokio::test]
async fn authenticated_route_follows_master_media_key_map_and_ranged_segment() {
    let mut segment = Fixture::body("video/mp2t", "segment bytes");
    segment.status = StatusCode::PARTIAL_CONTENT;
    segment.headers.insert(
        header::CONTENT_RANGE,
        HeaderValue::from_static("bytes 10-22/100"),
    );
    segment
        .headers
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    segment.headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("upstream=secret"),
    );
    let (state, transport) = state([
        (BASE, Fixture::redirect("https://cdn.example/new/master")),
        ("https://cdn.example/new/master", Fixture::body("application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nmedia\n")),
        ("https://cdn.example/new/media", Fixture::body("application/octet-stream", "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP:URI=\"init\"\n#EXTINF:5,\nsegment\n")),
        ("https://cdn.example/new/key", Fixture::body("application/octet-stream", vec![7; 16])),
        ("https://cdn.example/new/init", Fixture::body("video/mp4", "initialization")),
        ("https://cdn.example/new/segment", segment),
    ]).await;
    let uri = resource_path(&token(&state, BASE, Kind::Playlist, u64::MAX));
    let master = request(&state, &uri, Some("listener"), None).await;
    assert_eq!(master.status(), StatusCode::OK);
    assert_eq!(
        master.headers()[header::CONTENT_TYPE],
        "application/vnd.apple.mpegurl"
    );
    assert_eq!(master.headers()[header::CACHE_CONTROL], "no-store");
    let master = response_text(master).await;
    let media = request(
        &state,
        master.lines().last().unwrap(),
        Some("listener"),
        None,
    )
    .await;
    assert_eq!(media.status(), StatusCode::OK);
    let media = response_text(media).await;
    let lines: Vec<_> = media.lines().collect();
    let key = request(&state, uri_attribute(lines[1]), Some("listener"), None).await;
    assert_eq!(
        to_bytes(key.into_body(), 100).await.unwrap().as_ref(),
        &[7; 16]
    );
    let map = request(&state, uri_attribute(lines[2]), Some("listener"), None).await;
    assert_eq!(response_text(map).await, "initialization");
    let segment = request(
        &state,
        lines.last().unwrap(),
        Some("listener"),
        Some("bytes=10-22"),
    )
    .await;
    assert_eq!(segment.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(segment.headers()[header::CONTENT_RANGE], "bytes 10-22/100");
    assert_eq!(segment.headers()[header::ACCEPT_RANGES], "bytes");
    assert!(!segment.headers().contains_key(header::SET_COOKIE));
    assert_eq!(response_text(segment).await, "segment bytes");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|(url, _)| url.as_str())
            .collect::<Vec<_>>(),
        [
            BASE,
            "https://cdn.example/new/master",
            "https://cdn.example/new/media",
            "https://cdn.example/new/key",
            "https://cdn.example/new/init",
            "https://cdn.example/new/segment"
        ]
    );
    assert_eq!(requests.last().unwrap().1.as_ref().unwrap(), "bytes=10-22");
    assert_eq!(state.relay_slots.available_permits(), 32);
}

#[tokio::test]
async fn resource_routes_require_session_binding_and_unexpired_signature_before_transport() {
    let (state, transport) = state([]).await;
    let uri = resource_path(&token(&state, BASE, Kind::Playlist, u64::MAX));
    assert_eq!(
        request(&state, &uri, None, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&state, &uri, Some("other-listener"), None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &state,
            &uri.replace(STATION, OTHER_STATION),
            Some("listener"),
            None
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&state, &format!("{uri}x"), Some("listener"), None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let expired = resource_path(&token(&state, BASE, Kind::Playlist, 0));
    assert_eq!(
        request(&state, &expired, Some("listener"), None)
            .await
            .status(),
        StatusCode::GONE
    );
    assert!(transport.requests.lock().unwrap().is_empty());
    assert_eq!(state.relay_slots.available_permits(), 32);
}

#[tokio::test]
async fn playlist_body_limit_and_redirect_limit_release_capacity() {
    let (state, transport) = state([
        (
            BASE,
            Fixture::body(
                "application/vnd.apple.mpegurl",
                vec![b'x'; MAX_PLAYLIST + 1],
            ),
        ),
        ("http://radio.example/loop", Fixture::redirect("/loop")),
    ])
    .await;
    let uri = resource_path(&token(&state, BASE, Kind::Playlist, u64::MAX));
    assert_eq!(
        request(&state, &uri, Some("listener"), None).await.status(),
        StatusCode::BAD_REQUEST
    );
    let uri = resource_path(&token(
        &state,
        "http://radio.example/loop",
        Kind::Playlist,
        u64::MAX,
    ));
    assert_eq!(
        request(&state, &uri, Some("listener"), None).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 7);
    assert_eq!(state.relay_slots.available_permits(), 32);
}

#[tokio::test]
async fn signed_private_resource_is_still_rejected_by_production_transport() {
    let (mut state, _) = state([]).await;
    state.outbound = Arc::new(crate::outbound::NetworkTransport::new(&state.config));
    let rewritten = rewrite(
        &state,
        1,
        STATION,
        &url::Url::parse(BASE).unwrap(),
        "#EXTM3U\n#EXTINF:5,\nhttp://127.0.0.1:8000/private\n",
    )
    .unwrap_or_else(|_| panic!("rewrite failed"));
    let response = request(
        &state,
        rewritten.lines().last().unwrap(),
        Some("listener"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_text(response).await.contains("公共互联网"));
    assert_eq!(state.relay_slots.available_permits(), 32);
}

#[tokio::test]
async fn low_latency_reload_preserves_original_query_and_forwards_only_supported_controls() {
    let (state, transport) = state([(
        "http://radio.example/live/master.m3u8?source=radio&_HLS_msn=42&_HLS_part=3&_HLS_skip=YES",
        Fixture::body(
            "application/vnd.apple.mpegurl",
            "#EXTM3U\n#EXT-X-TARGETDURATION:5\n",
        ),
    )])
    .await;
    let uri = resource_path(&token(&state, BASE, Kind::Playlist, u64::MAX));
    let response = request(
        &state,
        &format!("{uri}&_HLS_msn=42&_HLS_part=3&_HLS_skip=YES&url=http://127.0.0.1/"),
        Some("listener"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
    let response = request(
        &state,
        &format!("{uri}&_HLS_skip=arbitrary"),
        Some("listener"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}
