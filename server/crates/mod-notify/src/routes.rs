//! Router axum của `/api/v1/notifications` (4 route): danh sách, số chưa đọc (chuông), đánh dấu đã đọc, gửi tay.
//! `/templates` và `/events` chưa nối router (chưa có trong đợt này).

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value};
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, Mode, validate_into, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::delivery::Deliverer;
use crate::notifications::{self, Category, SendNotification};

const BASE: &str = "/api/v1/notifications";

impl Dto for SendNotification {
    const NAME: &'static str = "SendNotificationDto";
}

/// Trạng thái dùng chung của router: pool DB (công ty lấy từ token) và bộ phân phối (socket, webhook).
pub struct NotifyState {
    pub db: Db,
    pub deliverer: Deliverer,
}

/// Bảng route (4 dòng) so với `routes.json`.
pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::GET, BASE, Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/notifications/unread-count", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::PATCH, "/api/v1/notifications/:id/read", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(&["param.id:ParseIntPipe"]),
        RouteSpec::new(
            Method::POST,
            "/api/v1/notifications/send",
            Access::Can(&["settings.integrations"]),
        )
        .status_ok(201),
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

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
async fn tenant(s: &NotifyState, u: &CurrentUser) -> Result<TenantDb, Response> {
    let Ok(company) = CompanyRef::new(i64::from(u.user.company_id)) else {
        return Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")));
    };
    s.db.tenant(company).await.map_err(|e| fail(AppError::internal(e)))
}

macro_rules! tenant {
    ($s:expr, $u:expr) => {
        match tenant(&$s, &$u).await {
            Ok(t) => t,
            Err(r) => return r,
        }
    };
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`.
struct JsonBody(Value);

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &S) -> Result<Self, Response> {
        let is_json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| {
                ct.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        let bytes: Bytes = to_bytes(req.into_body(), 5 * 1024 * 1024)
            .await
            .map_err(|_| fail(HttpError::payload_too_large("request entity too large")))?;
        if !is_json || bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(Value::Object(Map::new())));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Self(v)),
            _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
        }
    }
}

fn query_value(q: &HashMap<String, String>) -> Value {
    Value::Object(q.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
}

/// Số nguyên của DTO đã chuyển kiểu (`@Type(() => Number)` có thể ra số thực `5.0`).
fn int_of(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

async fn list(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let v = match validate_value("QueryNotificationDto", &query_value(&q), Mode::Lenient) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let cursor = match v.get("cursor").and_then(int_of).map(i32::try_from) {
        Some(Ok(n)) => Some(n),
        Some(Err(_)) => return fail(HttpError::bad_request("cursor must be an integer number")),
        None => None,
    };
    let limit = v.get("limit").and_then(int_of).unwrap_or(20);
    let read = v.get("read").and_then(Value::as_bool);
    let t = tenant!(s, u);
    let mut c = match t.acquire().await {
        Ok(c) => c,
        Err(e) => return fail(AppError::internal(e)),
    };
    ok(notifications::find_by_user(&mut c, u.user.user_id, cursor, limit, read).await)
}

async fn unread_count(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let category = match q.get("category").map(String::as_str) {
        None => None,
        Some("profile") => Some(Category::Profile),
        Some("message") => Some(Category::Message),
        Some(_) => {
            return fail(HttpError::validation(vec![
                "category must be one of the following values: profile, message".to_owned(),
            ]));
        }
    };
    let t = tenant!(s, u);
    let mut c = match t.acquire().await {
        Ok(c) => c,
        Err(e) => return fail(AppError::internal(e)),
    };
    ok(notifications::unread_count(&mut c, u.user.user_id, category).await)
}

async fn mark_read(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    // `ParseIntPipe` đã chạy ở router: số ngoài int4 thì không có thông báo nào.
    let Ok(id) = id.parse::<i32>() else {
        return fail(HttpError::not_found("Thong bao khong ton tai"));
    };
    let t = tenant!(s, u);
    ok(notifications::mark_as_read(&t, &s.deliverer, id, u.user.user_id).await)
}

async fn send(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match validate_into::<SendNotification>(&body, Mode::Lenient) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let t = tenant!(s, u);
    ok(notifications::send(&t, &s.deliverer, &dto, Utc::now()).await)
}

/// Router của module (4 route). Người gọi gắn state `Arc<NotifyState>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<NotifyState>> {
    let s = specs();
    let spec = |i: usize| -> RouteSpec { s[i].clone() };
    ApiRouter::new(deps)
        .route(spec(0), list)
        .route(spec(1), unread_count)
        .route(spec(2), mark_read)
        .route(spec(3), send)
}
