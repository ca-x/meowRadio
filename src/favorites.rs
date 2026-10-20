use crate::{
    AppState, auth,
    catalog::Station,
    error::{AppError, Result},
};
use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize)]
struct PageQuery {
    #[serde(default = "crate::catalog::default_page_size")]
    page_size: u32,
    #[serde(default)]
    q: String,
    #[serde(default)]
    page: u32,
}

#[derive(Serialize)]
struct Page {
    items: Vec<Station>,
    total: usize,
    page: usize,
    page_size: usize,
}

#[derive(Serialize)]
struct Summary {
    ids: Vec<String>,
    presets: Vec<Station>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/favorites/page", get(page))
        .route("/favorites/summary", get(summary))
}

fn station(json: &str) -> Result<Station> {
    serde_json::from_str(json)
        .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "收藏数据读取失败"))
}

async fn page(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: std::result::Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<Page>> {
    let user = auth::user(&state, &headers).await?;
    let Query(query) = query.map_err(|_| AppError::bad("搜索条件过长或页码超出范围"))?;
    if query.q.len() > 100 {
        return Err(AppError::bad("搜索条件过长或页码超出范围"));
    }
    if ![24, 100, 500, 1000].contains(&query.page_size) {
        return Err(AppError::bad("不支持的分页大小"));
    }
    let page_size = query.page_size as usize;
    let requested_page = query.page as usize;
    let mut tx = state.db.begin().await?;
    let (items, total, page) = if query.q.is_empty() {
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM favorites WHERE user_id=?")
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
        let total = total as usize;
        let page = requested_page.min(total.saturating_sub(1) / page_size);
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT station_json FROM favorites WHERE user_id=? ORDER BY created_at DESC, station_id LIMIT ? OFFSET ?",
        )
        .bind(user.id)
        .bind(page_size as i64)
        .bind((page * page_size) as i64)
        .fetch_all(&mut *tx)
        .await?;
        let items = rows
            .iter()
            .map(|json| station(json))
            .collect::<Result<_>>()?;
        (items, total, page)
    } else {
        // SQLite lower() is ASCII-only. Match the browser's Unicode lowercase
        // substring search, while retaining at most two pages of station data.
        let needle = query.q.to_lowercase();
        let mut rows = sqlx::query_scalar::<_, String>(
            "SELECT station_json FROM favorites WHERE user_id=? ORDER BY created_at DESC, station_id",
        )
        .bind(user.id)
        .fetch(&mut *tx);
        let mut items = Vec::with_capacity(page_size);
        let mut last_page = Vec::with_capacity(page_size);
        let mut total = 0usize;
        while let Some(json) = rows.try_next().await? {
            let item = station(&json)?;
            let text = format!("{} {} {}", item.name, item.tags, item.country);
            if !text.to_lowercase().contains(&needle) {
                continue;
            }
            if total.is_multiple_of(page_size) {
                last_page.clear();
            }
            if total / page_size == requested_page {
                items.push(item.clone());
            }
            last_page.push(item);
            total += 1;
        }
        let page = requested_page.min(total.saturating_sub(1) / page_size);
        if page != requested_page {
            items = last_page;
        }
        (items, total, page)
    };
    tx.commit().await?;
    Ok(Json(Page {
        items,
        total,
        page,
        page_size,
    }))
}

async fn summary(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Summary>> {
    let user = auth::user(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    let ids = sqlx::query_scalar(
        "SELECT station_id FROM favorites WHERE user_id=? ORDER BY created_at DESC, station_id",
    )
    .bind(user.id)
    .fetch_all(&mut *tx)
    .await?;
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT station_json FROM favorites WHERE user_id=? ORDER BY created_at DESC, station_id LIMIT 4",
    )
    .bind(user.id)
    .fetch_all(&mut *tx)
    .await?;
    let presets = rows
        .iter()
        .map(|json| station(json))
        .collect::<Result<_>>()?;
    tx.commit().await?;
    Ok(Json(Summary { ids, presets }))
}
