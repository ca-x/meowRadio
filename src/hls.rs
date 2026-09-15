//! Rewrite HLS resources to authenticated, signed same-origin URLs.
use crate::{
    AppState,
    error::{AppError, Result},
};
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_PLAYLIST: usize = 1024 * 1024;
const TOKEN_LIFETIME: u64 = 24 * 60 * 60;
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub enum Kind {
    Playlist,
    Asset,
}
#[derive(Serialize, Deserialize)]
struct Claim {
    user: i64,
    station: String,
    url: String,
    kind: Kind,
    expires: u64,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn invalid() -> AppError {
    AppError(StatusCode::FORBIDDEN, "播放资源链接无效")
}
fn mint(key: &[u8], claim: &Claim) -> Result<String> {
    let payload = serde_json::to_vec(claim).map_err(|_| invalid())?;
    if payload.len() > 5000 {
        return Err(AppError::bad("电台资源地址过长"));
    }
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| invalid())?;
    mac.update(payload.as_bytes());
    Ok(format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
pub(crate) fn resource(
    s: &AppState,
    user: i64,
    station: &str,
    token: &str,
) -> Result<(url::Url, Kind)> {
    if token.len() > 8000 {
        return Err(invalid());
    }
    let (payload, signature) = token.split_once('.').ok_or_else(invalid)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(s.hls_key.as_slice()).map_err(|_| invalid())?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).map_err(|_| invalid())?;
    let claim: Claim =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if claim.user != user || claim.station != station {
        return Err(invalid());
    }
    if claim.expires <= now() {
        return Err(AppError(StatusCode::GONE, "播放链接已过期，请重新连接"));
    }
    Ok((
        url::Url::parse(&claim.url).map_err(|_| invalid())?,
        claim.kind,
    ))
}
fn link(
    s: &AppState,
    user: i64,
    station: &str,
    base: &url::Url,
    value: &str,
    kind: Kind,
) -> Result<String> {
    if value.contains("{$") {
        return Err(AppError::bad("此 HLS 播放列表的变量格式暂不支持"));
    }
    let target = base
        .join(value)
        .map_err(|_| AppError::bad("HLS 资源地址无效"))?;
    if !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err(AppError::bad("HLS 包含不支持的资源协议或加密方式"));
    }
    let claim = Claim {
        user,
        station: station.into(),
        url: target.into(),
        kind,
        expires: now() + TOKEN_LIFETIME,
    };
    Ok(format!(
        "/api/stream/{station}?resource={}",
        mint(s.hls_key.as_slice(), &claim)?
    ))
}
fn attributes(
    s: &AppState,
    user: i64,
    station: &str,
    base: &url::Url,
    line: &str,
) -> Result<String> {
    let Some(colon) = line.find(':') else {
        return Ok(line.into());
    };
    let tag = &line[..colon];
    let kind = if matches!(
        tag,
        "#EXT-X-MEDIA" | "#EXT-X-I-FRAME-STREAM-INF" | "#EXT-X-RENDITION-REPORT"
    ) {
        Kind::Playlist
    } else {
        Kind::Asset
    };
    let mut result = line[..=colon].to_owned();
    let tail = &line[colon + 1..];
    let mut start = 0;
    let mut quoted = false;
    // Quoted attribute values may contain commas, e.g. signed CDN URLs or CODECS.
    for (index, c) in tail
        .char_indices()
        .chain(std::iter::once((tail.len(), ',')))
    {
        if c == '"' {
            quoted = !quoted;
        }
        if c != ',' || quoted {
            continue;
        }
        let part = &tail[start..index];
        if start > 0 {
            result.push(',');
        }
        if let Some((name, value)) = part.split_once('=')
            && name.trim() == "URI"
        {
            let value = value.trim();
            if !value.starts_with('"') || !value.ends_with('"') || value.len() < 2 {
                return Err(AppError::bad("HLS 资源属性格式无效"));
            }
            result.push_str(name);
            result.push_str("=\"");
            result.push_str(&link(
                s,
                user,
                station,
                base,
                &value[1..value.len() - 1],
                kind,
            )?);
            result.push('"');
        } else {
            result.push_str(part);
        }
        start = index + 1;
    }
    if quoted {
        return Err(AppError::bad("HLS 资源属性格式无效"));
    }
    Ok(result)
}

#[cfg(test)]
#[path = "hls_tests.rs"]
mod tests;
pub(crate) fn rewrite(
    s: &AppState,
    user: i64,
    station: &str,
    base: &url::Url,
    text: &str,
) -> Result<String> {
    if text.len() > MAX_PLAYLIST {
        return Err(AppError::bad("HLS 播放列表过大"));
    }
    let text = text.trim_start_matches('\u{feff}');
    if text.lines().next().map(str::trim) != Some("#EXTM3U") {
        return Err(AppError::bad("未收到有效的 HLS 播放列表"));
    }
    let master = text
        .lines()
        .any(|line| line.trim().starts_with("#EXT-X-STREAM-INF:"));
    let mut result = String::with_capacity(text.len() * 2);
    for raw in text.lines() {
        let line = raw.trim();
        // Steering is optional; use the already rewritten primary pathways. Its JSON
        // can contain further URL indirection, which is deliberately not fetched.
        if line.starts_with("#EXT-X-CONTENT-STEERING:") {
            continue;
        }
        if line.is_empty() {
            result.push('\n');
            continue;
        }
        let rewritten = if line.starts_with("#EXT-X-") {
            attributes(s, user, station, base, line)?
        } else if line.starts_with('#') {
            line.into()
        } else {
            link(
                s,
                user,
                station,
                base,
                line,
                if master { Kind::Playlist } else { Kind::Asset },
            )?
        };
        result.push_str(&rewritten);
        result.push('\n');
        if result.len() > 8 * MAX_PLAYLIST {
            return Err(AppError::bad("HLS 播放列表过大"));
        }
    }
    Ok(result)
}
