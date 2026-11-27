//! Bảng route và handler của M56 (K14), so với `contracts/routes.json` bởi `trinity check-routes`: 4 route quản trị cần tính năng
//! tổ chức `online_store` (`OrgFeatureGuard`, cần `AccessDeps.features`), 3 route công khai (tự tra cờ qua `mod_settings`).

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http::Method;
use serde::Serialize;
use serde_json::{Map, Value, json};
use trinity_db::platform::{Platform, RouteKind};
use trinity_db::{CompanyRef, Db};
use trinity_http::edge::client_ip::{ClientIpResolver, resolve_client_ip};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{OwnerIds, ScopeService};

use crate::settings;
use crate::shop::{self, OrderLimits, RATE_LIMIT_MESSAGE, StoreError};

const FEATURE: &str = "online_store";

pub fn specs() -> Vec<RouteSpec> {
    const ID: &[&str] = &["param.id:ParseIntPipe"];
    let feature =
        |m: Method, p: &'static str, a: Access| RouteSpec::new(m, p, a).status_ok(200).org_feature("online_store");
    vec![
        feature(Method::GET, "/api/v1/store/orders", Access::Can(&["deals.view"])),
        feature(
            Method::PATCH,
            "/api/v1/store/orders/:id",
            Access::Can(&["deals.manage"]),
        )
        .param_pipes(ID),
        feature(Method::GET, "/api/v1/store/settings", Access::Can(&["pos.manage"])),
        feature(Method::PUT, "/api/v1/store/settings", Access::Can(&["pos.manage"])),
        RouteSpec::new(Method::GET, "/api/v1/store/public/:slug", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/store/public/:slug/orders", Access::Public).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/store/public/:slug/orders/:code", Access::Public).status_ok(200),
    ]
}

/// Phụ thuộc của module: dựng một lần ở `serve`.
pub struct Ctx {
    pub db: Db,
    pub platform: Platform,
    pub scopes: ScopeService,
    pub ip: Arc<ClientIpResolver>,
    pub limits: OrderLimits,
}

impl Ctx {
    async fn conn(&self, company: CompanyRef) -> Result<trinity_db::TenantConn, AppError> {
        self.db
            .tenant(company)
            .await
            .map_err(AppError::internal)?
            .acquire()
            .await
            .map_err(AppError::internal)
    }

    /// Cờ tính năng `online_store` đã tính gói (đọc lỗi thì `get` tự fail-open như bản TS).
    async fn feature_enabled(&self, company: CompanyRef) -> Result<bool, AppError> {
        let ctx = mod_settings::Ctx {
            company_id: self.platform.multi_tenant().then_some(company.id()),
        };
        let mut conn = self.conn(company).await?;
        let features = mod_settings::features::get(&mut conn, ctx).await?;
        Ok(features.0.iter().any(|(k, v)| *k == FEATURE && *v == Some(true)))
    }

    async fn owner_ids(
        &self,
        company: CompanyRef,
        u: &CurrentUser,
        permission: &str,
    ) -> Result<Option<OwnerIds>, AppError> {
        self.scopes
            .owner_ids(company, u.user.user_id, &u.grants.grants, permission)
            .await
            .map_err(AppError::internal)
    }
}

fn respond(e: impl Into<AppError>, authenticated: bool) -> Response {
    let (status, body) = e.into().response(authenticated);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn fail(e: impl Into<AppError>) -> Response {
    respond(e, true)
}

fn pub_fail(e: impl Into<AppError>) -> Response {
    respond(e, false)
}

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

fn pub_ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => pub_fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
fn company_of(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

macro_rules! company {
    ($u:expr) => {
        match company_of(&$u) {
            Ok(c) => c,
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

fn order_id(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không có đơn này.").into())
}

async fn settings_get(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let co = company!(u);
    let r = async {
        let mut conn = c.conn(co).await?;
        settings::load(&mut conn).await
    }
    .await;
    ok(r.map(|s| settings::view(s, c.platform.multi_tenant(), co.id())))
}

async fn settings_put(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let co = company!(u);
    let input = if let Value::Object(m) = body { m } else { Map::new() };
    let r = async { settings::save(&c.db, &c.platform, co, &input, u.user.user_id).await }.await;
    ok(r.map(|s| settings::view(s, c.platform.multi_tenant(), co.id())))
}

async fn orders_list(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let co = company!(u);
    let r = async {
        let view = c.owner_ids(co, &u, "deals.view").await?;
        let phone_full = c.owner_ids(co, &u, "contacts.phone_full").await?;
        let mut conn = c.conn(co).await?;
        shop::list_orders(
            &mut conn,
            view.as_ref(),
            phone_full.as_ref(),
            q.get("status").map(String::as_str),
            q.get("limit").map(String::as_str),
        )
        .await
    }
    .await;
    ok(r)
}

async fn order_update(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let co = company!(u);
    // `String(body?.status ?? '')`: giá trị không phải chuỗi cũng không nằm trong danh sách trạng thái ⇒ 400 như nhau.
    let status = match body.get("status") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let r = async {
        let id = order_id(&id)?;
        let manage = c.owner_ids(co, &u, "deals.manage").await?;
        let phone_full = c.owner_ids(co, &u, "contacts.phone_full").await?;
        let mut conn = c.conn(co).await?;
        shop::update_order_status(&mut conn, manage.as_ref(), phone_full.as_ref(), id, &status).await
    }
    .await;
    ok(r)
}

/// Công ty của trang công khai: `?cid=`/`x-trinity-company` (số nguyên dương; không có công ty đó hoặc bị treo ⇒ 404, KHÔNG rơi về công ty 1, như `resolvePublicRouteCompany` bản TS) hoặc chủ của địa chỉ cửa hàng; slug lạ giữ công ty 1 như `enterRoutedCompany` bản TS (handler vẫn kiểm slug trong công ty đó).
/// Công ty không tồn tại hoặc bị treo ⇒ 404 "Không có cửa hàng này.".
async fn public_company(
    c: &Ctx,
    headers: &HeaderMap,
    q: &HashMap<String, String>,
    slug: &str,
) -> Result<CompanyRef, AppError> {
    if !c.platform.multi_tenant() {
        return CompanyRef::new(1).map_err(AppError::internal);
    }
    let raw = q
        .get("cid")
        .map(String::as_str)
        .or_else(|| headers.get("x-trinity-company").and_then(|v| v.to_str().ok()));
    let hint = raw
        .and_then(|r| r.trim().parse::<f64>().ok())
        .filter(|n| n.fract() == 0.0 && *n > 0.0)
        .map(|n| n as i64);
    let id = match hint {
        Some(id) => id,
        None => c
            .platform
            .company_for_route(RouteKind::StoreSlug, &slug.trim().to_lowercase())
            .await
            .map_err(AppError::internal)?
            .map_or(1, i64::from),
    };
    c.platform
        .active_company(id)
        .await
        .map_err(AppError::internal)?
        .ok_or_else(|| HttpError::not_found("Không có cửa hàng này.").into())
}

async fn public_get(
    State(c): State<Arc<Ctx>>,
    Path(slug): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let r = async {
        let co = public_company(&c, &headers, &q, &slug).await?;
        let enabled = c.feature_enabled(co).await?;
        let mut conn = c.conn(co).await?;
        shop::public_store(&mut conn, enabled, &slug).await
    }
    .await;
    pub_ok(r)
}

fn rate_limited(retry_after_sec: u64) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "statusCode": 429,
            "message": RATE_LIMIT_MESSAGE,
            "retryAfter": retry_after_sec,
        })),
    )
        .into_response();
    resp.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(retry_after_sec));
    resp
}

fn store_fail(e: StoreError) -> Response {
    match e {
        StoreError::App(e) => pub_fail(e),
        StoreError::RateLimited { retry_after_sec } => rate_limited(retry_after_sec),
    }
}

async fn public_order(
    State(c): State<Arc<Ctx>>,
    Path(slug): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    req: Request,
) -> Response {
    // IP khách từ hàm dùng chung (`TRUSTED_PROXY`), KHÔNG lấy phần tử đầu của `x-forwarded-for`.
    let client = resolve_client_ip(&c.ip, &req);
    let body = match JsonBody::from_request(req, &()).await {
        Ok(JsonBody(v)) => v,
        Err(r) => return r,
    };
    let co = match public_company(&c, &headers, &q, &slug).await {
        Ok(co) => co,
        Err(e) => return pub_fail(e),
    };
    let ip = client.ip.map(|i| i.to_string());
    let key = match c.limits.client_key(ip.as_deref(), &client.rate_key, &body) {
        Ok(k) => k,
        Err(e) => return store_fail(e),
    };
    let enabled = match c.feature_enabled(co).await {
        Ok(v) => v,
        Err(e) => return pub_fail(e),
    };
    let mut conn = match c.conn(co).await {
        Ok(v) => v,
        Err(e) => return pub_fail(e),
    };
    match shop::place_order(&mut conn, &c.limits, enabled, &slug, &key, &body).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => store_fail(e),
    }
}

async fn public_order_status(
    State(c): State<Arc<Ctx>>,
    Path((slug, code)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let r = async {
        let co = public_company(&c, &headers, &q, &slug).await?;
        let enabled = c.feature_enabled(co).await?;
        let phone = q.get("phone").map_or("", String::as_str);
        let mut conn = c.conn(co).await?;
        shop::order_status(&mut conn, enabled, &slug, &code, phone).await
    }
    .await;
    pub_ok(r)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/store/orders"), orders_list)
        .route(spec(&Method::PATCH, "/api/v1/store/orders/:id"), order_update)
        .route(spec(&Method::GET, "/api/v1/store/settings"), settings_get)
        .route(spec(&Method::PUT, "/api/v1/store/settings"), settings_put)
        .route(spec(&Method::GET, "/api/v1/store/public/:slug"), public_get)
        .route(spec(&Method::POST, "/api/v1/store/public/:slug/orders"), public_order)
        .route(
            spec(&Method::GET, "/api/v1/store/public/:slug/orders/:code"),
            public_order_status,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 7);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 7);
    }
}
