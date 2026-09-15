use crate::ApiTag;
use crate::RadioBrowserAPI;
use std::fmt::Display;

use std::collections::HashMap;
use std::error::Error;

pub enum TagOrder {
    Name,
    StationCount,
}

impl Display for TagOrder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::result::Result<(), std::fmt::Error> {
        match self {
            TagOrder::Name => write!(f, "name"),
            TagOrder::StationCount => write!(f, "stationcount"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TagSearchBuilder {
    map: HashMap<String, String>,
    api: RadioBrowserAPI,
    filter: Option<String>,
}

impl TagSearchBuilder {
    pub fn new(api: RadioBrowserAPI) -> Self {
        TagSearchBuilder {
            api,
            map: HashMap::new(),
            filter: None,
        }
    }

    pub fn filter<P: AsRef<str>>(mut self, filter: P) -> Self {
        self.filter = Some(filter.as_ref().to_string());
        self
    }

    pub fn order(mut self, order: TagOrder) -> Self {
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

    pub async fn send(mut self) -> Result<Vec<ApiTag>, Box<dyn Error>> {
        if let Some(filter) = self.filter {
            Ok(self
                .api
                .send(format!("/json/tags/{}", filter), self.map)
                .await?)
        } else {
            Ok(self.api.send("/json/tags", self.map).await?)
        }
    }
}
