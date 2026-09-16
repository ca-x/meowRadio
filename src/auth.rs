use crate::{
    AppState,
    error::{AppError, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub nickname: Option<String>,
    pub avatar_url: Option<String>,
}
#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
pub(crate) fn token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|s| s.trim().strip_prefix("meow_session="))
}
pub async fn user(state: &AppState, headers: &HeaderMap) -> Result<User> {
    let hash = token_hash(token(headers).ok_or_else(AppError::unauthorized)?);
    sqlx::query_as::<_,User>("SELECT u.id, u.username, u.role, u.nickname, CASE WHEN u.avatar_revision IS NOT NULL THEN '/api/profile/avatar?v=' || u.avatar_revision END AS avatar_url FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>unixepoch()")
        .bind(hash).fetch_optional(&state.db).await?.ok_or_else(AppError::unauthorized)
}
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<User>> {
    Ok(Json(user(&state, &headers).await?))
}

pub async fn create_session(state: &AppState, u: User) -> Result<(HeaderMap, Json<User>)> {
    create_session_checked(state, u, None).await
}
async fn create_session_checked(
    state: &AppState,
    u: User,
    expected_password_hash: Option<&str>,
) -> Result<(HeaderMap, Json<User>)> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at <= unixepoch()")
        .execute(&mut *tx)
        .await?;
    // Check the verified password again under the SQLite write lock so a login
    // racing a password change cannot create a session from the old password.
    let inserted = sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) SELECT ?,id,unixepoch()+2592000 FROM users WHERE id=? AND (? IS NULL OR password_hash=?)",
    )
    .bind(token_hash(&token))
    .bind(u.id)
    .bind(expected_password_hash)
    .bind(expected_password_hash)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() != 1 {
        return Err(AppError(StatusCode::UNAUTHORIZED, "用户名或密码不正确"));
    }
    tx.commit().await?;
    let mut headers = HeaderMap::new();
    let secure = if state.config.secure_cookie {
        "; Secure"
    } else {
        ""
    };
    headers.insert(
        header::SET_COOKIE,
        format!("meow_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000{secure}")
            .parse()
            .unwrap(),
    );
    Ok((headers, Json(u)))
}
pub fn validate(c: &Credentials) -> Result<()> {
    if !(3..=32).contains(&c.username.len())
        || !c
            .username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(AppError::bad(
            "用户名需为 3–32 位字母、数字、下划线或短横线",
        ));
    }
    if !(10..=128).contains(&c.password.len()) {
        return Err(AppError::bad("密码需为 10–128 字节"));
    }
    Ok(())
}
pub async fn register(
    State(state): State<AppState>,
    Json(mut c): Json<Credentials>,
) -> Result<(HeaderMap, Json<User>)> {
    if !crate::setup::is_initialized(&state).await? {
        return Err(AppError(StatusCode::FORBIDDEN, "请先完成初始化"));
    }
    if !state.config.registration {
        return Err(AppError(StatusCode::FORBIDDEN, "此服务已关闭注册"));
    }
    c.username = c.username.trim().to_lowercase();
    validate(&c)?;
    let password = c.password;
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| AppError::upstream())?
    .map_err(|_| AppError::upstream())?;
    let result = sqlx::query("INSERT INTO users(username,password_hash) VALUES(?,?)")
        .bind(&c.username)
        .bind(hash)
        .execute(&state.db)
        .await;
    let id = match result {
        Ok(r) => r.last_insert_rowid(),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError(StatusCode::CONFLICT, "用户名已被使用"));
        }
        Err(e) => return Err(e.into()),
    };
    create_session(
        &state,
        User {
            id,
            username: c.username,
            role: "user".into(),
            nickname: None,
            avatar_url: None,
        },
    )
    .await
}
pub async fn login(
    State(state): State<AppState>,
    Json(mut c): Json<Credentials>,
) -> Result<(HeaderMap, Json<User>)> {
    c.username = c.username.trim().to_lowercase();
    validate(&c)?;
    let row = sqlx::query_as::<_, (i64, String, String, String, Option<String>, Option<String>)>(
        "SELECT id,username,password_hash,role,nickname,CASE WHEN avatar_revision IS NOT NULL THEN '/api/profile/avatar?v=' || avatar_revision END FROM users WHERE username=?",
    )
    .bind(&c.username)
    .fetch_optional(&state.db)
    .await?;
    // A fixed valid dummy hash equalizes the expensive path for unknown accounts.
    let hash = row
        .as_ref()
        .map(|r| r.2.clone())
        .unwrap_or_else(|| state.dummy_hash.to_string());
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|h| {
            Argon2::default()
                .verify_password(c.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| AppError::upstream())?;
    if !valid {
        return Err(AppError(StatusCode::UNAUTHORIZED, "用户名或密码不正确"));
    }
    let (id, username, password_hash, role, nickname, avatar_url) =
        row.ok_or(AppError(StatusCode::UNAUTHORIZED, "用户名或密码不正确"))?;
    create_session_checked(
        &state,
        User {
            id,
            username,
            role,
            nickname,
            avatar_url,
        },
        Some(&password_hash),
    )
    .await
}
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<HeaderMap> {
    if let Some(t) = token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?")
            .bind(token_hash(t))
            .execute(&state.db)
            .await?;
    }
    let mut result = HeaderMap::new();
    let secure = if state.config.secure_cookie {
        "; Secure"
    } else {
        ""
    };
    result.insert(
        header::SET_COOKIE,
        format!("meow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}")
            .parse()
            .unwrap(),
    );
    Ok(result)
}
