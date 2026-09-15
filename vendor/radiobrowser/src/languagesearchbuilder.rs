use crate::ApiLanguage;
use crate::RadioBrowserAPI;
use std::fmt::Display;

use std::collections::HashMap;
use std::error::Error;

pub enum LanguageOrder {
    Name,
    StationCount,
}

impl Display for LanguageOrder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::result::Result<(), std::fmt::Error> {
        match self {
            LanguageOrder::Name => write!(f, "name"),
            LanguageOrder::StationCount => write!(f, "stationcount"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct LanguageSearchBuilder {
    map: HashMap<String, String>,
    api: RadioBrowserAPI,
    filter: Option<String>,
}

impl LanguageSearchBuilder {
    pub fn new(api: RadioBrowserAPI) -> Self {
        LanguageSearchBuilder {
            api,
            map: HashMap::new(),
            filter: None,
        }
    }

    pub fn filter<P: AsRef<str>>(mut self, filter: P) -> Self {
        self.filter = Some(filter.as_ref().to_string());
        self
    }

    pub fn order(mut self, order: LanguageOrder) -> Self {
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

    pub async fn send(mut self) -> Result<Vec<ApiLanguage>, Box<dyn Error>> {
        if let Some(filter) = self.filter {
            Ok(self
                .api
                .send(format!("/json/languages/{}", filter), self.map)
                .await?)
        } else {
            Ok(self.api.send("/json/languages", self.map).await?)
        }
    }
}
