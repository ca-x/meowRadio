use crate::{
    AppState, auth,
    error::{AppError, Result},
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::{net::IpAddr, time::Duration};

pub fn public_ip(ip: IpAddr) -> bool {
    // Conservative global-unicast allow rule, including mapped IPv4 and reserved ranges.
    match ip {
        IpAddr::V4(v) => {
            let denied = [
                "0.0.0.0/8",
                "10.0.0.0/8",
                "100.64.0.0/10",
                "127.0.0.0/8",
                "169.254.0.0/16",
                "172.16.0.0/12",
                "192.0.0.0/24",
                "192.0.2.0/24",
                "192.168.0.0/16",
                "198.18.0.0/15",
                "198.51.100.0/24",
                "203.0.113.0/24",
                "224.0.0.0/4",
                "240.0.0.0/4",
            ];
            !denied
                .iter()
                .any(|n| n.parse::<ipnet::Ipv4Net>().unwrap().contains(&v))
        }
        IpAddr::V6(v) => {
            if let Some(mapped) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(mapped));
            }
            "2000::/3".parse::<ipnet::Ipv6Net>().unwrap().contains(&v)
                && !["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"]
                    .iter()
                    .any(|n| n.parse::<ipnet::Ipv6Net>().unwrap().contains(&v))
        }
    }
}
#[derive(Default, serde::Deserialize)]
pub struct StreamQuery {
    resource: Option<String>,
    #[serde(rename = "_HLS_msn")]
    msn: Option<u64>,
    #[serde(rename = "_HLS_part")]
    part: Option<u64>,
    #[serde(rename = "_HLS_skip")]
    skip: Option<String>,
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
    uuid::Uuid::parse_str(&id).map_err(|_| AppError::bad("无效的电台编号"))?;
    let permit = s
        .relay_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "收听人数较多，请稍后重试"))?;
    let (mut url, kind) = if let Some(token) = &query.resource {
        let (url, kind) = crate::hls::resource(&s, user.id, &id, token)?;
        (url, Some(kind))
    } else {
        let station = s.catalog.station(&id).await?;
        let url = url::Url::parse(&station.url).map_err(|_| AppError::bad("电台地址无效"))?;
        let hls = station.hls || url.path().to_ascii_lowercase().ends_with(".m3u8");
        (
            url,
            if hls {
                Some(crate::hls::Kind::Playlist)
            } else {
                None
            },
        )
    };
    if query
        .skip
        .as_deref()
        .is_some_and(|value| !matches!(value, "YES" | "v2"))
    {
        return Err(AppError::bad("无效的 HLS 请求参数"));
    }
    if query.msn.is_some() || query.part.is_some() || query.skip.is_some() {
        if kind != Some(crate::hls::Kind::Playlist) {
            return Err(AppError::bad("无效的 HLS 请求参数"));
        }
        let existing: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(name, _)| !matches!(name.as_ref(), "_HLS_msn" | "_HLS_part" | "_HLS_skip"))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let mut pairs = url.query_pairs_mut();
        pairs.clear().extend_pairs(existing);
        if let Some(value) = query.msn {
            pairs.append_pair("_HLS_msn", &value.to_string());
        }
        if let Some(value) = query.part {
            pairs.append_pair("_HLS_part", &value.to_string());
        }
        if let Some(value) = &query.skip {
            pairs.append_pair("_HLS_skip", value);
        }
    }
    for _ in 0..6 {
        let response = s.outbound.get(&url, headers.get(header::RANGE)).await?;
        if response.status.is_redirection() {
            let location = response
                .headers
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(AppError::upstream)?;
            url = url.join(location).map_err(|_| AppError::upstream())?;
            continue;
        }
        if !response.status.is_success() {
            return Err(AppError::upstream());
        }
        let content_type = response
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_ascii_lowercase();
        let playlist = kind == Some(crate::hls::Kind::Playlist)
            || content_type.contains("mpegurl")
            || url.path().to_ascii_lowercase().ends_with(".m3u8");
        if playlist {
            let bytes = tokio::time::timeout(
                Duration::from_secs(10),
                axum::body::to_bytes(response.body, crate::hls::MAX_PLAYLIST),
            )
            .await
            .map_err(|_| AppError::upstream())?
            .map_err(|_| AppError::bad("HLS 播放列表读取失败或过大"))?;
            let text =
                std::str::from_utf8(&bytes).map_err(|_| AppError::bad("HLS 播放列表编码无效"))?;
            let rewritten = crate::hls::rewrite(&s, user.id, &id, &url, text)?;
            return Ok((
                [
                    (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                rewritten,
            )
                .into_response());
        }
        if kind.is_none()
            && !(content_type.starts_with("audio/")
                || content_type.starts_with("application/ogg")
                || content_type.starts_with("application/octet-stream"))
        {
            return Err(AppError::bad("此电台未返回可播放的音频流"));
        }
        let status = response.status;
        let mut output_headers = HeaderMap::new();
        output_headers.insert(
            header::CONTENT_TYPE,
            if kind.is_some() {
                header::HeaderValue::from_static("application/octet-stream")
            } else {
                content_type.parse().map_err(|_| AppError::upstream())?
            },
        );
        output_headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        for name in [header::CONTENT_RANGE, header::ACCEPT_RANGES] {
            if let Some(value) = response.headers.get(&name) {
                output_headers.insert(name, value.clone());
            }
        }
        let mut received = 0usize;
        let stream = response.body.into_data_stream().map(move |chunk| {
            let _ = &permit;
            chunk.and_then(|bytes| {
                received = received.saturating_add(bytes.len());
                if kind.is_some() && received > 64 * 1024 * 1024 {
                    Err(axum::Error::new(std::io::Error::other(
                        "HLS resource too large",
                    )))
                } else {
                    Ok(bytes)
                }
            })
        });
        return Ok((status, output_headers, Body::from_stream(stream)).into_response());
    }
    Err(AppError::bad("电台重定向次数过多"))
}
