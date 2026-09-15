use crate::{
    AppState, auth,
    error::{AppError, Result},
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

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
pub async fn stream(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    auth::user(&s, &headers).await?;
    if !s.config.relay {
        return Err(AppError(StatusCode::FORBIDDEN, "服务端中转未启用"));
    }
    let permit = s.relay_slots.clone().try_acquire_owned().map_err(|_| {
        AppError(
            StatusCode::TOO_MANY_REQUESTS,
            "收听人数较多，请使用直连模式",
        )
    })?;
    let station = s.catalog.station(&id).await?;
    if station.hls {
        return Err(AppError::bad("HLS 电台请使用直连模式"));
    }
    let mut url = url::Url::parse(&station.url).map_err(|_| AppError::bad("电台地址无效"))?;
    for _ in 0..6 {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(AppError::bad("不支持此电台地址"));
        }
        let host = url
            .host_str()
            .ok_or_else(|| AppError::bad("电台缺少主机名"))?
            .trim_matches(['[', ']'])
            .to_string();
        let port = url.port_or_known_default().unwrap();
        if !matches!(port, 80 | 443 | 8000..=9999) {
            return Err(AppError::bad("电台端口不在中转支持范围内"));
        }
        let addresses: Vec<SocketAddr> = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host.as_str(), port)),
        )
        .await
        .map_err(|_| AppError::upstream())?
        .map_err(|_| AppError::upstream())?
        .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(AppError::bad("中转仅允许公共互联网电台"));
        }
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .user_agent("meowRadio/0.1");
        let mut target = url.clone();
        if let Some(proxy) = &s.config.proxy {
            // Pin the destination even through a proxy. Plain HTTP can preserve Host;
            // HTTPS needs original TLS SNI, so reject instead of permitting DNS rebinding.
            if url.scheme() == "https" {
                return Err(AppError::bad(
                    "HTTPS 电台通过代理中转暂不支持，请切换直连模式",
                ));
            }
            target
                .set_ip_host(addresses[0].ip())
                .map_err(|_| AppError::upstream())?;
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| AppError::upstream())?);
        } else {
            builder = builder.resolve_to_addrs(&host, &addresses);
        }
        let authority = match url.port() {
            Some(p) => format!("{}:{p}", url.host_str().unwrap()),
            None => url.host_str().unwrap().to_string(),
        };
        let response = builder
            .build()
            .map_err(|_| AppError::upstream())?
            .get(target)
            .header(header::HOST, authority)
            .send()
            .await
            .map_err(|_| AppError::upstream())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(AppError::upstream)?;
            url = url.join(location).map_err(|_| AppError::upstream())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::upstream());
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("audio/mpeg")
            .to_string();
        if !(content_type.starts_with("audio/")
            || content_type.starts_with("application/ogg")
            || content_type.starts_with("application/octet-stream"))
            || content_type.contains("mpegurl")
        {
            return Err(AppError::bad("此电台格式无法中转，请切换直连模式"));
        }
        // Keep the capacity permit for the entire body lifetime, including disconnects.
        let stream = response.bytes_stream().map(move |chunk| {
            let _ = &permit;
            chunk
        });
        return Ok((
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "no-store".into()),
            ],
            Body::from_stream(stream),
        )
            .into_response());
    }
    Err(AppError::bad("电台重定向次数过多"))
}
