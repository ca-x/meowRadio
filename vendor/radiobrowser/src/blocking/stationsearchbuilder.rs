use crate::structs::ApiStation;
use crate::StationOrder;
use async_std::task;
use std::error::Error;

#[derive(Clone, Debug)]
pub struct StationSearchBuilder {
    builder: crate::StationSearchBuilder,
}

impl StationSearchBuilder {
    pub fn new(builder: crate::StationSearchBuilder) -> Self {
        StationSearchBuilder { builder }
    }

    pub fn name<P: AsRef<str>>(self, name: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.name(name),
        }
    }

    pub fn name_exact(self, name_exact: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.name_exact(name_exact),
        }
    }

    pub fn country<P: AsRef<str>>(self, country: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.country(country),
        }
    }

    pub fn country_exact(self, country_exact: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.country_exact(country_exact),
        }
    }

    pub fn countrycode<P: AsRef<str>>(self, countrycode: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.countrycode(countrycode),
        }
    }

    pub fn state<P: AsRef<str>>(self, state: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.state(state),
        }
    }

    pub fn state_exact(self, state_exact: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.state_exact(state_exact),
        }
    }

    pub fn language<P: AsRef<str>>(self, language: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.language(language),
        }
    }

    pub fn language_exact(self, language_exact: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.language_exact(language_exact),
        }
    }

    pub fn tag<P: AsRef<str>>(self, tag: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.tag(tag),
        }
    }

    pub fn tag_exact(self, tag_exact: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.tag_exact(tag_exact),
        }
    }

    pub fn tag_list(self, tags: Vec<&str>) -> Self {
        StationSearchBuilder {
            builder: self.builder.tag_list(tags),
        }
    }

    pub fn codec<P: AsRef<str>>(self, codec: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.codec(codec),
        }
    }

    pub fn bitrate_min(self, bitrate_min: u16) -> Self {
        StationSearchBuilder {
            builder: self.builder.bitrate_min(bitrate_min),
        }
    }

    pub fn bitrate_max(self, bitrate_max: u16) -> Self {
        StationSearchBuilder {
            builder: self.builder.bitrate_max(bitrate_max),
        }
    }

    pub fn has_geo_info(self, has_geo_info: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.has_geo_info(has_geo_info),
        }
    }

    pub fn has_extended_info(self, has_extended_info: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.has_extended_info(has_extended_info),
        }
    }

    pub fn is_https(self, is_https: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.is_https(is_https),
        }
    }

    pub fn order(self, order: StationOrder) -> Self {
        StationSearchBuilder {
            builder: self.builder.order(order),
        }
    }

    pub fn reverse(self, reverse: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.reverse(reverse),
        }
    }

    pub fn offset<P: AsRef<str>>(self, offset: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.offset(offset),
        }
    }

    pub fn limit<P: AsRef<str>>(self, limit: P) -> Self {
        StationSearchBuilder {
            builder: self.builder.limit(limit),
        }
    }

    pub fn hidebroken(self, hidebroken: bool) -> Self {
        StationSearchBuilder {
            builder: self.builder.hidebroken(hidebroken),
        }
    }

    pub fn send(self) -> Result<Vec<ApiStation>, Box<dyn Error>> {
        task::block_on(async { self.builder.send().await })
    }
}
