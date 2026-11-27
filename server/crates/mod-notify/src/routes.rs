//! Router axum của module notify (11 route): `/notifications` (danh sách, số chưa đọc, đánh dấu đã đọc, gửi tay),
//! `/templates` (CRUD mẫu, cổng `settings.integrations`) và `/events` (2 route `Internal`: phiếu lương duyệt, đẩy chuông WS).
//! Thân của `/templates` và `/events` kiểm tay ở [`crate::dto`]. `/events` không có người dùng/công ty trong token (khoá nội
//! bộ) nên chạy trên công ty mặc định như bản Node một-công-ty.

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
use crate::dto;
use crate::events;
use crate::notifications::{self, Category, SendNotification};
use crate::templates;

const BASE: &str = "/api/v1/notifications";
const TEMPLATES: &str = "/api/v1/templates";
const TEMPLATE_ID: &str = "/api/v1/templates/:id";

impl Dto for SendNotification {
    const NAME: &'static str = "SendNotificationDto";
}

/// Trạng thái dùng chung của router: pool DB (công ty lấy từ token) và bộ phân phối (socket, webhook).
pub struct NotifyState {
    pub db: Db,
    pub deliverer: Deliverer,
}

/// Bảng route (11 dòng) so với `routes.json`.
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
        RouteSpec::new(Method::GET, TEMPLATES, Access::Can(&["settings.integrations"])).status_ok(200),
        RouteSpec::new(Method::POST, TEMPLATES, Access::Can(&["settings.integrations"])).status_ok(201),
        RouteSpec::new(Method::GET, TEMPLATE_ID, Access::Can(&["settings.integrations"]))
            .status_ok(200)
            .param_pipes(&["param.id:ParseIntPipe"]),
        RouteSpec::new(Method::PATCH, TEMPLATE_ID, Access::Can(&["settings.integrations"]))
            .status_ok(200)
            .param_pipes(&["param.id:ParseIntPipe"]),
        RouteSpec::new(Method::DELETE, TEMPLATE_ID, Access::Can(&["settings.integrations"]))
            .status_ok(204)
            .param_pipes(&["param.id:ParseIntPipe"]),
        RouteSpec::new(Method::POST, "/api/v1/events/payslip-approved", Access::Internal).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/events/notify-ws-emit", Access::Internal).status_ok(200),
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

/// Chuỗi `:id` đã qua `ParseIntPipe`; ngoài int4 thì không có mẫu nào (404 đúng câu của `find_by_id`).
fn template_id(raw: &str) -> Result<i32, Response> {
    raw.parse::<i32>()
        .map_err(|_| fail(HttpError::not_found(format!("Template #{raw} khong ton tai"))))
}

async fn template_conn(s: &NotifyState, u: &CurrentUser) -> Result<trinity_db::TenantConn, Response> {
    let t = tenant(s, u).await?;
    t.acquire().await.map_err(|e| fail(AppError::internal(e)))
}

async fn templates_list(State(s): State<Arc<NotifyState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let mut c = match template_conn(&s, &u).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ok(templates::find_all(&mut c).await)
}

async fn templates_get(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match template_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let mut c = match template_conn(&s, &u).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ok(templates::find_by_id(&mut c, id).await)
}

async fn templates_create(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match dto::parse_create_template(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let mut c = match template_conn(&s, &u).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ok(templates::create(&mut c, &dto).await)
}

async fn templates_update(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let id = match template_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let dto = match dto::parse_update_template(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let mut c = match template_conn(&s, &u).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ok(templates::update(&mut c, id, &dto).await)
}

async fn templates_remove(
    State(s): State<Arc<NotifyState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match template_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let mut c = match template_conn(&s, &u).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    match templates::remove(&mut c, id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

/// Route `Internal` không có người dùng: công ty mặc định.
async fn default_tenant(s: &NotifyState) -> Result<TenantDb, Response> {
    s.db.tenant(CompanyRef::DEFAULT)
        .await
        .map_err(|e| fail(AppError::internal(e)))
}

async fn payslip_approved(State(s): State<Arc<NotifyState>>, JsonBody(body): JsonBody) -> Response {
    let dto = match dto::parse_payslip_approved(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let t = match default_tenant(&s).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    events::on_payslip_approved(&t, &s.deliverer, &dto.payload, Utc::now()).await;
    // Bản Node trả `undefined` ⇒ 200 không body.
    StatusCode::OK.into_response()
}

async fn notify_ws_emit(State(s): State<Arc<NotifyState>>, JsonBody(body): JsonBody) -> Response {
    let dto = match dto::parse_ws_emit(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let t = match default_tenant(&s).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    Json(events::emit_ws_notifications(&t, &s.deliverer, &dto.items).await).into_response()
}

/// Router của module (11 route). Người gọi gắn state `Arc<NotifyState>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<NotifyState>> {
    let s = specs();
    let spec = |i: usize| -> RouteSpec { s[i].clone() };
    ApiRouter::new(deps)
        .route(spec(0), list)
        .route(spec(1), unread_count)
        .route(spec(2), mark_read)
        .route(spec(3), send)
        .route(spec(4), templates_list)
        .route(spec(5), templates_create)
        .route(spec(6), templates_get)
        .route(spec(7), templates_update)
        .route(spec(8), templates_remove)
        .route(spec(9), payslip_approved)
        .route(spec(10), notify_ws_emit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bang_route_du_11_dong_khong_trung() {
        let s = specs();
        assert_eq!(s.len(), 11);
        let mut keys: Vec<_> = s.iter().map(|x| format!("{} {}", x.method, x.path)).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), 11);
    }
}
