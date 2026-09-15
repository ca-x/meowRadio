#[cfg(feature = "chrono")]
use chrono::DateTime;
#[cfg(feature = "chrono")]
use chrono::Utc;
use serde::Deserialize;

/// Radiobrowser status and statistical information of single server.
#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStatus {
    pub supported_version: u32,
    pub software_version: Option<String>,
    pub status: String,
    pub stations: u64,
    pub stations_broken: u64,
    pub tags: u64,
    pub clicks_last_hour: u64,
    pub clicks_last_day: u64,
    pub languages: u64,
    pub countries: u64,
}

#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStationAddResult {
    pub ok: bool,
    pub message: String,
    pub uuid: String,
}

#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStationVoteResult {
    pub ok: bool,
    pub message: String,
}

#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStationClickResult {
    pub ok: bool,
    pub message: String,
}

#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiCodec {
    name: String,
    stationcount: u64,
}

/// A single station entry
#[derive(PartialEq, Deserialize, Debug, Clone)]
pub struct ApiStation {
    pub changeuuid: String,
    pub stationuuid: String,
    pub serveruuid: Option<String>,
    pub name: String,
    pub url: String,
    pub url_resolved: String,
    pub homepage: String,
    pub favicon: String,
    pub tags: String,
    pub country: String,
    pub countrycode: String,
    pub iso_3166_2: Option<String>,
    pub state: String,
    pub language: String,
    pub languagecodes: Option<String>,
    pub votes: i32,
    #[cfg(feature = "chrono")]
    pub lastchangetime_iso8601: Option<DateTime<Utc>>,
    #[cfg(not(feature = "chrono"))]
    pub lastchangetime_iso8601: Option<String>,
    pub codec: String,
    pub bitrate: u32,
    pub hls: i8,
    pub lastcheckok: i8,
    #[cfg(feature = "chrono")]
    pub lastchecktime_iso8601: Option<DateTime<Utc>>,
    #[cfg(feature = "chrono")]
    pub lastcheckoktime_iso8601: Option<DateTime<Utc>>,
    #[cfg(feature = "chrono")]
    pub lastlocalchecktime_iso8601: Option<DateTime<Utc>>,
    #[cfg(feature = "chrono")]
    pub clicktimestamp_iso8601: Option<DateTime<Utc>>,
    #[cfg(not(feature = "chrono"))]
    pub lastchecktime_iso8601: Option<String>,
    #[cfg(not(feature = "chrono"))]
    pub lastcheckoktime_iso8601: Option<String>,
    #[cfg(not(feature = "chrono"))]
    pub lastlocalchecktime_iso8601: Option<String>,
    #[cfg(not(feature = "chrono"))]
    pub clicktimestamp_iso8601: Option<String>,
    pub clickcount: u32,
    pub clicktrend: i32,
    pub ssl_error: Option<u8>,
    pub geo_lat: Option<f64>,
    pub geo_long: Option<f64>,
    pub has_extended_info: Option<bool>,
}

/// A single historical entry for a station
#[derive(PartialEq, Deserialize, Debug, Clone)]
pub struct ApiStationHistory {
    pub changeuuid: String,
    pub stationuuid: String,
    pub name: String,
    pub url: String,
    pub homepage: String,
    pub favicon: String,
    pub tags: String,
    pub country: String,
    pub countrycode: String,
    pub state: String,
    pub language: String,
    pub languagecodes: Option<String>,
    pub votes: i32,
    #[cfg(feature = "chrono")]
    pub lastchangetime_iso8601: Option<DateTime<Utc>>,
    #[cfg(not(feature = "chrono"))]
    pub lastchangetime_iso8601: Option<String>,
    pub geo_lat: Option<f64>,
    pub geo_long: Option<f64>,
}

/// A click event for a station
#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStationClick {
    pub stationuuid: String,
    pub clickuuid: String,
    #[cfg(feature = "chrono")]
    pub clicktimestamp_iso8601: Option<DateTime<Utc>>,
    #[cfg(not(feature = "chrono"))]
    pub clicktimestamp_iso8601: Option<String>,
}

/// A single step of a check action for a station
#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStationCheckStep {
    pub stepuuid: String,
    pub parent_stepuuid: Option<String>,
    pub checkuuid: String,
    pub stationuuid: String,
    pub url: String,
    pub urltype: Option<String>,
    pub error: Option<String>,
    #[cfg(feature = "chrono")]
    pub creation_iso8601: DateTime<Utc>,
    #[cfg(not(feature = "chrono"))]
    pub creation_iso8601: String,
}

/// A single country
#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiCountry {
    pub name: String,
    pub iso_3166_1: String,
    pub stationcount: u32,
}

/// A single language
#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiLanguage {
    pub name: String,
    pub iso_639: Option<String>,
    pub stationcount: u32,
}

/// A single tag
#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiTag {
    pub name: String,
    pub stationcount: u32,
}

#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiStreamingServer {
    pub uuid: String,
    pub url: String,
    pub statusurl: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
}

#[derive(PartialEq, Eq, Deserialize, Debug, Clone)]
pub struct ApiConfig {
    pub check_enabled: bool,
    pub prometheus_exporter_enabled: bool,
    pub pull_servers: Vec<String>,
    pub tcp_timeout_seconds: u32,
    pub broken_stations_never_working_timeout_seconds: u32,
    pub broken_stations_timeout_seconds: u32,
    pub checks_timeout_seconds: u32,
    pub click_valid_timeout_seconds: u32,
    pub clicks_timeout_seconds: u32,
    pub mirror_pull_interval_seconds: u32,
    pub update_caches_interval_seconds: u32,
    pub server_name: String,
    pub server_location: String,
    pub server_country_code: String,
    pub check_retries: u32,
    pub check_batchsize: u32,
    pub check_pause_seconds: u32,
    pub api_threads: u32,
    pub cache_type: String,
    pub cache_ttl: u32,
    pub language_replace_filepath: String,
    pub language_to_code_filepath: String,
}
