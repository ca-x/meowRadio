//! Authenticated private radio playback, normalized to a same-origin MP3 stream.
use crate::{
    AppState, auth,
    error::{AppError, Result},
    source_types::{Candidate, MediaFormat, ResolvedSource},
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdout, Command},
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const START_TIMEOUT: Duration = Duration::from_secs(12);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

pub struct MediaService {
    slots: Arc<Semaphore>,
    jobs: Mutex<HashMap<uuid::Uuid, (i64, String, CancellationToken)>>,
    capabilities: tokio::sync::OnceCell<Capabilities>,
}
impl Default for MediaService {
    fn default() -> Self {
        Self::new()
    }
}
impl MediaService {
    pub fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
            jobs: Mutex::new(HashMap::new()),
            capabilities: tokio::sync::OnceCell::new(),
        }
    }
    pub fn cancel_station(&self, user: i64, id: &str) {
        for (owner, station, cancel) in self.jobs.lock().unwrap().values() {
            if *owner == user && station == id {
                cancel.cancel();
            }
        }
    }
    pub fn cancel_user(&self, user: i64) {
        for (owner, _, cancel) in self.jobs.lock().unwrap().values() {
            if *owner == user {
                cancel.cancel();
            }
        }
    }
    fn acquire(self: &Arc<Self>, user: i64, station: &str) -> Result<JobLease> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "转码任务较多，请稍后重试"))?;
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.values().filter(|(owner, _, _)| *owner == user).count() >= 2 {
            return Err(AppError(
                StatusCode::TOO_MANY_REQUESTS,
                "最多同时播放两个个人电台",
            ));
        }
        let id = uuid::Uuid::new_v4();
        let cancel = CancellationToken::new();
        jobs.insert(id, (user, station.into(), cancel.clone()));
        Ok(JobLease {
            service: self.clone(),
            id,
            cancel,
            _permit: permit,
        })
    }
    pub async fn probe(&self) -> Capabilities {
        self.capabilities.get_or_init(probe).await.clone()
    }
}
#[derive(Clone, serde::Serialize)]
pub struct Capabilities {
    pub available: bool,
    pub mp3: bool,
    pub native_rtmp: bool,
    pub rtsp: bool,
    pub mmst: bool,
    pub mmsh: bool,
    pub hls_extension_picky: bool,
}
fn binary() -> std::ffi::OsString {
    std::env::var_os("MEOW_FFMPEG").unwrap_or_else(|| "ffmpeg".into())
}
async fn output(args: &[&str]) -> Option<String> {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(binary())
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    result.status.success().then(|| {
        format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        )
    })
}
async fn probe() -> Capabilities {
    let protocols = output(&["-hide_banner", "-protocols"]).await;
    let encoders = output(&["-hide_banner", "-encoders"])
        .await
        .unwrap_or_default();
    let rtmp = output(&["-hide_banner", "-h", "protocol=rtmp"])
        .await
        .unwrap_or_default();
    let hls = output(&["-hide_banner", "-h", "demuxer=hls"])
        .await
        .unwrap_or_default();
    let demuxers = output(&["-hide_banner", "-demuxers"])
        .await
        .unwrap_or_default();
    let protocols_text = protocols.as_deref().unwrap_or_default();
    let has = |name: &str| protocols_text.lines().any(|l| l.trim() == name);
    Capabilities {
        available: protocols.is_some(),
        mp3: encoders.contains("libmp3lame"),
        native_rtmp: has("rtmp") && rtmp.contains("rtmp_tcurl") && rtmp.contains("rtmp_app"),
        rtsp: demuxers
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some("rtsp")),
        mmst: has("mmst"),
        mmsh: has("mmsh"),
        hls_extension_picky: hls.contains("extension_picky"),
    }
}
struct JobLease {
    service: Arc<MediaService>,
    id: uuid::Uuid,
    cancel: CancellationToken,
    _permit: OwnedSemaphorePermit,
}
impl Drop for JobLease {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.service.jobs.lock().unwrap().remove(&self.id);
    }
}
struct Playback {
    #[cfg(test)]
    child_id: u32,
    stdout: ChildStdout,
    tasks: Vec<JoinHandle<()>>,
    cancel: CancellationToken,
}
impl Drop for Playback {
    fn drop(&mut self) {
        self.cancel.cancel();
        for task in &self.tasks {
            task.abort();
        }
    }
}
struct Attempt {
    tasks: Vec<JoinHandle<()>>,
    cancel: CancellationToken,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        self.cancel.cancel();
        for task in &self.tasks {
            task.abort();
        }
    }
}
#[derive(Default, serde::Deserialize)]
pub struct StreamQuery {
    pub line: Option<usize>,
}

pub async fn stream(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<StreamQuery>,
) -> Result<Response> {
    let user = auth::user(&s, &headers).await?;
    if !s.config.relay {
        return Err(AppError(StatusCode::FORBIDDEN, "服务端中转未启用"));
    }
    let mut candidates = crate::personal_sources::candidates(&s, user.id, &id).await?;
    if let Some(line) = query.line {
        if line >= candidates.len() {
            return Err(AppError::bad("无效的播放线路"));
        }
        let selected = candidates.remove(line);
        candidates.insert(0, selected);
    }
    let lease = s.media.acquire(user.id, &id)?;
    let caps = s.media.probe().await;
    if !caps.available || !caps.mp3 {
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "服务端需要安装支持 libmp3lame 的 FFmpeg",
        ));
    }
    let work = async {
        for candidate in candidates {
            let resolved = tokio::time::timeout(
                START_TIMEOUT,
                crate::source_resolver::resolve(&s, &candidate),
            )
            .await;
            let Ok(Ok(source)) = resolved else {
                continue;
            };
            if let Ok(playback) = start_resolved(&s, source, &lease.cancel, &caps).await {
                return Ok(playback);
            }
        }
        Err(AppError(
            StatusCode::BAD_GATEWAY,
            "所有播放线路均不可用，请检查地址或稍后重试",
        ))
    };
    let (playback, prefix) = tokio::select! {
        _=lease.cancel.cancelled()=>return Err(AppError::upstream()),
        result=tokio::time::timeout(TOTAL_TIMEOUT,work)=>result.map_err(|_|AppError(StatusCode::GATEWAY_TIMEOUT,"播放线路连接超时，请稍后重试"))??,
    };
    let stream = futures_util::stream::unfold(
        (playback, lease, Some(prefix)),
        |(mut playback, lease, prefix)| async move {
            if let Some(prefix) = prefix {
                return Some((Ok::<_, std::io::Error>(prefix), (playback, lease, None)));
            }
            let mut buffer = vec![0; 16 * 1024];
            let read = tokio::select! {
                _=lease.cancel.cancelled()=>return None,
                result=tokio::time::timeout(Duration::from_secs(30),playback.stdout.read(&mut buffer))=>result,
            };
            match read {
                Ok(Ok(0)) => None,
                Ok(Ok(n)) => {
                    buffer.truncate(n);
                    Some((Ok(Bytes::from(buffer)), (playback, lease, None)))
                }
                _ => None,
            }
        },
    );
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("audio/mpeg"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        "x-accel-buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    Ok(response)
}

/// Validate precisely one owner-scoped candidate using the same secure decoder as playback.
/// A successful probe owns no continuing playback job; dropping it closes every ingress.
pub async fn validate_candidate(
    s: &AppState,
    user: i64,
    station_id: &str,
    candidate: &Candidate,
) -> Result<()> {
    if !s.config.relay {
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "服务端未启用媒体中转，无法验证播放地址",
        ));
    }
    let lease = s.media.acquire(user, station_id)?;
    let caps = s.media.probe().await;
    check_capability(&caps, MediaFormat::Auto)?;
    let work = async {
        let source = crate::source_resolver::resolve(s, candidate).await?;
        let (playback, _) = start_resolved(s, source, &lease.cancel, &caps).await?;
        drop(playback);
        Ok(())
    };
    tokio::select! {
        _ = lease.cancel.cancelled() => Err(AppError(StatusCode::CONFLICT, "播放地址验证已取消")),
        result = tokio::time::timeout(TOTAL_TIMEOUT, work) => result.map_err(|_| AppError(StatusCode::GATEWAY_TIMEOUT, "播放地址验证超时"))?,
    }
}

fn check_capability(caps: &Capabilities, format: MediaFormat) -> Result<()> {
    let missing = if !caps.available || !caps.mp3 {
        Some("服务端需要安装支持 libmp3lame 的 FFmpeg")
    } else {
        match format {
            MediaFormat::Rtmp if !caps.native_rtmp => Some("FFmpeg 缺少所需的原生 RTMP 协议支持"),
            MediaFormat::Rtsp if !caps.rtsp => Some("FFmpeg 缺少所需的 RTSP 支持"),
            MediaFormat::Mmst if !caps.mmst => Some("FFmpeg 缺少所需的 MMST 协议支持"),
            MediaFormat::Mmsh if !caps.mmsh => Some("FFmpeg 缺少所需的 MMSH 协议支持"),
            MediaFormat::Mms if !caps.mmst || !caps.mmsh => {
                Some("FFmpeg 缺少完整的 MMS（MMST/MMSH）协议支持")
            }
            _ => None,
        }
    };
    missing.map_or(Ok(()), |message| {
        Err(AppError(StatusCode::SERVICE_UNAVAILABLE, message))
    })
}

async fn start_resolved(
    s: &AppState,
    source: ResolvedSource,
    cancel: &CancellationToken,
    caps: &Capabilities,
) -> Result<(Playback, Bytes)> {
    let formats: &[MediaFormat] = if source.format == MediaFormat::Mms {
        &[MediaFormat::Mmst, MediaFormat::Mmsh]
    } else {
        std::slice::from_ref(&source.format)
    };
    let mut last = AppError::upstream();
    let mut missing = None;
    for &format in formats {
        if let Err(error) = check_capability(caps, format) {
            missing = Some(error);
            continue;
        }
        let mut source = source.clone();
        source.format = format;
        if matches!(format, MediaFormat::Mmst | MediaFormat::Mmsh) {
            source
                .url
                .set_scheme(if format == MediaFormat::Mmst {
                    "mmst"
                } else {
                    "mmsh"
                })
                .map_err(|_| AppError::upstream())?;
        }
        match tokio::time::timeout(START_TIMEOUT, start(s, source, cancel.child_token(), caps))
            .await
        {
            Ok(Ok(playback)) => return Ok(playback),
            Ok(Err(error)) if error.0 == StatusCode::SERVICE_UNAVAILABLE => return Err(error),
            Ok(Err(error)) => last = error,
            Err(_) => last = AppError(StatusCode::GATEWAY_TIMEOUT, "播放地址连接超时"),
        }
    }
    // If an MMS fallback could not run, the address has not been conclusively checked.
    Err(missing.unwrap_or(last))
}

async fn start(
    s: &AppState,
    source: ResolvedSource,
    cancel: CancellationToken,
    caps: &Capabilities,
) -> Result<(Playback, Bytes)> {
    check_capability(caps, source.format)?;
    let mut attempt = Attempt {
        tasks: vec![],
        cancel: cancel.clone(),
    };
    let mut command = Command::new(binary());
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-analyzeduration",
        "3000000",
        "-probesize",
        "1048576",
    ]);
    let mut pipe = None;
    match source.format {
        MediaFormat::Hls => {
            if caps.hls_extension_picky {
                command.args([
                    "-extension_picky",
                    "0",
                    "-allowed_segment_extensions",
                    "ALL",
                ]);
            }
            let input =
                crate::media_gateway::start(s.outbound.clone(), &source, cancel.clone(), false)
                    .await?;
            attempt.tasks.extend(input.tasks);
            // Every URI was replaced; unknown demuxers and file/data protocols remain unavailable.
            command.args(["-protocol_whitelist","http,tcp,crypto","-format_whitelist","hls,mpegts,mov,mp3,aac,ac3,eac3,flac,ogg,webvtt","-f","hls","-allowed_extensions","ALL","-seg_format_options","format_whitelist=mpegts,mov,mp3,aac,ac3,eac3,flac,ogg,webvtt:protocol_whitelist=none","-i",&input.url]);
        }
        MediaFormat::Mmsh => {
            let input =
                crate::media_gateway::start(s.outbound.clone(), &source, cancel.clone(), true)
                    .await?;
            attempt.tasks.extend(input.tasks);
            command.args([
                "-protocol_whitelist",
                "mmsh,http,tcp",
                "-f",
                "asf",
                "-i",
                &input.url,
            ]);
        }
        MediaFormat::Rtmp | MediaFormat::Rtsp | MediaFormat::Mmst => {
            let input = crate::legacy_media::start(
                crate::outbound::NetworkTransport::new(&s.config),
                source.url.clone(),
                cancel.clone(),
            )
            .await?;
            attempt.tasks.extend(input.tasks);
            match source.format {
                MediaFormat::Rtmp => {
                    let app = rtmp_app(&source.url);
                    let tcurl = format!("{}/{app}", &source.url[..url::Position::BeforePath]);
                    command.args([
                        "-protocol_whitelist",
                        "rtmp,tcp",
                        "-rtmp_tcurl",
                        &tcurl,
                        "-rtmp_app",
                        app,
                        "-f",
                        "flv",
                    ]);
                }
                MediaFormat::Rtsp => {
                    command.args([
                        "-protocol_whitelist",
                        "tcp",
                        "-rtsp_transport",
                        "tcp",
                        "-f",
                        "rtsp",
                    ]);
                }
                _ => {
                    command.args(["-protocol_whitelist", "mmst,tcp", "-f", "asf"]);
                }
            }
            command.args(["-i", &input.url]);
        }
        _ => {
            let (_, upstream) = crate::media_gateway::fetch(
                s.outbound.as_ref(),
                source.url.clone(),
                None,
                &source.headers,
            )
            .await?;
            let mut body = upstream.body.into_data_stream();
            let mut initial = Vec::new();
            while initial.len() < 32 {
                let Some(bytes) = body.next().await else {
                    break;
                };
                initial.extend_from_slice(&bytes.map_err(|_| AppError::upstream())?);
                if initial.len() > 1024 * 1024 {
                    return Err(AppError::upstream());
                }
            }
            let format = if source.format == MediaFormat::Auto {
                sniff(&initial).ok_or_else(|| AppError::bad("无法识别此音频格式"))?
            } else {
                source.format
            };
            let demuxer = demuxer(format).ok_or_else(AppError::upstream)?;
            command.args(["-protocol_whitelist", "pipe", "-f", demuxer, "-i", "pipe:0"]);
            pipe = Some((body, initial));
        }
    }
    command
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-threads",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-f",
            "mp3",
            "-write_xing",
            "0",
            "-id3v2_version",
            "0",
            "-flush_packets",
            "1",
            "pipe:1",
        ])
        .stdin(if pipe.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| AppError(StatusCode::SERVICE_UNAVAILABLE, "无法启动 FFmpeg 转码程序"))?;
    if let Some((mut body, initial)) = pipe {
        let mut stdin = child.stdin.take().ok_or_else(AppError::upstream)?;
        attempt.tasks.push(tokio::spawn(async move {
            if stdin.write_all(&initial).await.is_err() {
                return;
            }
            while let Some(Ok(bytes)) = body.next().await {
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        }));
    }
    let (diagnostic_sender, diagnostic_receiver) = tokio::sync::oneshot::channel();
    if let Some(mut stderr) = child.stderr.take() {
        // Retain at most two chunks for classification, never URLs or raw diagnostics in errors/logs.
        attempt.tasks.push(tokio::spawn(async move {
            let mut buffer = [0; 4096];
            let mut previous = Vec::new();
            let mut missing_component = false;
            while let Ok(n) = stderr.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                previous.extend_from_slice(&buffer[..n]);
                missing_component |= missing_component_diagnostic(&previous);
                if previous.len() > 4096 {
                    previous.drain(..previous.len() - 4096);
                }
            }
            let _ = diagnostic_sender.send(missing_component);
        }));
    }
    #[cfg(test)]
    let child_id = child.id().unwrap();
    let stdout = child.stdout.take().ok_or_else(AppError::upstream)?;
    let child_cancel = cancel.clone();
    attempt.tasks.push(tokio::spawn(async move {
        tokio::select! {
            _ = child_cancel.cancelled() => { let _ = child.kill().await; },
            _ = child.wait() => {},
        }
    }));
    let tasks = std::mem::take(&mut attempt.tasks);
    // The playback guard takes cancellation ownership before the temporary guard drops.
    attempt.cancel = CancellationToken::new();
    let mut playback = Playback {
        #[cfg(test)]
        child_id,
        stdout,
        tasks,
        cancel,
    };
    let mut prefix = Vec::new();
    while prefix.len() < 1024 {
        let mut buffer = [0; 4096];
        let n = playback
            .stdout
            .read(&mut buffer)
            .await
            .map_err(|_| AppError::upstream())?;
        if n == 0 {
            if matches!(
                tokio::time::timeout(Duration::from_millis(100), diagnostic_receiver).await,
                Ok(Ok(true))
            ) {
                return Err(AppError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "FFmpeg 缺少此媒体所需的解码器、格式或协议支持",
                ));
            }
            return Err(AppError::upstream());
        }
        prefix.extend_from_slice(&buffer[..n]);
    }
    if !mp3_frame(&prefix) {
        return Err(AppError::upstream());
    }
    Ok((playback, Bytes::from(prefix)))
}
fn missing_component_diagnostic(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    [
        "unknown decoder",
        "unknown encoder",
        "unknown input format",
        "demuxer not found",
        "protocol not found",
        "decoder not found",
        "no decoder found",
        "unrecognized option",
    ]
    .iter()
    .any(|value| text.contains(value))
        || text.contains("decoder (codec") && text.contains("not found")
}

// Match native FFmpeg's application/instance split while retaining the public tcUrl host.
fn rtmp_app(url: &url::Url) -> &str {
    let path = &url[url::Position::BeforePath..url::Position::AfterQuery];
    let path = path.trim_start_matches('/');
    if path.contains('?') && path.contains("slist=") {
        return path;
    }
    if path.starts_with("ondemand/") {
        return "ondemand";
    }
    let Some(first) = path.find('/') else {
        return path;
    };
    let rest = &path[first + 1..];
    let Some(second) = rest.find('/') else {
        return &path[..first];
    };
    if rest.find(':').is_some_and(|colon| colon < second) {
        &path[..first]
    } else {
        &path[..first + 1 + second]
    }
}

fn mp3_frame(bytes: &[u8]) -> bool {
    bytes.windows(4).any(|b| {
        b[0] == 0xff
            && b[1] & 0xe0 == 0xe0
            && b[1] & 0x18 != 0x08
            && b[1] & 6 != 0
            && b[2] >> 4 != 0
            && b[2] >> 4 != 15
            && b[2] & 0x0c != 0x0c
    })
}
fn demuxer(format: MediaFormat) -> Option<&'static str> {
    Some(match format {
        MediaFormat::Mp3 => "mp3",
        MediaFormat::Aac => "aac",
        MediaFormat::Ogg => "ogg",
        MediaFormat::Flac => "flac",
        MediaFormat::Wav => "wav",
        MediaFormat::Asf => "asf",
        MediaFormat::Flv => "flv",
        MediaFormat::MpegTs => "mpegts",
        MediaFormat::Mov => "mov",
        MediaFormat::Matroska => "matroska",
        _ => return None,
    })
}
fn sniff(bytes: &[u8]) -> Option<MediaFormat> {
    Some(if bytes.starts_with(b"FLV") {
        MediaFormat::Flv
    } else if bytes.starts_with(b"OggS") {
        MediaFormat::Ogg
    } else if bytes.starts_with(b"fLaC") {
        MediaFormat::Flac
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        MediaFormat::Wav
    } else if bytes.starts_with(&[0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]) {
        MediaFormat::Asf
    } else if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        MediaFormat::Matroska
    } else if bytes.get(4..8) == Some(b"ftyp") {
        MediaFormat::Mov
    } else if bytes.first() == Some(&0x47) {
        MediaFormat::MpegTs
    } else if bytes.len() > 2 && bytes[0] == 0xff && bytes[1] & 0xf6 == 0xf0 {
        MediaFormat::Aac
    } else if bytes.starts_with(b"ID3") || mp3_frame(bytes) {
        MediaFormat::Mp3
    } else {
        return None;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn per_user_and_global_limits_release_on_drop() {
        let service = Arc::new(MediaService::new());
        let a = service.acquire(1, "a").unwrap_or_else(|_| panic!());
        let b = service.acquire(1, "b").unwrap_or_else(|_| panic!());
        assert!(service.acquire(1, "c").is_err());
        let c = service.acquire(2, "c").unwrap_or_else(|_| panic!());
        let d = service.acquire(2, "d").unwrap_or_else(|_| panic!());
        assert!(service.acquire(3, "e").is_err());
        service.cancel_station(1, "a");
        assert!(a.cancel.is_cancelled());
        assert!(!b.cancel.is_cancelled());
        drop(a);
        assert!(service.acquire(3, "e").is_ok());
        drop((b, c, d));
        assert!(service.jobs.lock().unwrap().is_empty());
    }
    #[test]
    fn mp3_requires_audio_frames_not_only_metadata() {
        assert!(!mp3_frame(b"ID3metadata only"));
        assert!(mp3_frame(&[0xff, 0xfb, 0x90, 0x64]));
    }
    struct Files {
        entries: HashMap<String, Vec<u8>>,
    }
    impl crate::outbound::Transport for Files {
        fn get<'a>(
            &'a self,
            url: &'a url::Url,
            _range: Option<&'a axum::http::HeaderValue>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<crate::outbound::Upstream>> + Send + 'a>,
        > {
            Box::pin(async move {
                let bytes = self
                    .entries
                    .get(url.path())
                    .ok_or_else(AppError::upstream)?
                    .clone();
                Ok(crate::outbound::Upstream {
                    status: StatusCode::OK,
                    headers: HeaderMap::new(),
                    body: Body::from(bytes),
                })
            })
        }
    }
    async fn fixture_state(entries: HashMap<String, Vec<u8>>) -> (tempfile::TempDir, AppState) {
        let temp = tempfile::tempdir().unwrap();
        let mut state = crate::state(crate::config::Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            database: temp.path().join("test.db"),
            catalog_url: None,
            proxy: None,
            secure_cookie: false,
            registration: true,
            relay: true,
        })
        .await
        .unwrap();
        state.outbound = Arc::new(Files { entries });
        (temp, state)
    }
    fn wav() -> Vec<u8> {
        let size = 44100u32 * 2 * 3;
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((size + 36).to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16u32.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(44100u32.to_le_bytes());
        bytes.extend(88200u32.to_le_bytes());
        bytes.extend(2u16.to_le_bytes());
        bytes.extend(16u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend(size.to_le_bytes());
        bytes.resize(44 + size as usize, 0);
        bytes
    }
    #[tokio::test]
    async fn real_ffmpeg_wav_produces_mp3_and_drop_cleans_process() {
        let caps = probe().await;
        if !caps.available || !caps.mp3 {
            eprintln!("FFmpeg unavailable; integration fixture skipped");
            return;
        }
        let (_temp, state) = fixture_state(HashMap::from([("/audio.wav".into(), wav())])).await;
        let source = ResolvedSource {
            url: url::Url::parse("http://radio.example/audio.wav").unwrap(),
            headers: HeaderMap::new(),
            format: MediaFormat::Wav,
        };
        let (playback, prefix) = tokio::time::timeout(
            START_TIMEOUT,
            start(&state, source, CancellationToken::new(), &caps),
        )
        .await
        .unwrap()
        .unwrap_or_else(|_| panic!("WAV transcode failed"));
        assert!(prefix.len() >= 1024 && mp3_frame(&prefix));
        let pid = playback.child_id;
        let tasks: Vec<_> = playback.tasks.iter().map(|t| t.abort_handle()).collect();
        drop(playback);
        tokio::time::timeout(Duration::from_secs(3), async {
            while tasks.iter().any(|t| !t.is_finished())
                || cfg!(target_os = "linux")
                    && std::path::Path::new(&format!("/proc/{pid}")).exists()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn real_ffmpeg_hls_fetches_only_rewritten_gateway_resources() {
        let caps = probe().await;
        if !caps.available || !caps.mp3 {
            eprintln!("FFmpeg unavailable; integration fixture skipped");
            return;
        }
        let files = tempfile::tempdir().unwrap();
        let result = Command::new(binary())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:a",
                "aac",
                "-f",
                "hls",
                "-hls_time",
                "1",
                "-hls_list_size",
                "0",
            ])
            .arg(files.path().join("radio.m3u8"))
            .output()
            .await
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let entries = std::fs::read_dir(files.path())
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    format!("/{}", entry.file_name().to_string_lossy()),
                    std::fs::read(entry.path()).unwrap(),
                )
            })
            .collect();
        let (_temp, state) = fixture_state(entries).await;
        let source = ResolvedSource {
            url: url::Url::parse("http://radio.example/radio.m3u8").unwrap(),
            headers: HeaderMap::new(),
            format: MediaFormat::Hls,
        };
        let (playback, prefix) = tokio::time::timeout(
            START_TIMEOUT,
            start(&state, source, CancellationToken::new(), &caps),
        )
        .await
        .unwrap()
        .unwrap_or_else(|_| panic!("HLS transcode failed"));
        assert!(prefix.len() >= 1024 && mp3_frame(&prefix));
        drop(playback);
    }
    #[test]
    fn rtmp_application_preserves_instance_and_special_playpaths() {
        for (url, expected) in [
            ("rtmp://radio.example/live/stream", "live"),
            ("rtmp://radio.example/live/instance/stream", "live/instance"),
            ("rtmp://radio.example/live/mp4:folder/file", "live"),
            ("rtmp://radio.example/ondemand/clip", "ondemand"),
        ] {
            assert_eq!(rtmp_app(&url::Url::parse(url).unwrap()), expected);
        }
    }
    #[tokio::test]
    async fn authenticated_playback_falls_back_and_cancel_ends_body() {
        let caps = probe().await;
        if !caps.available || !caps.mp3 {
            eprintln!("FFmpeg unavailable; integration fixture skipped");
            return;
        }
        let (_temp, state) = fixture_state(HashMap::from([("/audio.wav".into(), wav())])).await;
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES(1,'alice','unused'),(2,'bob','unused')").execute(&state.db).await.unwrap();
        for (id, token) in [(1, "alice"), (2, "bob")] {
            sqlx::query(
                "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,unixepoch()+3600)",
            )
            .bind(auth::token_hash(token))
            .bind(id)
            .execute(&state.db)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO personal_sources(id,user_id,label,kind) VALUES('source',1,'test','file')",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let candidates=serde_json::json!([{"url":"http://radio.example/broken.wav","headers":{}},{"url":"http://radio.example/audio.wav","headers":{}}]).to_string();
        sqlx::query("INSERT INTO personal_stations(id,user_id,source_id,name,categories_json,candidates_json,position) VALUES('station',1,'source','test','[]',?,0)").bind(candidates).execute(&state.db).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            axum::http::HeaderValue::from_static("meow_session=bob"),
        );
        let error = stream(
            State(state.clone()),
            headers.clone(),
            Path("station".into()),
            Query(StreamQuery::default()),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        headers.insert(
            header::COOKIE,
            axum::http::HeaderValue::from_static("meow_session=alice"),
        );
        let response = stream(
            State(state.clone()),
            headers,
            Path("station".into()),
            Query(StreamQuery::default()),
        )
        .await
        .unwrap_or_else(|_| panic!("line fallback failed"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
        let mut body = response.into_body().into_data_stream();
        let prefix = body.next().await.unwrap().unwrap();
        assert!(prefix.len() >= 1024 && mp3_frame(&prefix));
        state.media.cancel_station(1, "station");
        assert!(body.next().await.is_none());
        drop(body);
        assert!(state.media.jobs.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn hls_segment_cannot_start_a_nested_network_demuxer() {
        let caps = probe().await;
        if !caps.available || !caps.mp3 {
            eprintln!("FFmpeg unavailable; integration fixture skipped");
            return;
        }
        let sink = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let outer=b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\nsegment.ts\n#EXT-X-ENDLIST\n".to_vec();
        let nested = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nhttp://{}/private\n#EXT-X-ENDLIST\n",
            sink.local_addr().unwrap()
        )
        .into_bytes();
        let (_temp, state) = fixture_state(HashMap::from([
            ("/radio.m3u8".into(), outer),
            ("/segment.ts".into(), nested),
        ]))
        .await;
        let source = ResolvedSource {
            url: url::Url::parse("http://radio.example/radio.m3u8").unwrap(),
            headers: HeaderMap::new(),
            format: MediaFormat::Hls,
        };
        assert!(
            tokio::time::timeout(
                START_TIMEOUT,
                start(&state, source, CancellationToken::new(), &caps)
            )
            .await
            .unwrap()
            .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), sink.accept())
                .await
                .is_err(),
            "nested demuxer escaped the local gateway"
        );
    }
    #[tokio::test]
    async fn validation_checks_only_its_candidate_and_releases_jobs() {
        let caps = probe().await;
        if !caps.available || !caps.mp3 {
            eprintln!("FFmpeg unavailable; integration fixture skipped");
            return;
        }
        let (_temp, state) = fixture_state(HashMap::from([("/audio.wav".into(), wav())])).await;
        let good = Candidate {
            url: "http://radio.example/audio.wav".into(),
            headers: Default::default(),
        };
        validate_candidate(&state, 1, "station", &good)
            .await
            .unwrap_or_else(|_| panic!("valid candidate failed validation"));
        assert!(state.media.jobs.lock().unwrap().is_empty());
        assert_eq!(state.media.slots.available_permits(), 4);
        let bad = Candidate {
            url: "http://radio.example/missing.wav".into(),
            headers: Default::default(),
        };
        let error = validate_candidate(&state, 1, "station", &bad)
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        assert!(state.media.jobs.lock().unwrap().is_empty());
        assert_eq!(state.media.slots.available_permits(), 4);
    }
    #[tokio::test]
    async fn validation_busy_is_retryable_and_does_not_consume_another_slot() {
        let (_temp, state) = fixture_state(HashMap::new()).await;
        let first = state.media.acquire(1, "one").unwrap_or_else(|_| panic!());
        let second = state.media.acquire(1, "two").unwrap_or_else(|_| panic!());
        let candidate = Candidate {
            url: "http://radio.example/audio.wav".into(),
            headers: Default::default(),
        };
        let error = validate_candidate(&state, 1, "three", &candidate)
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(state.media.jobs.lock().unwrap().len(), 2);
        assert_eq!(state.media.slots.available_permits(), 2);
        drop((first, second));
        assert!(state.media.jobs.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn validation_missing_protocol_is_service_unavailable_not_invalid_address() {
        let (_temp, state) = fixture_state(HashMap::new()).await;
        let caps = Capabilities {
            available: true,
            mp3: true,
            native_rtmp: false,
            rtsp: false,
            mmst: false,
            mmsh: false,
            hls_extension_picky: false,
        };
        assert!(state.media.capabilities.set(caps).is_ok());
        for url in [
            "rtmp://radio.example/live/stream",
            "rtsp://radio.example/live",
            "mmst://radio.example/live",
            "mmsh://radio.example/live",
            "mms://radio.example/live",
        ] {
            let candidate = Candidate {
                url: url.into(),
                headers: Default::default(),
            };
            let error = validate_candidate(&state, 1, "station", &candidate)
                .await
                .err()
                .unwrap();
            assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE, "{url}");
            assert!(state.media.jobs.lock().unwrap().is_empty());
            assert_eq!(state.media.slots.available_permits(), 4);
        }
    }
    #[test]
    fn component_diagnostics_do_not_confuse_bad_sources_with_missing_server_support() {
        for message in [
            "Unknown input format: 'hls'",
            "Decoder (codec aac) not found for input stream #0:0",
            "Decoding requested, but no decoder found for: wmav2",
            "Unrecognized option 'rtmp_tcurl'",
        ] {
            assert!(missing_component_diagnostic(message.as_bytes()));
        }
        for message in [
            "Connection refused",
            "Invalid data found when processing input",
            "HTTP error 403 Forbidden",
            "Protocol 'file' not on whitelist 'pipe'!",
        ] {
            assert!(!missing_component_diagnostic(message.as_bytes()));
        }
    }
}
