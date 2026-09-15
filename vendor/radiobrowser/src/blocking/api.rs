use crate::ApiStationHistory;
use crate::blocking::stationsearchbuilder::StationSearchBuilder;
use crate::blocking::CountrySearchBuilder;
use crate::blocking::LanguageSearchBuilder;
use crate::blocking::TagSearchBuilder;
use crate::ApiStationClickResult;
use crate::ApiStationVoteResult;
use crate::ApiStatus;
use crate::ApiConfig;

use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::error::Error;

#[derive(Clone, Debug)]
pub struct RadioBrowserAPI {
    api: crate::RadioBrowserAPI,
}

use async_std::task;

impl RadioBrowserAPI {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        task::block_on(async { crate::RadioBrowserAPI::new().await })
            .map(|api| RadioBrowserAPI { api })
    }

    pub fn new_from_dns_a<P: AsRef<str>>(dnsname: P) -> Result<Self, Box<dyn Error>> {
        task::block_on(async { crate::RadioBrowserAPI::new_from_dns_a(dnsname).await })
            .map(|api| RadioBrowserAPI { api })
    }

    pub fn new_from_dns_srv<P: AsRef<str>>(srvname: P) -> Result<Self, Box<dyn Error>> {
        task::block_on(async { crate::RadioBrowserAPI::new_from_dns_srv(srvname).await })
            .map(|api| RadioBrowserAPI { api })
    }

    pub fn get_server_status(&mut self) -> Result<ApiStatus, Box<dyn Error>> {
        task::block_on(async { self.api.get_server_status().await })
    }

    pub fn get_station_changes(&mut self, limit: u64, last_change_uuid: Option<String>) -> Result<Vec<ApiStationHistory>, Box<dyn Error>> {
        task::block_on(async { self.api.get_station_changes(limit, last_change_uuid).await })
    }

    pub fn get_server_config(&mut self) -> Result<ApiConfig, Box<dyn Error>> {
        task::block_on(async { self.api.get_server_config().await })
    }

    /// Add a click to a station found by stationuuid
    pub fn station_click<P: AsRef<str>>(&mut self, stationuuid: P) -> Result<ApiStationClickResult, Box<dyn Error>> {
        task::block_on(async { self.api.station_click(stationuuid).await })
    }

    /// Add a vote to a station found by a stationuuid
    pub fn station_vote<P: AsRef<str>>(&mut self, stationuuid: P) -> Result<ApiStationVoteResult, Box<dyn Error>> {
        task::block_on(async { self.api.station_vote(stationuuid).await })
    }

    pub fn get_stations(&self) -> StationSearchBuilder {
        StationSearchBuilder::new(self.api.get_stations())
    }

    pub fn get_countries(&self) -> CountrySearchBuilder {
        CountrySearchBuilder::new(self.api.get_countries())
    }

    pub fn get_languages(&self) -> LanguageSearchBuilder {
        LanguageSearchBuilder::new(self.api.get_languages())
    }

    pub fn get_tags(&self) -> TagSearchBuilder {
        TagSearchBuilder::new(self.api.get_tags())
    }

    pub fn send<P: AsRef<str>, Q: DeserializeOwned>(
        &mut self,
        endpoint: P,
        mapjson: HashMap<String, String>,
    ) -> Result<Q, Box<dyn Error>> {
        task::block_on(async { self.api.send(endpoint, mapjson).await })
    }

    pub fn get_default_servers() -> Result<Vec<String>, Box<dyn Error>> {
        task::block_on(async { crate::RadioBrowserAPI::get_default_servers().await })
    }
}
