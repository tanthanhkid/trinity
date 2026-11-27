//! Bảng route của M05 (K14), so với `contracts/routes.json` ở test cuối file.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, Path, Request, State};
use axum::response::{IntoResponse, Response};
use http::{Method, StatusCode};
use mod_auth::routes::{auth_fail, read_body};
use serde::Serialize;
use trinity_db::{CompanyRef, TenantConn};
use trinity_http::edge::client_ip::resolve_client_ip;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};

use crate::guards::KeyInfo;
use crate::{ApiKeysCtx, api_keys, teams};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const KEYS: &str = "/api/v1/api-keys";
const TEAMS: &str = "/api/v1/auth/teams";
const LOGIN: &str = "/api/v1/public/auth/login";

/// 5 route `/api-keys`, `POST /public/auth/login` (`ApiKeyGuard` + `@Public()`), 2 route `/auth/teams`.
pub fn routes() -> Vec<RouteSpec> {
    let keys = Access::Can(&["settings.integrations"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/api-keys", keys).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/api-keys/:id", keys)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/api-keys", keys).status_ok(201),
        RouteSpec::new(Method::POST, "/api/v1/api-keys/:id/rotate", keys)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/api-keys/:id", keys)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/public/auth/login", Access::Public)
            .status_ok(200)
            .guards(&["ApiKeyGuard"]),
        RouteSpec::new(Method::GET, "/api/v1/auth/teams", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/auth/teams", Access::Can(&["org.manage"])).status_ok(201),
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

/// Công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
fn company_of(u: &CurrentUser) -> Result<CompanyRef, AppError> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn").into())
}

async fn conn(c: &ApiKeysCtx, company: CompanyRef) -> Result<TenantConn, AppError> {
    let t = c.db.tenant(company).await.map_err(AppError::internal)?;
    t.acquire().await.map_err(AppError::internal)
}

fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy khoá API").into())
}

type S = State<Arc<ApiKeysCtx>>;
type U = Extension<CurrentUser>;

async fn list_keys(State(c): S, Extension(u): U) -> Response {
    let r = async {
        let mut db = conn(&c, company_of(&u)?).await?;
        api_keys::find_all(&mut db).await
    }
    .await;
    ok(r)
}

async fn get_key(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let r = async {
        let id = id_of(&id)?;
        let mut db = conn(&c, company_of(&u)?).await?;
        api_keys::find_by_id(&mut db, id).await
    }
    .await;
    ok(r)
}

async fn create_key(State(c): S, Extension(u): U, req: Request) -> Response {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let r = async {
        let input = api_keys::validate_create(&body)?;
        let company = company_of(&u)?;
        // Nạp quyền của owner TRƯỚC khi lấy kết nối: `create` kiểm owner qua `PermissionService` (có thể mở kết nối khác),
        // nên để bộ nhớ đệm nóng thì không phải giữ hai kết nối cùng lúc.
        let _ = c.perms.grants_for(company, input.owner_user_id).await;
        let mut db = conn(&c, company).await?;
        let ctx = api_keys::Ctx {
            company,
            permissions: &c.perms,
        };
        api_keys::create(&mut db, &ctx, &input, u.user.user_id).await
    }
    .await;
    ok(r)
}

async fn rotate_key(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let r = async {
        let id = id_of(&id)?;
        let company = company_of(&u)?;
        let mut db = conn(&c, company).await?;
        let ctx = api_keys::Ctx {
            company,
            permissions: &c.perms,
        };
        api_keys::rotate(&mut db, &ctx, id, u.user.user_id).await
    }
    .await;
    ok(r)
}

async fn revoke_key(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let r = async {
        let id = id_of(&id)?;
        let mut db = conn(&c, company_of(&u)?).await?;
        api_keys::revoke(&mut db, id, u.user.user_id).await
    }
    .await;
    ok(r)
}

async fn list_teams(State(c): S, Extension(u): U) -> Response {
    let r = async {
        let mut db = conn(&c, company_of(&u)?).await?;
        teams::find_all(&mut db).await
    }
    .await;
    ok(r)
}

async fn create_team(State(c): S, Extension(u): U, req: Request) -> Response {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let r = async {
        let (name, lead) = teams::parse_create(&body)?;
        let mut db = conn(&c, company_of(&u)?).await?;
        teams::create(&mut db, &name, lead).await
    }
    .await;
    ok(r)
}

/// `POST /public/auth/login`: `ApiKeyGuard` đã xác thực khoá (phạm vi `auth:login`) và gắn [`KeyInfo`]; chỉ đăng nhập được dưới
/// CHÍNH owner của khoá. Không có refresh token.
async fn public_login(State(c): S, req: Request) -> Response {
    let Some(key) = req.extensions().get::<KeyInfo>().cloned() else {
        // Guard phải gắn khoá: thiếu là lỗi cấu hình, không lộ chi tiết.
        return fail(HttpError::nest(500, Some("Cấu hình public auth lỗi".to_owned().into())));
    };
    let client = resolve_client_ip(&c.ip, &req);
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let d = match mod_auth::dto::login(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let ip = Some(client.rate_key.as_str());
    let fut = c.auth.login_third_party(
        key.company,
        &d.email,
        &d.password,
        ip,
        key.owner_user_id,
        client.ip.is_some(),
    );
    match fut.await {
        Ok(v) => Json(v).into_response(),
        Err(e) => auth_fail(e),
    }
}

/// Router của M05 (state `Arc<ApiKeysCtx>`). `deps.guards` phải có `ApiKeyGuard` ([`crate::guards::named_guards`]).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<ApiKeysCtx>> {
    let s = routes();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, KEYS), list_keys)
        .route(spec(&Method::POST, KEYS), create_key)
        .route(spec(&Method::GET, "/api/v1/api-keys/:id"), get_key)
        .route(spec(&Method::POST, "/api/v1/api-keys/:id/rotate"), rotate_key)
        .route(spec(&Method::DELETE, "/api/v1/api-keys/:id"), revoke_key)
        .route(spec(&Method::POST, LOGIN), public_login)
        .route(spec(&Method::GET, TEAMS), list_teams)
        .route(spec(&Method::POST, TEAMS), create_team)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 8);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 8);
    }
}
