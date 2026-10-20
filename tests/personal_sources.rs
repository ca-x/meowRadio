use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use meowradio::{
    AppState,
    config::Config,
    personal_sources::{parse_candidate, parse_feed},
};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn application() -> (tempfile::TempDir, AppState, Router) {
    let dir = tempfile::tempdir().unwrap();
    let state = meowradio::state(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("personal.db"),
        catalog_url: Some("http://127.0.0.1:9".into()),
        proxy: None,
        secure_cookie: false,
        registration: true,
        relay: true,
    })
    .await
    .unwrap();
    for (id, name) in [(1, "alice"), (2, "bob")] {
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES(?,?,'unused')")
            .bind(id)
            .bind(name)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,unixepoch()+3600)",
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
    user: Option<&str>,
    owner: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-meow-request", "1")
        .header("content-type", "application/json");
    if let Some(user) = user {
        request = request.header("cookie", format!("meow_session={user}"));
    }
    if let Some(owner) = owner {
        request = request.header("x-meow-owner", owner);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn alice(app: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    request(app, method, path, Some("alice"), Some("1"), body).await
}
fn feed(names: &[&str]) -> Value {
    Value::Array(names.iter().map(|name| json!({"name":name,"categories":[["音乐","爵士"]],"urls":["https://radio.example/live"]})).collect())
}
async fn upload(app: &Router, body: Value) -> String {
    let (status, source) = alice(
        app,
        "POST",
        "/api/personal-sources/upload?label=Library",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{source}");
    source["id"].as_str().unwrap().into()
}
async fn stations(app: &Router) -> Value {
    let (status, result) = alice(app, "GET", "/api/personal-stations", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result
}
#[tokio::test]
async fn atomic_refresh_keeps_ids_and_cascades_favorites() {
    let (_dir, state, app) = application().await;
    let source_id = upload(&app, feed(&["Keep", "Remove"])).await;
    let old = stations(&app).await;
    let keep_id = old["items"][0]["id"].as_str().unwrap();
    let remove_id = old["items"][1]["id"].as_str().unwrap();
    for id in [keep_id, remove_id] {
        let (status, station) =
            alice(&app, "PUT", &format!("/api/favorites/{id}"), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{station}");
        assert_eq!(station["personal"], true);
        assert_eq!(station["source_name"], "Library");
        assert_eq!(
            station["url"],
            format!("/api/personal-stations/{id}/stream")
        );
        assert!(!station.to_string().contains("radio.example"));
    }
    let replacement = format!("/api/personal-sources/upload?label=Updated&source_id={source_id}");
    let (status, _) = alice(
        &app,
        "POST",
        &replacement,
        json!([{"name":"Keep","urls":["file:///etc/passwd"]}]),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(stations(&app).await["total"], 2);
    let (status, _) = alice(
        &app,
        "POST",
        &replacement,
        json!([
            {"name":"Keep","categories":[["Talk"]],"urls":["https://radio.example/new"]},
            {"name":"Added","urls":["rtsp://radio.example/live"]}
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let refreshed = stations(&app).await;
    assert_eq!(refreshed["items"][0]["id"], keep_id);
    assert_eq!(refreshed["items"][0]["tags"], "Talk");
    let (status, favorites) = alice(&app, "GET", "/api/favorites", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(favorites.as_array().unwrap().len(), 1);
    assert_eq!(favorites[0]["source_name"], "Updated");
    assert_eq!(favorites[0]["tags"], "Talk");
    let candidates = meowradio::personal_sources::candidates(&state, 1, keep_id)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1));
    assert_eq!(candidates[0].url, "https://radio.example/new");
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!("/api/personal-sources/{source_id}/refresh"),
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        alice(
            &app,
            "DELETE",
            &format!("/api/personal-stations/{keep_id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        alice(&app, "GET", "/api/favorites", Value::Null).await.1,
        json!([])
    );
    assert_eq!(
        alice(
            &app,
            "DELETE",
            &format!("/api/personal-sources/{source_id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(stations(&app).await["total"], 0);
}
#[tokio::test]
async fn owner_isolation_and_account_change_guards() {
    let (_dir, state, app) = application().await;
    let source_id = upload(&app, feed(&["Private"])).await;
    let private = stations(&app).await;
    let id = private["items"][0]["id"].as_str().unwrap();
    for path in ["/api/personal-sources", "/api/personal-stations"] {
        assert_eq!(
            request(&app, "GET", path, None, None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (_, list) = request(
        &app,
        "GET",
        "/api/personal-sources",
        Some("bob"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(list, json!([]));
    let (_, page) = request(
        &app,
        "GET",
        "/api/personal-stations",
        Some("bob"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(page["total"], 0);
    for (method, path) in [
        ("DELETE", format!("/api/personal-sources/{source_id}")),
        ("POST", format!("/api/personal-sources/{source_id}/refresh")),
        ("DELETE", format!("/api/personal-stations/{id}")),
        ("PUT", format!("/api/favorites/{id}")),
        ("POST", format!("/api/stations/{id}/click")),
    ] {
        assert_eq!(
            request(&app, method, &path, Some("bob"), Some("2"), Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    assert!(
        meowradio::personal_sources::candidates(&state, 2, id)
            .await
            .is_err()
    );
    for owner in [None, Some("2")] {
        assert_eq!(
            request(
                &app,
                "DELETE",
                "/api/personal-sources",
                Some("alice"),
                owner,
                Value::Null
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            request(
                &app,
                "POST",
                "/api/personal-sources/upload?label=Wrong",
                Some("alice"),
                owner,
                feed(&["Wrong"])
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!("/api/stations/{id}/click"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        alice(&app, "DELETE", "/api/personal-sources", Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(stations(&app).await["total"], 0);
}
#[test]
fn strict_legacy_grammar_and_feed_limits() {
    let candidate = parse_candidate(r#"https://radio.example/live -headers "Referer: https://radio.example/\r\nUser-Agent: Radio player" -reuse 1"#).unwrap_or_else(|e| panic!("{}",e.1));
    assert_eq!(candidate.headers["Referer"], "https://radio.example/");
    assert_eq!(candidate.headers["User-Agent"], "Radio player");
    for scheme in [
        "http", "https", "rtmp", "rtmps", "rtsp", "rtsps", "mms", "mmst", "mmsh",
    ] {
        assert!(parse_candidate(&format!("{scheme}://radio.example/live")).is_ok());
    }
    for invalid in [
        "file:///etc/passwd",
        "concat:https://radio.example/a|file:///secret",
        "https://alice:secret@radio.example/",
        "http://127.0.0.1/a",
        "http://169.254.169.254/a",
        "https://[::1]/a",
        "rtmp://192.168.1.1/a",
        "https://radio.example/live -i /etc/passwd",
        "https://radio.example/live -reuse 2",
        r#"https://radio.example/live -headers "Host: internal""#,
        r#"https://radio.example/live -headers "Referer: ok\r\nAuthorization: secret""#,
        "https://radio.example/live -headers \"Referer: ok\nInjected: bad\"",
        "https://radio.example/live -reuse 1 ; touch /tmp/no",
    ] {
        assert!(parse_candidate(invalid).is_err(), "accepted {invalid}");
    }
    let merged = parse_feed(&serde_json::to_vec(&json!([
        {"name":"Same","categories":[["One"]],"urls":["https://radio.example/a"]},
        {"name":"Same","categories":[["Two"],["One"]],"urls":["https://radio.example/a",{"url":"https://radio.example/b","headers":{"accept":"audio/*"}}]}
    ])).unwrap()).unwrap_or_else(|e| panic!("{}",e.1));
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].candidates.len(), 2);
    assert_eq!(merged[0].categories, vec![vec!["One"], vec!["Two"]]);
    for invalid in [
        json!([{"name":"Empty","urls":[]}]),
        json!([{"name":"Deep","categories":[["a","b","c","d","e","f","g","h","i"]],"urls":["https://radio.example/a"]}]),
        json!([{"name":"Many","urls":vec!["https://radio.example/a";17]}]),
        json!([{"name":"Bad","urls":[{"url":"https://radio.example/a","headers":{"Cookie":"secret"}}]}]),
    ] {
        assert!(parse_feed(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    assert!(parse_feed(&vec![b' '; 5 * 1024 * 1024 + 1]).is_err());
}
#[tokio::test]
async fn pagination_categories_and_private_list_separation() {
    let (_dir, _state, app) = application().await;
    let body = Value::Array((0..30).map(|i|json!({"name":format!("中文 Station {i}"),"categories":[["音乐",if i%2==0 {"爵士"}else{"摇滚"}]],"urls":["https://radio.example/live"]})).collect());
    let source_id = upload(&app, body).await;
    let page = stations(&app).await;
    assert_eq!(page["total"], 30);
    assert_eq!(page["items"].as_array().unwrap().len(), 24);
    let (status, all) = alice(&app, "GET", "/api/personal-stations/explore", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all["items"].as_array().unwrap().len(), 30);
    let (_, larger) = alice(
        &app,
        "GET",
        "/api/personal-stations?page_size=100",
        Value::Null,
    )
    .await;
    assert_eq!(larger["items"].as_array().unwrap().len(), 30);
    assert_eq!(larger["page_size"], 100);
    let (status, _) = request(
        &app,
        "GET",
        "/api/personal-stations/explore",
        None,
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (_, other) = request(
        &app,
        "GET",
        "/api/personal-stations/explore",
        Some("bob"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(other["items"].as_array().unwrap().len(), 0);
    assert_eq!(
        page["categories"],
        json!([["音乐", "爵士"], ["音乐", "摇滚"]])
    );
    let (_, last) = alice(
        &app,
        "GET",
        "/api/personal-stations?page=999999",
        Value::Null,
    )
    .await;
    assert_eq!(last["page"], 1);
    assert_eq!(last["items"].as_array().unwrap().len(), 6);
    let mut url = url::Url::parse("https://example.test/api/personal-stations").unwrap();
    url.query_pairs_mut()
        .append_pair("q", "中文")
        .append_pair("category", r#"["音乐","爵士"]"#)
        .append_pair("source_id", &source_id);
    let (_, filtered) = alice(
        &app,
        "GET",
        &format!("{}?{}", url.path(), url.query().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(filtered["total"], 15);
    assert_eq!(
        alice(&app, "GET", "/api/favorites", Value::Null).await.1,
        json!([])
    );
    let id = page["items"][0]["id"].as_str().unwrap();
    assert_eq!(
        alice(&app, "PUT", &format!("/api/favorites/{id}"), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        alice(&app, "DELETE", "/api/personal-sources", Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        alice(&app, "GET", "/api/favorites", Value::Null).await.1,
        json!([])
    );
}

#[tokio::test]
async fn remote_refresh_rejects_invalid_or_replaced_feed_without_losing_snapshot() {
    use meowradio::outbound::{Transport, Upstream};
    use std::{
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };
    struct FeedTransport(Arc<Mutex<String>>);
    impl Transport for FeedTransport {
        fn get<'a>(
            &'a self,
            _url: &'a url::Url,
            _range: Option<&'a axum::http::HeaderValue>,
        ) -> Pin<Box<dyn Future<Output = meowradio::error::Result<Upstream>> + Send + 'a>> {
            Box::pin(async move {
                let mut headers = axum::http::HeaderMap::new();
                headers.insert(
                    "content-type",
                    axum::http::HeaderValue::from_static("application/json"),
                );
                Ok(Upstream {
                    status: StatusCode::OK,
                    headers,
                    body: Body::from(self.0.lock().unwrap().clone()),
                })
            })
        }
    }
    let (_dir, mut state, _app) = application().await;
    let response = Arc::new(Mutex::new(feed(&["Remote"]).to_string()));
    state.outbound = Arc::new(FeedTransport(response.clone()));
    let app = meowradio::app(state);
    let (status, source) = alice(
        &app,
        "POST",
        "/api/personal-sources",
        json!({"label":"Remote source","url":"https://feeds.example/list.json"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{source}");
    assert!(source.get("is_subscription").is_none());
    let id = source["id"].as_str().unwrap();
    let original = stations(&app).await;
    for invalid in [
        json!([{"name":"Broken","urls":[]}]).to_string(),
        "<html>Feed has moved</html>".into(),
        "{".into(),
    ] {
        *response.lock().unwrap() = invalid;
        let (status, error) = alice(
            &app,
            "POST",
            &format!("/api/personal-sources/{id}/refresh"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert_eq!(stations(&app).await, original);
    }
    *response.lock().unwrap() =
        json!([{"name":"Remote","urls":["https://radio.example/updated"]}]).to_string();
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!("/api/personal-sources/{id}/refresh"),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        stations(&app).await["items"][0]["id"],
        original["items"][0]["id"]
    );
    *response.lock().unwrap() = json!([
        {"name":"Remote","urls":["https://radio.example/new", "file:///private"]},
        {"name":"All invalid","urls":["http://127.0.0.1/stream"]}
    ])
    .to_string();
    let (status, diagnostics) = alice(
        &app,
        "POST",
        &format!("/api/personal-sources/{id}/refresh"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(diagnostics["invalid_records"].as_array().unwrap().len(), 2);
    assert_eq!(diagnostics["valid_count"], 1);
    let station_id = original["items"][0]["id"].as_str().unwrap();
    assert_eq!(
        alice(
            &app,
            "PUT",
            &format!("/api/favorites/{station_id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    // A changed online feed must be reviewed again: an old confirmation cannot
    // silently discard newly invalid addresses or cascade the existing favorite.
    *response.lock().unwrap() = json!([
        {"name":"Remote","urls":["file:///newly-invalid"]},
        {"name":"All invalid","urls":["http://127.0.0.1/stream"]}
    ])
    .to_string();
    let (status, changed_diagnostics) = alice(
        &app,
        "POST",
        &format!(
            "/api/personal-sources/{id}/refresh?discard_invalid=true&snapshot_token={}",
            diagnostics["snapshot_token"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_ne!(
        changed_diagnostics["snapshot_token"],
        diagnostics["snapshot_token"]
    );
    assert_eq!(
        changed_diagnostics["invalid_records"][0]["url"],
        "file:///newly-invalid"
    );
    assert_eq!(stations(&app).await["items"][0]["id"], station_id);
    assert_eq!(
        alice(&app, "GET", "/api/favorites", Value::Null)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    *response.lock().unwrap() = json!([
        {"name":"Remote","urls":["https://radio.example/new", "file:///private"]},
        {"name":"All invalid","urls":["http://127.0.0.1/stream"]}
    ])
    .to_string();
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!(
                "/api/personal-sources/{id}/refresh?discard_invalid=true&snapshot_token={}",
                diagnostics["snapshot_token"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        stations(&app).await["items"][0]["id"],
        original["items"][0]["id"]
    );

    *response.lock().unwrap() =
        json!([{"name":"All invalid","urls":["file:///private"]}]).to_string();
    let input = json!({"label":"Second source","url":"https://feeds.example/other.json"});
    assert_eq!(
        alice(&app, "POST", "/api/personal-sources", input.clone())
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (_, sources) = alice(&app, "GET", "/api/personal-sources", Value::Null).await;
    assert_eq!(sources.as_array().unwrap().len(), 1);
    let (_, diagnostics) = alice(&app, "POST", "/api/personal-sources", input.clone()).await;
    let mut confirmed = input;
    confirmed["snapshot_token"] = diagnostics["snapshot_token"].clone();
    confirmed["discard_invalid"] = json!(true);
    let (status, empty) = alice(&app, "POST", "/api/personal-sources", confirmed).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(empty["station_count"], 0);
}

#[tokio::test]
async fn import_capacity_is_per_application_and_permits_release_on_every_result() {
    let (_dir, state, app) = application().await;
    assert_eq!(state.source_import_slots.available_permits(), 2);
    let held = state
        .source_import_slots
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    for (path, body) in [
        (
            "/api/personal-sources",
            json!({"label":"Station","url":"rtmp://radio.example/live"}),
        ),
        (
            "/api/personal-sources/upload?label=Library",
            feed(&["Station"]),
        ),
        ("/api/personal-sources/missing/refresh", Value::Null),
    ] {
        let (status, error) = alice(&app, "POST", path, body).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{error}");
        assert_eq!(error["error"], "订阅导入繁忙，请稍后重试");
    }
    drop(held);
    for (path, body) in [
        (
            "/api/personal-sources",
            json!({"label":"Station","url":"file:///etc/passwd"}),
        ),
        (
            "/api/personal-sources/upload?label=Library",
            json!({"invalid":"feed"}),
        ),
        ("/api/personal-sources/missing/refresh", Value::Null),
    ] {
        assert!(alice(&app, "POST", path, body).await.0.is_client_error());
        assert_eq!(state.source_import_slots.available_permits(), 2);
    }
    let id = upload(&app, feed(&["Success"])).await;
    assert_eq!(state.source_import_slots.available_permits(), 2);
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!("/api/personal-sources/{id}/refresh"),
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(state.source_import_slots.available_permits(), 2);
    let (status, source) = alice(
        &app,
        "POST",
        "/api/personal-sources",
        json!({"label":"Direct","url":"rtmp://radio.example/live"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(state.source_import_slots.available_permits(), 2);
    let id = source["id"].as_str().unwrap();
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!("/api/personal-sources/{id}/refresh"),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(state.source_import_slots.available_permits(), 2);
}

#[tokio::test]
async fn stalled_upload_times_out_and_releases_import_permit() {
    use std::{convert::Infallible, sync::Arc, time::Duration};
    let (_dir, state, app) = application().await;
    let polled = Arc::new(tokio::sync::Notify::new());
    let signal = polled.clone();
    let pending_body = futures_util::stream::once(async move {
        signal.notify_one();
        std::future::pending::<Result<axum::body::Bytes, Infallible>>().await
    });
    let request = Request::builder()
        .method("POST")
        .uri("/api/personal-sources/upload?label=Slow")
        .header("x-meow-request", "1")
        .header("x-meow-owner", "1")
        .header("cookie", "meow_session=alice")
        .body(Body::from_stream(pending_body))
        .unwrap();
    let response = tokio::spawn(app.clone().oneshot(request));
    // Let authentication finish against real SQLite before pausing the clock.
    polled.notified().await;
    assert_eq!(state.source_import_slots.available_permits(), 1);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    let response = response.await.unwrap().unwrap();
    tokio::time::resume();
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    assert_eq!(state.source_import_slots.available_permits(), 2);
    assert_eq!(stations(&app).await["total"], 0);
    upload(&app, feed(&["After timeout"])).await;
    assert_eq!(state.source_import_slots.available_permits(), 2);
}

#[tokio::test]
async fn invalid_url_confirmation_keeps_backups_and_reports_only_failed_lines() {
    let (_dir, state, app) = application().await;
    let source_id = upload(&app, feed(&["Keep", "Gone"])).await;
    let original = stations(&app).await;
    let keep_id = original["items"][0]["id"].as_str().unwrap();
    let gone_id = original["items"][1]["id"].as_str().unwrap();
    for id in [keep_id, gone_id] {
        assert_eq!(
            alice(&app, "PUT", &format!("/api/favorites/{id}"), Value::Null)
                .await
                .0,
            StatusCode::OK
        );
    }
    let replacement = json!([
        {"name":"Keep","categories":[["Music"]],"urls":["https://radio.example/first","http://127.0.0.1/live",{"url":"https://radio.example/backup","headers":{"User-Agent":"Player"}}]},
        {"name":"Gone","urls":["file:///private"]},
        {"name":"Keep","categories":[["Talk"]],"urls":["https://radio.example/forbidden -headers \"Authorization: hidden-header-secret\""]},
        {"name":"Bad headers","urls":[{"url":"https://radio.example/bad-headers","headers":{"Cookie":"another-header-secret"}}]},
        {"name":"New","urls":["rtmp://radio.example/live"]}
    ]);
    let path = format!("/api/personal-sources/upload?label=Updated&source_id={source_id}");
    let (status, diagnostics) = alice(&app, "POST", &path, replacement.clone()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(diagnostics["error"], "发现无效播放地址");
    assert_eq!(diagnostics["valid_count"], 2);
    let invalid = diagnostics["invalid_records"].as_array().unwrap();
    assert_eq!(invalid.len(), 4);
    for (record, (name, index, line, url)) in invalid.iter().zip([
        ("Keep", 1, 2, "http://127.0.0.1/live"),
        ("Gone", 2, 1, "file:///private"),
        ("Keep", 3, 1, "https://radio.example/forbidden"),
        ("Bad headers", 4, 1, "https://radio.example/bad-headers"),
    ]) {
        assert_eq!(record["name"], name);
        assert_eq!(record["index"], index);
        assert_eq!(record["line"], line);
        assert_eq!(record["url"], url);
        assert!(!record["reason"].as_str().unwrap().is_empty());
    }
    for sensitive in [
        "hidden-header-secret",
        "another-header-secret",
        "radio.example/first",
        "radio.example/backup",
    ] {
        assert!(!diagnostics.to_string().contains(sensitive));
    }
    assert_eq!(stations(&app).await, original);
    assert_eq!(state.source_import_slots.available_permits(), 2);
    let (status, updated) = alice(
        &app,
        "POST",
        &format!(
            "{path}&discard_invalid=true&snapshot_token={}",
            diagnostics["snapshot_token"].as_str().unwrap()
        ),
        replacement,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["station_count"], 2);
    let stations = stations(&app).await;
    assert_eq!(stations["items"][0]["id"], keep_id);
    assert_eq!(stations["items"][0]["tags"], "Music, Talk");
    let urls = meowradio::personal_sources::candidates(&state, 1, keep_id)
        .await
        .unwrap_or_else(|e| panic!("{}", e.1));
    assert_eq!(
        urls.iter().map(|c| c.url.as_str()).collect::<Vec<_>>(),
        vec![
            "https://radio.example/first",
            "https://radio.example/backup"
        ]
    );
    let (_, favorites) = alice(&app, "GET", "/api/favorites", Value::Null).await;
    assert_eq!(favorites.as_array().unwrap().len(), 1);
    assert_eq!(favorites[0]["id"], keep_id);
    assert_eq!(favorites[0]["source_name"], "Updated");

    let invalid_schema = json!([{"name":"","urls":["file:///private"]}]);
    assert_eq!(
        alice(
            &app,
            "POST",
            &format!("{path}&discard_invalid=true"),
            invalid_schema
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let all_bad = json!([{"name":"Keep","urls":["file:///private"]}]);
    let (_, diagnostics) = alice(&app, "POST", &path, all_bad.clone()).await;
    let (status, empty) = alice(
        &app,
        "POST",
        &format!(
            "{path}&discard_invalid=true&snapshot_token={}",
            diagnostics["snapshot_token"].as_str().unwrap()
        ),
        all_bad,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["station_count"], 0);
    assert_eq!(
        alice(&app, "GET", "/api/favorites", Value::Null).await.1,
        json!([])
    );
}
