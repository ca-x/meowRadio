use crate::ApiCountry;
use async_std::task;
use std::error::Error;

#[derive(Clone, Debug)]
pub struct CountrySearchBuilder {
    builder: crate::CountrySearchBuilder,
}

impl CountrySearchBuilder {
    pub fn new(builder: crate::CountrySearchBuilder) -> Self {
        CountrySearchBuilder { builder }
    }

    pub fn filter<P: AsRef<str>>(self, filter: P) -> Self {
        CountrySearchBuilder {
            builder: self.builder.filter(filter.as_ref().to_string()),
        }
    }

    pub fn order(self, order: crate::CountryOrder) -> Self {
        CountrySearchBuilder {
            builder: self.builder.order(order),
        }
    }

    pub fn reverse(self, reverse: bool) -> Self {
        CountrySearchBuilder {
            builder: self.builder.reverse(reverse),
        }
    }

    pub fn offset<P: AsRef<str>>(self, offset: P) -> Self {
        CountrySearchBuilder {
            builder: self.builder.offset(offset),
        }
    }

    pub fn limit<P: AsRef<str>>(self, limit: P) -> Self {
        CountrySearchBuilder {
            builder: self.builder.limit(limit),
        }
    }

    pub fn hidebroken(self, hidebroken: bool) -> Self {
        CountrySearchBuilder {
            builder: self.builder.hidebroken(hidebroken),
        }
    }

    pub fn send(self) -> Result<Vec<ApiCountry>, Box<dyn Error>> {
        task::block_on(async { self.builder.send().await })
    }
}
