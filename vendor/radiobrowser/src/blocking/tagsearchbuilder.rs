use crate::ApiTag;
use async_std::task;
use std::error::Error;

#[derive(Clone, Debug)]
pub struct TagSearchBuilder {
    builder: crate::TagSearchBuilder,
}

impl TagSearchBuilder {
    pub fn new(builder: crate::TagSearchBuilder) -> Self {
        TagSearchBuilder { builder }
    }

    pub fn filter<P: AsRef<str>>(self, filter: P) -> Self {
        TagSearchBuilder {
            builder: self.builder.filter(filter.as_ref().to_string()),
        }
    }

    pub fn order(self, order: crate::TagOrder) -> Self {
        TagSearchBuilder {
            builder: self.builder.order(order),
        }
    }

    pub fn reverse(self, reverse: bool) -> Self {
        TagSearchBuilder {
            builder: self.builder.reverse(reverse),
        }
    }

    pub fn offset<P: AsRef<str>>(self, offset: P) -> Self {
        TagSearchBuilder {
            builder: self.builder.offset(offset),
        }
    }

    pub fn limit<P: AsRef<str>>(self, limit: P) -> Self {
        TagSearchBuilder {
            builder: self.builder.limit(limit),
        }
    }

    pub fn hidebroken(self, hidebroken: bool) -> Self {
        TagSearchBuilder {
            builder: self.builder.hidebroken(hidebroken),
        }
    }

    pub fn send(self) -> Result<Vec<ApiTag>, Box<dyn Error>> {
        task::block_on(async { self.builder.send().await })
    }
}
