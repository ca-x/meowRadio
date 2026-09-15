pub mod auth;
pub mod catalog;
pub mod config;
pub mod error;
pub mod relay;
pub mod setup;
use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use config::Config;
use error::AppError;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Config,
    pub catalog: catalog::Catalog,
    pub dummy_hash: Arc<str>,
    pub relay_slots: Arc<Semaphore>,
    auth_attempts: Arc<Mutex<HashMap<IpAddr, (Instant, u32)>>>,
}
pub async fn state(config: Config) -> anyhow::Result<AppState> {
    if let Some(parent) = config
        .database
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    let opts = SqliteConnectOptions::new()
        .filename(&config.database)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let db = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!().run(&db).await?;
    let dummy = tokio::task::spawn_blocking(|| {
        Argon2::default()
            .hash_password(
                b"not-a-real-password",
                &SaltString::generate(&mut rand_core::OsRng),
            )
            .map(|h| h.to_string())
    })
    .await??;
    let catalog = catalog::Catalog::new(&config)?;
    Ok(AppState {
        db,
        catalog,
        config,
        dummy_hash: dummy.into(),
        relay_slots: Arc::new(Semaphore::new(32)),
        auth_attempts: Default::default(),
    })
}
async fn security(State(s): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) && request
        .headers()
        .get("x-meow-request")
        .and_then(|h| h.to_str().ok())
        != Some("1")
    {
        return AppError(StatusCode::FORBIDDEN, "请求校验失败，请刷新页面").into_response();
    }
    if matches!(
        path,
        "/api/auth/login" | "/api/auth/register" | "/api/setup"
    ) && request.method() == axum::http::Method::POST
    {
        let ip = request
            .extensions()
            .get::<ConnectInfo<std::net::SocketAddr>>()
            .map(|i| i.0.ip())
            .unwrap_or(IpAddr::from([127, 0, 0, 1]));
        let allowed = {
            let mut map = s.auth_attempts.lock().unwrap();
            map.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
            if map.len() >= 10000 && !map.contains_key(&ip) {
                false
            } else {
                let entry = map.entry(ip).or_insert((Instant::now(), 0));
                entry.1 += 1;
                entry.1 <= 12
            }
        };
        if !allowed {
            return AppError(
                StatusCode::TOO_MANY_REQUESTS,
                "尝试次数过多，请一分钟后重试",
            )
            .into_response();
        }
    }
    let mut response = next.run(request).await;
    for (key, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' https: http: blob:; connect-src 'self' https: http:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        ),
    ] {
        response
            .headers_mut()
            .insert(key, HeaderValue::from_static(value));
    }
    response
}
#[derive(rust_embed::RustEmbed)]
#[folder = "web/dist/"]
struct Assets;
async fn frontend(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(asset) = Assets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (
                header::CONTENT_TYPE,
                mime_guess::from_path(path)
                    .first_or_octet_stream()
                    .to_string(),
            ),
            (
                header::CACHE_CONTROL,
                if path.starts_with("assets/") {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }
                .to_string(),
            ),
        ],
        asset.data.into_owned(),
    )
        .into_response()
}
async fn settings(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"proxy_configured":s.config.proxy.is_some(),"relay_enabled":s.config.relay,"registration_enabled":s.config.registration,"version":env!("CARGO_PKG_VERSION")}),
    )
}
async fn health(State(s): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    sqlx::query("SELECT 1").execute(&s.db).await?;
    Ok(Json(
        serde_json::json!({"status":"ok","version":env!("CARGO_PKG_VERSION")}),
    ))
}
pub fn app(s: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/settings", get(settings))
        .route("/setup", get(setup::status).post(setup::initialize))
        .route("/auth/me", get(auth::me))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/stations", get(catalog::search))
        .route("/stations/{id}/click", post(catalog::click))
        .route("/favorites", get(catalog::favorites))
        .route(
            "/favorites/{id}",
            put(catalog::save).delete(catalog::remove),
        )
        .route("/stream/{id}", get(relay::stream))
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));
    Router::new()
        .nest("/api", api)
        .fallback(get(frontend))
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::from_fn_with_state(s.clone(), security))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(s)
}
