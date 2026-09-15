//! One-hop outbound requests. Every destination is resolved, checked and pinned
//! before dialing; callers must repeat this for every redirect and HLS resource.
use crate::{
    config::Config,
    error::{AppError, Result},
};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use http_body_util::{BodyExt, Empty};
use hyper::{body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use std::{future::Future, net::SocketAddr, pin::Pin, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    task::JoinHandle,
    time::timeout,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{self, ClientConfig, RootCertStore, pki_types::ServerName},
};
use url::Url;

const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Upstream {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Body,
}

pub trait Transport: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a Url,
        range: Option<&'a HeaderValue>,
    ) -> Pin<Box<dyn Future<Output = Result<Upstream>> + Send + 'a>>;
}

#[derive(Clone)]
pub struct NetworkTransport {
    proxy: Option<String>,
    tls: Arc<ClientConfig>,
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type BoxIo = Box<dyn Io>;

// A dropped relay body must also stop its connection task, including idle streams.
struct Connection(JoinHandle<()>);
impl Drop for Connection {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl NetworkTransport {
    pub fn new(config: &Config) -> Self {
        let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("supported TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Self {
            proxy: config.proxy.clone(),
            tls: Arc::new(tls),
        }
    }

    async fn fetch(&self, url: &Url, range: Option<&HeaderValue>) -> Result<Upstream> {
        let (host, port) = validate_url(url)?;
        let addresses: Vec<SocketAddr> =
            timeout(DNS_TIMEOUT, tokio::net::lookup_host((host.as_str(), port)))
                .await
                .map_err(|_| AppError::upstream())?
                .map_err(|_| AppError::upstream())?
                .collect();
        validate_addresses(&addresses)?;
        let proxy = self
            .proxy
            .as_deref()
            .map(Url::parse)
            .transpose()
            .map_err(|_| AppError::upstream())?;
        // The entire TCP/proxy/TLS handshake shares a deadline, including retries.
        let io = timeout(CONNECT_TIMEOUT, async {
            for address in &addresses {
                if let Ok(connection) = self.dial(url, &host, *address, proxy.as_ref()).await {
                    return Ok(connection);
                }
            }
            Err(AppError::upstream())
        })
        .await
        .map_err(|_| AppError::upstream())??;
        let request = origin_request(url, range)?;
        let (response, connection) = exchange(io, request).await?;
        let (parts, body) = response.into_parts();
        let stream = futures_util::stream::unfold(
            (body.into_data_stream(), connection, false),
            |(mut stream, connection, done)| async move {
                if done {
                    return None;
                }
                let item = match timeout(READ_TIMEOUT, stream.next()).await {
                    Ok(Some(Ok(bytes))) => Ok(bytes),
                    Ok(Some(Err(error))) => Err(std::io::Error::other(error)),
                    Ok(None) => return None,
                    Err(_) => Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "upstream read timeout",
                    )),
                };
                let done = item.is_err();
                Some((item, (stream, connection, done)))
            },
        );
        Ok(Upstream {
            status: parts.status,
            headers: parts.headers,
            body: Body::from_stream(stream),
        })
    }

    async fn dial(
        &self,
        url: &Url,
        host: &str,
        address: SocketAddr,
        proxy: Option<&Url>,
    ) -> Result<BoxIo> {
        let Some(proxy) = proxy else {
            let io: BoxIo = Box::new(
                TcpStream::connect(address)
                    .await
                    .map_err(|_| AppError::upstream())?,
            );
            return self.target_tls(io, url, host).await;
        };
        let proxy_host = proxy
            .host_str()
            .ok_or_else(AppError::upstream)?
            .trim_matches(['[', ']']);
        let proxy_port = proxy
            .port_or_known_default()
            .or_else(|| (proxy.scheme() == "socks5").then_some(1080))
            .ok_or_else(AppError::upstream)?;
        let (username, password) = proxy_credentials(proxy)?;
        if proxy.scheme() == "socks5" {
            let socket = TcpStream::connect((proxy_host, proxy_port))
                .await
                .map_err(|_| AppError::upstream())?;
            // SocketAddr encodes an IP in SOCKS, never a remotely resolved hostname.
            let socket = if proxy.username().is_empty() && proxy.password().is_none() {
                tokio_socks::tcp::Socks5Stream::connect_with_socket(socket, address).await
            } else {
                tokio_socks::tcp::Socks5Stream::connect_with_password_and_socket(
                    socket, address, &username, &password,
                )
                .await
            }
            .map_err(|_| AppError::upstream())?;
            return self.target_tls(Box::new(socket), url, host).await;
        }
        if !matches!(proxy.scheme(), "http" | "https") {
            return Err(AppError::upstream());
        }
        let mut io: BoxIo = Box::new(
            TcpStream::connect((proxy_host, proxy_port))
                .await
                .map_err(|_| AppError::upstream())?,
        );
        if proxy.scheme() == "https" {
            io = self.tls(io, proxy_host).await?;
        }
        let auth = if !proxy.username().is_empty() || proxy.password().is_some() {
            let mut value = HeaderValue::from_str(&format!(
                "Basic {}",
                STANDARD.encode(format!("{username}:{password}"))
            ))
            .map_err(|_| AppError::upstream())?;
            value.set_sensitive(true);
            Some(value)
        } else {
            None
        };
        // Tunnel HTTP too: a forwarding proxy may regenerate Host from an
        // absolute URI's pinned IP, breaking virtual-hosted radio endpoints.
        let io = connect_tunnel(io, address, auth).await?;
        self.target_tls(io, url, host).await
    }

    async fn target_tls(&self, io: BoxIo, url: &Url, host: &str) -> Result<BoxIo> {
        if url.scheme() == "https" {
            self.tls(io, host).await
        } else {
            Ok(io)
        }
    }

    async fn tls(&self, io: BoxIo, host: &str) -> Result<BoxIo> {
        let name = ServerName::try_from(host.to_owned()).map_err(|_| AppError::upstream())?;
        let stream = TlsConnector::from(self.tls.clone())
            .connect(name, io)
            .await
            .map_err(|_| AppError::upstream())?;
        Ok(Box::new(stream))
    }
}

impl Transport for NetworkTransport {
    fn get<'a>(
        &'a self,
        url: &'a Url,
        range: Option<&'a HeaderValue>,
    ) -> Pin<Box<dyn Future<Output = Result<Upstream>> + Send + 'a>> {
        Box::pin(self.fetch(url, range))
    }
}

fn validate_url(url: &Url) -> Result<(String, u16)> {
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
        .to_owned();
    let port = url.port_or_known_default().ok_or_else(AppError::upstream)?;
    if !matches!(port, 80 | 443 | 8000..=9999) {
        return Err(AppError::bad("电台端口不在中转支持范围内"));
    }
    Ok((host, port))
}

fn validate_addresses(addresses: &[SocketAddr]) -> Result<()> {
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !crate::relay::public_ip(address.ip()))
    {
        return Err(AppError::bad("中转仅允许公共互联网电台"));
    }
    Ok(())
}

fn authority(url: &Url) -> String {
    url[url::Position::BeforeHost..url::Position::AfterPort].to_owned()
}

fn origin_request(url: &Url, range: Option<&HeaderValue>) -> Result<Request<Empty<Bytes>>> {
    let mut request = Request::builder()
        .method("GET")
        .uri(&url[url::Position::BeforePath..url::Position::AfterQuery])
        .header(header::HOST, authority(url))
        .header(header::USER_AGENT, "meowRadio/0.1")
        .header(header::ACCEPT_ENCODING, "identity");
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    request
        .body(Empty::<Bytes>::new())
        .map_err(|_| AppError::upstream())
}

fn proxy_credentials(proxy: &Url) -> Result<(String, String)> {
    let decode = |s: &str| {
        percent_encoding::percent_decode_str(s)
            .decode_utf8()
            .map(|s| s.into_owned())
            .map_err(|_| AppError::upstream())
    };
    Ok((
        decode(proxy.username())?,
        decode(proxy.password().unwrap_or(""))?,
    ))
}

async fn exchange(
    io: BoxIo,
    request: Request<Empty<Bytes>>,
) -> Result<(hyper::Response<Incoming>, Connection)> {
    timeout(READ_TIMEOUT, async {
        let (mut sender, connection) = http1::Builder::new()
            .max_buf_size(32 * 1024)
            .handshake(TokioIo::new(io))
            .await
            .map_err(|_| AppError::upstream())?;
        let connection = Connection(tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        }));
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| AppError::upstream())?;
        Ok((response, connection))
    })
    .await
    .map_err(|_| AppError::upstream())?
}

async fn connect_tunnel(
    io: BoxIo,
    address: SocketAddr,
    auth: Option<HeaderValue>,
) -> Result<BoxIo> {
    let authority = address.to_string();
    let mut request = Request::builder()
        .method("CONNECT")
        .uri(&authority)
        .header(header::HOST, &authority);
    if let Some(auth) = auth {
        request = request.header(header::PROXY_AUTHORIZATION, auth);
    }
    let request = request
        .body(Empty::<Bytes>::new())
        .map_err(|_| AppError::upstream())?;
    let (response, _connection) = exchange(io, request).await?;
    if !response.status().is_success() {
        return Err(AppError::upstream());
    }
    let upgraded = hyper::upgrade::on(response)
        .await
        .map_err(|_| AppError::upstream())?;
    Ok(Box::new(TokioIo::new(upgraded)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn transport(proxy: Option<String>) -> NetworkTransport {
        NetworkTransport::new(&Config {
            listen: "127.0.0.1:3000".parse().unwrap(),
            database: "unused".into(),
            catalog_url: None,
            proxy,
            secure_cookie: false,
            registration: false,
            relay: true,
        })
    }

    async fn read_headers(io: &mut (impl AsyncRead + Unpin)) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 16 * 1024);
            bytes.push(io.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn rejects_credentials_schemes_ports_and_mixed_private_dns() {
        for url in [
            "file:///etc/passwd",
            "ftp://radio.example/",
            "http://user:pass@radio.example/",
            "http://radio.example:22/",
        ] {
            assert!(validate_url(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
        for addresses in [
            vec![],
            vec!["127.0.0.1:80"],
            vec!["1.1.1.1:80", "10.0.0.1:80"],
            vec!["[::ffff:127.0.0.1]:80"],
        ] {
            let addresses: Vec<_> = addresses.iter().map(|s| s.parse().unwrap()).collect();
            assert!(validate_addresses(&addresses).is_err());
        }
        assert!(validate_addresses(&["1.1.1.1:443".parse().unwrap()]).is_ok());
        let url = Url::parse("https://[2606:4700:4700::1111]:8443/path").unwrap();
        assert_eq!(authority(&url), "[2606:4700:4700::1111]:8443");
        assert_eq!(
            validate_url(&url)
                .unwrap_or_else(|_| panic!("valid IPv6 URL rejected"))
                .0,
            "2606:4700:4700::1111"
        );
    }

    #[tokio::test]
    async fn private_destination_rejected_before_proxy_connect() {
        let transport = transport(Some("http://127.0.0.1:1".into()));
        let error = transport
            .get(&Url::parse("http://127.0.0.1/").unwrap(), None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn http_proxy_pins_target_and_passes_range_without_following_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let transport = transport(Some(format!(
            "http://user:p%40ss@{}",
            listener.local_addr().unwrap()
        )));
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_headers(&mut socket).await.to_ascii_lowercase();
            assert!(request.starts_with("connect 1.1.1.1:8000 http/1.1\r\n"));
            assert!(request.contains("\r\nhost: 1.1.1.1:8000\r\n"));
            assert!(request.contains(&format!(
                "\r\nproxy-authorization: basic {}\r\n",
                STANDARD.encode("user:p@ss").to_ascii_lowercase()
            )));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            let request = read_headers(&mut socket).await.to_ascii_lowercase();
            assert!(request.starts_with("get /audio?key=abc http/1.1\r\n"));
            assert!(request.contains("\r\nhost: 1.1.1.1:8000\r\n"));
            assert!(request.contains("\r\nrange: bytes=10-20\r\n"));
            assert!(!request.contains("proxy-authorization"));
            assert!(!request.contains("\r\ncookie:"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        });
        let response = transport
            .get(
                &Url::parse("http://1.1.1.1:8000/audio?key=abc#fragment").unwrap(),
                Some(&HeaderValue::from_static("bytes=10-20")),
            )
            .await
            .unwrap_or_else(|_| panic!("request failed"));
        assert_eq!(response.status, StatusCode::FOUND);
        assert_eq!(
            response.headers[header::LOCATION],
            "http://127.0.0.1/private"
        );
        server.await.unwrap();
    }

    async fn proxy_fixture(trust_certificate: bool, https_proxy: bool, https_target: bool) {
        let port = if https_target { 443 } else { 80 };
        let certified =
            rcgen::generate_simple_self_signed(vec!["radio.example".into(), "127.0.0.1".into()])
                .unwrap();
        let certificate = certified.cert.der().clone();
        let server_config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der())
                .into(),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = Url::parse(&format!(
            "{}://user:secret@{}",
            if https_proxy { "https" } else { "http" },
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let mut transport = transport(None);
        if trust_certificate {
            let mut roots = RootCertStore::empty();
            roots.add(certificate).unwrap();
            transport.tls = Arc::new(
                ClientConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
            );
        }
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let server_config = Arc::new(server_config);
            let mut socket: BoxIo = if https_proxy {
                Box::new(
                    tokio_rustls::TlsAcceptor::from(server_config.clone())
                        .accept(socket)
                        .await
                        .unwrap(),
                )
            } else {
                Box::new(socket)
            };
            let request = read_headers(&mut socket).await.to_ascii_lowercase();
            assert!(request.starts_with(&format!("connect 1.1.1.1:{port} http/1.1\r\n")));
            assert!(request.contains(&format!("\r\nhost: 1.1.1.1:{port}\r\n")));
            assert!(request.contains("\r\nproxy-authorization: basic "));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            let mut stream: BoxIo = if https_target {
                let hello = tokio_rustls::LazyConfigAcceptor::new(
                    rustls::server::Acceptor::default(),
                    socket,
                )
                .await
                .unwrap();
                assert_eq!(hello.client_hello().server_name(), Some("radio.example"));
                let stream = hello.into_stream(server_config).await;
                if !trust_certificate {
                    assert!(
                        stream.is_err(),
                        "untrusted certificate must fail verification"
                    );
                    return;
                }
                Box::new(stream.unwrap())
            } else {
                socket
            };
            let request = read_headers(&mut stream).await.to_ascii_lowercase();
            assert!(request.starts_with("get /live?token=test http/1.1\r\n"));
            assert!(request.contains("\r\nhost: radio.example\r\n"));
            assert!(request.contains("\r\nrange: bytes=10-20\r\n"));
            assert!(!request.contains("proxy-authorization"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\naudio")
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
        });
        let url = Url::parse(&format!(
            "{}://radio.example/live?token=test#ignored",
            if https_target { "https" } else { "http" }
        ))
        .unwrap();
        let result = transport
            .dial(
                &url,
                "radio.example",
                format!("1.1.1.1:{port}").parse().unwrap(),
                Some(&proxy),
            )
            .await;
        if trust_certificate {
            let io = result.unwrap_or_else(|_| panic!("proxy connection failed"));
            let request = origin_request(&url, Some(&HeaderValue::from_static("bytes=10-20")))
                .unwrap_or_else(|_| panic!("request failed"));
            let (response, _connection) = exchange(io, request)
                .await
                .unwrap_or_else(|_| panic!("request failed"));
            assert_eq!(
                response.into_body().collect().await.unwrap().to_bytes(),
                "audio"
            );
        } else {
            assert!(result.is_err());
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn https_connect_uses_pinned_ip_original_sni_and_private_proxy_auth() {
        proxy_fixture(true, false, true).await;
    }

    #[tokio::test]
    async fn https_connect_rejects_untrusted_certificate() {
        proxy_fixture(false, false, true).await;
    }

    #[tokio::test]
    async fn https_proxy_supports_nested_verified_target_tls() {
        proxy_fixture(true, true, true).await;
    }

    #[tokio::test]
    async fn http_proxy_tunnels_http_with_original_hostname_range_and_private_proxy_auth() {
        proxy_fixture(true, false, false).await;
    }

    #[tokio::test]
    async fn https_proxy_tunnels_http_with_original_hostname_range_and_private_proxy_auth() {
        proxy_fixture(true, true, false).await;
    }

    #[tokio::test]
    async fn connect_rejects_proxy_auth_policy_redirect_and_upstream_failures() {
        for status in [
            "407 Proxy Authentication Required",
            "403 Forbidden",
            "302 Found",
            "502 Bad Gateway",
        ] {
            let (client, mut proxy) = tokio::io::duplex(1024);
            let server = tokio::spawn(async move {
                let request = read_headers(&mut proxy).await;
                assert!(request.starts_with("CONNECT 1.1.1.1:80 HTTP/1.1\r\n"));
                proxy
                    .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
                assert_eq!(
                    proxy.read(&mut [0; 1]).await.unwrap(),
                    0,
                    "failed CONNECT must not send an origin request"
                );
            });
            let result =
                connect_tunnel(Box::new(client), "1.1.1.1:80".parse().unwrap(), None).await;
            assert_eq!(
                result.err().expect("failed CONNECT accepted").0,
                StatusCode::BAD_GATEWAY
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn connect_formats_ipv6_authority_and_keeps_buffered_tunnel_bytes() {
        let (client, mut proxy) = tokio::io::duplex(1024);
        let server = tokio::spawn(async move {
            let request = read_headers(&mut proxy).await.to_ascii_lowercase();
            assert!(request.starts_with("connect [2606:4700:4700::1111]:443 http/1.1\r\n"));
            proxy
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nhello")
                .await
                .unwrap();
        });
        let mut tunnel = connect_tunnel(
            Box::new(client),
            "[2606:4700:4700::1111]:443".parse().unwrap(),
            None,
        )
        .await
        .unwrap_or_else(|_| panic!("CONNECT failed"));
        let mut bytes = [0; 5];
        tunnel.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"hello");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks_proxy_receives_ip_instead_of_hostname() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let transport = transport(Some(format!("socks5://{}", listener.local_addr().unwrap())));
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(socket.read_u8().await.unwrap(), 5);
            let count = socket.read_u8().await.unwrap();
            let mut methods = vec![0; count as usize];
            socket.read_exact(&mut methods).await.unwrap();
            assert!(methods.contains(&0));
            socket.write_all(&[5, 0]).await.unwrap();
            let mut connect = [0; 10];
            socket.read_exact(&mut connect).await.unwrap();
            assert_eq!(connect, [5, 1, 0, 1, 1, 1, 1, 1, 0, 80]);
            socket
                .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            let request = read_headers(&mut socket).await.to_ascii_lowercase();
            assert!(request.starts_with("get /live http/1.1\r\n"));
            assert!(!request.contains("proxy-authorization"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\naudio")
                .await
                .unwrap();
        });
        let response = transport
            .get(&Url::parse("http://1.1.1.1/live").unwrap(), None)
            .await
            .unwrap_or_else(|_| panic!("SOCKS request failed"));
        assert_eq!(response.body.collect().await.unwrap().to_bytes(), "audio");
        server.await.unwrap();
    }
}
