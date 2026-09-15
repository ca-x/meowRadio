use crate::ApiLanguage;
use async_std::task;
use std::error::Error;

#[derive(Clone, Debug)]
pub struct LanguageSearchBuilder {
    builder: crate::LanguageSearchBuilder,
}

impl LanguageSearchBuilder {
    pub fn new(builder: crate::LanguageSearchBuilder) -> Self {
        LanguageSearchBuilder { builder }
    }

    pub fn filter<P: AsRef<str>>(self, filter: P) -> Self {
        LanguageSearchBuilder {
            builder: self.builder.filter(filter.as_ref().to_string()),
        }
    }

    pub fn order(self, order: crate::LanguageOrder) -> Self {
        LanguageSearchBuilder {
            builder: self.builder.order(order),
        }
    }

    pub fn reverse(self, reverse: bool) -> Self {
        LanguageSearchBuilder {
            builder: self.builder.reverse(reverse),
        }
    }

    pub fn offset<P: AsRef<str>>(self, offset: P) -> Self {
        LanguageSearchBuilder {
            builder: self.builder.offset(offset),
        }
    }

    pub fn limit<P: AsRef<str>>(self, limit: P) -> Self {
        LanguageSearchBuilder {
            builder: self.builder.limit(limit),
        }
    }

    pub fn hidebroken(self, hidebroken: bool) -> Self {
        LanguageSearchBuilder {
            builder: self.builder.hidebroken(hidebroken),
        }
    }

    pub fn send(self) -> Result<Vec<ApiLanguage>, Box<dyn Error>> {
        task::block_on(async { self.builder.send().await })
    }
}
