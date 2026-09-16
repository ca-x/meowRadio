//! Legacy protocols terminate at a local relay; only Rust opens public upstreams.
use crate::{
    error::{AppError, Result},
    media_gateway::LocalInput,
    outbound::{BoxIo, NetworkTransport, validate_media_target},
};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
use url::{Position, Url};

pub async fn start(
    network: NetworkTransport,
    target: Url,
    cancel: CancellationToken,
) -> Result<LocalInput> {
    validate_media_target(&target)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| AppError::upstream())?;
    let address = listener.local_addr().map_err(|_| AppError::upstream())?;
    let scheme = match target.scheme() {
        "rtmps" => "rtmp",
        "rtsps" => "rtsp",
        other => other,
    };
    let mut local = target.clone();
    local.set_scheme(scheme).map_err(|_| AppError::upstream())?;
    local
        .set_host(Some("127.0.0.1"))
        .map_err(|_| AppError::upstream())?;
    local
        .set_port(Some(address.port()))
        .map_err(|_| AppError::upstream())?;
    let local_url = local.to_string();
    let current = Arc::new(Mutex::new((target, 0usize)));
    let task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                Some(_) = children.join_next(), if !children.is_empty() => {},
                accepted = listener.accept() => {
                    let Ok((socket,_)) = accepted else { break; };
                    if children.len() >= 4 { continue; }
                    let (network,local,current,cancel) = (network.clone(),local.clone(),current.clone(),cancel.clone());
                    children.spawn(async move {
                        let target = current.lock().unwrap().0.clone();
                        let work = async {
                            let mut upstream = network.open_media(&target).await?;
                            let mut socket = socket;
                            if matches!(target.scheme(), "rtsp" | "rtsps") {
                                rtsp(socket, upstream, target, local, network, current).await
                            } else {
                                if target.scheme() == "mmst" { rewrite_mmst_start(&mut socket, &mut upstream, &target).await?; }
                                tokio::io::copy_bidirectional(&mut socket, &mut upstream).await.map_err(|_| AppError::upstream())?;
                                Ok(())
                            }
                        };
                        tokio::select! { _ = cancel.cancelled() => {}, _ = work => {} }
                    });
                }
            }
        }
        children.abort_all();
    });
    Ok(LocalInput {
        url: local_url,
        tasks: vec![task],
    })
}

async fn rewrite_mmst_start(
    socket: &mut TcpStream,
    upstream: &mut BoxIo,
    target: &Url,
) -> Result<()> {
    let mut head = [0u8; 16];
    socket
        .read_exact(&mut head)
        .await
        .map_err(|_| AppError::upstream())?;
    let size = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
    if !(40..=8192).contains(&size) || &head[12..16] != b"MMS " {
        return Err(AppError::upstream());
    }
    let mut packet = head.to_vec();
    packet.resize(size + 16, 0);
    socket
        .read_exact(&mut packet[16..])
        .await
        .map_err(|_| AppError::upstream())?;
    let packet = mmst_start_packet(&packet, target.host_str().ok_or_else(AppError::upstream)?)?;
    upstream
        .write_all(&packet)
        .await
        .map_err(|_| AppError::upstream())
}

fn mmst_start_packet(packet: &[u8], host: &str) -> Result<Vec<u8>> {
    if packet.len() < 52 || packet[36..38] != [1, 0] {
        return Err(AppError::upstream());
    }
    let text =
        format!("NSPlayer/7.0.0.1956; {{7E667F5D-A661-495E-A512-F55686DDA178}}; Host: {host}");
    let mut out = packet[..52].to_vec();
    for c in text.encode_utf16().chain(std::iter::once(0)) {
        out.extend_from_slice(&c.to_le_bytes());
    }
    out.resize(out.len().div_ceil(8) * 8, 0);
    let size = (out.len() - 16) as u32;
    let words = size / 8;
    out[8..12].copy_from_slice(&size.to_le_bytes());
    out[16..20].copy_from_slice(&words.to_le_bytes());
    out[32..36].copy_from_slice(&(words - 2).to_le_bytes());
    Ok(out)
}

// RTSP messages and interleaved RTP share one TCP stream. Never edit RTP bytes.
async fn frame(io: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let first = io.read_u8().await.map_err(|_| AppError::upstream())?;
    let mut data = vec![first];
    if first == b'$' {
        let mut rest = [0; 3];
        io.read_exact(&mut rest)
            .await
            .map_err(|_| AppError::upstream())?;
        data.extend(rest);
        let size = u16::from_be_bytes([rest[1], rest[2]]) as usize;
        data.resize(4 + size, 0);
        io.read_exact(&mut data[4..])
            .await
            .map_err(|_| AppError::upstream())?;
        return Ok(data);
    }
    while !data.ends_with(b"\r\n\r\n") {
        if data.len() >= 32768 {
            return Err(AppError::upstream());
        }
        data.push(io.read_u8().await.map_err(|_| AppError::upstream())?);
    }
    let header = std::str::from_utf8(&data).map_err(|_| AppError::upstream())?;
    // FFmpeg accepts bare LF while this gateway frames CRLF. Reject ambiguous
    // header syntax so a hidden Location cannot bypass destination rewriting.
    for (index, line) in header.split("\r\n").enumerate() {
        if line.is_empty() {
            continue;
        }
        if index == 0 {
            if line.bytes().any(|byte| byte.is_ascii_control()) {
                return Err(AppError::upstream());
            }
        } else {
            let (name, value) = line.split_once(':').ok_or_else(AppError::upstream)?;
            axum::http::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| AppError::upstream())?;
            axum::http::HeaderValue::from_str(value).map_err(|_| AppError::upstream())?;
        }
    }

    let mut lengths = header
        .lines()
        .filter_map(|l| l.split_once(':'))
        .filter(|(n, _)| n.eq_ignore_ascii_case("content-length"));
    let length = lengths
        .next()
        .map(|(_, v)| v.trim().parse::<usize>())
        .transpose()
        .map_err(|_| AppError::upstream())?
        .unwrap_or(0);
    if length > 1024 * 1024 || lengths.next().is_some() {
        return Err(AppError::upstream());
    }
    let start = data.len();
    data.resize(start + length, 0);
    io.read_exact(&mut data[start..])
        .await
        .map_err(|_| AppError::upstream())?;
    Ok(data)
}

fn origin(url: &Url) -> &str {
    &url[..Position::BeforePath]
}
fn localize_url(raw: &str, target: &Url, local: &Url) -> Result<String> {
    let url = target.join(raw).map_err(|_| AppError::upstream())?;
    if !matches!(url.scheme(), "rtsp" | "rtsps")
        || url.host_str() != target.host_str()
        || validate_media_target(&url)?.1 != validate_media_target(target)?.1
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::upstream());
    }
    Ok(format!("{}{}", origin(local), &url[Position::BeforePath..]))
}

async fn rtsp(
    socket: TcpStream,
    upstream: BoxIo,
    target: Url,
    local: Url,
    network: NetworkTransport,
    current: Arc<Mutex<(Url, usize)>>,
) -> Result<()> {
    let (mut client_read, mut client_write) = socket.into_split();
    let (mut server_read, mut server_write) = tokio::io::split(upstream);
    let to_server = async {
        loop {
            let data = frame(&mut client_read).await?;
            let data = if data[0] == b'$' {
                data
            } else {
                let text = std::str::from_utf8(&data).map_err(|_| AppError::upstream())?;
                text.replace(origin(&local), origin(&target)).into_bytes()
            };
            server_write
                .write_all(&data)
                .await
                .map_err(|_| AppError::upstream())?;
        }
        #[allow(unreachable_code)]
        Ok::<(), AppError>(())
    };
    let to_client = async {
        loop {
            let data = frame(&mut server_read).await?;
            let data = if data[0] == b'$' {
                data
            } else {
                let text = std::str::from_utf8(&data).map_err(|_| AppError::upstream())?;
                let (headers, body) = text.split_once("\r\n\r\n").ok_or_else(AppError::upstream)?;
                let mut rewritten = String::new();
                for (index, line) in headers.split("\r\n").enumerate() {
                    if index == 0 {
                        rewritten.push_str(line);
                        rewritten.push_str("\r\n");
                        continue;
                    }
                    let (name, value) = line.split_once(':').ok_or_else(AppError::upstream)?;
                    let value = value.trim();
                    if name.eq_ignore_ascii_case("content-length") {
                        continue;
                    }
                    rewritten.push_str(name);
                    rewritten.push_str(": ");
                    if name.eq_ignore_ascii_case("location") {
                        let next = target.join(value).map_err(|_| AppError::upstream())?;
                        if !matches!(next.scheme(), "rtsp" | "rtsps") {
                            return Err(AppError::upstream());
                        }
                        {
                            if current.lock().unwrap().1 >= 6 {
                                return Err(AppError::upstream());
                            }
                        }
                        // Validate DNS and TLS before exposing a redirect. The next connection is checked again.
                        drop(network.open_media(&next).await?);
                        let value = format!("{}{}", origin(&local), &next[Position::BeforePath..]);
                        {
                            let mut current = current.lock().unwrap();
                            current.0 = next;
                            current.1 += 1;
                        }
                        rewritten.push_str(&value);
                    } else if name.eq_ignore_ascii_case("content-base")
                        || name.eq_ignore_ascii_case("content-location")
                    {
                        rewritten.push_str(&localize_url(value, &target, &local)?);
                    } else {
                        rewritten.push_str(value);
                    }
                    rewritten.push_str("\r\n");
                }
                let body = rewrite_sdp(body, &target, &local)?;
                rewritten.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
                rewritten.push_str(&body);
                rewritten.into_bytes()
            };
            client_write
                .write_all(&data)
                .await
                .map_err(|_| AppError::upstream())?;
        }
        #[allow(unreachable_code)]
        Ok::<(), AppError>(())
    };
    tokio::select! { result=to_server=>result, result=to_client=>result }
}

fn rewrite_sdp(body: &str, target: &Url, local: &Url) -> Result<String> {
    let mut out = String::new();
    for line in body.split_inclusive('\n') {
        if let Some(value) = line.strip_prefix("a=control:") {
            let value = value.trim();
            if value.contains("://") || value.starts_with("//") {
                out.push_str("a=control:");
                out.push_str(&localize_url(value, target, local)?);
                out.push_str("\r\n");
                continue;
            }
        }
        // Other absolute network URLs (including nested SDP indirections) are not passed to a demuxer.
        if line.contains("://") {
            return Err(AppError::upstream());
        }
        out.push_str(line);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mmst_rewrites_original_host_and_all_packet_lengths() {
        let mut packet = vec![0; 64];
        packet[36] = 1;
        let result = mmst_start_packet(&packet, "radio.example").unwrap_or_else(|_| panic!());
        assert_eq!(result.len() % 8, 0);
        assert_eq!(
            u32::from_le_bytes(result[8..12].try_into().unwrap()) as usize,
            result.len() - 16
        );
        let text = String::from_utf16_lossy(
            &result[52..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        );
        assert!(text.contains("Host: radio.example"));
    }
    #[test]
    fn sdp_control_stays_on_local_relay() {
        let target = Url::parse("rtsp://radio.example/live").unwrap();
        let local = Url::parse("rtsp://127.0.0.1:1234/live").unwrap();
        assert!(rewrite_sdp("a=control:rtsp://127.0.0.1/private\r\n", &target, &local).is_err());
        assert!(rewrite_sdp("a=control://127.0.0.1/private\r\n", &target, &local).is_err());
        assert!(
            rewrite_sdp("a=control:rtsp://radio.example/track\r\n", &target, &local)
                .unwrap_or_else(|_| panic!())
                .contains("127.0.0.1:1234/track")
        );
    }
    #[tokio::test]
    async fn ambiguous_rtsp_headers_cannot_smuggle_redirects_or_body_lengths() {
        for header in [
            "RTSP/1.0 302 Found\r\nX: a\nLocation: rtsp://127.0.0.1/private\r\n\r\n",
            "RTSP/1.0 200 OK\r\nContent-Length: 0\r\nContent-Length: 4\r\n\r\n",
            "RTSP/1.0 302 Found\r\n Location: rtsp://127.0.0.1/private\r\n\r\n",
            "RTSP/1.0 200 OK\r\nContent-Length : 4\r\n\r\n",
        ] {
            assert!(frame(&mut header.as_bytes()).await.is_err());
        }
    }
    #[tokio::test]
    async fn interleaved_rtp_is_not_text_rewritten() {
        let data = [b'$', 0, 0, 4, 0xff, 0, 1, 2];
        let mut io = &data[..];
        assert_eq!(frame(&mut io).await.unwrap_or_else(|_| panic!()), data);
    }
    async fn headers(io: &mut (impl AsyncRead + Unpin)) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 32768);
            bytes.push(io.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }
    #[tokio::test]
    async fn rtsp_rewrites_authority_and_blocks_private_redirect_before_ffmpeg() {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = crate::config::Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            database: "unused".into(),
            catalog_url: None,
            proxy: Some(format!("http://{}", proxy.local_addr().unwrap())),
            secure_cookie: false,
            registration: false,
            relay: true,
        };
        let server = tokio::spawn(async move {
            let (mut io, _) = proxy.accept().await.unwrap();
            assert!(
                headers(&mut io)
                    .await
                    .starts_with("CONNECT 1.1.1.1:554 HTTP/1.1")
            );
            io.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            let request = headers(&mut io).await;
            assert!(request.starts_with("OPTIONS rtsp://1.1.1.1:554/live RTSP/1.0"));
            io.write_all(b"RTSP/1.0 302 Found\r\nCSeq: 1\r\nLocation: rtsp://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        });
        let cancel = CancellationToken::new();
        let input = start(
            NetworkTransport::new(&config),
            Url::parse("rtsp://1.1.1.1:554/live").unwrap(),
            cancel.clone(),
        )
        .await
        .unwrap_or_else(|_| panic!());
        let local = Url::parse(&input.url).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", local.port().unwrap()))
            .await
            .unwrap();
        client
            .write_all(format!("OPTIONS {} RTSP/1.0\r\nCSeq: 1\r\n\r\n", input.url).as_bytes())
            .await
            .unwrap();
        let mut result = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.read_to_end(&mut result),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_empty(), "unsafe redirect must never reach FFmpeg");
        cancel.cancel();
        for task in input.tasks {
            task.await.unwrap();
        }
        server.await.unwrap();
    }
}
