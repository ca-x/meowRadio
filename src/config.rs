use std::{net::SocketAddr, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub listen: SocketAddr,
    pub database: PathBuf,
    pub catalog_url: Option<String>,
    pub proxy: Option<String>,
    pub secure_cookie: bool,
    pub registration: bool,
    pub relay: bool,
}
impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let proxy = std::env::var("MEOW_PROXY").ok().filter(|s| !s.is_empty());
        if let Some(ref p) = proxy {
            let u = url::Url::parse(p)?;
            anyhow::ensure!(
                matches!(u.scheme(), "http" | "https" | "socks5"),
                "MEOW_PROXY must use http, https or socks5 (local DNS)"
            );
            anyhow::ensure!(u.host_str().is_some(), "proxy host required");
        }
        let catalog_url = std::env::var("MEOW_CATALOG_URL")
            .ok()
            .filter(|s| !s.is_empty());
        if let Some(ref base) = catalog_url {
            let u = url::Url::parse(base)?;
            anyhow::ensure!(
                matches!(u.scheme(), "https" | "http") && u.host_str().is_some(),
                "invalid catalog URL"
            );
        }
        Ok(Self {
            listen: std::env::var("MEOW_LISTEN")
                .unwrap_or("0.0.0.0:3000".into())
                .parse()?,
            database: std::env::var("MEOW_DATABASE")
                .unwrap_or("data/meowradio.db".into())
                .into(),
            catalog_url,
            proxy,
            secure_cookie: flag("MEOW_SECURE_COOKIE", false),
            registration: flag("MEOW_REGISTRATION", true),
            relay: flag("MEOW_RELAY", true),
        })
    }
}
fn flag(key: &str, default: bool) -> bool {
    std::env::var(key)
        .map(|v| v == "true" || v == "1")
        .unwrap_or(default)
}
