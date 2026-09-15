use crate::{
    AppState,
    catalog::Catalog,
    error::{AppError, Result},
};
use axum::{Json, extract::State, http::StatusCode};
use radiobrowser::{ApiCountry, ApiLanguage, ApiTag};
use serde::{Serialize, de::DeserializeOwned};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
pub struct Facet {
    pub value: String,
    pub label: String,
    pub count: u32,
}
#[derive(Clone, Serialize)]
pub struct Directory {
    pub countries: Vec<Facet>,
    pub languages: Vec<Facet>,
    pub tags: Vec<Facet>,
}
impl Catalog {
    async fn facet_request<T: DeserializeOwned>(&self, path: &str, limit: u16) -> Result<Vec<T>> {
        let bases = match self.config.catalog_url.as_deref() {
            Some(base) => vec![base],
            None => vec![
                "https://de1.api.radio-browser.info",
                "https://nl1.api.radio-browser.info",
            ],
        };
        for base in bases {
            let result = self.client.post(format!("{}{path}",base.trim_end_matches('/')))
                .json(&serde_json::json!({"hidebroken":"true","limit":limit.to_string(),"order":"stationcount","reverse":"true"})).send().await;
            if let Ok(response) = result
                && response.status().is_success()
                && let Ok(values) = response.json::<Vec<T>>().await
            {
                return Ok(values);
            }
        }
        Err(AppError::upstream())
    }
    pub async fn directory(&self) -> Result<Directory> {
        // Coalesce concurrent cache misses rather than issuing three requests per visitor.
        let mut cache = self.directory_cache.lock().await;
        if let Some((at, data)) = &*cache
            && at.elapsed() < Duration::from_secs(if data.is_ok() { 3600 } else { 15 })
        {
            return data.clone();
        }
        let _permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "目录加载繁忙，请稍后重试"))?;
        let result = tokio::try_join!(
            self.facet_request::<ApiCountry>("/json/countries", 300),
            self.facet_request::<ApiLanguage>("/json/languages", 1000),
            self.facet_request::<ApiTag>("/json/tags", 120)
        );
        let (countries, languages, tags) = match result {
            Ok(data) => data,
            Err(error) => {
                *cache = Some((Instant::now(), Err(error.clone())));
                return Err(error);
            }
        };
        let data = Directory {
            countries: countries
                .into_iter()
                .filter(|c| {
                    c.iso_3166_1.len() == 2
                        && c.iso_3166_1.bytes().all(|b| b.is_ascii_alphabetic())
                        && c.stationcount > 0
                })
                .map(|c| Facet {
                    value: c.iso_3166_1.to_uppercase(),
                    label: c.name,
                    count: c.stationcount,
                })
                .collect(),
            languages: languages
                .into_iter()
                .filter(|l| !l.name.is_empty() && l.name.len() <= 80 && l.stationcount > 0)
                .map(|l| Facet {
                    value: l.name.clone(),
                    label: l.name,
                    count: l.stationcount,
                })
                .collect(),
            tags: tags
                .into_iter()
                .filter(|t| !t.name.is_empty() && t.name.len() <= 60 && t.stationcount > 0)
                .map(|t| Facet {
                    value: t.name.clone(),
                    label: t.name,
                    count: t.stationcount,
                })
                .collect(),
        };
        *cache = Some((Instant::now(), Ok(data.clone())));
        Ok(data)
    }
}
pub async fn get(State(s): State<AppState>) -> Result<Json<Directory>> {
    Ok(Json(s.catalog.directory().await?))
}
