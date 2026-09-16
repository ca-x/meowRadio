use crate::{
    AppState, auth,
    error::{AppError, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use image::{ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use std::{
    io::{Cursor, Write},
    path::PathBuf,
};
use tokio::sync::Semaphore;

pub const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;
// Keep decoding work and memory bounded even if several accounts upload at once.
static AVATAR_JOBS: Semaphore = Semaphore::const_new(2);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/profile", get(auth::me).patch(update))
        .route(
            "/profile/avatar",
            get(avatar).post(upload_avatar).delete(delete_avatar),
        )
        .route("/profile/password", post(change_password))
}

fn expected_user(headers: &HeaderMap, user: &auth::User) -> Result<()> {
    if let Some(owner) = headers.get("x-meow-owner")
        && owner
            .to_str()
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            != Some(user.id)
    {
        return Err(AppError(
            StatusCode::CONFLICT,
            "登录账号已变化，请重新登录后重试。",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileUpdate {
    nickname: String,
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ProfileUpdate>,
) -> Result<Json<auth::User>> {
    let user = auth::user(&state, &headers).await?;
    expected_user(&headers, &user)?;
    let nickname = input.nickname.trim();
    if nickname.chars().count() > 60 || nickname.chars().any(char::is_control) {
        return Err(AppError::bad("昵称不能超过 60 个字符或包含控制字符"));
    }
    sqlx::query("UPDATE users SET nickname=? WHERE id=?")
        .bind(if nickname.is_empty() {
            None
        } else {
            Some(nickname)
        })
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(auth::user(&state, &headers).await?))
}

async fn avatar_path(state: &AppState, user: &auth::User) -> Result<PathBuf> {
    // Usernames originate in auth validation, never from a filename/URL parameter.
    // Check again to safely handle legacy or manually imported database records.
    if !(3..=32).contains(&user.username.len())
        || !user
            .username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(storage_error());
    }
    let parent = state
        .config
        .database
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    let directory = parent.join("avatar");
    match tokio::fs::create_dir(&directory).await {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                    .await
                    .map_err(|_| storage_error())?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(storage_error()),
    }
    let metadata = tokio::fs::symlink_metadata(&directory)
        .await
        .map_err(|_| storage_error())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(storage_error());
    }
    let path = directory.join(format!("{}.webp", user.username));
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_AVATAR_BYTES as u64 =>
        {
            return Err(storage_error());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    Ok(path)
}
fn storage_error() -> AppError {
    AppError(StatusCode::INTERNAL_SERVER_ERROR, "头像保存失败，请重试")
}
fn invalid_image() -> AppError {
    AppError::bad("头像需为有效的 PNG、JPEG 或 WebP 图片，尺寸不能超过 4096 像素")
}
fn convert_avatar(bytes: &[u8]) -> Result<Vec<u8>> {
    let format = image::guess_format(bytes).map_err(|_| invalid_image())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(invalid_image());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut dimensions = ImageReader::with_format(Cursor::new(bytes), format);
    dimensions.limits(limits.clone());
    let (width, height) = dimensions.into_dimensions().map_err(|_| invalid_image())?;
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err(invalid_image());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| invalid_image())?;
    // Crop first: resizing a 1×4096 image to fill a square would otherwise
    // create a huge intermediate image despite the decoder's allocation limit.
    let side = width.min(height);
    let image = decoded
        .crop_imm((width - side) / 2, (height - side) / 2, side, side)
        .resize_exact(256, 256, image::imageops::FilterType::Lanczos3);
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::WebP)
        .map_err(|_| storage_error())?;
    Ok(output.into_inner())
}

pub async fn upload_avatar(
    State(state): State<AppState>,
    request: Request,
) -> Result<Json<auth::User>> {
    let headers = request.headers().clone();
    let user = auth::user(&state, &headers).await?;
    expected_user(&headers, &user)?;
    let permit = AVATAR_JOBS
        .try_acquire()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "头像处理繁忙，请稍后重试"))?;
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        to_bytes(request.into_body(), MAX_AVATAR_BYTES),
    )
    .await
    .map_err(|_| AppError(StatusCode::REQUEST_TIMEOUT, "头像上传超时，请重试"))?
    .map_err(|_| AppError(StatusCode::PAYLOAD_TOO_LARGE, "头像不能超过 5 MiB"))?;
    let path = avatar_path(&state, &user).await?;
    let temporary = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let output = convert_avatar(&bytes)?;
        let directory = path.parent().ok_or_else(storage_error)?;
        std::fs::create_dir_all(directory).map_err(|_| storage_error())?;
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| storage_error())?;
        file.write_all(&output).map_err(|_| storage_error())?;
        file.as_file().sync_all().map_err(|_| storage_error())?;
        Ok::<_, AppError>((file, path))
    })
    .await
    .map_err(|_| storage_error())??;
    // Acquire SQLite's write lock before the rename to serialize replacements and
    // revision updates across requests (and processes sharing this database).
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET avatar_revision=? WHERE id=?")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tokio::task::spawn_blocking(move || temporary.0.persist(temporary.1))
        .await
        .map_err(|_| storage_error())?
        .map_err(|_| storage_error())?;
    tx.commit().await?;
    Ok(Json(auth::user(&state, &headers).await?))
}

pub async fn avatar(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let user = auth::user(&state, &headers).await?;
    if user.avatar_url.is_none() {
        return Err(AppError(StatusCode::NOT_FOUND, "尚未设置头像"));
    }
    let bytes = tokio::fs::read(avatar_path(&state, &user).await?)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError(StatusCode::NOT_FOUND, "尚未设置头像")
            } else {
                storage_error()
            }
        })?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

pub async fn delete_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<auth::User>> {
    let user = auth::user(&state, &headers).await?;
    expected_user(&headers, &user)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET avatar_revision=NULL WHERE id=?")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    match tokio::fs::remove_file(avatar_path(&state, &user).await?).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    tx.commit().await?;
    Ok(Json(auth::user(&state, &headers).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasswordUpdate {
    current_password: String,
    new_password: String,
}
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PasswordUpdate>,
) -> Result<StatusCode> {
    let user = auth::user(&state, &headers).await?;
    expected_user(&headers, &user)?;
    if !(10..=128).contains(&input.new_password.len()) {
        return Err(AppError::bad("密码需为 10–128 字节"));
    }
    if input.current_password.len() > 128 {
        return Err(AppError::bad("当前密码不正确"));
    }
    let old_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let expected_hash = old_hash.clone();
    let new_hash = tokio::task::spawn_blocking(move || {
        let valid = PasswordHash::new(&old_hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(input.current_password.as_bytes(), &hash)
                .is_ok()
        });
        if !valid {
            return Err(AppError::bad("当前密码不正确"));
        }
        Argon2::default()
            .hash_password(
                input.new_password.as_bytes(),
                &SaltString::generate(&mut rand_core::OsRng),
            )
            .map(|hash| hash.to_string())
            .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "密码修改失败，请重试"))
    })
    .await
    .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "密码修改失败，请重试"))??;
    let current_session =
        auth::token_hash(auth::token(&headers).ok_or_else(AppError::unauthorized)?);
    let mut tx = state.db.begin().await?;
    let updated = sqlx::query("UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>unixepoch())")
        .bind(new_hash).bind(user.id).bind(expected_hash).bind(&current_session).bind(user.id)
        .execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "账号状态已变化，请重新登录后重试",
        ));
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
        .bind(user.id)
        .bind(current_session)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
