//! Shared private-source contracts. URLs and options are data, never commands.
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaFormat {
    Auto,
    Hls,
    Mp3,
    Aac,
    Ogg,
    Flac,
    Wav,
    Asf,
    Flv,
    MpegTs,
    Mov,
    Matroska,
    Rtmp,
    Rtsp,
    Mms,
    Mmst,
    Mmsh,
}

#[derive(Clone, Debug)]
pub struct ResolvedSource {
    pub url: url::Url,
    pub headers: HeaderMap,
    pub format: MediaFormat,
}
