use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use meowradio::{AppState, config::Config};
use serde_json::{Value, json};
use tower::ServiceExt;

const OLD: &str = "test-password-12345";
const NEW: &str = "replacement-password-67890";

async fn application() -> (tempfile::TempDir, AppState, Router) {
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("test.db"),
        catalog_url: Some("http://127.0.0.1:9".into()),
        proxy: None,
        secure_cookie: true,
        registration: true,
        relay: true,
    };
    let state = meowradio::state(config).await.unwrap();
    let app = meowradio::app(state.clone());
    (dir, state, app)
}
async fn raw(
    app: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    cookie: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-meow-request", "1");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    (
        status,
        headers,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
async fn json_request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let (status, headers, bytes) = raw(
        app,
        method,
        path,
        serde_json::to_vec(&body).unwrap(),
        cookie,
    )
    .await;
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers
            .get("set-cookie")
            .map(|v| v.to_str().unwrap().to_owned()),
    )
}
async fn account(app: &Router, path: &str, name: &str) -> (Value, String) {
    let (status, user, cookie) = json_request(
        app,
        "POST",
        path,
        json!({"username":name,"password":OLD}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    (user, cookie.unwrap())
}

#[tokio::test]
async fn profile_defaults_persistence_and_immutable_username() {
    let (_dir, state, app) = application().await;
    let (user, cookie) = account(&app, "/api/setup", "alice").await;
    assert!(user["nickname"].is_null());
    assert!(user["avatar_url"].is_null());
    let (other, other_cookie) = account(&app, "/api/auth/register", "bobby").await;
    assert!(other["nickname"].is_null());
    assert!(other["avatar_url"].is_null());
    let result = json_request(
        &app,
        "PATCH",
        "/api/profile",
        json!({"nickname":"  小猫 Alice  "}),
        Some(&cookie),
    )
    .await;
    assert_eq!(result.0, StatusCode::OK);
    assert_eq!(result.1["nickname"], "小猫 Alice");
    assert_eq!(result.1["username"], "alice");
    assert_eq!(
        json_request(
            &app,
            "PATCH",
            "/api/profile",
            json!({"nickname":"Alice","username":"bobby"}),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_request(
            &app,
            "PATCH",
            "/api/profile",
            json!({"nickname":"猫".repeat(61)}),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_request(
            &app,
            "PATCH",
            "/api/profile",
            json!({"nickname":"fake"}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(
        json_request(
            &app,
            "GET",
            "/api/auth/me",
            Value::Null,
            Some(&other_cookie)
        )
        .await
        .1["nickname"]
            .is_null()
    );
    let login = account(&app, "/api/auth/login", "alice").await;
    assert_eq!(login.0["nickname"], "小猫 Alice");
    let restored = meowradio::app(meowradio::state(state.config.clone()).await.unwrap());
    assert_eq!(
        json_request(&restored, "GET", "/api/auth/me", Value::Null, Some(&cookie))
            .await
            .1["nickname"],
        "小猫 Alice"
    );
    let cleared = json_request(
        &restored,
        "PATCH",
        "/api/profile",
        json!({"nickname":"  "}),
        Some(&cookie),
    )
    .await;
    assert_eq!(cleared.0, StatusCode::OK);
    assert!(cleared.1["nickname"].is_null());
}

fn png(color: [u8; 3], width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb(color));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}
#[tokio::test]
async fn avatars_validate_convert_replace_and_remain_private() {
    let (dir, _state, app) = application().await;
    let (_, cookie) = account(&app, "/api/setup", "alice").await;
    let (_, other_cookie) = account(&app, "/api/auth/register", "bobby").await;
    for bytes in [
        b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
        b"RIFFinvalidWEBP".to_vec(),
        png([1, 2, 3], 4097, 1),
    ] {
        assert_eq!(
            raw(&app, "POST", "/api/profile/avatar", bytes, Some(&cookie))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        raw(
            &app,
            "POST",
            "/api/profile/avatar",
            vec![0; 5 * 1024 * 1024 + 1],
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        raw(
            &app,
            "POST",
            "/api/profile/avatar",
            png([1, 2, 3], 1, 1),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let first = raw(
        &app,
        "POST",
        "/api/profile/avatar",
        png([255, 0, 0], 300, 100),
        Some(&cookie),
    )
    .await;
    assert_eq!(first.0, StatusCode::OK);
    let first_user: Value = serde_json::from_slice(&first.2).unwrap();
    let url = first_user["avatar_url"].as_str().unwrap();
    assert!(url.starts_with("/api/profile/avatar?v="));
    let avatar = raw(&app, "GET", url, vec![], Some(&cookie)).await;
    assert_eq!(avatar.0, StatusCode::OK);
    assert_eq!(avatar.1["content-type"], "image/webp");
    assert_eq!(avatar.1["cache-control"], "private, no-store");
    assert_eq!(avatar.1["x-content-type-options"], "nosniff");
    assert_eq!(
        image::guess_format(&avatar.2).unwrap(),
        image::ImageFormat::WebP
    );
    let decoded = image::load_from_memory(&avatar.2).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (256, 256));
    assert_eq!(
        raw(&app, "GET", url, vec![], None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        raw(&app, "GET", url, vec![], Some(&other_cookie)).await.0,
        StatusCode::NOT_FOUND
    );
    let second = raw(
        &app,
        "POST",
        "/api/profile/avatar",
        png([0, 0, 255], 128, 128),
        Some(&cookie),
    )
    .await;
    assert_eq!(second.0, StatusCode::OK);
    let second_user: Value = serde_json::from_slice(&second.2).unwrap();
    assert_ne!(first_user["avatar_url"], second_user["avatar_url"]);
    let files: Vec<_> = std::fs::read_dir(dir.path().join("avatar"))
        .unwrap()
        .collect();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].as_ref().unwrap().file_name(), "alice.webp");
    assert_ne!(
        avatar.2,
        std::fs::read(dir.path().join("avatar/alice.webp")).unwrap()
    );
    // A very narrow image must crop before scaling to avoid a huge intermediate.
    assert_eq!(
        raw(
            &app,
            "POST",
            "/api/profile/avatar",
            png([1, 2, 3], 1, 4096),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::OK
    );
    // All three supported source formats are decoded and re-encoded.
    for format in [image::ImageFormat::Jpeg, image::ImageFormat::WebP] {
        let mut source = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(8, 8, image::Rgb([20, 40, 60]))
            .write_to(&mut source, format)
            .unwrap();
        assert_eq!(
            raw(
                &app,
                "POST",
                "/api/profile/avatar",
                source.into_inner(),
                Some(&cookie)
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let deleted = json_request(
        &app,
        "DELETE",
        "/api/profile/avatar",
        Value::Null,
        Some(&cookie),
    )
    .await;
    assert_eq!(deleted.0, StatusCode::OK);
    assert!(deleted.1["avatar_url"].is_null());
    assert!(!dir.path().join("avatar/alice.webp").exists());
}

#[tokio::test]
async fn password_change_keeps_current_session_and_revokes_other_sessions() {
    let (_dir, _state, app) = application().await;
    let (_, cookie) = account(&app, "/api/setup", "alice").await;
    let (_, other_session) = account(&app, "/api/auth/login", "alice").await;
    let (_, other_user) = account(&app, "/api/auth/register", "bobby").await;
    let wrong = json_request(
        &app,
        "POST",
        "/api/profile/password",
        json!({"current_password":"wrong-password","new_password":NEW}),
        Some(&cookie),
    )
    .await;
    assert_eq!(wrong.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        json_request(
            &app,
            "POST",
            "/api/profile/password",
            json!({"current_password":OLD,"new_password":"short"}),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_request(
            &app,
            "POST",
            "/api/profile/password",
            json!({"current_password":OLD,"new_password":NEW}),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        json_request(&app, "GET", "/api/auth/me", Value::Null, Some(&cookie))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        json_request(
            &app,
            "GET",
            "/api/auth/me",
            Value::Null,
            Some(&other_session)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_request(&app, "GET", "/api/auth/me", Value::Null, Some(&other_user))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        json_request(
            &app,
            "POST",
            "/api/auth/login",
            json!({"username":"alice","password":OLD}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_request(
            &app,
            "POST",
            "/api/auth/login",
            json!({"username":"alice","password":NEW}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn concurrent_password_changes_allow_only_one_winner() {
    let (_dir, _state, app) = application().await;
    let (_, cookie) = account(&app, "/api/setup", "alice").await;
    let passwords = ["new-password-choice-one", "new-password-choice-two"];
    let (one, two) = tokio::join!(
        json_request(
            &app,
            "POST",
            "/api/profile/password",
            json!({"current_password":OLD,"new_password":passwords[0]}),
            Some(&cookie)
        ),
        json_request(
            &app,
            "POST",
            "/api/profile/password",
            json!({"current_password":OLD,"new_password":passwords[1]}),
            Some(&cookie)
        ),
    );
    let statuses = [one.0, two.0];
    assert_eq!(
        statuses
            .iter()
            .filter(|&&status| status == StatusCode::NO_CONTENT)
            .count(),
        1
    );
    for (index, status) in statuses.into_iter().enumerate() {
        if status != StatusCode::NO_CONTENT {
            assert!(matches!(
                status,
                StatusCode::CONFLICT | StatusCode::BAD_REQUEST
            ));
        }
        let login = json_request(
            &app,
            "POST",
            "/api/auth/login",
            json!({"username":"alice","password":passwords[index]}),
            None,
        )
        .await;
        assert_eq!(
            login.0,
            if status == StatusCode::NO_CONTENT {
                StatusCode::OK
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    assert_eq!(
        json_request(&app, "GET", "/api/auth/me", Value::Null, Some(&cookie))
            .await
            .0,
        StatusCode::OK
    );
}

#[cfg(unix)]
#[tokio::test]
async fn avatars_reject_symlink_directories_and_files() {
    use std::os::unix::fs::symlink;
    let (dir, _state, app) = application().await;
    let (_, cookie) = account(&app, "/api/setup", "alice").await;
    let outside = tempfile::tempdir().unwrap();
    let avatar_dir = dir.path().join("avatar");
    symlink(outside.path(), &avatar_dir).unwrap();
    assert_eq!(
        raw(
            &app,
            "POST",
            "/api/profile/avatar",
            png([1, 2, 3], 1, 1),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    std::fs::remove_file(&avatar_dir).unwrap();
    assert_eq!(
        raw(
            &app,
            "POST",
            "/api/profile/avatar",
            png([1, 2, 3], 1, 1),
            Some(&cookie)
        )
        .await
        .0,
        StatusCode::OK
    );
    let avatar_file = avatar_dir.join("alice.webp");
    std::fs::remove_file(&avatar_file).unwrap();
    let private = outside.path().join("private.txt");
    std::fs::write(&private, "private data").unwrap();
    symlink(&private, &avatar_file).unwrap();
    for method in ["GET", "POST", "DELETE"] {
        assert_eq!(
            raw(
                &app,
                method,
                "/api/profile/avatar",
                png([1, 2, 3], 1, 1),
                Some(&cookie)
            )
            .await
            .0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    assert_eq!(std::fs::read_to_string(private).unwrap(), "private data");
}

#[tokio::test]
async fn stale_profile_owner_does_not_mutate_another_logged_in_account() {
    let (_dir, state, app) = application().await;
    let (_alice, _) = account(&app, "/api/setup", "alice").await;
    let (bob, cookie) = account(&app, "/api/auth/register", "bobby").await;
    for (method, path, body) in [
        (
            "PATCH",
            "/api/profile",
            br#"{"nickname":"wrong account"}"#.to_vec(),
        ),
        ("POST", "/api/profile/avatar", vec![1, 2, 3]),
        (
            "POST",
            "/api/profile/password",
            format!(r#"{{"current_password":"{OLD}","new_password":"{NEW}"}}"#).into_bytes(),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("cookie", &cookie)
                    .header("x-meow-request", "1")
                    .header("x-meow-owner", "1")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
    let nickname: Option<String> = sqlx::query_scalar("SELECT nickname FROM users WHERE id=?")
        .bind(bob["id"].as_i64().unwrap())
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert!(nickname.is_none());
}
