use crate::{
    AppState,
    auth::{self, Credentials, User},
    error::{AppError, Result},
};
use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};

pub async fn is_initialized(s: &AppState) -> Result<bool> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM installation")
            .fetch_one(&s.db)
            .await?
            != 0,
    )
}
pub async fn status(State(s): State<AppState>) -> Result<Json<serde_json::Value>> {
    Ok(Json(
        serde_json::json!({"initialized":is_initialized(&s).await?}),
    ))
}
async fn create(s: &AppState, mut c: Credentials) -> Result<User> {
    c.username = c.username.trim().to_lowercase();
    auth::validate(&c)?;
    let password = c.password;
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(
                password.as_bytes(),
                &SaltString::generate(&mut rand_core::OsRng),
            )
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| AppError::upstream())?
    .map_err(|_| AppError::upstream())?;
    // The first operation is a write: SQLite serializes contenders, with no read→write upgrade race.
    let mut tx = s.db.begin().await?;
    let claim = sqlx::query("INSERT INTO installation(id) VALUES(1) ON CONFLICT DO NOTHING")
        .execute(&mut *tx)
        .await?;
    if claim.rows_affected() == 0 {
        return Err(AppError(StatusCode::CONFLICT, "服务已经初始化，请登录"));
    }
    let id = sqlx::query("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')")
        .bind(&c.username)
        .bind(hash)
        .execute(&mut *tx)
        .await?
        .last_insert_rowid();
    tx.commit().await?;
    Ok(User {
        id,
        username: c.username,
        role: "admin".into(),
        nickname: None,
        avatar_url: None,
    })
}
pub async fn initialize(
    State(s): State<AppState>,
    Json(c): Json<Credentials>,
) -> Result<(HeaderMap, Json<User>)> {
    if is_initialized(&s).await? {
        return Err(AppError(StatusCode::CONFLICT, "服务已经初始化，请登录"));
    }
    let u = create(&s, c).await?;
    auth::create_session(&s, u).await
}
pub async fn from_env(s: &AppState) -> anyhow::Result<()> {
    if is_initialized(s).await.map_err(|e| anyhow::anyhow!(e.1))? {
        return Ok(());
    }
    let username = std::env::var("MEOW_INIT_USERNAME").ok();
    let password = std::env::var("MEOW_INIT_PASSWORD").ok();
    match (username, password) {
        (None, None) => {
            tracing::info!("Open the web setup wizard to create the first administrator")
        }
        (Some(username), Some(password)) => {
            create(s, Credentials { username, password })
                .await
                .map_err(|e| anyhow::anyhow!(e.1))?;
            tracing::info!("Administrator initialized from environment");
        }
        _ => anyhow::bail!(
            "Set both MEOW_INIT_USERNAME and MEOW_INIT_PASSWORD, or neither to use the wizard"
        ),
    }
    Ok(())
}
