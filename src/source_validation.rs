//! Bounded, cancellable checks. Failed lines remain stored until explicitly confirmed.
use crate::{
    AppState, auth,
    error::{AppError, Result},
    source_types::Candidate,
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const MAX_JOBS: usize = 32;
const MAX_LINES: usize = 80_000;
const TTL: Duration = Duration::from_secs(30 * 60);

/// The default implementation always uses the same secure media pipeline as playback.
/// Injectable to allow deterministic tests without DNS, external streams, or FFmpeg.
pub trait CandidateValidator: Send + Sync {
    fn capabilities<'a>(&'a self, state: &'a AppState)
    -> BoxFuture<'a, crate::media::Capabilities>;
    fn validate<'a>(
        &'a self,
        state: &'a AppState,
        user: i64,
        station: &'a str,
        candidate: &'a Candidate,
    ) -> BoxFuture<'a, Result<()>>;
}
struct MediaValidator;
impl CandidateValidator for MediaValidator {
    fn capabilities<'a>(
        &'a self,
        state: &'a AppState,
    ) -> BoxFuture<'a, crate::media::Capabilities> {
        Box::pin(state.media.probe())
    }
    fn validate<'a>(
        &'a self,
        state: &'a AppState,
        user: i64,
        station: &'a str,
        candidate: &'a Candidate,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(crate::media::validate_candidate(
            state, user, station, candidate,
        ))
    }
}
#[derive(Clone, Serialize)]
pub struct Failure {
    pub name: String,
    pub station_id: String,
    pub url: String,
    /// One-based display index within the station's snapshot.
    pub line: usize,
    pub key: String,
    pub reason: String,
}
#[derive(Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub source_id: String,
    pub total: usize,
    pub checked: usize,
    pub status: &'static str,
    pub failed_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failures: Option<Vec<Failure>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}
struct Entry {
    user: i64,
    job: Mutex<Job>,
    failures: Mutex<Vec<Failure>>,
    cancel: CancellationToken,
    running: AtomicBool,
    updated: Mutex<Instant>,
}
impl Entry {
    fn view(&self) -> Job {
        let mut job = self.job.lock().unwrap().clone();
        if job.status == "complete" {
            job.failures = Some(self.failures.lock().unwrap().clone());
        }
        job
    }
    fn finish(&self, status: &'static str, reason: Option<&'static str>) {
        let mut job = self.job.lock().unwrap();
        // A cancellation acknowledged to the caller cannot turn into a completed result.
        if job.status == "running" {
            job.status = status;
            job.reason = reason;
        }
        *self.updated.lock().unwrap() = Instant::now();
    }
    fn cancel(&self) {
        self.cancel.cancel();
        self.finish("cancelled", None);
    }
}
pub struct ValidationService {
    jobs: Mutex<HashMap<(i64, String), Arc<Entry>>>,
    slots: Semaphore,
    validator: Arc<dyn CandidateValidator>,
}
impl Default for ValidationService {
    fn default() -> Self {
        Self::new()
    }
}
impl ValidationService {
    pub fn new() -> Self {
        Self::with_validator(Arc::new(MediaValidator))
    }
    pub fn with_validator(validator: Arc<dyn CandidateValidator>) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            slots: Semaphore::new(2),
            validator,
        }
    }
    pub fn cancel_source(&self, user: i64, source: &str) {
        if let Some(entry) = self.jobs.lock().unwrap().get(&(user, source.to_owned())) {
            entry.cancel();
        }
    }
    pub fn cancel_user(&self, user: i64) {
        for entry in self
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|entry| entry.user == user)
        {
            entry.cancel();
        }
    }
    fn lookup(&self, user: i64, source: &str) -> Result<Arc<Entry>> {
        let mut jobs = self.jobs.lock().unwrap();
        prune(&mut jobs);
        jobs.get(&(user, source.to_owned()))
            .cloned()
            .ok_or(AppError(StatusCode::NOT_FOUND, "校验任务不存在或已过期"))
    }
}
fn prune(jobs: &mut HashMap<(i64, String), Arc<Entry>>) {
    jobs.retain(|_, entry| {
        entry.running.load(Ordering::Acquire) || entry.updated.lock().unwrap().elapsed() < TTL
    });
}
struct Line {
    station: String,
    name: String,
    line: usize,
    candidate: Candidate,
}
fn fingerprint(station: &str, candidate: &Candidate) -> String {
    let hash = Sha256::digest(serde_json::to_vec(candidate).expect("candidate serialization"));
    format!("{station}:{hash:x}")
}
fn not_found() -> AppError {
    AppError(StatusCode::NOT_FOUND, "私人订阅不存在")
}
async fn owned(state: &AppState, user: i64, id: &str) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM personal_sources WHERE id=? AND user_id=?)",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&state.db)
    .await?;
    if exists { Ok(()) } else { Err(not_found()) }
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/personal-sources/{id}/validation",
            get(current).post(start).delete(cancel),
        )
        .route(
            "/personal-sources/{id}/validation/clear",
            post(clear).layer(DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
}
async fn start(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Job>)> {
    let user = auth::user(&state, &headers).await?;
    crate::personal_sources::expected_owner(&headers, user.id)?;
    owned(&state, user.id, &id).await?;
    if !state.config.relay {
        return Err(AppError(StatusCode::FORBIDDEN, "服务端中转未启用"));
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT id,name,candidates_json FROM personal_stations WHERE source_id=? AND user_id=? ORDER BY position,id").bind(&id).bind(user.id).fetch_all(&state.db).await?;
    let mut lines = Vec::new();
    for (station, name, json) in rows {
        let candidates: Vec<Candidate> = serde_json::from_str(&json)
            .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "电台数据读取失败"))?;
        for (index, candidate) in candidates.into_iter().enumerate() {
            if lines.len() >= MAX_LINES {
                return Err(AppError::bad("校验线路数量超过限制"));
            }
            lines.push(Line {
                station: station.clone(),
                name: name.clone(),
                line: index + 1,
                candidate,
            });
        }
    }
    let job = Job {
        id: uuid::Uuid::new_v4().to_string(),
        source_id: id.clone(),
        total: lines.len(),
        checked: 0,
        status: "running",
        failed_count: 0,
        failures: None,
        reason: None,
    };
    let entry = Arc::new(Entry {
        user: user.id,
        job: Mutex::new(job.clone()),
        failures: Mutex::new(Vec::new()),
        cancel: CancellationToken::new(),
        running: AtomicBool::new(true),
        updated: Mutex::new(Instant::now()),
    });
    {
        let mut jobs = state.source_validation.jobs.lock().unwrap();
        prune(&mut jobs);
        if let Some(((_, source), _)) = jobs
            .iter()
            .find(|(_, entry)| entry.user == user.id && entry.running.load(Ordering::Acquire))
        {
            return Err(if source == &id {
                AppError(StatusCode::CONFLICT, "此订阅正在校验，请查看当前进度")
            } else {
                AppError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "另一个订阅正在校验，请等待或取消",
                )
            });
        }
        let key = (user.id, id);
        if !jobs.contains_key(&key) && jobs.len() >= MAX_JOBS {
            let oldest = jobs
                .iter()
                .filter(|(_, entry)| !entry.running.load(Ordering::Acquire))
                .min_by_key(|(_, entry)| *entry.updated.lock().unwrap())
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                jobs.remove(&oldest);
            } else {
                return Err(AppError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "校验任务较多，请稍后重试",
                ));
            }
        }
        jobs.insert(key, entry.clone());
    }
    tokio::spawn(async move {
        // The registry stores no task handle or state; the task releases its state on completion.
        run(&state, &entry, lines).await;
        entry.running.store(false, Ordering::Release);
    });
    Ok((StatusCode::ACCEPTED, Json(job)))
}
fn supported(caps: &crate::media::Capabilities, lines: &[Line]) -> bool {
    caps.available
        && caps.mp3
        && lines.iter().all(
            |line| match line.candidate.url.split(':').next().unwrap_or("") {
                "rtmp" | "rtmps" => caps.native_rtmp,
                "rtsp" | "rtsps" => caps.rtsp,
                "mms" => caps.mmst || caps.mmsh,
                "mmst" => caps.mmst,
                "mmsh" => caps.mmsh,
                _ => true,
            },
        )
}
async fn run(state: &AppState, entry: &Entry, lines: Vec<Line>) {
    let service = &state.source_validation;
    let caps = tokio::select! {
        biased;
        _ = entry.cancel.cancelled() => { entry.finish("cancelled", None); return; }
        caps = service.validator.capabilities(state) => caps,
    };
    if !supported(&caps, &lines) {
        entry.finish(
            "blocked",
            Some("服务端 FFmpeg 缺失或不支持此订阅所需协议，未判定任何线路失效"),
        );
        return;
    }
    for line in lines {
        let outcome = loop {
            let permit = tokio::select! {
                biased;
                _ = entry.cancel.cancelled() => { entry.finish("cancelled", None); return; }
                permit = service.slots.acquire() => permit.expect("validation semaphore remains open"),
            };
            let outcome = tokio::select! {
                biased;
                _ = entry.cancel.cancelled() => { entry.finish("cancelled", None); return; }
                result = tokio::time::timeout(Duration::from_secs(65), service.validator.validate(state, entry.user, &line.station, &line.candidate)) => result.unwrap_or(Err(AppError(StatusCode::GATEWAY_TIMEOUT, "线路校验超时，可能暂时不可用，建议稍后重试"))),
            };
            drop(permit);
            if outcome
                .as_ref()
                .is_err_and(|error| error.0 == StatusCode::TOO_MANY_REQUESTS)
            {
                tokio::select! {
                    _ = entry.cancel.cancelled() => { entry.finish("cancelled", None); return; }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
                continue;
            }
            break outcome;
        };
        if let Err(error) = &outcome {
            if error.0 == StatusCode::CONFLICT {
                entry.finish("cancelled", Some("播放资源已变化，校验已取消"));
                return;
            }
            if matches!(
                error.0,
                StatusCode::SERVICE_UNAVAILABLE | StatusCode::INTERNAL_SERVER_ERROR
            ) {
                entry.finish("blocked", Some("服务端校验组件不可用，请修复后重新校验"));
                return;
            }
            entry.failures.lock().unwrap().push(Failure {
                key: fingerprint(&line.station, &line.candidate),
                station_id: line.station,
                url: line.candidate.url,
                name: line.name,
                line: line.line,
                reason: if matches!(
                    error.0,
                    StatusCode::GATEWAY_TIMEOUT | StatusCode::REQUEST_TIMEOUT
                ) {
                    "线路校验超时，可能暂时不可用，建议稍后重试".into()
                } else {
                    error.1.into()
                },
            });
        }
        let mut job = entry.job.lock().unwrap();
        job.checked += 1;
        job.failed_count += usize::from(outcome.is_err());
        *entry.updated.lock().unwrap() = Instant::now();
    }
    entry.finish("complete", None);
}
async fn current(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Job>> {
    let user = auth::user(&state, &headers).await?;
    owned(&state, user.id, &id).await?;
    Ok(Json(state.source_validation.lookup(user.id, &id)?.view()))
}
#[derive(Deserialize)]
struct Cancel {
    job_id: Option<String>,
}
async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(input): Query<Cancel>,
    headers: HeaderMap,
) -> Result<Json<Job>> {
    let user = auth::user(&state, &headers).await?;
    crate::personal_sources::expected_owner(&headers, user.id)?;
    owned(&state, user.id, &id).await?;
    let entry = state.source_validation.lookup(user.id, &id)?;
    if input.job_id.as_deref() != Some(entry.view().id.as_str()) {
        return Err(AppError(
            StatusCode::CONFLICT,
            "校验未完成或结果已更新，请重新校验",
        ));
    }
    entry.cancel();
    Ok(Json(entry.view()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Clear {
    job_id: String,
    keys: Vec<String>,
}
#[derive(Serialize)]
struct Cleared {
    removed_lines: usize,
    removed_stations: usize,
    skipped_lines: usize,
}
async fn clear(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Cleared>> {
    let user = auth::user(&state, &headers).await?;
    crate::personal_sources::expected_owner(&headers, user.id)?;
    owned(&state, user.id, &id).await?;
    let _permit = state
        .source_import_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "订阅导入繁忙，请稍后重试"))?;
    let bytes = tokio::time::timeout(Duration::from_secs(30), to_bytes(body, 12 * 1024 * 1024))
        .await
        .map_err(|_| AppError(StatusCode::REQUEST_TIMEOUT, "清理请求读取超时"))?
        .map_err(|_| AppError::bad("清理线路数量或标识无效"))?;
    let input: Clear =
        serde_json::from_slice(&bytes).map_err(|_| AppError::bad("清理线路数量或标识无效"))?;
    if input.keys.len() > MAX_LINES || input.keys.iter().any(|key| key.len() > 128) {
        return Err(AppError::bad("清理线路数量或标识无效"));
    }
    let entry = state.source_validation.lookup(user.id, &id)?;
    let job = entry.view();
    if job.id != input.job_id || job.status != "complete" {
        return Err(AppError(
            StatusCode::CONFLICT,
            "校验未完成或结果已更新，请重新校验",
        ));
    }
    let failed: HashSet<_> = job
        .failures
        .unwrap_or_default()
        .into_iter()
        .map(|failure| failure.key)
        .collect();
    let keys: HashSet<_> = input.keys.into_iter().collect();
    if !keys.is_subset(&failed) {
        return Err(AppError::bad("只能清理本次校验中确认失效的线路"));
    }
    let mut tx = state.db.begin().await?;
    // Acquire SQLite's write lock before reading candidate fingerprints.
    let updated =
        sqlx::query("UPDATE personal_sources SET updated_at=updated_at WHERE id=? AND user_id=?")
            .bind(&id)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(not_found());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,candidates_json FROM personal_stations WHERE source_id=? AND user_id=?",
    )
    .bind(&id)
    .bind(user.id)
    .fetch_all(&mut *tx)
    .await?;
    let mut result = Cleared {
        removed_lines: 0,
        removed_stations: 0,
        skipped_lines: 0,
    };
    let mut changed = Vec::new();
    for (station, json) in rows {
        let mut candidates: Vec<Candidate> = serde_json::from_str(&json)
            .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "电台数据读取失败"))?;
        let before = candidates.len();
        candidates.retain(|candidate| !keys.contains(&fingerprint(&station, candidate)));
        if before == candidates.len() {
            continue;
        }
        result.removed_lines += before - candidates.len();
        if candidates.is_empty() {
            sqlx::query("DELETE FROM personal_stations WHERE id=? AND user_id=? AND source_id=?")
                .bind(&station)
                .bind(user.id)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            result.removed_stations += 1;
        } else {
            sqlx::query("UPDATE personal_stations SET candidates_json=? WHERE id=? AND user_id=? AND source_id=?").bind(serde_json::to_string(&candidates).unwrap()).bind(&station).bind(user.id).bind(&id).execute(&mut *tx).await?;
        }
        changed.push(station);
    }
    if !changed.is_empty() {
        sqlx::query("UPDATE personal_sources SET updated_at=unixepoch() WHERE id=? AND user_id=?")
            .bind(&id)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    for station in changed {
        state.media.cancel_station(user.id, &station);
    }
    result.skipped_lines = keys.len().saturating_sub(result.removed_lines);
    Ok(Json(result))
}
