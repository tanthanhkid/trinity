//! Bảng route và handler của M01 (K14): 23 route `/api/v1/auth/*` (không gồm `/auth/teams`, thuộc `mod-apikeys`). Mỗi route khai
//! [`Access`] bắt buộc, quyền và mã thành công khớp `contracts/routes.json`. Token trả trong body (bản TS không đặt cookie).

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, Request, State};
use axum::handler::Handler;
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use trinity_db::{CompanyRef, Db};
use trinity_http::edge::body::read_field_limited;
use trinity_http::edge::client_ip::{ClientIp, ClientIpResolver, resolve_client_ip};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;

use crate::{Actor, AuthFail, AuthService, Patch, PermGrants, Upload, dto, invitable_roles, invitation_scope};

const INVITATIONS: &str = "/api/v1/auth/invitations";
const WIFI: &str = "/api/v1/auth/settings/login-wifi-check";
const TARGETS: &str = "/api/v1/auth/settings/login-wifi-check-targets";
const SINGLE: &str = "/api/v1/auth/settings/single-session";
const ID_PIPE: &[&str] = &["param.id:ParseIntPipe"];
const SETTINGS: Access = Access::Can(&["settings.integrations"]);
const USERS_MANAGE: Access = Access::Can(&["users.manage"]);
/// `FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } })`.
const AVATAR_MAX_BYTES: usize = 5 * 1024 * 1024;
const RATE_LIMIT_MESSAGE: &str = "Quá nhiều lần thử, vui lòng thử lại sau";

/// Trạng thái dùng chung của router M01.
pub struct AuthCtx {
    pub auth: Arc<AuthService<PermGrants>>,
    pub db: Db,
    pub scopes: ScopeService,
    pub ip: Arc<ClientIpResolver>,
}

type S = State<Arc<AuthCtx>>;
type U = Extension<CurrentUser>;

/// Bảng route của module (23 dòng), so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let post = |p: &'static str, a: Access, code: u16| RouteSpec::new(Method::POST, p, a).status_ok(code);
    let get = |p: &'static str, a: Access| RouteSpec::new(Method::GET, p, a).status_ok(200);
    vec![
        post("/api/v1/auth/login", Access::Public, 200),
        post("/api/v1/auth/register", Access::Public, 201),
        get("/api/v1/auth/signup-enabled", Access::Public),
        post("/api/v1/auth/refresh", Access::Public, 200),
        post("/api/v1/auth/logout", Access::AuthOnly, 200),
        get("/api/v1/auth/me", Access::AuthOnly),
        RouteSpec::new(Method::PATCH, "/api/v1/auth/password", Access::AuthOnly).status_ok(200),
        post("/api/v1/auth/reset-password", Access::AuthOnly, 200),
        RouteSpec::new(Method::PATCH, "/api/v1/auth/profile", Access::AuthOnly).status_ok(200),
        post("/api/v1/auth/profile/avatar", Access::AuthOnly, 201),
        get(WIFI, Access::AuthOnly),
        RouteSpec::new(Method::PATCH, WIFI, SETTINGS).status_ok(200),
        get(TARGETS, SETTINGS),
        RouteSpec::new(Method::PUT, TARGETS, SETTINGS).status_ok(200),
        get("/api/v1/auth/settings/login-wifi-check-targets/roster", SETTINGS),
        get(SINGLE, Access::AuthOnly),
        RouteSpec::new(Method::PATCH, SINGLE, SETTINGS).status_ok(200),
        post(INVITATIONS, USERS_MANAGE, 201),
        get(INVITATIONS, USERS_MANAGE),
        get("/api/v1/auth/invitations/roles", USERS_MANAGE),
        post("/api/v1/auth/invitations/:id/revoke", USERS_MANAGE, 200).param_pipes(ID_PIPE),
        post("/api/v1/auth/invitations/preview", Access::Public, 200),
        post("/api/v1/auth/invitations/accept", Access::Public, 201),
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

/// Lỗi của `AuthService`: 429 của giới hạn tốc độ có dạng `{ statusCode, message, retryAfter }` (đối tượng thuần của
/// `HttpException`), còn lại là lỗi HTTP thường.
pub fn auth_fail(e: AuthFail) -> Response {
    match e.retry_after() {
        Some(retry) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "statusCode": 429, "message": RATE_LIMIT_MESSAGE, "retryAfter": retry })),
        )
            .into_response(),
        None => fail(e.error().clone()),
    }
}

fn res(r: Result<Value, AuthFail>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => auth_fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
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

fn actor_of(u: &CurrentUser, company: CompanyRef) -> Actor {
    Actor {
        user_id: u.user.user_id,
        company,
        is_admin: u.grants.is_admin,
        grants: u.grants.grants.clone(),
    }
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`, hỏng ⇒ 400.
pub async fn read_body(req: Request) -> Result<Value, Response> {
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
        return Ok(Value::Object(Map::new()));
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(v),
        _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
    }
}

/// IP khách (đã qua lớp K16) và thân JSON của request.
struct Input {
    client: ClientIp,
    body: Value,
}

impl Input {
    /// Khoá IP cho giới hạn tốc độ và nhật ký (IP khách, hoặc IP peer khi không tin được).
    fn ip(&self) -> Option<&str> {
        Some(self.client.rate_key.as_str())
    }

    /// IP khách có tin được để so với IP văn phòng không.
    fn trusted(&self) -> bool {
        self.client.ip.is_some()
    }
}

async fn input(c: &AuthCtx, req: Request) -> Result<Input, Response> {
    let client = resolve_client_ip(&c.ip, &req);
    let body = read_body(req).await?;
    Ok(Input { client, body })
}

macro_rules! inp {
    ($c:expr, $req:expr) => {
        match input(&$c, $req).await {
            Ok(i) => i,
            Err(r) => return r,
        }
    };
}

fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy lời mời").into())
}

// ---------------------------------------------------------------- công khai

async fn login(State(c): S, req: Request) -> Response {
    let i = inp!(c, req);
    match dto::login(&i.body) {
        Ok(d) => res(c.auth.login(&d.email, &d.password, i.ip(), i.trusted()).await),
        Err(e) => fail(e),
    }
}

async fn register(State(c): S, req: Request) -> Response {
    let i = inp!(c, req);
    match dto::register(&i.body) {
        Ok(d) => {
            let fut = c.auth.register(
                &d.company_name,
                &d.email,
                &d.password,
                &d.full_name,
                i.ip(),
                i.trusted(),
            );
            res(fut.await)
        }
        Err(e) => fail(e),
    }
}

async fn signup_enabled(State(c): S) -> Response {
    Json(json!({ "enabled": c.auth.signup_enabled() })).into_response()
}

async fn refresh(State(c): S, req: Request) -> Response {
    let i = inp!(c, req);
    match dto::refresh(&i.body) {
        Ok(token) => res(c.auth.refresh(&token).await),
        Err(e) => fail(e),
    }
}

async fn preview(State(c): S, req: Request) -> Response {
    let i = inp!(c, req);
    match dto::invitation_token(&i.body) {
        Ok(token) => res(c.auth.preview_invitation(&token).await),
        Err(e) => fail(e),
    }
}

async fn accept(State(c): S, req: Request) -> Response {
    let i = inp!(c, req);
    match dto::accept_invitation(&i.body) {
        Ok(d) => {
            let fut = c
                .auth
                .accept_invitation(&d.token, &d.full_name, &d.password, i.ip(), i.trusted());
            res(fut.await)
        }
        Err(e) => fail(e),
    }
}

// ---------------------------------------------------------------- đã đăng nhập

async fn logout(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::logout(&i.body) {
        Ok(token) => res(c.auth.logout(co, u.user.user_id, token.as_deref()).await),
        Err(e) => fail(e),
    }
}

async fn me(State(c): S, Extension(u): U) -> Response {
    res(c.auth.get_me(company!(u), u.user.user_id).await)
}

async fn change_password(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::change_password(&i.body) {
        Ok((current, new)) => res(c.auth.change_password(co, u.user.user_id, &current, &new, i.ip()).await),
        Err(e) => fail(e),
    }
}

async fn reset_password(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::reset_my_password(&i.body) {
        Ok(current) => res(c.auth.reset_my_password(co, u.user.user_id, &current, i.ip()).await),
        Err(e) => fail(e),
    }
}

/// `Patch<String>` ⇒ `Patch<&str>`.
fn patch_str(p: &Patch<String>) -> Patch<&str> {
    match p {
        Patch::Keep => Patch::Keep,
        Patch::Clear => Patch::Clear,
        Patch::Set(s) => Patch::Set(s.as_str()),
    }
}

async fn update_profile(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::update_profile(&i.body) {
        Ok(p) => {
            let fut = c
                .auth
                .update_profile(co, u.user.user_id, p.full_name.as_deref(), patch_str(&p.phone));
            res(fut.await)
        }
        Err(e) => fail(e),
    }
}

/// `FileInterceptor('file')` của multer: trường tệp duy nhất tên `file` (tệp khác hoặc trùng ⇒ 400 `Unexpected field`),
/// vượt 5 MB ⇒ 413 `File too large`.
async fn read_avatar(mut mp: Multipart) -> Result<Option<Upload>, HttpError> {
    let mut out: Option<Upload> = None;
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        if f.file_name().is_none() {
            // Trường chữ không dùng tới: bỏ qua nhưng vẫn đọc hết để multipart đi tiếp.
            read_field_limited(&mut f, 1024 * 1024).await?;
            continue;
        }
        if f.name() != Some("file") || out.is_some() {
            return Err(HttpError::bad_request("Unexpected field"));
        }
        let content_type = f.content_type().unwrap_or("text/plain").to_owned();
        let bytes = read_field_limited(&mut f, AVATAR_MAX_BYTES).await?;
        out = Some(Upload {
            bytes: bytes.to_vec(),
            content_type,
        });
    }
    Ok(out)
}

async fn upload_avatar(State(c): S, Extension(u): U, mp: Multipart) -> Response {
    let co = company!(u);
    match read_avatar(mp).await {
        Ok(file) => res(c.auth.upload_avatar(co, u.user.user_id, file).await),
        Err(e) => fail(e),
    }
}

// ---------------------------------------------------------------- cấu hình

async fn wifi_get(State(c): S, Extension(u): U) -> Response {
    Json(c.auth.login_wifi_config(company!(u)).await).into_response()
}

async fn wifi_update(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::enabled(&i.body) {
        Ok(en) => res(c.auth.update_login_wifi_config(co, en, u.user.user_id).await),
        Err(e) => fail(e),
    }
}

async fn single_get(State(c): S, Extension(u): U) -> Response {
    Json(c.auth.single_session_config(company!(u)).await).into_response()
}

async fn single_update(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::enabled(&i.body) {
        Ok(en) => res(c.auth.update_single_session_config(co, en, u.user.user_id).await),
        Err(e) => fail(e),
    }
}

async fn targets_roster(State(c): S, Extension(u): U) -> Response {
    res(c.auth.targets_roster(company!(u)).await)
}

async fn targets_list(State(c): S, Extension(u): U) -> Response {
    res(c.auth.targets_list(company!(u)).await)
}

async fn targets_replace(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    match dto::replace_targets(&i.body) {
        Ok(items) => res(c.auth.targets_replace(co, &items, u.user.user_id).await),
        Err(e) => fail(e),
    }
}

// ---------------------------------------------------------------- lời mời

async fn invitation_create(State(c): S, Extension(u): U, req: Request) -> Response {
    let co = company!(u);
    let i = inp!(c, req);
    let (email, role_id) = match dto::create_invitation(&i.body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let actor = actor_of(&u, co);
    let owners = match invitation_scope(&c.scopes, &actor).await {
        Ok(o) => o,
        Err(e) => return auth_fail(e),
    };
    res(c.auth.create_invitation(&actor, &email, role_id, &owners).await)
}

async fn invitation_roles(State(c): S, Extension(u): U) -> Response {
    let actor = actor_of(&u, company!(u));
    res(invitable_roles(&c.db, &actor).await)
}

async fn invitation_list(State(c): S, Extension(u): U, Query(q): Query<HashMap<String, String>>) -> Response {
    let co = company!(u);
    let actor = actor_of(&u, co);
    let owners = match invitation_scope(&c.scopes, &actor).await {
        Ok(o) => o,
        Err(e) => return auth_fail(e),
    };
    let pending_only = !matches!(q.get("all").map(String::as_str), Some("1" | "true"));
    res(c.auth.list_invitations(co, pending_only, None, &owners).await)
}

async fn invitation_revoke(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let actor = actor_of(&u, co);
    let owners = match invitation_scope(&c.scopes, &actor).await {
        Ok(o) => o,
        Err(e) => return auth_fail(e),
    };
    res(c.auth.revoke_invitation(co, id, &owners).await)
}

/// Router của M01 (state `Arc<AuthCtx>`).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<AuthCtx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let limit = || DefaultBodyLimit::max(AVATAR_MAX_BYTES + 1024 * 1024);
    ApiRouter::new(deps)
        .route(spec(&Method::POST, "/api/v1/auth/login"), login)
        .route(spec(&Method::POST, "/api/v1/auth/register"), register)
        .route(spec(&Method::GET, "/api/v1/auth/signup-enabled"), signup_enabled)
        .route(spec(&Method::POST, "/api/v1/auth/refresh"), refresh)
        .route(spec(&Method::POST, "/api/v1/auth/logout"), logout)
        .route(spec(&Method::GET, "/api/v1/auth/me"), me)
        .route(spec(&Method::PATCH, "/api/v1/auth/password"), change_password)
        .route(spec(&Method::POST, "/api/v1/auth/reset-password"), reset_password)
        .route(spec(&Method::PATCH, "/api/v1/auth/profile"), update_profile)
        .route(
            spec(&Method::POST, "/api/v1/auth/profile/avatar"),
            upload_avatar.layer(limit()),
        )
        .route(spec(&Method::GET, WIFI), wifi_get)
        .route(spec(&Method::PATCH, WIFI), wifi_update)
        .route(spec(&Method::GET, TARGETS), targets_list)
        .route(spec(&Method::PUT, TARGETS), targets_replace)
        .route(
            spec(&Method::GET, "/api/v1/auth/settings/login-wifi-check-targets/roster"),
            targets_roster,
        )
        .route(spec(&Method::GET, SINGLE), single_get)
        .route(spec(&Method::PATCH, SINGLE), single_update)
        .route(spec(&Method::POST, INVITATIONS), invitation_create)
        .route(spec(&Method::GET, INVITATIONS), invitation_list)
        .route(spec(&Method::GET, "/api/v1/auth/invitations/roles"), invitation_roles)
        .route(
            spec(&Method::POST, "/api/v1/auth/invitations/:id/revoke"),
            invitation_revoke,
        )
        .route(spec(&Method::POST, "/api/v1/auth/invitations/preview"), preview)
        .route(spec(&Method::POST, "/api/v1/auth/invitations/accept"), accept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 23);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 23);
        assert!(table.iter().all(|r| r.path.starts_with("/api/v1/auth/")));
    }
}
