use crate::api::RadioBrowserAPI;
use crate::structs::ApiStation;
use std::fmt::Display;

use std::collections::HashMap;
use std::error::Error;

pub enum StationOrder {
    Name,
    Url,
    Homepage,
    Favicon,
    Tags,
    Country,
    State,
    Language,
    Votes,
    Codec,
    Bitrate,
    Lastcheckok,
    Lastchecktime,
    Clicktimestamp,
    Clickcount,
    Clicktrend,
    Changetimestamp,
    Random,
}

impl Display for StationOrder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::result::Result<(), std::fmt::Error> {
        match self {
            StationOrder::Name => write!(f, "name"),
            StationOrder::Url => write!(f, "url"),
            StationOrder::Homepage => write!(f, "homepage"),
            StationOrder::Favicon => write!(f, "favicon"),
            StationOrder::Tags => write!(f, "tags"),
            StationOrder::Country => write!(f, "country"),
            StationOrder::State => write!(f, "state"),
            StationOrder::Language => write!(f, "language"),
            StationOrder::Votes => write!(f, "votes"),
            StationOrder::Codec => write!(f, "codec"),
            StationOrder::Bitrate => write!(f, "bitrate"),
            StationOrder::Lastcheckok => write!(f, "lastcheckok"),
            StationOrder::Lastchecktime => write!(f, "lastchecktime"),
            StationOrder::Clicktimestamp => write!(f, "clicktimestamp"),
            StationOrder::Clickcount => write!(f, "clickcount"),
            StationOrder::Clicktrend => write!(f, "clicktrend"),
            StationOrder::Changetimestamp => write!(f, "changetimestamp"),
            StationOrder::Random => write!(f, "random"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StationSearchBuilder {
    map: HashMap<String, String>,
    api: RadioBrowserAPI,
}

impl StationSearchBuilder {
    pub fn new(api: RadioBrowserAPI) -> Self {
        StationSearchBuilder {
            api,
            map: HashMap::new(),
        }
    }

    pub fn name<P: AsRef<str>>(mut self, name: P) -> Self {
        self.map
            .insert(String::from("name"), name.as_ref().to_string());
        self
    }

    pub fn name_exact(mut self, name_exact: bool) -> Self {
        self.map
            .insert(String::from("nameExact"), name_exact.to_string());
        self
    }

    pub fn country<P: AsRef<str>>(mut self, country: P) -> Self {
        self.map
            .insert(String::from("country"), country.as_ref().to_string());
        self
    }

    pub fn country_exact(mut self, country_exact: bool) -> Self {
        self.map
            .insert(String::from("countryExact"), country_exact.to_string());
        self
    }

    pub fn countrycode<P: AsRef<str>>(mut self, countrycode: P) -> Self {
        self.map.insert(
            String::from("countrycode"),
            countrycode.as_ref().to_string(),
        );
        self
    }

    pub fn state<P: AsRef<str>>(mut self, state: P) -> Self {
        self.map
            .insert(String::from("state"), state.as_ref().to_string());
        self
    }

    pub fn state_exact(mut self, state_exact: bool) -> Self {
        self.map
            .insert(String::from("stateExact"), state_exact.to_string());
        self
    }

    pub fn language<P: AsRef<str>>(mut self, language: P) -> Self {
        self.map
            .insert(String::from("language"), language.as_ref().to_string());
        self
    }

    pub fn language_exact(mut self, language_exact: bool) -> Self {
        self.map
            .insert(String::from("languageExact"), language_exact.to_string());
        self
    }

    pub fn tag<P: AsRef<str>>(mut self, tag: P) -> Self {
        self.map
            .insert(String::from("tag"), tag.as_ref().to_string());
        self
    }

    pub fn tag_exact(mut self, tag_exact: bool) -> Self {
        self.map
            .insert(String::from("tagExact"), tag_exact.to_string());
        self
    }

    pub fn tag_list(mut self, tags: Vec<&str>) -> Self {
        self.map
            .insert(String::from("tagList"), tags.join(","));
        self
    }

    pub fn codec<P: AsRef<str>>(mut self, codec: P) -> Self {
        self.map
            .insert(String::from("codec"), codec.as_ref().to_string());
        self
    }

    pub fn bitrate_min(mut self, bitrate_min: u16) -> Self {
        self.map
            .insert(String::from("bitrateMin"), bitrate_min.to_string());
        self
    }

    pub fn bitrate_max(mut self, bitrate_max: u16) -> Self {
        self.map
            .insert(String::from("bitrateMax"), bitrate_max.to_string());
        self
    }

    pub fn has_geo_info(mut self, has_geo_info: bool) -> Self {
        self.map
            .insert(String::from("has_geo_info"), has_geo_info.to_string());
        self
    }

    pub fn has_extended_info(mut self, has_extended_info: bool) -> Self {
        self.map.insert(
            String::from("has_extended_info"),
            has_extended_info.to_string(),
        );
        self
    }

    pub fn is_https(mut self, is_https: bool) -> Self {
        self.map
            .insert(String::from("is_https"), is_https.to_string());
        self
    }

    pub fn order(mut self, order: StationOrder) -> Self {
        self.map.insert(String::from("order"), order.to_string());
        self
    }

    pub fn reverse(mut self, reverse: bool) -> Self {
        self.map
            .insert(String::from("reverse"), reverse.to_string());
        self
    }

    pub fn offset<P: AsRef<str>>(mut self, offset: P) -> Self {
        self.map
            .insert(String::from("offset"), offset.as_ref().to_string());
        self
    }

    pub fn limit<P: AsRef<str>>(mut self, limit: P) -> Self {
        self.map
            .insert(String::from("limit"), limit.as_ref().to_string());
        self
    }

    pub fn hidebroken(mut self, hidebroken: bool) -> Self {
        self.map
            .insert(String::from("hidebroken"), hidebroken.to_string());
        self
    }

    pub async fn send(mut self) -> Result<Vec<ApiStation>, Box<dyn Error>> {
        Ok(self.api.send("/json/stations/search", self.map).await?)
    }
}
