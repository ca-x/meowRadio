use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

pub struct AppError(pub StatusCode, pub &'static str);
pub type Result<T> = std::result::Result<T, AppError>;
impl AppError {
    pub fn bad(message: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, message)
    }
    pub fn upstream() -> Self {
        Self(StatusCode::BAD_GATEWAY, "电台服务暂时不可用，请稍后重试")
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "请先登录")
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "数据保存失败，请重试")
    }
}
