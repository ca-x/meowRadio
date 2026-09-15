use crate::ApiCountry;
use crate::RadioBrowserAPI;
use std::fmt::Display;

use std::collections::HashMap;
use std::error::Error;

pub enum CountryOrder {
    Name,
    StationCount,
}

impl Display for CountryOrder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::result::Result<(), std::fmt::Error> {
        match self {
            CountryOrder::Name => write!(f, "name"),
            CountryOrder::StationCount => write!(f, "stationcount"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CountrySearchBuilder {
    map: HashMap<String, String>,
    api: RadioBrowserAPI,
    filter: Option<String>,
}

impl CountrySearchBuilder {
    pub fn new(api: RadioBrowserAPI) -> Self {
        CountrySearchBuilder {
            api,
            map: HashMap::new(),
            filter: None,
        }
    }

    pub fn filter<P: AsRef<str>>(mut self, filter: P) -> Self {
        self.filter = Some(filter.as_ref().to_string());
        self
    }

    pub fn order(mut self, order: CountryOrder) -> Self {
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

    pub async fn send(mut self) -> Result<Vec<ApiCountry>, Box<dyn Error>> {
        if let Some(filter) = self.filter {
            Ok(self
                .api
                .send(format!("/json/countries/{}", filter), self.map)
                .await?)
        } else {
            Ok(self.api.send("/json/countries", self.map).await?)
        }
    }
}
