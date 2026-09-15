use crate::{
    AppState, auth,
    error::{AppError, Result},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use std::time::{Duration, Instant};

pub async fn test(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    auth::user(&s, &headers).await?;
    let _permit = s
        .catalog
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError(StatusCode::TOO_MANY_REQUESTS, "连接测试繁忙，请稍后重试"))?;
    let started = Instant::now();
    // A fixed public target prevents this diagnostic becoming an arbitrary URL fetcher.
    // Reuse the exact proxy-aware client used for catalog requests, including TLS verification.
    let status = s
        .catalog
        .client
        .get("https://de1.api.radio-browser.info/json/stats")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| AppError(StatusCode::BAD_GATEWAY, "连接失败或超时，请检查代理和网络"))?
        .error_for_status()
        .map_err(|_| AppError(StatusCode::BAD_GATEWAY, "外网服务返回错误，请稍后重试"))?
        .json::<radiobrowser::ApiStatus>()
        .await
        .map_err(|_| AppError(StatusCode::BAD_GATEWAY, "未收到有效的电台服务响应"))?;
    if !status.status.eq_ignore_ascii_case("ok") {
        return Err(AppError(StatusCode::BAD_GATEWAY, "外网电台服务暂不可用"));
    }
    Ok(Json(
        serde_json::json!({"ok":true,"mode":if s.config.proxy.is_some(){"proxy"}else{"direct"},"elapsed_ms":started.elapsed().as_millis(),"target":"Radio Browser"}),
    ))
}
