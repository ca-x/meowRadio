use axum::{
    Router,
    body::{Body, Bytes},
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use meowradio::{
    AppState,
    auth::{self, User},
    config::Config,
    recordings::{MAX_UPLOAD_BYTES, USER_QUOTA_BYTES},
};
use serde_json::{Value, json};
use tower::ServiceExt;

const QUERY: &str = "/api/recordings?title=Evening%20Jazz&station_id=12345678-1234-1234-1234-123456789abc&station_name=Jazz&duration_seconds=12.5";
fn sample() -> Vec<u8> {
    let mut bytes = vec![0x1a, 0x45, 0xdf, 0xa3];
    bytes.extend((0..20000).map(|i| (i % 256) as u8));
    bytes
}
async fn fixture() -> (tempfile::TempDir, AppState, Router, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = meowradio::state(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("test.db"),
        catalog_url: None,
        proxy: None,
        secure_cookie: false,
        registration: true,
        relay: true,
    })
    .await
    .unwrap();
    let mut cookies = Vec::new();
    for name in ["alice", "bob"] {
        let id = sqlx::query("INSERT INTO users(username,password_hash) VALUES(?, 'unused')")
            .bind(name)
            .execute(&s.db)
            .await
            .unwrap()
            .last_insert_rowid();
        let (headers, _) = auth::create_session(
            &s,
            User {
                id,
                username: name.into(),
                role: "user".into(),
                nickname: None,
                avatar_url: None,
            },
        )
        .await
        .map_err(|e| e.1)
        .unwrap();
        cookies.push(headers["set-cookie"].to_str().unwrap().to_owned());
    }
    let app = meowradio::app(s.clone());
    (dir, s, app, cookies.remove(0), cookies.remove(0))
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    mime: &str,
    body: Body,
) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("cookie", cookie)
                .header("x-meow-request", "1")
                // The fixture's recorded samples belong to Alice (user ID 1).
                .header("x-meow-owner", "1")
                .header("content-type", mime)
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn upload(app: &Router, cookie: &str) -> Response {
    call(
        app,
        "POST",
        QUERY,
        cookie,
        "audio/webm;codecs=opus",
        Body::from(sample()),
    )
    .await
}
#[tokio::test]
async fn recordings_persist_stream_seek_rename_export_and_delete_privately() {
    let (dir, s, app, alice, bob) = fixture().await;
    let response = upload(&app, &alice).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    let saved = json_body(response).await;
    assert_eq!(saved["size_bytes"], sample().len());
    assert_eq!(saved["duration_seconds"], 12.5);
    assert!(saved["created_at"].as_i64().unwrap() > 0);
    assert_eq!(saved["mime_type"], "audio/webm");
    let id = saved["id"].as_str().unwrap();
    let item = format!("/api/recordings/{id}");
    let audio = format!("{item}/audio");
    let file = dir.path().join(format!("record/alice/{id}.webm"));
    assert_eq!(tokio::fs::read(&file).await.unwrap(), sample());
    assert_eq!(
        json_body(call(&app, "GET", "/api/recordings", &bob, "", Body::empty()).await).await,
        json!([])
    );
    for (method, path, body) in [
        ("GET", audio.clone(), Body::empty()),
        ("PATCH", item.clone(), Body::from(r#"{"title":"stolen"}"#)),
        ("DELETE", item.clone(), Body::empty()),
    ] {
        assert_eq!(
            call(&app, method, &path, &bob, "application/json", body)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        call(&app, "GET", &audio, "", "", Body::empty())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let restarted = meowradio::app(meowradio::state(s.config.clone()).await.unwrap());
    let list = json_body(
        call(
            &restarted,
            "GET",
            "/api/recordings",
            &alice,
            "",
            Body::empty(),
        )
        .await,
    )
    .await;
    assert_eq!(list, json!([saved]));
    for (range, expected, content_range) in [
        ("bytes=4-9", sample()[4..10].to_vec(), "bytes 4-9/20004"),
        (
            "bytes=-4",
            sample()[20000..].to_vec(),
            "bytes 20000-20003/20004",
        ),
        (
            "bytes=20000-",
            sample()[20000..].to_vec(),
            "bytes 20000-20003/20004",
        ),
    ] {
        let response = restarted
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&audio)
                    .header("cookie", &alice)
                    .header("range", range)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], content_range);
        assert_eq!(
            response.headers()["content-length"],
            expected.len().to_string()
        );
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            expected
        );
    }
    for range in [
        "bytes=20004-",
        "bytes=2-1",
        "bytes=-0",
        "bytes=0-1,3-4",
        "nonsense",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&audio)
                    .header("cookie", &alice)
                    .header("range", range)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()["content-range"], "bytes */20004");
    }
    let response = call(
        &app,
        "PATCH",
        &item,
        &alice,
        "application/json",
        Body::from(json!({"title":"晚间 / ../../Jazz"}).to_string()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["title"], "晚间 / ../../Jazz");
    assert!(file.exists(), "renaming metadata must not rename files");
    let response = call(
        &app,
        "GET",
        &format!("{audio}?download=true"),
        &alice,
        "",
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(
        response.headers()["content-length"],
        sample().len().to_string()
    );
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        sample()
    );
    let static_path = format!("/record/alice/{id}.webm");
    assert_eq!(
        call(&app, "GET", &static_path, &alice, "", Body::empty())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "DELETE", &item, &alice, "", Body::empty())
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(!file.exists());
    assert_eq!(
        json_body(call(&app, "GET", "/api/recordings", &alice, "", Body::empty()).await).await,
        json!([])
    );
    assert_eq!(
        call(&app, "GET", &audio, &alice, "", Body::empty())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn uploads_validate_types_metadata_csrf_and_streamed_size_and_cleanup() {
    let (_dir, s, app, alice, _) = fixture().await;
    for (mime, bytes) in [
        ("text/html", b"<script>bad</script>".to_vec()),
        ("audio/webm", b"invalid".to_vec()),
        ("audio/ogg", sample()),
        ("audio/mp4", b"short".to_vec()),
        ("audio/webm", vec![]),
    ] {
        assert_eq!(
            call(&app, "POST", QUERY, &alice, mime, Body::from(bytes))
                .await
                .status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }
    for uri in [
        QUERY.replace("12.5", "NaN"),
        QUERY.replace("12.5", "3601"),
        QUERY.replace("12.5", "-1"),
        QUERY.replace("Evening%20Jazz", &"a".repeat(161)),
        QUERY.replace(
            "station_name=Jazz",
            &format!("station_name={}", "a".repeat(251)),
        ),
        QUERY.replace("12345678-1234-1234-1234-123456789abc", "..%2F..%2Fetc"),
        QUERY.replace("Evening%20Jazz", ""),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                &uri,
                &alice,
                "audio/webm",
                Body::from(sample())
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(QUERY)
                .header("cookie", &alice)
                .header("content-type", "audio/webm")
                .body(Body::from(sample()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for method in ["PATCH", "DELETE"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/api/recordings/12345678-1234-1234-1234-123456789abc")
                    .header("cookie", &alice)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert_eq!(
        call(&app, "POST", QUERY, "", "audio/webm", Body::from(sample()))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(QUERY)
                .header("cookie", &alice)
                .header("x-meow-request", "1")
                .header("content-type", "audio/webm")
                .header("content-length", MAX_UPLOAD_BYTES + 1)
                .header("x-meow-owner", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    // A chunked body has no Content-Length and must still hit the upload ceiling.
    let chunk = Bytes::from(vec![0u8; 1024 * 1024]);
    let stream =
        futures_util::stream::iter((0..101).map(move |_| Ok::<_, std::io::Error>(chunk.clone())));
    assert_eq!(
        call(
            &app,
            "POST",
            QUERY,
            &alice,
            "audio/webm",
            Body::from_stream(stream)
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let stream = futures_util::stream::iter(vec![
        Ok(Bytes::from(sample())),
        Err(std::io::Error::other("disconnected")),
    ]);
    assert_eq!(
        call(
            &app,
            "POST",
            QUERY,
            &alice,
            "audio/webm",
            Body::from_stream(stream)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        std::fs::read_dir(s.recordings_dir.join("alice"))
            .unwrap()
            .count(),
        0
    );
    let permit = s.recording_upload_slots.acquire_many(4).await.unwrap();
    assert_eq!(
        upload(&app, &alice).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(permit);
    // The normal JSON limit still applies to rename, and malformed route IDs never form paths.
    let saved = json_body(upload(&app, &alice).await).await;
    let uri = format!("/api/recordings/{}", saved["id"].as_str().unwrap());
    assert_eq!(
        call(
            &app,
            "PATCH",
            &uri,
            &alice,
            "application/json",
            Body::from(json!({"title":"a".repeat(9000)}).to_string())
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/recordings/..%2F..%2Fetc/audio",
            &alice,
            "",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn quota_uses_disk_bytes_and_serializes_competing_uploads() {
    let (_dir, s, app, alice, _) = fixture().await;
    let user_dir = s.recordings_dir.join("alice");
    tokio::fs::create_dir(&user_dir).await.unwrap();
    // Sparse file represents actual stored size without allocating a GiB in the test.
    let existing = tokio::fs::File::create(user_dir.join("orphan.webm"))
        .await
        .unwrap();
    existing
        .set_len(USER_QUOTA_BYTES - sample().len() as u64)
        .await
        .unwrap();
    let (a, b) = tokio::join!(upload(&app, &alice), upload(&app, &alice));
    assert!(matches!(
        (a.status(), b.status()),
        (StatusCode::CREATED, StatusCode::INSUFFICIENT_STORAGE)
            | (StatusCode::INSUFFICIENT_STORAGE, StatusCode::CREATED)
    ));
    assert_eq!(std::fs::read_dir(&user_dir).unwrap().count(), 2);
    assert_eq!(
        json_body(call(&app, "GET", "/api/recordings", &alice, "", Body::empty()).await)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[cfg(unix)]
#[tokio::test]
async fn symlink_directories_and_blobs_cannot_escape_private_storage() {
    let (dir, s, app, alice, _) = fixture().await;
    let external = dir.path().join("outside");
    std::fs::create_dir(&external).unwrap();
    let private = s.recordings_dir.join("alice");
    std::os::unix::fs::symlink(&external, &private).unwrap();
    assert_eq!(upload(&app, &alice).await.status(), StatusCode::BAD_REQUEST);
    std::fs::remove_file(&private).unwrap();
    let saved = json_body(upload(&app, &alice).await).await;
    let id = saved["id"].as_str().unwrap();
    let path = private.join(format!("{id}.webm"));
    std::fs::remove_file(&path).unwrap();
    let secret = external.join("secret");
    std::fs::write(&secret, b"secret").unwrap();
    std::os::unix::fs::symlink(&secret, &path).unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/recordings/{id}/audio"),
            &alice,
            "",
            Body::empty()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(std::fs::read(&secret).unwrap(), b"secret");
}

#[tokio::test]
async fn ogg_and_mp4_use_server_extensions_and_cancelled_uploads_are_removed() {
    use futures_util::StreamExt;
    let (_dir, s, app, alice, _) = fixture().await;
    for (mime, bytes, extension) in [
        ("audio/ogg; codecs=opus", b"OggS\0test".as_slice(), "ogg"),
        (
            "audio/mp4; codecs=mp4a.40.2",
            b"\0\0\0\x18ftypM4A \0\0\0\0".as_slice(),
            "m4a",
        ),
    ] {
        let response = call(&app, "POST", QUERY, &alice, mime, Body::from(bytes)).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let saved = json_body(response).await;
        let id = saved["id"].as_str().unwrap();
        assert!(
            s.recordings_dir
                .join("alice")
                .join(format!("{id}.{extension}"))
                .exists()
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/api/recordings/{id}"),
                &alice,
                "",
                Body::empty()
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
    }
    let user_dir = s.recordings_dir.join("alice");
    let stream =
        futures_util::stream::once(async { Ok::<_, std::io::Error>(Bytes::from(sample())) })
            .chain(futures_util::stream::pending());
    let task = tokio::spawn(async move {
        call(
            &app,
            "POST",
            QUERY,
            &alice,
            "audio/webm",
            Body::from_stream(stream),
        )
        .await
    });
    for _ in 0..100 {
        if std::fs::read_dir(&user_dir).unwrap().count() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(std::fs::read_dir(&user_dir).unwrap().count(), 1);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(std::fs::read_dir(&user_dir).unwrap().count(), 0);
    assert_eq!(s.recording_upload_slots.available_permits(), 4);
}

#[tokio::test]
async fn recording_uploads_bind_the_original_owner_before_writing_any_files() {
    let (_dir, s, app, alice, bob) = fixture().await;
    // A recording captured by Alice must not follow an ambient cookie switched to Bob.
    for (cookie, owner) in [
        (&bob, Some("1")),
        (&alice, None),
        (&alice, Some("invalid")),
        (&alice, Some("2")),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri(QUERY)
            .header("cookie", cookie)
            .header("x-meow-request", "1")
            .header("content-type", "audio/webm");
        if let Some(owner) = owner {
            request = request.header("x-meow-owner", owner);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(sample())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(response).await["error"],
            "登录账号已变化，请下载录音后重新登录。"
        );
    }
    assert_eq!(
        std::fs::read_dir(s.recordings_dir.as_path())
            .unwrap()
            .count(),
        0
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recordings")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(upload(&app, &alice).await.status(), StatusCode::CREATED);
}
