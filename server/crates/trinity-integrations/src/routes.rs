//! Router axum của mô-đun `integrations` (bản Node: `integrations.controller.ts`, `webhooks.controller.ts`,
//! `webhook-inbound-sources.controller.ts`, `webhook-inbound.controller.ts`): 19 route.
//!
//! | Nhóm | Route | Quyền |
//! |---|---|---|
//! | `IntegrationsController` | `GET /integrations/status`, `GET /integrations/audit-logs` | any(3 quyền) / `integrations.ai_admin` |
//! | `WebhooksController` | 10 route `/integrations/webhooks/{events,endpoints*,deliveries*}` | `integrations.webhooks` |
//! | `WebhookInboundSourcesController` | 6 route `/integrations/webhooks/inbound-sources*` | `integrations.webhooks` (+ `contacts.create` khi ghi) |
//! | `WebhookInboundController` | `POST /hooks/in/:token` | công khai, xác thực bằng token trong đường dẫn (+ chữ ký) |
//!
//! Thân của mọi route là hàm của [`crate::webhooks`] / [`crate::audit`] / [`crate::status`]; ở đây chỉ kiểm DTO (theo
//! `contracts/dto/schema.json`), cờ `INTEGRATIONS_WEBHOOKS_ENABLED` (tắt ⇒ 404) và đổi lỗi nghiệp vụ sang mã HTTP.

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, TenantConn, TenantDb};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, KeepStatus, RouteSpec};
use trinity_http::validate::{Mode, query_to_json, validate_value};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::instant::parse_instant_with;
use trinity_rbac::ScopeService;

use crate::audit::{self, AuditQuery, AuditStatus, Channel};
use crate::status;
use crate::webhooks::deliveries::{self, DeliveryError, DeliveryQuery};
use crate::webhooks::endpoints::{self, CreateEndpoint, EndpointError, UpdateEndpoint};
use crate::webhooks::inbound::receive::{InboundError, InboundRequest, InboundService};
use crate::webhooks::inbound::sources::{self, Actor, CreateInboundSource, SourceError, Tenant, UpdateInboundSource};
use crate::webhooks::sender::Sender;

/// Body JSON tối đa như `bodyParser` của bản Node.
const BODY_LIMIT: usize = 5 * 1024 * 1024;

const WEBHOOKS: &[&str] = &["integrations.webhooks"];
const WEBHOOKS_WRITE: &[&str] = &["integrations.webhooks", "contacts.create"];
const ANY_STATUS: &[&str] = &[
    "integrations.webhooks",
    "integrations.ai_connect",
    "integrations.ai_admin",
];
const ADMIN: &[&str] = &["integrations.ai_admin"];
const ID: &[&str] = &["param.id:ParseIntPipe"];
const UUID: &[&str] = &["param.id:ParseUUIDPipe"];

/// Hàm tra biến môi trường (dựng một lần ở `serve` từ env tiến trình).
pub type EnvFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Trạng thái dùng chung của router: pool DB, phạm vi quyền, env, bộ gửi webhook ra (SSRF-guard) và bộ nhận webhook vào.
pub struct IntegrationsState {
    pub db: Db,
    pub platform: Platform,
    pub scopes: ScopeService,
    pub env: EnvFn,
    pub sender: Sender,
    pub inbound: InboundService,
}

impl IntegrationsState {
    fn get(&self, k: &str) -> Option<String> {
        (self.env)(k)
    }

    fn webhooks_on(&self) -> bool {
        status::webhooks_enabled(&|k: &str| self.get(k))
    }

    fn any_on(&self) -> bool {
        status::any_enabled(&|k: &str| self.get(k))
    }
}

/// Bảng route (19 dòng) so với `routes.json`.
pub fn specs() -> Vec<RouteSpec> {
    let r = |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok);
    vec![
        r(
            Method::GET,
            "/api/v1/integrations/status",
            Access::CanAny(ANY_STATUS),
            200,
        ),
        r(Method::GET, "/api/v1/integrations/audit-logs", Access::Can(ADMIN), 200),
        r(
            Method::GET,
            "/api/v1/integrations/webhooks/events",
            Access::Can(WEBHOOKS),
            200,
        ),
        r(
            Method::GET,
            "/api/v1/integrations/webhooks/endpoints",
            Access::Can(WEBHOOKS),
            200,
        ),
        r(
            Method::POST,
            "/api/v1/integrations/webhooks/endpoints",
            Access::Can(WEBHOOKS),
            201,
        ),
        r(
            Method::GET,
            "/api/v1/integrations/webhooks/endpoints/:id",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::PATCH,
            "/api/v1/integrations/webhooks/endpoints/:id",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::DELETE,
            "/api/v1/integrations/webhooks/endpoints/:id",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::POST,
            "/api/v1/integrations/webhooks/endpoints/:id/rotate-secret",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::POST,
            "/api/v1/integrations/webhooks/endpoints/:id/test",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::GET,
            "/api/v1/integrations/webhooks/deliveries",
            Access::Can(WEBHOOKS),
            200,
        ),
        r(
            Method::POST,
            "/api/v1/integrations/webhooks/deliveries/:id/retry",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(UUID),
        r(
            Method::GET,
            "/api/v1/integrations/webhooks/inbound-sources",
            Access::Can(WEBHOOKS),
            200,
        ),
        r(
            Method::POST,
            "/api/v1/integrations/webhooks/inbound-sources",
            Access::Can(WEBHOOKS_WRITE),
            201,
        ),
        r(
            Method::GET,
            "/api/v1/integrations/webhooks/inbound-sources/:id",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::PATCH,
            "/api/v1/integrations/webhooks/inbound-sources/:id",
            Access::Can(WEBHOOKS_WRITE),
            200,
        )
        .param_pipes(ID),
        r(
            Method::DELETE,
            "/api/v1/integrations/webhooks/inbound-sources/:id",
            Access::Can(WEBHOOKS),
            200,
        )
        .param_pipes(ID),
        r(
            Method::POST,
            "/api/v1/integrations/webhooks/inbound-sources/:id/rotate-token",
            Access::Can(WEBHOOKS_WRITE),
            200,
        )
        .param_pipes(ID),
        // Mã thật là 200 (`res.status(out.httpStatus)`); 201 là mặc định của decorator `@Post` trong routes.json,
        // handler giữ 200 bằng `KeepStatus`.
        r(Method::POST, "/api/v1/hooks/in/:token", Access::Public, 201),
    ]
}

// ---- Phản hồi lỗi -----------------------------------------------------------------------------------------------------

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

/// Lỗi có mã + câu như `XxxException('câu')` của Nest (mã 5xx dùng chung câu "Internal server error" ở `AppError`).
fn status_err(status: u16, msg: impl Into<String>, authenticated: bool) -> Response {
    respond(HttpError::nest(status, Some(Message::One(msg.into()))), authenticated)
}

/// `new NotFoundException()` (cờ tắt, token lạ).
fn not_found_plain(authenticated: bool) -> Response {
    respond(HttpError::nest(404, None), authenticated)
}

fn internal(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Response {
    fail(AppError::internal(e))
}

fn ep_err(e: EndpointError) -> Response {
    match e {
        EndpointError::Sqlx(e) => internal(e),
        e => status_err(e.http_status(), e.to_string(), true),
    }
}

fn src_err(e: SourceError) -> Response {
    match e {
        SourceError::Sqlx(e) => internal(e),
        e => status_err(e.http_status(), e.to_string(), true),
    }
}

fn delivery_err(e: DeliveryError) -> Response {
    match e {
        DeliveryError::Sqlx(e) => internal(e),
        e @ DeliveryError::InvalidCursor => status_err(400, e.to_string(), true),
    }
}

fn audit_err(e: audit::AuditError) -> Response {
    match e {
        audit::AuditError::Sqlx(e) => internal(e),
        e @ audit::AuditError::InvalidCursor => status_err(400, e.to_string(), true),
    }
}

fn rate_limited(retry_after_sec: u64) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "statusCode": 429,
            "message": "Quá nhiều request, thử lại sau.",
            "retryAfter": retry_after_sec,
        })),
    )
        .into_response();
    resp.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(retry_after_sec));
    resp
}

fn inbound_err(e: InboundError) -> Response {
    match e {
        InboundError::RateLimited { retry_after_sec, .. } => rate_limited(retry_after_sec),
        InboundError::Sqlx(e) => respond(AppError::internal(e), false),
        InboundError::Contacts(e) => respond(*e, false),
        InboundError::NotFound => not_found_plain(false),
        e => status_err(e.http_status(), e.to_string(), false),
    }
}

// ---- Tiện ích dùng chung ----------------------------------------------------------------------------------------------

/// Công ty của token không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
fn company_of(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

async fn tenant_of(s: &IntegrationsState, u: &CurrentUser) -> Result<TenantDb, Response> {
    let co = company_of(u)?;
    s.db.tenant(co).await.map_err(internal)
}

async fn conn_of(t: &TenantDb) -> Result<TenantConn, Response> {
    t.acquire().await.map_err(internal)
}

/// Cờ webhook tắt ⇒ 404 (sau bước kiểm DTO, như pipe của Nest chạy trước handler).
macro_rules! gate {
    ($s:expr) => {
        if !$s.webhooks_on() {
            return not_found_plain(true);
        }
    };
}

macro_rules! tenant {
    ($s:expr, $u:expr) => {
        match tenant_of(&$s, &$u).await {
            Ok(t) => t,
            Err(r) => return r,
        }
    };
}

macro_rules! conn {
    ($t:expr) => {
        match conn_of(&$t).await {
            Ok(c) => c,
            Err(r) => return r,
        }
    };
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`; gốc phải là `{` hoặc `[`.
struct JsonBody(Value);

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .is_some_and(|ct| ct == "application/json" || ct.ends_with("+json"))
}

/// Phân tích thân như `body-parser` strict; trả `(giá trị, có phải JSON không rỗng)`.
fn parse_body(headers: &HeaderMap, bytes: &Bytes) -> Result<(Value, bool), Response> {
    if !is_json(headers) || bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok((Value::Object(Map::new()), false));
    }
    let first = bytes.iter().find(|b| !b.is_ascii_whitespace()).copied().unwrap_or(b' ');
    if first != b'{' && first != b'[' {
        return Err(status_err(400, "Unexpected token in JSON", false));
    }
    serde_json::from_slice::<Value>(bytes)
        .map(|v| (v, true))
        .map_err(|e| status_err(400, e.to_string(), false))
}

async fn read_body(req: Request) -> Result<(HeaderMap, Bytes), Response> {
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, BODY_LIMIT)
        .await
        .map_err(|_| status_err(413, "request entity too large", false))?;
    Ok((parts.headers, bytes))
}

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &S) -> Result<Self, Response> {
        let (headers, bytes) = read_body(req).await?;
        parse_body(&headers, &bytes).map(|(v, _)| Self(v))
    }
}

/// Số nguyên của DTO đã chuyển kiểu (có thể ra số thực `5.0`).
fn int_of(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| {
        v.as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
            .map(|f| f as i64)
    })
}

/// Số nguyên i32 của khoá `k` trong DTO đã kiểm: vắng ⇒ `None`; ngoài khoảng i32 ⇒ 400 (không rơi về `None`).
fn int32(v: &Value, k: &str) -> Result<Option<i32>, Response> {
    match v.get(k).filter(|x| !x.is_null()) {
        None => Ok(None),
        Some(x) => int_of(x)
            .and_then(|n| i32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| status_err(400, format!("{k} must not be greater than {}", i32::MAX), true)),
    }
}

fn string_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn strings_of(v: &Value, k: &str) -> Option<Vec<String>> {
    v.get(k).and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    })
}

/// `:id` đã qua `ParseIntPipe` ở router; số ngoài int4 thì không có bản ghi nào.
fn id_of(raw: &str, not_found: &str) -> Result<i32, Response> {
    raw.parse::<i32>().map_err(|_| status_err(404, not_found, true))
}

fn dto_query(name: &str, uri: &axum::http::Uri) -> Result<Value, Response> {
    validate_value(name, &query_to_json(uri.query().unwrap_or("")), Mode::Strict).map_err(fail)
}

fn dto_body(name: &str, body: &Value) -> Result<Value, Response> {
    validate_value(name, body, Mode::Strict).map_err(fail)
}

fn parse_time(v: &Value, k: &str) -> Result<Option<chrono::DateTime<chrono::Utc>>, Response> {
    match v.get(k).and_then(Value::as_str) {
        None => Ok(None),
        Some(s) => parse_instant_with(s, 0)
            .map(Some)
            .ok_or_else(|| status_err(400, format!("{k} must be a valid ISO 8601 date string"), true)),
    }
}

// ---- IntegrationsController ---------------------------------------------------------------------------------------------

async fn integrations_status(State(s): State<Arc<IntegrationsState>>) -> Response {
    Json(status::status(&|k: &str| s.get(k))).into_response()
}

async fn audit_logs(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    req: Request,
) -> Response {
    let v = match dto_query("QueryAuditLogsDto", req.uri()) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !s.any_on() {
        return not_found_plain(true);
    }
    let q = match build_audit_query(&v) {
        Ok(q) => q,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match audit::list(&mut c, &q).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => audit_err(e),
    }
}

fn build_audit_query(v: &Value) -> Result<AuditQuery, Response> {
    Ok(AuditQuery {
        channel: string_of(v, "channel").and_then(|c| Channel::parse(&c)),
        status: string_of(v, "status").and_then(|c| AuditStatus::parse(&c)),
        user_id: int32(v, "user_id")?,
        from: parse_time(v, "from")?,
        to: parse_time(v, "to")?,
        cursor: string_of(v, "cursor"),
        limit: v.get("limit").and_then(int_of),
    })
}

// ---- WebhooksController -------------------------------------------------------------------------------------------------

async fn events(State(s): State<Arc<IntegrationsState>>) -> Response {
    gate!(s);
    Json(Value::Array(endpoints::event_catalog())).into_response()
}

async fn ep_list(State(s): State<Arc<IntegrationsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    gate!(s);
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::list(&mut c).await {
        Ok(data) => Json(json!({ "data": data })).into_response(),
        Err(e) => ep_err(e),
    }
}

async fn ep_create(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let v = match dto_body("CreateWebhookEndpointDto", &body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let dto = CreateEndpoint {
        name: string_of(&v, "name").unwrap_or_default(),
        url: string_of(&v, "url").unwrap_or_default(),
        events: strings_of(&v, "events").unwrap_or_default(),
    };
    gate!(s);
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::create(&mut c, &s.sender, &dto, u.user.user_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

async fn ep_get(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy endpoint") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::get(&mut c, id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

async fn ep_update(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let v = match dto_body("UpdateWebhookEndpointDto", &body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let dto = UpdateEndpoint {
        name: string_of(&v, "name"),
        url: string_of(&v, "url"),
        events: strings_of(&v, "events"),
        is_active: v.get("is_active").and_then(Value::as_bool),
    };
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy endpoint") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::update(&mut c, &s.sender, id, &dto, u.user.user_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

async fn ep_remove(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy endpoint") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::remove(&mut c, id, u.user.user_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

async fn ep_rotate(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy endpoint") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::rotate_secret(&mut c, &s.sender, id, u.user.user_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

/// Gửi `ping` đồng bộ (tối đa 10 giây): KHÔNG giữ kết nối trong lúc chờ HTTP nên chỉ truyền `TenantDb`.
async fn ep_test(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy endpoint") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    match endpoints::test(&t, &s.sender, id, u.user.user_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

async fn deliveries_list(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    req: Request,
) -> Response {
    let v = match dto_query("QueryWebhookDeliveriesDto", req.uri()) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let q = DeliveryQuery {
        endpoint_id: match int32(&v, "endpoint_id") {
            Ok(n) => n,
            Err(r) => return r,
        },
        status: string_of(&v, "status"),
        event_type: string_of(&v, "event_type"),
        cursor: string_of(&v, "cursor"),
        limit: v.get("limit").and_then(int_of),
    };
    gate!(s);
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match deliveries::list(&mut c, &q).await {
        Ok((data, next_cursor)) => {
            Json(json!({ "data": data, "meta": { "next_cursor": next_cursor } })).into_response()
        }
        Err(e) => delivery_err(e),
    }
}

async fn delivery_retry(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match endpoints::retry_delivery(&mut c, &id, u.user.user_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => ep_err(e),
    }
}

// ---- WebhookInboundSourcesController -------------------------------------------------------------------------------------

/// Người cấu hình kèm phạm vi `contacts.transfer` (người nhận mặc định phải nằm trong đó).
async fn actor_of(s: &IntegrationsState, u: &CurrentUser, with_transfer: bool) -> Result<Actor, Response> {
    let transfer = if with_transfer {
        let co = company_of(u)?;
        s.scopes
            .owner_ids(co, u.user.user_id, &u.grants.grants, "contacts.transfer")
            .await
            .map_err(internal)?
    } else {
        None
    };
    Ok(Actor {
        user_id: u.user.user_id,
        transfer,
    })
}

fn tenant_info(s: &IntegrationsState, u: &CurrentUser) -> Tenant {
    Tenant {
        company_id: u.user.company_id,
        multi_tenant: s.platform.multi_tenant(),
    }
}

async fn src_list(State(s): State<Arc<IntegrationsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    gate!(s);
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match sources::list(&mut c).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => src_err(e),
    }
}

async fn src_create(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match CreateInboundSource::from_body(&body) {
        Ok(d) => d,
        Err(e) => return src_err(e),
    };
    gate!(s);
    let actor = match actor_of(&s, &u, true).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match sources::create(&mut c, &s.inbound_keys(), tenant_info(&s, &u), &dto, &actor).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => src_err(e),
    }
}

async fn src_get(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy nguồn") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match sources::get(&mut c, id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => src_err(e),
    }
}

async fn src_update(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match UpdateInboundSource::from_body(&body) {
        Ok(d) => d,
        Err(e) => return src_err(e),
    };
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy nguồn") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let actor = match actor_of(&s, &u, true).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match sources::update(&mut c, &s.inbound_keys(), id, &dto, &actor).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => src_err(e),
    }
}

async fn src_rotate(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy nguồn") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let actor = match actor_of(&s, &u, true).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match sources::rotate_token(&mut c, tenant_info(&s, &u), id, &actor).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => src_err(e),
    }
}

async fn src_remove(
    State(s): State<Arc<IntegrationsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    gate!(s);
    let id = match id_of(&id, "Không tìm thấy nguồn") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let actor = match actor_of(&s, &u, false).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let t = tenant!(s, u);
    let mut c = conn!(t);
    match sources::remove(&mut c, id, &actor).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => src_err(e),
    }
}

// ---- WebhookInboundController (công khai) -------------------------------------------------------------------------------

/// Công ty của đường công khai: `?cid=`/`x-trinity-company` (số nguyên dương), không có thì công ty 1; công ty không tồn tại
/// hoặc bị treo ⇒ 404 (KHÔNG rơi về công ty 1). Bản một công ty luôn là công ty 1.
async fn public_company(
    s: &IntegrationsState,
    headers: &HeaderMap,
    q: &HashMap<String, String>,
) -> Result<CompanyRef, Response> {
    if !s.platform.multi_tenant() {
        return CompanyRef::new(1).map_err(|e| respond(AppError::internal(e), false));
    }
    let raw = q
        .get("cid")
        .map(String::as_str)
        .or_else(|| headers.get("x-trinity-company").and_then(|v| v.to_str().ok()));
    let id = raw
        .and_then(|r| r.trim().parse::<f64>().ok())
        .filter(|n| n.fract() == 0.0 && *n > 0.0)
        .map_or(1, |n| n as i64);
    match s.platform.active_company(id).await {
        Ok(Some(c)) => Ok(c),
        Ok(None) => Err(not_found_plain(false)),
        Err(e) => Err(respond(AppError::internal(e), false)),
    }
}

/// `POST /hooks/in/:token`: thân và chữ ký đọc nguyên byte (chữ ký ký trên byte thô). Phản hồi công khai luôn `200`.
async fn inbound(
    State(s): State<Arc<IntegrationsState>>,
    Path(token): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    req: Request,
) -> Response {
    let (headers, bytes) = match read_body(req).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    let (body, has_raw) = match parse_body(&headers, &bytes) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let co = match public_company(&s, &headers, &q).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let db = match s.db.tenant(co).await {
        Ok(t) => t,
        Err(e) => return respond(AppError::internal(e), false),
    };
    let signature = headers.get("x-trinity-signature").and_then(|v| v.to_str().ok());
    let request = InboundRequest {
        raw_body: has_raw.then_some(&bytes[..]),
        body: &body,
        signature,
    };
    match s.inbound.receive(&db, &token, &request).await {
        Ok(out) => {
            let status = StatusCode::from_u16(out.http_status).unwrap_or(StatusCode::OK);
            let mut resp = (status, Json(out.body)).into_response();
            resp.extensions_mut().insert(KeepStatus);
            resp
        }
        Err(e) => inbound_err(e),
    }
}

impl IntegrationsState {
    /// Nguồn khoá của webhook vào (cùng khoá `INTEGRATIONS_SECRET_KEY` với webhook ra).
    fn inbound_keys(&self) -> crate::webhooks::secret::KeySource {
        let env = Arc::clone(&self.env);
        Arc::new(move || crate::webhooks::secret::load_secret_key(&|k: &str| env(k)))
    }
}

/// Router của module (19 route). Người gọi gắn state `Arc<IntegrationsState>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<IntegrationsState>> {
    let table = specs();
    let spec = |m: Method, p: &str| -> RouteSpec {
        table
            .iter()
            .find(|r| r.method == m && r.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("route {m} {p} chưa khai trong specs()"))
    };
    ApiRouter::new(deps)
        .route(spec(Method::GET, "/api/v1/integrations/status"), integrations_status)
        .route(spec(Method::GET, "/api/v1/integrations/audit-logs"), audit_logs)
        .route(spec(Method::GET, "/api/v1/integrations/webhooks/events"), events)
        .route(spec(Method::GET, "/api/v1/integrations/webhooks/endpoints"), ep_list)
        .route(spec(Method::POST, "/api/v1/integrations/webhooks/endpoints"), ep_create)
        .route(spec(Method::GET, "/api/v1/integrations/webhooks/endpoints/:id"), ep_get)
        .route(
            spec(Method::PATCH, "/api/v1/integrations/webhooks/endpoints/:id"),
            ep_update,
        )
        .route(
            spec(Method::DELETE, "/api/v1/integrations/webhooks/endpoints/:id"),
            ep_remove,
        )
        .route(
            spec(
                Method::POST,
                "/api/v1/integrations/webhooks/endpoints/:id/rotate-secret",
            ),
            ep_rotate,
        )
        .route(
            spec(Method::POST, "/api/v1/integrations/webhooks/endpoints/:id/test"),
            ep_test,
        )
        .route(
            spec(Method::GET, "/api/v1/integrations/webhooks/deliveries"),
            deliveries_list,
        )
        .route(
            spec(Method::POST, "/api/v1/integrations/webhooks/deliveries/:id/retry"),
            delivery_retry,
        )
        .route(
            spec(Method::GET, "/api/v1/integrations/webhooks/inbound-sources"),
            src_list,
        )
        .route(
            spec(Method::POST, "/api/v1/integrations/webhooks/inbound-sources"),
            src_create,
        )
        .route(
            spec(Method::GET, "/api/v1/integrations/webhooks/inbound-sources/:id"),
            src_get,
        )
        .route(
            spec(Method::PATCH, "/api/v1/integrations/webhooks/inbound-sources/:id"),
            src_update,
        )
        .route(
            spec(Method::DELETE, "/api/v1/integrations/webhooks/inbound-sources/:id"),
            src_remove,
        )
        .route(
            spec(
                Method::POST,
                "/api/v1/integrations/webhooks/inbound-sources/:id/rotate-token",
            ),
            src_rotate,
        )
        .route(spec(Method::POST, "/api/v1/hooks/in/:token"), inbound)
}

#[cfg(test)]
mod tests {
    use trinity_http::router::check::check_embedded;

    use super::*;

    #[test]
    fn bang_route_khop_routes_json() {
        let s = specs();
        assert_eq!(s.len(), 19);
        let rep = check_embedded(&s, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
    }

    #[test]
    fn khong_route_nao_can_org_feature_hay_guard_rieng() {
        assert!(specs().iter().all(|r| r.org_feature.is_none() && r.guards.is_empty()));
    }

    #[test]
    fn id_ngoai_int4_la_404() {
        assert_eq!(id_of("12", "x").ok(), Some(12));
        assert!(id_of("99999999999", "x").is_err());
    }

    #[test]
    fn so_nguyen_ngoai_i32_la_400() {
        assert_eq!(int32(&json!({"n": 5.0}), "n").ok().flatten(), Some(5));
        assert_eq!(int32(&json!({}), "n").ok().flatten(), None);
        assert!(int32(&json!({"n": 3_000_000_000_i64}), "n").is_err());
    }

    #[test]
    fn thoi_gian_nhieu_dang() {
        assert!(parse_time(&json!({"from": "2026-10-01"}), "from").unwrap().is_some());
        assert!(
            parse_time(&json!({"from": "2026-10-01T10:00:00+0700"}), "from")
                .unwrap()
                .is_some()
        );
        assert!(parse_time(&json!({}), "from").unwrap().is_none());
    }

    #[test]
    fn body_json_nhu_body_parser() {
        let mut h = HeaderMap::new();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        let (v, raw) = parse_body(&h, &Bytes::from_static(b"{\"a\":1}")).unwrap();
        assert!(raw && v["a"] == 1);
        assert!(parse_body(&h, &Bytes::from_static(b"nope")).is_err());
        let (v, raw) = parse_body(&HeaderMap::new(), &Bytes::from_static(b"{\"a\":1}")).unwrap();
        assert!(!raw && v.as_object().is_some_and(Map::is_empty));
    }
}
