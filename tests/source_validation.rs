use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use meowradio::{
    AppState,
    config::Config,
    error::{AppError, Result},
    media::Capabilities,
    source_types::Candidate,
    source_validation::{CandidateValidator, ValidationService},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;
use tower::ServiceExt;

struct Validator {
    gate: Option<Arc<Semaphore>>,
    available: bool,
    calls: AtomicUsize,
    active: AtomicUsize,
    busy_once: bool,
}
impl Validator {
    fn normal() -> Self {
        Self {
            gate: None,
            available: true,
            calls: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            busy_once: false,
        }
    }
}
struct ActiveCall<'a>(&'a AtomicUsize);
impl Drop for ActiveCall<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl CandidateValidator for Validator {
    fn capabilities<'a>(&'a self, _: &'a AppState) -> BoxFuture<'a, Capabilities> {
        Box::pin(async {
            Capabilities {
                available: self.available,
                mp3: self.available,
                native_rtmp: self.available,
                rtsp: self.available,
                mmst: self.available,
                mmsh: self.available,
                hls_extension_picky: false,
            }
        })
    }
    fn validate<'a>(
        &'a self,
        _: &'a AppState,
        _: i64,
        _: &'a str,
        candidate: &'a Candidate,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            self.active.fetch_add(1, Ordering::SeqCst);
            let _active = ActiveCall(&self.active);
            if self.busy_once && call == 0 {
                return Err(AppError(StatusCode::TOO_MANY_REQUESTS, "繁忙"));
            }
            if let Some(gate) = &self.gate {
                gate.acquire().await.unwrap().forget();
            }
            if candidate.url.contains("bad") {
                Err(AppError::upstream())
            } else {
                Ok(())
            }
        })
    }
}
async fn application(validator: Arc<Validator>) -> (tempfile::TempDir, AppState, Router) {
    let dir = tempfile::tempdir().unwrap();
    let mut state = meowradio::state(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("validation.db"),
        catalog_url: Some("http://127.0.0.1:9".into()),
        proxy: None,
        secure_cookie: false,
        registration: true,
        relay: true,
    })
    .await
    .unwrap();
    state.source_validation = Arc::new(ValidationService::with_validator(validator));
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
    sqlx::query(
        "INSERT INTO personal_sources(id,user_id,label,kind) VALUES('source',1,'Library','file')",
    )
    .execute(&state.db)
    .await
    .unwrap();
    let app = meowradio::app(state.clone());
    (dir, state, app)
}
async fn station(state: &AppState, id: &str, urls: &[&str]) {
    let candidates: Vec<Candidate> = urls
        .iter()
        .map(|url| Candidate {
            url: format!("https://radio.example/{url}"),
            headers: Default::default(),
        })
        .collect();
    sqlx::query("INSERT INTO personal_stations(id,user_id,source_id,name,categories_json,candidates_json,position) VALUES(?,1,'source',?,'[]',?,0)").bind(id).bind(id).bind(serde_json::to_string(&candidates).unwrap()).execute(&state.db).await.unwrap();
    sqlx::query("INSERT INTO favorites(user_id,station_id,station_json,personal_station_id) VALUES(1,?,'{}',?)").bind(id).bind(id).execute(&state.db).await.unwrap();
}
async fn request(
    app: &Router,
    method: &str,
    suffix: &str,
    user: Option<(&str, &str)>,
    value: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api/personal-sources/source/validation{suffix}"))
        .header("x-meow-request", "1")
        .header("content-type", "application/json");
    if let Some((cookie, owner)) = user {
        request = request
            .header("cookie", format!("meow_session={cookie}"))
            .header("x-meow-owner", owner);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn alice(app: &Router, method: &str, suffix: &str, value: Value) -> (StatusCode, Value) {
    request(app, method, suffix, Some(("alice", "1")), value).await
}
async fn completed(app: &Router) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (status, job) = alice(app, "GET", "", Value::Null).await;
            assert_eq!(status, StatusCode::OK);
            if job["status"] != "running" {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
async fn count(state: &AppState, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn owner_isolation_and_confirmation_guard() {
    let (_dir, state, app) = application(Arc::new(Validator::normal())).await;
    station(&state, "A", &["bad"]).await;
    for method in ["GET", "POST", "DELETE"] {
        assert_eq!(
            request(&app, method, "", None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, method, "", Some(("bob", "2")), Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    for method in ["POST", "DELETE"] {
        assert_eq!(
            request(&app, method, "", Some(("alice", "2")), Value::Null)
                .await
                .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        alice(&app, "POST", "", Value::Null).await.0,
        StatusCode::ACCEPTED
    );
    let job = completed(&app).await;
    let body = json!({"job_id":job["id"],"keys":[job["failures"][0]["key"]]});
    assert_eq!(
        request(&app, "POST", "/clear", Some(("bob", "2")), body.clone())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, "POST", "/clear", Some(("alice", "2")), body)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        alice(
            &app,
            "POST",
            "/clear",
            json!({"job_id":job["id"],"keys":["forged"]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(count(&state, "personal_stations").await, 1);
}

#[tokio::test]
async fn progress_and_cancel_do_not_delete_or_publish_partial_failure_list() {
    let gate = Arc::new(Semaphore::new(0));
    let validator = Arc::new(Validator {
        gate: Some(gate.clone()),
        ..Validator::normal()
    });
    let (_dir, state, app) = application(validator.clone()).await;
    station(&state, "A", &["bad", "good"]).await;
    let (status, job) = alice(&app, "POST", "", Value::Null).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(job["total"], 2);
    assert_eq!(
        alice(&app, "POST", "", Value::Null).await.0,
        StatusCode::CONFLICT
    );
    gate.add_permits(1);
    tokio::time::timeout(Duration::from_secs(2), async {
        while validator.calls.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let (_, progress) = alice(&app, "GET", "", Value::Null).await;
    assert_eq!(progress["checked"], 1);
    assert_eq!(progress["failed_count"], 1);
    assert!(progress.get("failures").is_none());
    let (status, cancelled) = alice(
        &app,
        "DELETE",
        &format!("?job_id={}", job["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled["status"], "cancelled");
    tokio::time::timeout(Duration::from_secs(2), async {
        while validator.active.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        alice(
            &app,
            "POST",
            "/clear",
            json!({"job_id":job["id"],"keys":[]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(count(&state, "personal_stations").await, 1);
    assert_eq!(count(&state, "favorites").await, 1);
}

#[tokio::test]
async fn all_failed_addresses_are_reported_without_automatic_deletion() {
    let (_dir, state, app) = application(Arc::new(Validator::normal())).await;
    station(&state, "A", &["good-b", "bad-c", "bad-d"]).await;
    assert_eq!(
        alice(&app, "POST", "", Value::Null).await.0,
        StatusCode::ACCEPTED
    );
    let job = completed(&app).await;
    assert_eq!(job["status"], "complete");
    assert_eq!(job["checked"], 3);
    assert_eq!(job["failed_count"], 2);
    let failures = job["failures"].as_array().unwrap();
    assert_eq!(failures.len(), 2);
    assert_eq!(failures[0]["line"], 2);
    assert_eq!(failures[1]["line"], 3);
    assert_eq!(failures[0]["url"], "https://radio.example/bad-c");
    assert!(
        failures
            .iter()
            .all(|failure| failure.get("headers").is_none())
    );
    assert_eq!(
        meowradio::personal_sources::candidates(&state, 1, "A")
            .await
            .ok()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(count(&state, "favorites").await, 1);
}

#[tokio::test]
async fn clear_retains_good_line_and_favorite_cascades_empty_station_and_skips_changed_fingerprint()
{
    let (_dir, state, app) = application(Arc::new(Validator::normal())).await;
    station(&state, "A", &["good-b", "bad-c", "bad-d"]).await;
    station(&state, "B", &["bad-only"]).await;
    station(&state, "C", &["bad-replaced"]).await;
    alice(&app, "POST", "", Value::Null).await;
    let job = completed(&app).await;
    let fresh = json!([{"url":"https://radio.example/bad-replaced","headers":{"Referer":"https://new.example/"}}]);
    sqlx::query("UPDATE personal_stations SET candidates_json=? WHERE id='C'")
        .bind(fresh.to_string())
        .execute(&state.db)
        .await
        .unwrap();
    let keys: Vec<_> = job["failures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|failure| failure["key"].clone())
        .collect();
    let body = json!({"job_id":job["id"],"keys":keys});
    let (status, result) = alice(&app, "POST", "/clear", body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result,
        json!({"removed_lines":3,"removed_stations":1,"skipped_lines":1})
    );
    let remaining = meowradio::personal_sources::candidates(&state, 1, "A")
        .await
        .ok()
        .unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].url, "https://radio.example/good-b");
    assert_eq!(count(&state, "personal_stations").await, 2);
    assert_eq!(count(&state, "favorites").await, 2);
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT personal_station_id FROM favorites ORDER BY personal_station_id",
    )
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(ids, ["A", "C"]);
    let (_, repeated) = alice(&app, "POST", "/clear", body).await;
    assert_eq!(repeated["removed_lines"], 0);
    assert_eq!(repeated["skipped_lines"], 4);
}

#[tokio::test]
async fn missing_server_capabilities_block_validation_without_marking_sources_invalid() {
    let validator = Arc::new(Validator {
        available: false,
        ..Validator::normal()
    });
    let (_dir, state, app) = application(validator.clone()).await;
    station(&state, "A", &["bad"]).await;
    alice(&app, "POST", "", Value::Null).await;
    let job = completed(&app).await;
    assert_eq!(job["status"], "blocked");
    assert_eq!(job["checked"], 0);
    assert_eq!(job["failed_count"], 0);
    assert!(job.get("failures").is_none());
    assert_eq!(validator.calls.load(Ordering::SeqCst), 0);
    assert_eq!(count(&state, "personal_stations").await, 1);
}

#[tokio::test]
async fn busy_media_pipeline_retries_without_false_failure() {
    let validator = Arc::new(Validator {
        busy_once: true,
        ..Validator::normal()
    });
    let (_dir, state, app) = application(validator.clone()).await;
    station(&state, "A", &["good"]).await;
    alice(&app, "POST", "", Value::Null).await;
    let job = completed(&app).await;
    assert_eq!(job["status"], "complete");
    assert_eq!(job["checked"], 1);
    assert_eq!(job["failed_count"], 0);
    assert_eq!(validator.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn slow_line_times_out_but_remaining_lines_are_still_checked() {
    let gate = Arc::new(Semaphore::new(0));
    let validator = Arc::new(Validator {
        gate: Some(gate.clone()),
        ..Validator::normal()
    });
    let (_dir, state, app) = application(validator.clone()).await;
    station(&state, "A", &["slow", "good"]).await;
    alice(&app, "POST", "", Value::Null).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while validator.calls.load(Ordering::SeqCst) < 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(66)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    gate.add_permits(1);
    let job = completed(&app).await;
    assert_eq!(job["status"], "complete");
    assert_eq!(job["checked"], 2);
    assert_eq!(job["failed_count"], 1);
    assert!(
        job["failures"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("暂时不可用")
    );
    assert_eq!(job["failures"][0]["line"], 1);
    assert_eq!(count(&state, "personal_stations").await, 1);
}

#[tokio::test]
async fn stale_or_missing_job_id_cannot_cancel_new_validation() {
    let gate = Arc::new(Semaphore::new(0));
    let validator = Arc::new(Validator {
        gate: Some(gate.clone()),
        ..Validator::normal()
    });
    let (_dir, state, app) = application(validator.clone()).await;
    station(&state, "A", &["good"]).await;
    let (_, old) = alice(&app, "POST", "", Value::Null).await;
    gate.add_permits(1);
    assert_eq!(completed(&app).await["status"], "complete");
    let (status, new) = alice(&app, "POST", "", Value::Null).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_ne!(old["id"], new["id"]);
    for suffix in [
        String::new(),
        format!("?job_id={}", old["id"].as_str().unwrap()),
    ] {
        assert_eq!(
            alice(&app, "DELETE", &suffix, Value::Null).await.0,
            StatusCode::CONFLICT
        );
        let (_, current) = alice(&app, "GET", "", Value::Null).await;
        assert_eq!(current["id"], new["id"]);
        assert_eq!(current["status"], "running");
    }
    let (status, cancelled) = alice(
        &app,
        "DELETE",
        &format!("?job_id={}", new["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(count(&state, "personal_stations").await, 1);
    assert_eq!(count(&state, "favorites").await, 1);
}
