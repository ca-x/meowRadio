//! Private audio blobs live outside the database; SQLite owns their user-scoped metadata.
use crate::{
    AppState, auth,
    config::Config,
    error::{AppError, Result},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path as FsPath, PathBuf},
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
};
use tokio_util::io::ReaderStream;

pub const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
pub const USER_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const COLUMNS: &str =
    "id,title,station_id,station_name,mime_type,size_bytes,duration_seconds,created_at";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/recordings",
            get(list).post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/recordings/{id}",
            axum::routing::patch(rename).delete(delete),
        )
        .route("/recordings/{id}/audio", get(audio))
}

pub async fn storage_root(config: &Config) -> anyhow::Result<PathBuf> {
    let root = std::env::var_os("MEOW_RECORDINGS_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            config
                .database
                .parent()
                .unwrap_or(FsPath::new("."))
                .join("record")
        });
    fs::create_dir_all(&root).await?;
    Ok(fs::canonicalize(root).await?)
}
fn io_error(error: std::io::Error) -> AppError {
    tracing::error!(%error, "recording storage operation failed");
    AppError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "录音文件操作失败，请重试",
    )
}
fn not_found() -> AppError {
    AppError(StatusCode::NOT_FOUND, "录音不存在")
}
fn unsupported() -> AppError {
    AppError(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "仅支持 WebM、Ogg 或 MP4 音频录音",
    )
}
fn too_large() -> AppError {
    AppError(StatusCode::PAYLOAD_TOO_LARGE, "单条录音不能超过 100 MiB")
}
fn valid_id(id: &str) -> Result<String> {
    uuid::Uuid::parse_str(id)
        .map(|v| v.to_string())
        .map_err(|_| AppError::bad("录音编号无效"))
}
fn extension(mime: &str) -> Result<&'static str> {
    match mime {
        "audio/webm" => Ok("webm"),
        "audio/ogg" => Ok("ogg"),
        "audio/mp4" => Ok("m4a"),
        _ => Err(unsupported()),
    }
}
fn text_field(value: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(AppError::bad("录音名称或电台名称无效或过长"));
    }
    Ok(value.to_owned())
}
async fn user_dir(s: &AppState, username: &str) -> Result<PathBuf> {
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(AppError::bad("用户名无法用于录音存储"));
    }
    let path = s.recordings_dir.join(username);
    match fs::create_dir(&path).await {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                    .await
                    .map_err(io_error)?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(io_error(e)),
    }
    let meta = fs::symlink_metadata(&path).await.map_err(io_error)?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || fs::canonicalize(&path).await.map_err(io_error)?.parent()
            != Some(s.recordings_dir.as_path())
    {
        return Err(AppError::bad("录音存储目录无效"));
    }
    Ok(path)
}
fn blob_path(dir: &FsPath, recording: &Recording) -> Result<PathBuf> {
    Ok(dir.join(format!(
        "{}.{}",
        valid_id(&recording.id)?,
        extension(&recording.mime_type)?
    )))
}
async fn regular_file(path: &FsPath) -> Result<std::fs::Metadata> {
    let meta = fs::symlink_metadata(path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            not_found()
        } else {
            io_error(e)
        }
    })?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(not_found());
    }
    Ok(meta)
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Recording {
    pub id: String,
    pub title: String,
    pub station_id: String,
    pub station_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub duration_seconds: f64,
    /// Unix timestamp in seconds.
    pub created_at: i64,
}
async fn owned(s: &AppState, user_id: i64, id: &str) -> Result<Recording> {
    let id = valid_id(id)?;
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM recordings WHERE id=? AND user_id=?"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(not_found)
}
async fn list(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<Recording>>> {
    let u = auth::user(&s, &headers).await?;
    Ok(Json(
        sqlx::query_as(&format!(
            "SELECT {COLUMNS} FROM recordings WHERE user_id=? ORDER BY created_at DESC,id DESC"
        ))
        .bind(u.id)
        .fetch_all(&s.db)
        .await?,
    ))
}
#[derive(Deserialize)]
struct UploadQuery {
    title: String,
    station_id: String,
    station_name: String,
    duration_seconds: f64,
}
fn has_magic(mime: &str, prefix: &[u8]) -> bool {
    match mime {
        "audio/webm" => prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "audio/ogg" => prefix.starts_with(b"OggS"),
        "audio/mp4" => prefix.len() >= 12 && &prefix[4..8] == b"ftyp",
        _ => false,
    }
}
async fn upload(
    State(s): State<AppState>,
    Query(mut q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    let u = auth::user(&s, &headers).await?;
    if headers
        .get("x-meow-owner")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        != Some(u.id)
    {
        return Err(AppError(
            StatusCode::CONFLICT,
            "登录账号已变化，请下载录音后重新登录。",
        ));
    }
    q.title = text_field(&q.title, 160)?;
    q.station_name = text_field(&q.station_name, 250)?;
    q.station_id = valid_id(&q.station_id)?;
    if !q.duration_seconds.is_finite() || !(0.0..=3600.0).contains(&q.duration_seconds) {
        return Err(AppError::bad("录音时长必须在 0–3600 秒之间"));
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    extension(&mime)?;
    if let Some(length) = headers.get(header::CONTENT_LENGTH) {
        let length: u64 = length
            .to_str()
            .ok()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::bad("录音长度无效"))?;
        if length > MAX_UPLOAD_BYTES {
            return Err(too_large());
        }
    }
    let permit = s
        .recording_upload_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "录音上传繁忙，请稍后重试"))?;
    let dir = user_dir(&s, &u.username).await?;
    // TempPath removes incomplete uploads on every error and when the handler is cancelled.
    let temporary = tempfile::Builder::new()
        .prefix(".upload-")
        .tempfile_in(&dir)
        .map_err(io_error)?;
    let (file, temp_path) = temporary.into_parts();
    let mut file = fs::File::from_std(file);
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    let mut prefix = Vec::with_capacity(12);
    while let Some(chunk) = tokio::time::timeout(IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| AppError(StatusCode::REQUEST_TIMEOUT, "录音上传超时"))?
    {
        let chunk = chunk.map_err(|_| AppError::bad("录音上传中断"))?;
        size = size.checked_add(chunk.len() as u64).ok_or_else(too_large)?;
        if size > MAX_UPLOAD_BYTES {
            return Err(too_large());
        }
        prefix.extend_from_slice(&chunk[..chunk.len().min(12 - prefix.len())]);
        file.write_all(&chunk).await.map_err(io_error)?;
    }
    if !has_magic(&mime, &prefix) {
        return Err(unsupported());
    }
    file.flush().await.map_err(io_error)?;
    file.sync_all().await.map_err(io_error)?;
    drop(file);
    // Finish the filesystem/SQLite commit even if the client disconnects at this point.
    let saved = tokio::spawn(async move {
        let _permit = permit;
        let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await?;
        // Actual files (including leftovers from a process crash) count against quota.
        // In-flight .upload files are bounded separately by the upload semaphore.
        let mut total = 0u64;
        let mut files = fs::read_dir(&dir).await.map_err(io_error)?;
        while let Some(entry) = files.next_entry().await.map_err(io_error)? {
            if entry.file_name().to_string_lossy().starts_with(".upload-") { continue; }
            let meta = fs::symlink_metadata(entry.path()).await.map_err(io_error)?;
            if meta.file_type().is_symlink() || !meta.is_file() { return Err(AppError::bad("录音存储目录无效")); }
            total = total.saturating_add(meta.len());
        }
        if total.saturating_add(size) > USER_QUOTA_BYTES {
            return Err(AppError(StatusCode::INSUFFICIENT_STORAGE, "个人录音空间已达到 1 GiB，请先删除部分录音"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let recording: Recording = sqlx::query_as(&format!("INSERT INTO recordings(id,user_id,title,station_id,station_name,mime_type,size_bytes,duration_seconds) VALUES(?,?,?,?,?,?,?,?) RETURNING {COLUMNS}"))
            .bind(&id).bind(u.id).bind(q.title).bind(q.station_id).bind(q.station_name).bind(&mime).bind(size as i64).bind(q.duration_seconds)
            .fetch_one(&mut *tx).await?;
        let final_path = blob_path(&dir, &recording)?;
        temp_path.persist_noclobber(&final_path).map_err(|e| io_error(e.error))?;
        let cleanup = tempfile::TempPath::try_from_path(final_path).map_err(io_error)?;
        tx.commit().await?;
        cleanup.keep().map_err(|e| io_error(e.error))?;
        Ok::<_, AppError>(recording)
    }).await.map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "录音保存失败"))??;
    Ok((StatusCode::CREATED, Json(saved)).into_response())
}
#[derive(Deserialize)]
struct Rename {
    title: String,
}
async fn rename(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(q): Json<Rename>,
) -> Result<Json<Recording>> {
    let u = auth::user(&s, &headers).await?;
    let id = valid_id(&id)?;
    let title = text_field(&q.title, 160)?;
    let recording = sqlx::query_as(&format!(
        "UPDATE recordings SET title=? WHERE id=? AND user_id=? RETURNING {COLUMNS}"
    ))
    .bind(title)
    .bind(id)
    .bind(u.id)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(not_found)?;
    Ok(Json(recording))
}
async fn delete(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let u = auth::user(&s, &headers).await?;
    let recording = owned(&s, u.id, &id).await?;
    let dir = user_dir(&s, &u.username).await?;
    let path = blob_path(&dir, &recording)?;
    tokio::spawn(async move {
        let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await?;
        let result = sqlx::query("DELETE FROM recordings WHERE id=? AND user_id=?")
            .bind(recording.id)
            .bind(u.id)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            return Err(not_found());
        }
        // Remove the blob before committing: failed filesystem deletes retain metadata for retry.
        match regular_file(&path).await {
            Ok(_) => fs::remove_file(path).await.map_err(io_error)?,
            Err(e) if e.0 == StatusCode::NOT_FOUND => {}
            Err(e) => return Err(e),
        }
        tx.commit().await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
    .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "录音删除失败"))?
}
#[derive(Deserialize)]
struct AudioQuery {
    #[serde(default)]
    download: bool,
}
fn byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if length == 0 {
        return None;
    }
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        Some((length.saturating_sub(suffix), length - 1))
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>().ok()?.min(length - 1)
        };
        (start <= end && start < length).then_some((start, end))
    }
}
async fn audio(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<AudioQuery>,
    headers: HeaderMap,
) -> Result<Response> {
    let u = auth::user(&s, &headers).await?;
    let recording = owned(&s, u.id, &id).await?;
    let dir = user_dir(&s, &u.username).await?;
    let path = blob_path(&dir, &recording)?;
    regular_file(&path).await?;
    let mut file = fs::File::open(path).await.map_err(io_error)?;
    let length = file.metadata().await.map_err(io_error)?.len();
    let range = match headers.get(header::RANGE) {
        None => None,
        Some(value) => match value.to_str().ok().and_then(|v| byte_range(v, length)) {
            Some(range) => Some(range),
            None => {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [
                        (header::CONTENT_RANGE, format!("bytes */{length}")),
                        (header::ACCEPT_RANGES, "bytes".into()),
                        (header::CONTENT_LENGTH, "0".into()),
                    ],
                )
                    .into_response());
            }
        },
    };
    let (start, count) = range
        .map(|(start, end)| (start, end - start + 1))
        .unwrap_or((0, length));
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(io_error)?;
    let mut response = Body::from_stream(ReaderStream::new(file.take(count))).into_response();
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        recording.mime_type.parse().map_err(|_| unsupported())?,
    );
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    h.insert(header::CONTENT_LENGTH, count.into());
    let disposition = if q.download { "attachment" } else { "inline" };
    let filename = format!("{}.{}", recording.title, extension(&recording.mime_type)?);
    let encoded =
        percent_encoding::utf8_percent_encode(&filename, percent_encoding::NON_ALPHANUMERIC);
    h.insert(
        header::CONTENT_DISPOSITION,
        format!(
            "{disposition}; filename=\"{}.{}\"; filename*=UTF-8''{encoded}",
            recording.id,
            extension(&recording.mime_type)?
        )
        .parse()
        .map_err(|_| AppError::bad("录音名称无效"))?,
    );
    if let Some((start, end)) = range {
        h.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}").parse().unwrap(),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}
