use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use meowradio::{AppState, catalog::Station, config::Config};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn application() -> (tempfile::TempDir, AppState, Router) {
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("favorites.db"),
        catalog_url: Some("http://127.0.0.1:9".into()),
        proxy: None,
        secure_cookie: false,
        registration: true,
        relay: true,
    };
    let state = meowradio::state(config).await.unwrap();
    for (id, name) in [(1, "alice"), (2, "bob")] {
        sqlx::query("INSERT INTO users(id, username, password_hash) VALUES(?, ?, 'unused')")
            .bind(id)
            .bind(name)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, unixepoch()+3600)",
        )
        .bind(meowradio::auth::token_hash(name))
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    }
    let app = meowradio::app(state.clone());
    (dir, state, app)
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-meow-request", "1");
    if let Some(cookie) = cookie {
        request = request.header("cookie", format!("meow_session={cookie}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn get(app: &Router, path: &str) -> Value {
    let (status, body) = request(app, "GET", path, Some("alice")).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}

fn station(index: usize) -> Station {
    Station {
        id: format!("station-{index:03}"),
        name: format!("Radio {index:03}"),
        url: "https://radio.example/stream".into(),
        country: "China".into(),
        countrycode: "CN".into(),
        tags: if index.is_multiple_of(2) {
            "jazz"
        } else {
            "rock"
        }
        .into(),
        codec: "MP3".into(),
        bitrate: 128,
        hls: false,
        personal: false,
        source_id: None,
        source_name: None,
    }
}

async fn insert(state: &AppState, user_id: i64, station: Station, created_at: i64) {
    sqlx::query(
        "INSERT INTO favorites(user_id, station_id, station_json, created_at) VALUES(?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(&station.id)
    .bind(serde_json::to_string(&station).unwrap())
    .bind(created_at)
    .execute(&state.db)
    .await
    .unwrap();
}

fn ids(page: &Value) -> Vec<&str> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn pages_are_stable_bounded_and_clamp_after_removals() {
    let (_dir, state, app) = application().await;
    // Insert backwards with equal timestamps to exercise the station_id tie-breaker.
    for index in (0..49).rev() {
        insert(&state, 1, station(index), 100).await;
    }
    for (page, first, last, count) in [(0, 0, 23, 24), (1, 24, 47, 24), (2, 48, 48, 1)] {
        let body = get(&app, &format!("/api/favorites/page?page={page}")).await;
        assert_eq!(body["total"], 49);
        assert_eq!(body["page"], page);
        assert_eq!(body["page_size"], 24);
        let found = ids(&body);
        assert_eq!(found.len(), count);
        assert_eq!(found[0], format!("station-{first:03}"));
        assert_eq!(found[count - 1], format!("station-{last:03}"));
    }
    let legacy = get(&app, "/api/favorites").await;
    assert_eq!(legacy.as_array().unwrap().len(), 49);
    let beyond = get(&app, "/api/favorites/page?page=999").await;
    assert_eq!(beyond["page"], 2);
    assert_eq!(ids(&beyond), ["station-048"]);
    assert_eq!(
        request(&app, "DELETE", "/api/favorites/station-048", Some("alice"))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let clamped = get(&app, "/api/favorites/page?page=2").await;
    assert_eq!(clamped["total"], 48);
    assert_eq!(clamped["page"], 1);
    assert_eq!(ids(&clamped).len(), 24);
    assert_eq!(ids(&clamped)[23], "station-047");
    sqlx::query("DELETE FROM favorites WHERE user_id=1 AND station_id >= 'station-024'")
        .execute(&state.db)
        .await
        .unwrap();
    let exact = get(&app, "/api/favorites/page?page=1").await;
    assert_eq!(exact["total"], 24);
    assert_eq!(exact["page"], 0);
    assert_eq!(ids(&exact).len(), 24);
    sqlx::query("DELETE FROM favorites WHERE user_id=1")
        .execute(&state.db)
        .await
        .unwrap();
    for path in [
        "/api/favorites/page?page=2",
        "/api/favorites/page?page=2&q=jazz",
    ] {
        assert_eq!(
            get(&app, path).await,
            json!({"items":[], "total":0, "page":0, "page_size":24})
        );
    }
}

#[tokio::test]
async fn search_counts_all_matches_before_paging_and_preserves_unicode_substrings() {
    let (_dir, state, app) = application().await;
    for index in 0..60 {
        insert(&state, 1, station(index), 100).await;
    }
    let first = get(&app, "/api/favorites/page?q=JAZZ").await;
    assert_eq!(first["total"], 30);
    assert_eq!(ids(&first).len(), 24);
    assert_eq!(ids(&first)[23], "station-046");
    let second = get(&app, "/api/favorites/page?q=jazz&page=1").await;
    assert_eq!(second["total"], 30);
    assert_eq!(
        ids(&second),
        [
            "station-048",
            "station-050",
            "station-052",
            "station-054",
            "station-056",
            "station-058"
        ]
    );
    assert_eq!(
        get(&app, "/api/favorites/page?q=jazz&page=99").await,
        second
    );
    // Exact filtered page boundary also clamps to the previous page.
    sqlx::query("DELETE FROM favorites WHERE station_id >= 'station-048'")
        .execute(&state.db)
        .await
        .unwrap();
    let exact = get(&app, "/api/favorites/page?q=jazz&page=1").await;
    assert_eq!(exact["total"], 24);
    assert_eq!(exact["page"], 0);
    assert_eq!(ids(&exact).len(), 24);
    let mut special = station(100);
    special.name = "ÄTHER 中文 100%_FM".into();
    special.tags = "ÉLECTRO,新闻".into();
    special.country = "Österreich".into();
    insert(&state, 1, special, 101).await;
    for needle in [
        "äther",
        "中文",
        "électro",
        "新闻",
        "österreich",
        "%",
        "_",
        "%_",
        "FM ÉLECTRO",
    ] {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", needle)
            .finish();
        let result = get(&app, &format!("/api/favorites/page?{query}")).await;
        assert_eq!(result["total"], 1, "{needle}");
        assert_eq!(ids(&result), ["station-100"], "{needle}");
    }
    let missing = get(&app, "/api/favorites/page?q=absent&page=10").await;
    assert_eq!(
        missing,
        json!({"items":[], "total":0, "page":0, "page_size":24})
    );
}

#[tokio::test]
async fn summary_is_lightweight_and_both_endpoints_are_private_to_the_session() {
    let (_dir, state, app) = application().await;
    for index in 0..50 {
        insert(&state, 1, station(index), 100).await;
    }
    insert(&state, 1, station(100), 101).await;
    insert(&state, 2, station(200), 102).await;
    let summary = get(&app, "/api/favorites/summary").await;
    assert_eq!(summary.as_object().unwrap().len(), 2);
    assert_eq!(summary["ids"].as_array().unwrap().len(), 51);
    assert!(
        summary["ids"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_string)
    );
    assert_eq!(summary["presets"].as_array().unwrap().len(), 4);
    for (index, id) in ["station-100", "station-000", "station-001", "station-002"]
        .into_iter()
        .enumerate()
    {
        assert_eq!(summary["ids"][index], id);
        assert_eq!(summary["presets"][index]["id"], id);
    }
    let (_, bob) = request(&app, "GET", "/api/favorites/page?user_id=1", Some("bob")).await;
    assert_eq!(bob["total"], 1);
    assert_eq!(ids(&bob), ["station-200"]);
    let (_, bob_summary) = request(&app, "GET", "/api/favorites/summary", Some("bob")).await;
    assert_eq!(bob_summary["ids"], json!(["station-200"]));
    for path in ["/api/favorites/page", "/api/favorites/summary"] {
        for cookie in [None, Some("invalid")] {
            let (status, body) = request(&app, "GET", path, cookie).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(body, json!({"error":"请先登录"}));
        }
    }
    sqlx::query("UPDATE sessions SET expires_at=0 WHERE user_id=1")
        .execute(&state.db)
        .await
        .unwrap();
    for path in ["/api/favorites/page", "/api/favorites/summary"] {
        assert_eq!(
            request(&app, "GET", path, Some("alice")).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn page_validation_returns_chinese_json_errors_and_counts_utf8_bytes() {
    let (_dir, _state, app) = application().await;
    for query in [
        "page=-1",
        "page=4294967296",
        "page=18446744073709551615",
        "page=abc",
        "page=1.5",
    ] {
        let (status, body) = request(
            &app,
            "GET",
            &format!("/api/favorites/page?{query}"),
            Some("alice"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(body, json!({"error":"搜索条件过长或页码超出范围"}));
    }
    for (needle, expected) in [
        ("a".repeat(100), StatusCode::OK),
        ("a".repeat(101), StatusCode::BAD_REQUEST),
        ("中".repeat(33), StatusCode::OK),
        ("中".repeat(34), StatusCode::BAD_REQUEST),
    ] {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", &needle)
            .finish();
        let (status, _) = request(
            &app,
            "GET",
            &format!("/api/favorites/page?{query}"),
            Some("alice"),
        )
        .await;
        assert_eq!(status, expected);
    }
}
