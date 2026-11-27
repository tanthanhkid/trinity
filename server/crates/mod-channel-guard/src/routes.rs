//! Hai đường `settings/channel-guard` (M45): `GET /api/v1/settings/channel-guard` (quyền `settings.features`) và
//! `GET /api/v1/settings/channel-guard/alerts` (chỉ cần đăng nhập, chỉ trả chữ cảnh báo). Chỉ đọc; khoá/mở kênh do chủ nền tảng
//! bằng CLI. Khai trong tệp sở hữu là tiền tố `settings/channel-guard`, lồng trong `settings`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use trinity_db::CompanyRef;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};

use crate::guard::ChannelGuard;

const STATUS: &str = "/api/v1/settings/channel-guard";
const ALERTS: &str = "/api/v1/settings/channel-guard/alerts";

/// Bảng route của module (2 dòng), so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::GET, STATUS, Access::Can(&["settings.features"])).status_ok(200),
        RouteSpec::new(Method::GET, ALERTS, Access::AuthOnly).status_ok(200),
    ]
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
fn company(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

async fn status(State(g): State<Arc<ChannelGuard>>, Extension(u): Extension<CurrentUser>) -> Response {
    match company(&u) {
        Ok(c) => ok(g.status(c).await),
        Err(r) => r,
    }
}

async fn alerts(State(g): State<Arc<ChannelGuard>>, Extension(u): Extension<CurrentUser>) -> Response {
    match company(&u) {
        Ok(c) => ok(g.alerts(c).await),
        Err(r) => r,
    }
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<ChannelGuard>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<ChannelGuard>> {
    let s = specs();
    let spec = |p: &str| {
        s.iter()
            .find(|x| x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec GET {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(STATUS), status)
        .route(spec(ALERTS), alerts)
}
