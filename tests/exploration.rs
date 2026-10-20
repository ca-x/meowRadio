use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
};
use http_body_util::BodyExt;
use meowradio::config::Config;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

async fn application() -> (tempfile::TempDir, Router, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let upstream = Router::new()
        .route("/json/countries", post(|| async { Json(json!([
            {"name":"China","iso_3166_1":"CN","stationcount":545},
            {"name":"United States","iso_3166_1":"US","stationcount":545},
            {"name":"France","iso_3166_1":"FR","stationcount":545},
            {"name":"Japan","iso_3166_1":"JP","stationcount":545}
        ])) }))
        .route("/json/languages", post(|| async { Json(json!([])) }))
        .route("/json/tags", post(|| async { Json(json!([
            {"name":"jazz","stationcount":1089},{"name":"rock","stationcount":1090}
        ])) }))
        .route("/json/stations/search", post(|State(calls): State<Arc<AtomicUsize>>, Json(params): Json<Value>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            let mut items: Vec<Value> = (0..2180).map(|i| {
                let country = ["CN", "US", "FR", "JP"][i % 4];
                json!({"stationuuid":format!("radio-{i:04}"),"changeuuid":"","name":format!("Radio {i:04}"),"url":"https://radio.example/live","url_resolved":"","homepage":"","favicon":"","tags":if i == 0 {""} else if i == 1 {"rare"} else if i == 2 {"jazz,rock"} else if i % 2 == 0 {"jazz"} else {"rock"},"country":country,"countrycode":country,"state":"","language":if country == "CN" {"chinese"} else {"english"},"votes":i,"codec":"MP3","bitrate":128,"hls":0,"lastcheckok":1,"clickcount":2180-i,"clicktrend":0})
            }).filter(|s| {
                [("countrycode", "countrycode"), ("tag", "tags"), ("language", "language"), ("codec", "codec"), ("name", "name")]
                    .iter().all(|(param, field)| params[*param].as_str().is_none_or(|v| s[*field].as_str().unwrap().contains(v)))
                    && s["bitrate"].as_u64().unwrap() >= params["bitrateMin"].as_str().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
            }).collect();
            if params["order"] == "votes" { items.reverse(); }
            let limit = params["limit"].as_str().and_then(|v| v.parse::<usize>().ok()).unwrap_or(items.len());
            let offset = params["offset"].as_str().and_then(|v|v.parse::<usize>().ok()).unwrap_or(0);
            Json(items.into_iter().skip(offset).take(limit).collect::<Vec<_>>())
        })).with_state(calls.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: dir.path().join("test.db"),
        catalog_url: Some(format!("http://{address}")),
        proxy: None,
        secure_cookie: false,
        registration: true,
        relay: true,
    };
    let state = meowradio::state(config).await.unwrap();
    (dir, meowradio::app(state), calls)
}
async fn get(app: &Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
#[tokio::test]
async fn global_overview_is_directory_only_and_never_playable() {
    let (_dir, app, calls) = application().await;
    let (status, data) = get(&app, "/api/stations/explore").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["items"].as_array().unwrap().len(), 4);
    assert_eq!(data["total"], 2180);
    assert_eq!(data["complete"], false);
    for code in ["CN", "US", "FR", "JP"] {
        let item = data["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["countrycode"] == code)
            .unwrap();
        assert_eq!(item["id"], format!("country:{code}"));
        assert_eq!(item["cluster"]["count"], 545);
        assert_eq!(item["url"], "");
        assert_eq!(item["personal"], false);
    }
    let (_, nebula) = get(&app, "/api/stations/explore?view=nebula").await;
    assert_eq!(nebula["items"].as_array().unwrap().len(), 3);
    assert_eq!(nebula["items"][0]["cluster"]["kind"], "genre");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn visible_details_are_scoped_coalesced_and_keep_global_remainders() {
    let (_dir, app, calls) = application().await;
    let path = "/api/stations/explore?detail=2&countries=CN";
    let ((status, data), (_, other)) = tokio::join!(get(&app, path), get(&app, path));
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data, other);
    let items = data["items"].as_array().unwrap();
    let stations: Vec<_> = items
        .iter()
        .filter(|s| s.get("cluster").is_none())
        .collect();
    assert_eq!(stations.len(), 200);
    assert!(stations.iter().all(|s| s["countrycode"] == "CN"));
    assert_eq!(
        items.iter().find(|s| s["id"] == "country:CN").unwrap()["cluster"]["count"],
        345
    );
    assert!(items.iter().any(|s| s["id"] == "country:JP"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    get(&app, path).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let (_, complete) = get(&app, "/api/stations/explore?detail=4&country=CN").await;
    assert_eq!(complete["items"].as_array().unwrap().len(), 545);
    assert_eq!(complete["complete"], true);
}
#[tokio::test]
async fn filters_reach_upstream_and_combined_counts_are_unknown() {
    let (_dir, app, _calls) = application().await;
    let (status, data) = get(
        &app,
        "/api/stations/explore?country=US&language=english&tag=rock&sort=votes",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["total"], Value::Null);
    assert_eq!(data["items"][0]["id"], "radio-2177");
    let items = data["items"].as_array().unwrap();
    assert_eq!(items.len(), 101);
    assert!(
        items
            .iter()
            .filter(|s| s.get("cluster").is_none())
            .all(|s| s["countrycode"] == "US" && s["tags"] == "rock")
    );
    assert_eq!(items.last().unwrap()["cluster"]["count"], Value::Null);
    let (_, none) = get(&app, "/api/stations/explore?country=US&language=chinese").await;
    assert_eq!(none["complete"], true);
    assert_eq!(none["items"], json!([]));
    let (status, numeric) = get(
        &app,
        "/api/stations/explore?country=US&bitrate_min=320&limit=24&offset=0",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(numeric["items"], json!([]));
    for path in [
        "/api/stations/explore?countries=CN,invalid",
        "/api/stations/explore?countries=CN,US,FR,JP,DE,GB,IT,ES,CA,BR,AU,IN,NZ",
        "/api/stations/explore?detail=9",
        "/api/stations/explore?view=bad",
    ] {
        assert_eq!(get(&app, path).await.0, StatusCode::BAD_REQUEST);
    }
}
#[tokio::test]
async fn list_page_size_is_configurable_without_changing_its_default() {
    let (_dir, app, _calls) = application().await;
    assert_eq!(
        get(&app, "/api/stations").await.1.as_array().unwrap().len(),
        24
    );
    assert_eq!(
        get(&app, "/api/stations?limit=100")
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        100
    );
    assert_eq!(
        get(&app, "/api/stations?limit=9999999").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn nebula_visible_genres_fetch_real_tags_and_deduplicate_overlap() {
    let (_dir, app, calls) = application().await;
    let (status, data) = get(
        &app,
        "/api/stations/explore?view=nebula&detail=1&genres=jazz",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let stations: Vec<_> = data["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s.get("cluster").is_none())
        .collect();
    assert_eq!(stations.len(), 100);
    assert!(
        stations
            .iter()
            .all(|s| s["tags"].as_str().unwrap().contains("jazz"))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let (_, overlap) = get(
        &app,
        "/api/stations/explore?view=nebula&detail=1&genres=jazz,rock",
    )
    .await;
    let stations: Vec<_> = overlap["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s.get("cluster").is_none())
        .collect();
    assert_eq!(stations.len(), 199);
    let ids: std::collections::HashSet<_> =
        stations.iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), stations.len());
    assert_eq!(overlap["total"], Value::Null);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let (_, explicit) = get(
        &app,
        "/api/stations/explore?view=nebula&detail=1&tag=jazz&genres=rock",
    )
    .await;
    assert!(
        explicit["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s.get("cluster").is_none())
            .all(|s| s["tags"].as_str().unwrap().contains("jazz"))
    );
    for path in [
        "/api/stations/explore?view=nebula&detail=1&genres=unknown",
        "/api/stations/explore?genres=jazz%0Arock",
        "/api/stations/explore?genres=jazz,,rock",
    ] {
        assert_eq!(get(&app, path).await.0, StatusCode::BAD_REQUEST);
    }
}
#[tokio::test]
async fn nebula_other_remainder_covers_rare_and_untagged_stations() {
    let (_dir, app, calls) = application().await;
    let (_, overview) = get(&app, "/api/stations/explore?view=nebula").await;
    let other = overview["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "genre:*")
        .unwrap();
    assert_eq!(other["cluster"]["count"], Value::Null);
    assert_eq!(other["tags"], "");
    assert_eq!(other["url"], "");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let (_, detail) = get(&app, "/api/stations/explore?view=nebula&detail=1&genres=*").await;
    assert_eq!(detail["complete"], false);
    let items = detail["items"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|s| s["id"] == "radio-0000" && s["tags"] == "")
    );
    assert!(
        items
            .iter()
            .any(|s| s["id"] == "radio-0001" && s["tags"] == "rare")
    );
    assert!(items.iter().any(|s| s["id"] == "genre:*"));
    let (_, complete) = get(&app, "/api/stations/explore?view=nebula&detail=6&genres=*").await;
    assert_eq!(complete["complete"], true);
    assert_eq!(complete["items"].as_array().unwrap().len(), 2180);
    assert!(
        complete["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("cluster").is_none())
    );
}
