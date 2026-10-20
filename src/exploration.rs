use crate::{
    AppState,
    catalog::{Catalog, Cluster, Search, Station},
    directory::Facet,
    error::{AppError, Result},
};
use axum::{
    Json,
    extract::{Query, State},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
pub struct Explore {
    #[serde(flatten)]
    search: Search,
    #[serde(default = "default_view")]
    view: String,
    #[serde(default)]
    countries: String,
    #[serde(default)]
    genres: String,
    #[serde(default)]
    detail: u8,
}
fn default_view() -> String {
    "globe".into()
}
#[derive(Clone, Serialize)]
pub struct Exploration {
    items: Vec<Station>,
    total: Option<u32>,
    complete: bool,
}
pub(crate) type Cache = HashMap<String, (Instant, Exploration)>;

fn cluster(facet: &Facet, kind: &str, count: Option<u32>) -> Station {
    Station {
        id: format!("{kind}:{}", facet.value),
        name: facet.label.clone(),
        url: String::new(),
        country: if kind == "country" {
            facet.label.clone()
        } else {
            String::new()
        },
        countrycode: if kind == "country" {
            facet.value.clone()
        } else {
            String::new()
        },
        tags: if kind == "genre" && facet.value != "*" {
            facet.value.clone()
        } else {
            String::new()
        },
        codec: String::new(),
        bitrate: 0,
        hls: false,
        geo_lat: None,
        geo_long: None,
        personal: false,
        source_id: None,
        source_name: None,
        cluster: Some(Cluster {
            kind: kind.into(),
            key: facet.value.clone(),
            count,
        }),
    }
}
impl Explore {
    fn validate(&mut self) -> Result<Vec<String>> {
        // Exploration has no list pagination; validate only its actual filters.
        self.search.limit = 100;
        self.search.offset = 0;
        self.search.validate()?;
        if !["globe", "nebula"].contains(&self.view.as_str())
            || self.detail > 8
            || self.countries.len() > 35
            || self.genres.len() > 731
            || self.genres.chars().any(char::is_control)
        {
            return Err(AppError::bad("无效的探索视口"));
        }
        let mut countries = Vec::new();
        if !self.countries.is_empty() {
            for code in self.countries.split(',') {
                if code.len() != 2 || !code.bytes().all(|b| b.is_ascii_alphabetic()) {
                    return Err(AppError::bad("无效的探索国家"));
                }
                countries.push(code.to_uppercase());
            }
        }
        countries.sort();
        countries.dedup();
        if countries.len() > 12 {
            return Err(AppError::bad("探索视口过大"));
        }
        if !self.search.country.is_empty()
            && (self.search.country.len() != 2
                || !self.search.country.bytes().all(|b| b.is_ascii_alphabetic()))
        {
            return Err(AppError::bad("无效的探索国家"));
        }
        if !self.genres.is_empty() {
            let mut genres = self.genres.split(',').map(str::trim).collect::<Vec<_>>();
            if genres.len() > 12
                || genres.iter().any(|genre| {
                    genre.is_empty() || genre.len() > 60 || genre.chars().any(char::is_control)
                })
            {
                return Err(AppError::bad("无效的探索流派"));
            }
            genres.sort_unstable();
            genres.dedup();
            self.genres = genres.join(",");
        }
        if self.search.tag.chars().any(char::is_control) {
            return Err(AppError::bad("无效的探索流派"));
        }
        self.search.q = self.search.q.trim().to_string();
        self.search.country.make_ascii_uppercase();
        Ok(countries)
    }
    fn filtered(&self) -> bool {
        !self.search.q.trim().is_empty()
            || !self.search.tag.is_empty()
            || !self.search.language.is_empty()
            || !self.search.codec.is_empty()
            || self.search.bitrate_min > 0
    }
}
impl Catalog {
    async fn load_exploration(&self, query: &Explore, visible: Vec<String>) -> Result<Exploration> {
        let directory = self.directory().await?;
        let filtered = query.filtered();
        let country_filter = &query.search.country;
        let facets: Vec<&Facet> = if query.view == "globe" {
            directory
                .countries
                .iter()
                .filter(|f| country_filter.is_empty() || f.value == *country_filter)
                .collect()
        } else {
            directory
                .tags
                .iter()
                .filter(|f| {
                    query.search.tag.is_empty() || f.value.eq_ignore_ascii_case(&query.search.tag)
                })
                .collect()
        };
        let total = if filtered || query.view == "nebula" {
            None
        } else {
            Some(facets.iter().map(|f| f.count).sum())
        };
        // Each scope carries the actual search and whether exhausting it covers
        // every record matching the user's filters, rather than one visible facet.
        let mut scopes = Vec::new();
        if query.view == "nebula"
            && query.search.tag.is_empty()
            && query.detail > 0
            && !query.genres.is_empty()
        {
            let genres = query.genres.split(',').collect::<Vec<_>>();
            if genres.contains(&"*") {
                scopes.push(("global".to_string(), query.search.clone(), true));
            } else {
                for genre in genres {
                    let facet = directory
                        .tags
                        .iter()
                        .find(|f| f.value.eq_ignore_ascii_case(genre))
                        .ok_or_else(|| AppError::bad("无效的探索流派"))?;
                    let mut search = query.search.clone();
                    search.tag = facet.value.clone();
                    scopes.push((format!("genre:{}", facet.value), search, false));
                }
            }
        } else if !country_filter.is_empty()
            || (query.view == "nebula" && !query.search.tag.is_empty())
        {
            scopes.push(("global".to_string(), query.search.clone(), true));
        } else if query.detail > 0 && !visible.is_empty() {
            for country in visible {
                let mut search = query.search.clone();
                search.country = country.clone();
                scopes.push((format!("country:{country}"), search, false));
            }
        } else if filtered {
            scopes.push(("global".to_string(), query.search.clone(), true));
        }
        let pages = 1u32 << query.detail.max(1).saturating_sub(1);
        let results = stream::iter(scopes.into_iter().map(
            |(scope, mut search, covers_filters)| {
                async move {
                    let mut stations = Vec::new();
                    let mut ids = HashSet::new();
                    let mut complete = false;
                    for page in 0..pages {
                        search.offset = page * 100;
                        let batch = self.search_page(search.clone()).await?;
                        let count = batch.len();
                        let before = stations.len();
                        for station in batch {
                            if ids.insert(station.id.clone()) {
                                stations.push(station);
                            }
                        }
                        if count < 100 {
                            complete = true;
                            break;
                        }
                        // An upstream ignoring offsets must leave an aggregate remainder.
                        if before == stations.len() {
                            break;
                        }
                    }
                    Ok::<_, AppError>((scope, stations, complete, covers_filters))
                }
            },
        ))
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
        let mut items = Vec::new();
        let mut completed = HashSet::new();
        let mut global_complete = false;
        let mut all_ids = HashSet::new();
        for result in results {
            let (scope, stations, complete, covers_filters) = result?;
            if complete {
                if covers_filters {
                    global_complete = true;
                } else {
                    completed.insert(scope);
                }
            }
            for station in stations {
                if all_ids.insert(station.id.clone()) {
                    items.push(station);
                }
            }
        }
        let mut aggregates = Vec::new();
        if !global_complete {
            for facet in facets {
                let kind = if query.view == "globe" {
                    "country"
                } else {
                    "genre"
                };
                if completed.contains(&format!("{kind}:{}", facet.value)) {
                    continue;
                }
                let loaded = items
                    .iter()
                    .filter(|s| {
                        if query.view == "globe" {
                            s.countrycode.eq_ignore_ascii_case(&facet.value)
                        } else {
                            s.tags
                                .split(',')
                                .any(|t| t.trim().eq_ignore_ascii_case(&facet.value))
                        }
                    })
                    .count() as u32;
                let known = if query.view == "globe" {
                    !filtered
                } else {
                    country_filter.is_empty()
                        && query.search.q.trim().is_empty()
                        && query.search.language.is_empty()
                        && query.search.codec.is_empty()
                        && query.search.bitrate_min == 0
                };
                let count = known.then(|| facet.count.saturating_sub(loaded));
                if count != Some(0) {
                    aggregates.push(cluster(
                        facet,
                        if query.view == "globe" {
                            "country"
                        } else {
                            "genre"
                        },
                        count,
                    ));
                }
            }
            // Tags overlap and the directory exposes only its top tags. A global
            // unknown remainder keeps rare genres and untagged stations reachable.
            if query.view == "nebula" && query.search.tag.is_empty() {
                aggregates.push(cluster(
                    &Facet {
                        value: "*".into(),
                        label: "Other".into(),
                        count: 0,
                    },
                    "genre",
                    None,
                ));
            }
            // A selected tag outside the directory's top tags still needs a drillable remainder.
            if query.view == "nebula" && !query.search.tag.is_empty() && aggregates.is_empty() {
                aggregates.push(cluster(
                    &Facet {
                        value: query.search.tag.clone(),
                        label: query.search.tag.clone(),
                        count: 0,
                    },
                    "genre",
                    None,
                ));
            }
        }
        let complete = global_complete || aggregates.is_empty();
        items.extend(aggregates);
        Ok(Exploration {
            items,
            total,
            complete,
        })
    }
    async fn explore(&self, mut query: Explore) -> Result<Exploration> {
        let visible = query.validate()?;
        let key = serde_json::to_string(&serde_json::json!({"view":query.view,"countries":visible,"genres":query.genres,"detail":query.detail,
            "q":query.search.q,"tag":query.search.tag,"country":query.search.country,"language":query.search.language,
            "codec":query.search.codec,"bitrate":query.search.bitrate_min,"sort":query.search.sort})).unwrap();
        let previous = self.exploration_cache.lock().await.get(&key).cloned();
        if let Some((at, value)) = &previous
            && at.elapsed() < Duration::from_secs(120)
        {
            return Ok(value.clone());
        }
        let gate = {
            let mut gates = self.exploration_refresh.lock().await;
            // Gates are retained while in use; old keys are bounded independently of traffic.
            if gates.len() >= 256 {
                gates.retain(|_, gate| Arc::strong_count(gate) > 1);
            }
            gates.entry(key.clone()).or_default().clone()
        };
        if let Some((_, value)) = previous {
            if let Ok(guard) = gate.try_lock_owned() {
                let catalog = self.clone();
                tokio::spawn(async move {
                    if let Ok(result) = catalog.load_exploration(&query, visible).await {
                        catalog.store_exploration(key, result).await;
                    }
                    drop(guard);
                });
            }
            return Ok(value);
        }
        let _guard = gate.lock().await;
        if let Some((_, value)) = self.exploration_cache.lock().await.get(&key) {
            return Ok(value.clone());
        }
        let result = self.load_exploration(&query, visible).await?;
        self.store_exploration(key, result.clone()).await;
        Ok(result)
    }
    async fn store_exploration(&self, key: String, result: Exploration) {
        const MAX_KEYS: usize = 128;
        const MAX_ITEMS: usize = 100_000;
        let mut cache = self.exploration_cache.lock().await;
        cache.remove(&key);
        // Large detail responses still reach the caller in full. Only retained
        // snapshots have this memory budget; eviction never truncates a viewport.
        if result.items.len() > MAX_ITEMS {
            return;
        }
        let mut retained_items = cache
            .values()
            .map(|(_, data)| data.items.len())
            .sum::<usize>();
        while cache.len() >= MAX_KEYS || retained_items + result.items.len() > MAX_ITEMS {
            let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some((_, removed)) = cache.remove(&oldest) {
                retained_items -= removed.items.len();
            }
        }
        cache.insert(key, (Instant::now(), result));
    }
}
pub async fn get(
    State(state): State<AppState>,
    Query(query): Query<Explore>,
) -> Result<Json<Exploration>> {
    Ok(Json(state.catalog.explore(query).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, directory::Directory};

    #[tokio::test]
    async fn cached_snapshots_share_one_node_budget() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::new(&Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            database: dir.path().join("unused.db"),
            catalog_url: Some("http://127.0.0.1:1".into()),
            proxy: None,
            secure_cookie: false,
            registration: true,
            relay: true,
        })
        .unwrap();
        let node: Station = serde_json::from_value(serde_json::json!({
            "id":"", "name":"", "url":"", "country":"", "countrycode":"", "tags":"", "codec":"", "bitrate":0, "hls":false
        })).unwrap();
        catalog
            .store_exploration(
                "old".into(),
                Exploration {
                    items: vec![node.clone(); 60_000],
                    total: None,
                    complete: false,
                },
            )
            .await;
        catalog
            .store_exploration(
                "new".into(),
                Exploration {
                    items: vec![node; 50_000],
                    total: None,
                    complete: false,
                },
            )
            .await;
        let cache = catalog.exploration_cache.lock().await;
        assert!(!cache.contains_key("old"));
        assert_eq!(cache["new"].1.items.len(), 50_000);
        assert!(
            cache
                .values()
                .map(|(_, data)| data.items.len())
                .sum::<usize>()
                <= 100_000
        );
    }

    #[tokio::test]
    async fn stale_overview_survives_directory_refresh_failure() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            database: dir.path().join("unused.db"),
            catalog_url: Some("http://127.0.0.1:1".into()),
            proxy: None,
            secure_cookie: false,
            registration: true,
            relay: true,
        };
        let catalog = Catalog::new(&config).unwrap();
        *catalog.directory_cache.lock().await = Some((
            Instant::now(),
            Ok(Directory {
                countries: vec![Facet {
                    value: "CN".into(),
                    label: "China".into(),
                    count: 200,
                }],
                languages: vec![],
                tags: vec![],
            }),
        ));
        let query: Explore = serde_json::from_value(serde_json::json!({})).unwrap();
        let first = catalog
            .explore(query.clone())
            .await
            .unwrap_or_else(|_| panic!("overview failed"));
        assert_eq!(first.items.len(), 1);
        for (at, _) in catalog.exploration_cache.lock().await.values_mut() {
            *at = Instant::now() - Duration::from_secs(121);
        }
        *catalog.directory_cache.lock().await = Some((Instant::now(), Err(AppError::upstream())));
        let stale = tokio::time::timeout(Duration::from_millis(100), catalog.explore(query))
            .await
            .unwrap()
            .unwrap_or_else(|_| panic!("stale response failed"));
        assert_eq!(stale.items[0].cluster.as_ref().unwrap().count, Some(200));
        tokio::task::yield_now().await;
        assert_eq!(catalog.exploration_cache.lock().await.len(), 1);
    }
}
