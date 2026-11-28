//! Bảng route của M52 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Kết nối, ngắt và ZNS cần `integrations.webhooks`; hộp thư (xem, trả lời, ghép khách) cần
//! `contacts.update`. Cờ/gói `zalo_oa` tắt ⇒ 403 (`org_feature`, kèm `OrgFeatureGuard`); callback OAuth và webhook công khai
//! (xác thực bằng `state` và chữ ký), webhook luôn 200 sau khi kiểm chữ ký để Zalo không gửi lại.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http::Method;
use mod_channel_guard::ChannelGuard;
use serde::Serialize;
use serde_json::{Map, Value, json};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};

use crate::client::ZaloClient;
use crate::config::{Env, zalo_oa_config};
use crate::messaging::{self, ZnsInput};
use crate::threads;
use crate::token::{self, Ctx, acquire};
use crate::webhook;
use crate::{LinkThread, SavePhone, SendText, SendZns, clamp_limit, parse_cursor};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 11 route của `ZaloOaController` + `save-phone` (chỉ có ở Rust, khai ở `RUST_ONLY_AUTHED_ROUTES`).
pub fn routes() -> Vec<RouteSpec> {
    let inbox = Access::Can(&["contacts.update"]);
    let manage = Access::Can(&["integrations.webhooks"]);
    let r =
        |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok).org_feature("zalo_oa");
    vec![
        r(Method::GET, "/api/v1/zalo-oa/status", inbox, 200),
        r(Method::POST, "/api/v1/zalo-oa/connect", manage, 200),
        RouteSpec::new(Method::GET, "/api/v1/zalo-oa/oauth/callback", Access::Public),
        r(Method::DELETE, "/api/v1/zalo-oa/connection", manage, 204),
        r(Method::GET, "/api/v1/zalo-oa/threads", inbox, 200),
        r(Method::GET, "/api/v1/zalo-oa/threads/:id/messages", inbox, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/messages", inbox, 201).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/read", inbox, 204).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/link", inbox, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/save-phone", inbox, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/zns", manage, 200),
        RouteSpec::new(Method::POST, "/api/v1/zalo-oa/webhook", Access::Public).status_ok(200),
    ]
}

/// Trạng thái của router: DB, nền tảng đa công ty, env, client Zalo và `ChannelGuard` (tin tư vấn, ZNS).
pub struct ZaloState {
    pub db: Db,
    pub platform: Platform,
    pub env: Env,
    pub client: ZaloClient,
    pub guard: ChannelGuard,
}

impl ZaloState {
    pub fn new(db: Db, platform: Platform, env: Env, guard: ChannelGuard) -> Self {
        let client = ZaloClient::new(env.clone());
        Self {
            db,
            platform,
            env,
            client,
            guard,
        }
    }

    fn ctx(&self, company: CompanyRef) -> Ctx<'_> {
        Ctx {
            db: &self.db,
            env: &self.env,
            client: &self.client,
            platform: &self.platform,
            company,
        }
    }
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

fn no_content(r: Result<(), AppError>) -> Response {
    match r {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
macro_rules! company {
    ($u:expr) => {
        match CompanyRef::new(i64::from($u.user.company_id)) {
            Ok(c) => c,
            Err(_) => return fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")),
        }
    };
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có hội thoại nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không có hội thoại này").into())
}

fn param<'a>(q: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    q.get(key).map(String::as_str)
}

fn found(url: &str) -> Response {
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::FOUND;
    if let Ok(v) = HeaderValue::from_str(url) {
        r.headers_mut().insert(header::LOCATION, v);
    }
    r
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

async fn status(State(s): State<Arc<ZaloState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    ok(token::status(&s.ctx(company)).await)
}

async fn connect(State(s): State<Arc<ZaloState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    ok(token::start_connect(&s.ctx(company), u.user.user_id, now_ms()).await)
}

/// Công ty đã mở luồng OAuth theo `state` (nhiều công ty); một công ty thì luôn công ty mặc định.
async fn oauth_company(platform: &Platform, state: &str) -> Option<CompanyRef> {
    if !platform.multi_tenant() {
        return Some(CompanyRef::DEFAULT);
    }
    let id = platform.company_for_oauth_state(state).await.ok()??;
    CompanyRef::new(i64::from(id)).ok()
}

async fn callback(State(s): State<Arc<ZaloState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let back = zalo_oa_config(&s.env).post_connect_url;
    let sep = if back.contains('?') { '&' } else { '?' };
    let to = |outcome: &str| found(&format!("{back}{sep}zalo_oa={outcome}"));
    let get = |k: &str| param(&q, k).unwrap_or_default();
    let Some(company) = oauth_company(&s.platform, get("state")).await else {
        return to("error");
    };
    let ctx = s.ctx(company);
    match token::complete_connect(&ctx, get("code"), get("oa_id"), get("state"), now_ms()).await {
        Ok(_) => to("connected"),
        Err(_) => to("error"),
    }
}

async fn disconnect(State(s): State<Arc<ZaloState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    no_content(token::disconnect(&s.ctx(company)).await)
}

async fn list(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let company = company!(u);
    let ctx = s.ctx(company);
    let page = async {
        let mut conn = acquire(&ctx).await?;
        threads::list(
            &mut conn,
            clamp_limit(param(&q, "limit"), 30, 100),
            parse_cursor(param(&q, "cursor")),
            param(&q, "q"),
        )
        .await
    }
    .await;
    ok(page)
}

async fn messages(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let company = company!(u);
    let before = match param(&q, "before").map(threads::parse_before) {
        None => None,
        Some(Ok(n)) => Some(n),
        Some(Err(e)) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let ctx = s.ctx(company);
    let limit = clamp_limit(param(&q, "limit"), 50, 200);
    let rows = async {
        let mut conn = acquire(&ctx).await?;
        threads::messages(&mut conn, id, limit, before).await
    }
    .await;
    ok(rows.map(|data| json!({ "data": data })))
}

async fn reply(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let dto = match SendText::from_json(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let sent = messaging::send_text(
        &s.ctx(company),
        Some(&s.guard),
        id,
        &dto.text,
        Some(u.user.user_id),
        now_ms(),
    )
    .await;
    ok(sent.map(|message_id| json!({ "message_id": message_id })))
}

async fn read(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let ctx = s.ctx(company);
    let done = async {
        let mut conn = acquire(&ctx).await?;
        threads::mark_read(&mut conn, id).await
    }
    .await;
    no_content(done)
}

async fn link(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let dto = match LinkThread::from_json(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let ctx = s.ctx(company);
    let phone = dto.phone.as_deref();
    let thread = async {
        let mut conn = acquire(&ctx).await?;
        threads::link(&mut conn, id, dto.contact_id, phone, u.user.user_id).await
    }
    .await;
    ok(thread)
}

async fn save_phone(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let dto = match SavePhone::from_json(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let ctx = s.ctx(company);
    let saved = async {
        let mut conn = acquire(&ctx).await?;
        threads::save_phone(&mut conn, id, dto.message_id, dto.phone.as_deref(), u.user.user_id).await
    }
    .await;
    ok(saved)
}

async fn zns(
    State(s): State<Arc<ZaloState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let dto = match SendZns::from_json(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let input = ZnsInput {
        phone: &dto.phone,
        template_id: &dto.template_id,
        template_data: &dto.template_data,
        tracking_id: dto.tracking_id.as_deref(),
        sent_by: Some(u.user.user_id),
    };
    ok(messaging::send_zns(&s.ctx(company), Some(&s.guard), &input, now_ms()).await)
}

/// `POST /zalo-oa/webhook`: chữ ký tính trên BYTE THÔ nên đọc `Bytes`; công ty mặc định cho bản một công ty, nhiều công ty
/// thì `webhook::receive` tìm theo OA.
async fn webhook_receive(State(s): State<Arc<ZaloState>>, headers: HeaderMap, body: Bytes) -> Response {
    let signature = headers.get("x-zevent-signature").and_then(|v| v.to_str().ok());
    let raw = (!body.is_empty()).then_some(body.as_ref());
    // Bộ đọc thân JSON của Node từ chối thân hỏng bằng 400 TRƯỚC khi tới kiểm chữ ký.
    if raw.is_some_and(
        |r| !matches!(serde_json::from_slice::<serde_json::Value>(r), Ok(v) if v.is_object() || v.is_array()),
    ) {
        return fail(HttpError::bad_request("Thân yêu cầu không phải JSON hợp lệ"));
    }
    let out = webhook::receive(&s.ctx(CompanyRef::DEFAULT), raw, signature, now_ms()).await;
    ok(out.map(|o| json!({ "ok": o.ok })))
}

/// Router của module: 12 route, quyền và mã thành công khớp `routes.json`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<ZaloState>> {
    let table = routes();
    let spec = |m: &Method, p: &str| {
        table
            .iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/zalo-oa/status"), status)
        .route(spec(&Method::POST, "/api/v1/zalo-oa/connect"), connect)
        .route(spec(&Method::GET, "/api/v1/zalo-oa/oauth/callback"), callback)
        .route(spec(&Method::DELETE, "/api/v1/zalo-oa/connection"), disconnect)
        .route(spec(&Method::GET, "/api/v1/zalo-oa/threads"), list)
        .route(spec(&Method::GET, "/api/v1/zalo-oa/threads/:id/messages"), messages)
        .route(spec(&Method::POST, "/api/v1/zalo-oa/threads/:id/messages"), reply)
        .route(spec(&Method::POST, "/api/v1/zalo-oa/threads/:id/read"), read)
        .route(spec(&Method::POST, "/api/v1/zalo-oa/threads/:id/link"), link)
        .route(
            spec(&Method::POST, "/api/v1/zalo-oa/threads/:id/save-phone"),
            save_phone,
        )
        .route(spec(&Method::POST, "/api/v1/zalo-oa/zns"), zns)
        .route(spec(&Method::POST, "/api/v1/zalo-oa/webhook"), webhook_receive)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 12);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        // `save-phone` chỉ có ở Rust nên không tính vào số route đã khớp routes.json.
        assert_eq!(rep.declared, 11);
    }
}
