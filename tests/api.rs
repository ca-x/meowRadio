use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use meowradio::{AppState, config::Config};
use serde_json::{Value, json};
use tower::ServiceExt;

const STATION: &str = "12345678-1234-1234-1234-123456789abc";
fn fixture() -> Value {
    json!({"stationuuid":STATION,"changeuuid":STATION,"name":"Test Jazz","url":"http://127.0.0.1:8000/private","url_resolved":"http://127.0.0.1:8000/private","homepage":"","favicon":"","tags":"jazz","country":"Test","countrycode":"US","state":"","language":"English","votes":10,"codec":"MP3","bitrate":128,"hls":0,"lastcheckok":1,"clickcount":10,"clicktrend":1})
}
async fn application() -> (tempfile::TempDir, AppState, Router) {
    let mock = Router::new().fallback(axum::routing::post(|| async {
        axum::Json(json!([fixture()]))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("test.db"),
        catalog_url: Some(format!("http://{addr}")),
        proxy: None,
        secure_cookie: true,
        registration: true,
        relay: true,
    };
    let state = meowradio::state(config).await.unwrap();
    let app = meowradio::app(state.clone());
    (dir, state, app)
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-meow-request", "1");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let code = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        code,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}
fn credentials(name: &str) -> Value {
    json!({"username":name,"password":"test-password-12345"})
}
#[tokio::test]
async fn setup_auth_and_private_favorites_survive_restart() {
    let (_dir, s, app) = application().await;
    assert_eq!(
        request(&app, "GET", "/api/setup", Value::Null, None)
            .await
            .1["initialized"],
        false
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/auth/register",
            credentials("alice"),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (code, u, alice) = request(&app, "POST", "/api/setup", credentials("alice"), None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(u["role"], "admin");
    let alice = alice.unwrap();
    for flag in ["HttpOnly", "SameSite=Strict", "Secure"] {
        assert!(alice.contains(flag));
    }
    assert_eq!(
        request(&app, "POST", "/api/setup", credentials("secondadmin"), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, u, bob) = request(&app, "POST", "/api/auth/register", credentials("bob"), None).await;
    assert_eq!(u["role"], "user");
    let bob = bob.unwrap();
    assert_eq!(
        request(&app, "POST", "/api/auth/register", credentials("BOB"), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE username='alice'")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert_eq!(
        request(
            &app,
            "PUT",
            &format!("/api/favorites/{STATION}"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for _ in 0..2 {
        assert_eq!(
            request(
                &app,
                "PUT",
                &format!("/api/favorites/{STATION}"),
                Value::Null,
                Some(&alice)
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        request(&app, "GET", "/api/favorites", Value::Null, Some(&alice))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        request(&app, "GET", "/api/favorites", Value::Null, Some(&bob))
            .await
            .1,
        json!([])
    );
    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/api/favorites/{STATION}"),
            Value::Null,
            Some(&bob)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    // A new state/pool models a restart; user sessions and favorites remain valid.
    let restarted = meowradio::app(meowradio::state(s.config.clone()).await.unwrap());
    assert_eq!(
        request(
            &restarted,
            "GET",
            "/api/favorites",
            Value::Null,
            Some(&alice)
        )
        .await
        .1[0]["name"],
        "Test Jazz"
    );
    let mut wrong = credentials("alice");
    wrong["password"] = json!("wrong-password-123");
    assert_eq!(
        request(&app, "POST", "/api/auth/login", wrong, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "POST", "/api/auth/login", credentials("ALICE"), None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "POST", "/api/auth/logout", Value::Null, Some(&alice))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/api/auth/me", Value::Null, Some(&alice))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE sessions SET expires_at=0")
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "GET", "/api/auth/me", Value::Null, Some(&bob))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn setup_race_has_one_winner() {
    let (_dir, s, app) = application().await;
    let (a, b) = tokio::join!(
        request(&app, "POST", "/api/setup", credentials("first"), None),
        request(&app, "POST", "/api/setup", credentials("second"), None)
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE role='admin'")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn csrf_rate_limit_validation_and_security_headers() {
    let (_dir, _s, app) = application().await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .body(Body::from(credentials("admin").to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/setup",
            json!({"username":"ab","password":"short"}),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for _ in 0..12 {
        let _ = request(
            &app,
            "POST",
            "/api/auth/login",
            credentials("unknown"),
            None,
        )
        .await;
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/auth/login",
            credentials("unknown"),
            None
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(response.headers().contains_key("content-security-policy"));
    assert_eq!(
        request(&app, "GET", "/api/stations?offset=10001", Value::Null, None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "GET", "/assets/missing.js", Value::Null, None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn catalog_uses_real_api_shape_and_relay_blocks_private_destinations() {
    let (_dir, _s, app) = application().await;
    let (code, stations, _) = request(&app, "GET", "/api/stations?q=jazz", Value::Null, None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(stations[0]["id"], STATION);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/stream/{STATION}"),
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, _, cookie) = request(&app, "POST", "/api/setup", credentials("admin"), None).await;
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/stream/{STATION}"),
            Value::Null,
            cookie.as_deref()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            "/api/favorites/not-a-uuid",
            Value::Null,
            cookie.as_deref()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
#[test]
fn relay_rejects_special_networks() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "100.64.1.1",
        "192.168.1.1",
        "198.18.0.1",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fc00::1",
        "fe80::1",
        "2001:db8::1",
        "2002:7f00:1::",
    ] {
        assert!(!meowradio::relay::public_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(meowradio::relay::public_ip(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn environment_initialization_is_one_time_and_requires_both_values() {
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("environment.db");
    let run = |username: Option<&str>, password: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_meowradio"));
        command
            .env("MEOW_DATABASE", &db)
            .env("MEOW_LISTEN", "127.0.0.1:0")
            .env_remove("MEOW_PROXY")
            .env_remove("MEOW_INIT_USERNAME")
            .env_remove("MEOW_INIT_PASSWORD")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(value) = username {
            command.env("MEOW_INIT_USERNAME", value);
        }
        if let Some(value) = password {
            command.env("MEOW_INIT_PASSWORD", value);
        }
        command.spawn().unwrap()
    };
    let mut invalid = run(Some("admin"), None);
    assert!(!invalid.wait().unwrap().success());
    let mut child = run(Some("admin"), Some("initial-password-12345"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let db = sqlx::SqlitePool::connect(&format!("sqlite:{}", db.display()))
            .await
            .unwrap();
        let mut found = false;
        for _ in 0..50 {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM installation")
                .fetch_one(&db)
                .await
                .unwrap();
            if count == 1 {
                found = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(found, "environment initialization did not complete");
        let original: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE username='admin'")
                .fetch_one(&db)
                .await
                .unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        // Even incomplete environment values are ignored once initialized.
        let mut restarted = run(Some("newadmin"), None);
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        assert!(restarted.try_wait().unwrap().is_none());
        let current: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE username='admin'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(original, current);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        restarted.kill().unwrap();
        restarted.wait().unwrap();
    });
}

#[tokio::test]
async fn configured_proxy_carries_catalog_requests_without_leaking_credentials() {
    let proxy = Router::new().fallback(axum::routing::post(
        |request: axum::extract::Request| async move {
            assert_eq!(request.uri().host(), Some("catalog.invalid"));
            assert_eq!(request.uri().path(), "/json/stations/search");
            axum::Json(json!([fixture()]))
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, proxy).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("proxy.db"),
        catalog_url: Some("http://catalog.invalid".into()),
        proxy: Some(format!("http://proxy-user:proxy-password@{address}")),
        secure_cookie: false,
        registration: true,
        relay: true,
    };
    let app = meowradio::app(meowradio::state(config).await.unwrap());
    let (code, stations, _) = request(&app, "GET", "/api/stations?q=jazz", Value::Null, None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(stations[0]["name"], "Test Jazz");
    let (_, settings, _) = request(&app, "GET", "/api/settings", Value::Null, None).await;
    assert_eq!(settings["proxy_configured"], true);
    assert!(!settings.to_string().contains("proxy-password"));
}
