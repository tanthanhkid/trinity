//! Bảng route và handler của module (K14): 6 route OAuth + 2 route kết nối AI, khớp `contracts/routes.json`.
//!
//! Route OAuth công khai (`Access::Public`): xác thực nằm trong từng endpoint (PKCE, client auth, giới hạn tốc độ). Lỗi trả
//! theo RFC 6749 (`{error, error_description}`), không qua bộ định dạng lỗi `{statusCode, message}` của Nest. Cờ
//! `INTEGRATIONS_MCP_ENABLED` hoặc URL gốc thiếu ⇒ mọi route 404.

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use trinity_db::CompanyRef;
use trinity_http::edge::client_ip::{ClientIp, resolve_client_ip};
use trinity_http::rate_limit::{Hit, now_ms};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_integrations::audit::AuditStatus;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::can;

use crate::authorize::AuthorizeInput;
use crate::consent::parse_granted;
use crate::ctx::OauthCtx;
use crate::error::OAuthError;
use crate::metadata::{authorization_server_metadata, protected_resource_metadata};

const BODY_LIMIT: usize = 5 * 1024 * 1024;
const CONSENT: Access = Access::Can(&["integrations.ai_connect"]);
const CONNECTIONS: Access = Access::CanAny(&["integrations.ai_connect", "integrations.ai_admin"]);

pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(
            Method::GET,
            "/api/v1/oauth/.well-known/oauth-authorization-server",
            Access::Public,
        )
        .status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/oauth/protected-resource", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/oauth/register", Access::Public).status_ok(201),
        RouteSpec::new(Method::POST, "/api/v1/oauth/token", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/oauth/revoke", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/oauth/authorize/context", CONSENT).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/oauth/authorize/decision", CONSENT).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/integrations/ai-connections", CONNECTIONS).status_ok(200),
        RouteSpec::new(Method::DELETE, "/api/v1/integrations/ai-connections/:id", CONNECTIONS).status_ok(204),
    ]
}

// ---------------------------------------------------------------- phản hồi

fn plain_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "statusCode": 404, "message": "Not Found" })),
    )
        .into_response()
}

fn app_fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn no_store(mut r: Response) -> Response {
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    r
}

/// Lỗi OAuth ở endpoint công khai: `{error, error_description}` kèm `Cache-Control: no-store`; 401 thêm `WWW-Authenticate`.
fn oauth_fail(e: &OAuthError) -> Response {
    let mut r = no_store(
        (
            StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_REQUEST),
            Json(e.body()),
        )
            .into_response(),
    );
    if e.status == 401 {
        r.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"oauth\""),
        );
    }
    r
}

/// Lỗi ở màn đồng ý (Bearer JWT): 401 đổi thành 400 để FE không tưởng phiên đăng nhập hết hạn.
fn consent_fail(e: &OAuthError) -> Response {
    let status = if e.status == 401 { 400 } else { e.status };
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        Json(e.body()),
    )
        .into_response()
}

fn too_many(retry_after: u64, no_store_headers: bool) -> Response {
    let mut r = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": "temporarily_unavailable", "error_description": "Quá nhiều yêu cầu, thử lại sau" })),
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&retry_after.to_string()) {
        r.headers_mut().insert(header::RETRY_AFTER, v);
    }
    if no_store_headers { no_store(r) } else { r }
}

fn metadata_response(v: Value) -> Response {
    let mut r = Json(v).into_response();
    let h = r.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=300"));
    r
}

// ---------------------------------------------------------------- thân và giới hạn

/// Thân như body-parser: JSON hoặc `application/x-www-form-urlencoded`; loại khác hoặc rỗng ⇒ `{}`; không phải đối tượng ⇒ `{}`.
async fn read_body(req: Request) -> Result<Map<String, Value>, Response> {
    let ct = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    let bytes: Bytes = to_bytes(req.into_body(), BODY_LIMIT)
        .await
        .map_err(|_| app_fail(HttpError::payload_too_large("request entity too large")))?;
    if ct == "application/json" {
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Map::new());
        }
        return match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(m)) => Ok(m),
            Ok(Value::Array(_)) => Ok(Map::new()),
            _ => Err(app_fail(HttpError::bad_request("Unexpected token in JSON"))),
        };
    }
    if ct == "application/x-www-form-urlencoded" {
        let mut m = Map::new();
        for (k, v) in form_urlencoded::parse(&bytes) {
            let (k, v) = (k.into_owned(), Value::String(v.into_owned()));
            match m.remove(&k) {
                None => m.insert(k, v),
                Some(Value::Array(mut a)) => {
                    a.push(v);
                    m.insert(k, Value::Array(a))
                }
                Some(old) => m.insert(k, Value::Array(vec![old, v])),
            };
        }
        return Ok(m);
    }
    Ok(Map::new())
}

fn obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

/// Giới hạn tốc độ theo IP khách. IP không tin được ⇒ kiểm CẢ HAI: trần chung theo IP peer VÀ khoá riêng của client (`own`:
/// client_id, redirect_uris…) trên `limiter`; đổi `own` không lách được trần peer, một client cũng không làm nghẽn client khác.
fn hit_by_client(
    ctx: &OauthCtx,
    limiter: &trinity_http::rate_limit::FixedWindowLimiter,
    prefix: &str,
    client: &ClientIp,
    own: Option<&str>,
) -> Hit {
    let now = now_ms();
    if let Some(ip) = client.ip {
        return limiter.hit(&format!("{prefix}:{ip}"), now);
    }
    let peer = ctx
        .limits
        .untrusted_peer
        .hit(&format!("{prefix}:{}", client.rate_key), now);
    // `own.trim().slice(0, 200)` (đơn vị UTF-16).
    let o = String::from_utf16_lossy(
        &crate::util::js_trim(own.unwrap_or(""))
            .encode_utf16()
            .take(200)
            .collect::<Vec<u16>>(),
    );
    let digest = Sha256::digest(o.as_bytes());
    let short: String = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(24)
        .collect();
    let mine = limiter.hit(&format!("{prefix}:u:{short}"), now);
    if peer.allowed { mine } else { peer }
}

/// `own` của giới hạn: `body.client_id` nếu là chuỗi.
fn own_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

// ---------------------------------------------------------------- handler công khai

async fn as_metadata(State(ctx): State<Arc<OauthCtx>>) -> Response {
    match (&ctx.config.base, ctx.config.enabled) {
        (Some(b), true) => metadata_response(authorization_server_metadata(b)),
        _ => metadata_not_found(),
    }
}

async fn pr_metadata(State(ctx): State<Arc<OauthCtx>>) -> Response {
    match (&ctx.config.base, ctx.config.enabled) {
        (Some(b), true) => metadata_response(protected_resource_metadata(b)),
        _ => metadata_not_found(),
    }
}

/// 404 của route metadata vẫn mang header `@Header` của Nest.
fn metadata_not_found() -> Response {
    let mut r = plain_not_found();
    let h = r.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=300"));
    r
}

async fn register(State(ctx): State<Arc<OauthCtx>>, req: Request) -> Response {
    let client = resolve_client_ip(&ctx.ip, &req);
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !ctx.config.enabled {
        return plain_not_found();
    }
    let own = trinity_kernel::json::js_json(body.get("redirect_uris").unwrap_or(&Value::String(String::new())));
    let hit = hit_by_client(&ctx, &ctx.limits.register, "reg", &client, Some(&own));
    if !hit.allowed {
        return too_many(hit.retry_after_sec, true);
    }
    match ctx.register_client(&body).await {
        Ok(out) => {
            let id = out
                .get("client_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let name = out.get("client_name").cloned().unwrap_or(Value::Null);
            ctx.audit(
                CompanyRef::DEFAULT,
                OauthCtx::entry(
                    "oauth.register",
                    AuditStatus::Ok,
                    &id,
                    None,
                    json!({ "client_name": name }),
                ),
            )
            .await;
            no_store((StatusCode::CREATED, Json(out)).into_response())
        }
        Err(e) => oauth_fail(&e),
    }
}

async fn token(State(ctx): State<Arc<OauthCtx>>, req: Request) -> Response {
    let client = resolve_client_ip(&ctx.ip, &req);
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !ctx.config.enabled {
        return plain_not_found();
    }
    let hit = hit_by_client(&ctx, &ctx.limits.token, "tok", &client, own_of(body.get("client_id")));
    if !hit.allowed {
        return too_many(hit.retry_after_sec, true);
    }
    match ctx.token(&body).await {
        Ok(out) => no_store(Json(out).into_response()),
        Err(e) => oauth_fail(&e),
    }
}

async fn revoke(State(ctx): State<Arc<OauthCtx>>, req: Request) -> Response {
    let client = resolve_client_ip(&ctx.ip, &req);
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !ctx.config.enabled {
        return plain_not_found();
    }
    let hit = hit_by_client(&ctx, &ctx.limits.token, "rev", &client, own_of(body.get("client_id")));
    if !hit.allowed {
        return too_many(hit.retry_after_sec, true);
    }
    match ctx.revoke_token(&body).await {
        Ok(()) => no_store(Json(json!({})).into_response()),
        Err(e) => oauth_fail(&e),
    }
}

// ---------------------------------------------------------------- màn đồng ý

/// Người dùng của request; công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
fn who(u: &CurrentUser) -> Result<(CompanyRef, i32), Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map(|c| (c, u.user.user_id))
        .map_err(|_| app_fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

/// Cờ bật + giới hạn 30 lần/phút/người dùng (khoá theo công ty).
fn consent_gate(ctx: &OauthCtx, company: CompanyRef, user: i32) -> Option<Response> {
    if !ctx.config.enabled {
        return Some(plain_not_found());
    }
    let hit = ctx
        .limits
        .consent
        .hit_company(company.id(), &format!("consent:{user}"), now_ms());
    (!hit.allowed).then(|| too_many(hit.retry_after_sec, false))
}

async fn consent_context(
    State(ctx): State<Arc<OauthCtx>>,
    Extension(u): Extension<CurrentUser>,
    req: Request,
) -> Response {
    let (company, user) = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if let Some(r) = consent_gate(&ctx, company, user) {
        return r;
    }
    let params: AuthorizeInput = obj(body.get("params")).cloned().unwrap_or_default();
    match ctx.consent_context(company, user, &params).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => consent_fail(&e),
    }
}

async fn consent_decision(
    State(ctx): State<Arc<OauthCtx>>,
    Extension(u): Extension<CurrentUser>,
    req: Request,
) -> Response {
    let (company, user) = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if let Some(r) = consent_gate(&ctx, company, user) {
        return r;
    }
    let params: AuthorizeInput = obj(body.get("params")).cloned().unwrap_or_default();
    let (Some(approve), Some(token)) = (
        body.get("approve").and_then(Value::as_bool),
        body.get("consent_token").and_then(Value::as_str),
    ) else {
        return consent_fail(&OAuthError::new("invalid_request", "Thiếu approve hoặc consent_token"));
    };
    let granted = match parse_granted(body.get("granted_scopes")) {
        Ok(g) => g,
        Err(e) => return consent_fail(&e),
    };
    match ctx
        .consent_decision(company, user, &params, approve, token, granted)
        .await
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => consent_fail(&e),
    }
}

// ---------------------------------------------------------------- kết nối AI

fn is_ai_admin(u: &CurrentUser) -> bool {
    u.is_admin() || can(&u.grants.grants, "integrations.ai_admin", None)
}

async fn connections_list(
    State(ctx): State<Arc<OauthCtx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let (company, user) = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if !ctx.config.enabled {
        return plain_not_found();
    }
    let all = q.get("scope").is_some_and(|s| s == "all");
    // `scope=all` mà thiếu `integrations.ai_admin` ⇒ 404 (không lộ sự tồn tại).
    if all && !is_ai_admin(&u) {
        return plain_not_found();
    }
    match ctx.list_connections(company, user, all).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => oauth_fail_plain(&e),
    }
}

async fn connections_revoke(
    State(ctx): State<Arc<OauthCtx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let (company, user) = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if !ctx.config.enabled {
        return plain_not_found();
    }
    match ctx.revoke_connection(company, &id, user, is_ai_admin(&u)).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => app_fail(HttpError::not_found("Không tìm thấy kết nối")),
        Err(e) => oauth_fail_plain(&e),
    }
}

/// Lỗi nội bộ ở route Bearer: 500 theo định dạng lỗi chung.
fn oauth_fail_plain(e: &OAuthError) -> Response {
    app_fail(HttpError::nest(e.status, None))
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<OauthCtx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<OauthCtx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(
            spec(&Method::GET, "/api/v1/oauth/.well-known/oauth-authorization-server"),
            as_metadata,
        )
        .route(spec(&Method::GET, "/api/v1/oauth/protected-resource"), pr_metadata)
        .route(spec(&Method::POST, "/api/v1/oauth/register"), register)
        .route(spec(&Method::POST, "/api/v1/oauth/token"), token)
        .route(spec(&Method::POST, "/api/v1/oauth/revoke"), revoke)
        .route(spec(&Method::POST, "/api/v1/oauth/authorize/context"), consent_context)
        .route(
            spec(&Method::POST, "/api/v1/oauth/authorize/decision"),
            consent_decision,
        )
        .route(
            spec(&Method::GET, "/api/v1/integrations/ai-connections"),
            connections_list,
        )
        .route(
            spec(&Method::DELETE, "/api/v1/integrations/ai-connections/:id"),
            connections_revoke,
        )
}
