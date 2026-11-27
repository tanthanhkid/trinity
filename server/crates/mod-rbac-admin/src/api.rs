//! Router axum của M04: nối extractor → `validate_*` → hàm nghiệp vụ → JSON cho các route ở [`crate::routes::routes`].
//!
//! `PUT /users/:id/roles` KHÔNG nằm ở đây: `mod-users` đã khai và mount đường này (cùng quyền `users.manage`), mount hai lần
//! sẽ trùng route. Hàm [`crate::roles::set_user_roles`] vẫn giữ cho lúc gộp.

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

use crate::{
    Actor, Ctx, audit, roles, validate_audit_query, validate_create_role, validate_set_grants, validate_update_role,
};

/// Trạng thái dùng chung của router; công ty lấy từ token của từng request.
pub struct RbacState {
    pub db: Db,
    pub permissions: PermissionService,
    pub scope: ScopeService,
    pub cache: Arc<RbacCache>,
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

/// Kết nối công ty, ngữ cảnh và người gọi. Công ty của token không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
async fn open(s: &RbacState, u: &CurrentUser) -> Result<(TenantConn, Ctx, Actor), Response> {
    let Ok(company) = CompanyRef::new(i64::from(u.user.company_id)) else {
        return Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")));
    };
    let ctx = Ctx {
        company,
        permissions: s.permissions.clone(),
        scope: s.scope.clone(),
        cache: s.cache.clone(),
    };
    let actor = Actor {
        user_id: u.user.user_id,
        is_admin: u.grants.is_admin,
        grants: u.grants.grants.clone(),
    };
    let tenant = s.db.tenant(company).await.map_err(|e| fail(AppError::internal(e)))?;
    let conn = tenant.acquire().await.map_err(|e| fail(AppError::internal(e)))?;
    Ok((conn, ctx, actor))
}

macro_rules! open {
    ($s:expr, $u:expr) => {
        match open(&$s, &$u).await {
            Ok(x) => x,
            Err(r) => return r,
        }
    };
}

/// `ParseIntPipe` đã chạy ở router: số ngoài int4 thì không có vai trò nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy vai trò").into())
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

async fn list(State(s): State<Arc<RbacState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let (mut c, _, _) = open!(s, u);
    ok(roles::list(&mut c).await)
}

async fn get_one(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _, _) = open!(s, u);
    ok(roles::get(&mut c, id).await)
}

async fn create(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let input = match validate_create_role(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _, actor) = open!(s, u);
    ok(roles::create(&mut c, &actor, &input).await)
}

async fn clone_role(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _, actor) = open!(s, u);
    ok(roles::clone(&mut c, &actor, id).await)
}

async fn update(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let input = match validate_update_role(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _, actor) = open!(s, u);
    ok(roles::update(&mut c, &actor, id, &input).await)
}

async fn set_grants(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let grants = match validate_set_grants(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, ctx, actor) = open!(s, u);
    ok(roles::set_grants(&mut c, &ctx, &actor, id, &grants).await)
}

async fn remove(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, ctx, actor) = open!(s, u);
    ok(roles::remove(&mut c, &ctx, &actor, id).await)
}

async fn members(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, ctx, actor) = open!(s, u);
    ok(roles::members(&mut c, &ctx, &actor, id).await)
}

async fn audit_list(
    State(s): State<Arc<RbacState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| q.get(k).map(String::as_str);
    let query = match validate_audit_query(get("targetType"), get("targetId"), get("page"), get("limit")) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _, _) = open!(s, u);
    ok(audit::list(&mut c, &query).await)
}

/// Router của module (9 route; `PUT /users/:id/roles` do `mod-users` mount). Người gọi gắn state `Arc<RbacState>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<RbacState>> {
    let s = crate::routes::routes();
    let spec = |m: &Method, p: &str| -> RouteSpec {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/roles"), list)
        .route(spec(&Method::GET, "/api/v1/roles/:id"), get_one)
        .route(spec(&Method::POST, "/api/v1/roles"), create)
        .route(spec(&Method::POST, "/api/v1/roles/:id/clone"), clone_role)
        .route(spec(&Method::PATCH, "/api/v1/roles/:id"), update)
        .route(spec(&Method::PUT, "/api/v1/roles/:id/grants"), set_grants)
        .route(spec(&Method::DELETE, "/api/v1/roles/:id"), remove)
        .route(spec(&Method::GET, "/api/v1/roles/:id/members"), members)
        .route(spec(&Method::GET, "/api/v1/rbac/audit"), audit_list)
}
