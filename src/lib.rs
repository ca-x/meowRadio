pub mod auth;
pub mod catalog;
pub mod config;
pub mod directory;
pub mod error;
pub mod exploration;
pub mod favorites;
pub mod hls;
pub mod legacy_media;
pub mod media;
pub mod media_gateway;
pub mod outbound;
pub mod personal_sources;
pub mod profile;
pub mod proxy;
pub mod recordings;
pub mod relay;
pub mod setup;
pub mod source_resolver;
pub mod source_types;
pub mod source_validation;
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
    pub media: Arc<media::MediaService>,
    pub source_import_slots: Arc<Semaphore>,
    pub source_validation: Arc<source_validation::ValidationService>,
    pub recording_upload_slots: Arc<Semaphore>,
    pub recordings_dir: Arc<std::path::PathBuf>,
    pub outbound: Arc<dyn outbound::Transport>,
    pub(crate) hls_key: Arc<[u8; 32]>,
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
    let outbound = Arc::new(outbound::NetworkTransport::new(&config));
    let mut hls_key = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut hls_key);
    let recordings_dir = recordings::storage_root(&config).await?;
    Ok(AppState {
        db,
        catalog,
        outbound,
        hls_key: Arc::new(hls_key),
        config,
        dummy_hash: dummy.into(),
        relay_slots: Arc::new(Semaphore::new(32)),
        media: Arc::new(media::MediaService::new()),
        source_import_slots: Arc::new(Semaphore::new(2)),
        source_validation: Arc::new(source_validation::ValidationService::new()),
        recording_upload_slots: Arc::new(Semaphore::new(4)),
        recordings_dir: Arc::new(recordings_dir),
        auth_attempts: Default::default(),
    })
}
async fn security(State(s): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let private_recording = path == "/api/recordings"
        || path.starts_with("/api/recordings/")
        || path == "/api/profile"
        || path.starts_with("/api/profile/")
        || path.starts_with("/api/personal-sources")
        || path.starts_with("/api/personal-stations");
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
        "/api/auth/login"
            | "/api/auth/register"
            | "/api/setup"
            | "/api/proxy/test"
            | "/api/profile/password"
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
    if private_recording {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    }
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
    let path = if path.is_empty() || matches!(path.trim_end_matches('/'), "login" | "sources") {
        "index.html"
    } else {
        path
    };
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
        .route("/proxy/test", post(proxy::test))
        .route("/setup", get(setup::status).post(setup::initialize))
        .route("/auth/me", get(auth::me))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/stations", get(catalog::search))
        .route(
            "/stations/explore",
            get(exploration::get).layer(tower_http::compression::CompressionLayer::new()),
        )
        .route("/directory", get(directory::get))
        .route("/stations/{id}/click", post(catalog::click))
        .route(
            "/favorites",
            get(catalog::favorites).layer(tower_http::compression::CompressionLayer::new()),
        )
        .route(
            "/favorites/{id}",
            put(catalog::save).delete(catalog::remove),
        )
        .route("/stream/{id}", get(relay::stream))
        .merge(personal_sources::routes())
        .merge(source_validation::routes())
        .route("/personal-sources/capabilities", get(media_capabilities))
        .route("/personal-stations/{id}/stream", get(media::stream))
        .route("/personal-stations/{id}", get(personal_station))
        .merge(favorites::routes())
        .merge(recordings::routes())
        .merge(profile::routes())
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

async fn media_capabilities(
    State(s): State<AppState>,
    headers: axum::http::HeaderMap,
) -> error::Result<Json<media::Capabilities>> {
    auth::user(&s, &headers).await?;
    Ok(Json(s.media.probe().await))
}

async fn personal_station(
    State(s): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> error::Result<Json<catalog::Station>> {
    let user = auth::user(&s, &headers).await?;
    personal_sources::owned_station(&s, user.id, &id)
        .await?
        .map(Json)
        .ok_or(AppError(StatusCode::NOT_FOUND, "私人订阅或电台不存在"))
}
