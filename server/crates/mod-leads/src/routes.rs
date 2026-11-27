//! Bảng route và handler của M24 (K14): 8 route, so với `contracts/routes.json` ở test cuối file. Cờ tính năng tổ chức
//! (`lead_scoring`, `stale_reminders`) do `ApiRouter` kiểm trước handler (cần `AccessDeps::features`).
//!
//! Chưa làm ở tầng route: đẩy socket nội bộ cho thông báo của `POST /stale-work/run` (tiến trình khác vẫn nhận qua `NOTIFY`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::future::{Future, ready};
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use http::Method;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;

use crate::{Features, lead, stale};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const LEAD: &str = "lead_scoring";
const STALE: &str = "stale_reminders";
/// Số khách chấm lại tối đa mỗi lượt `recompute-all`.
const RESCORE_LIMIT: i64 = 500;

/// Trạng thái của router: DB, phạm vi quyền và cờ job (hiển thị ở `job_enabled`).
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
    /// `leadScoringJobEnabled()`.
    pub lead_job_enabled: bool,
    /// `staleJobEnabled()`.
    pub stale_job_enabled: bool,
}

/// Cờ tính năng đã được `ApiRouter` kiểm trước handler nên chạy tay luôn coi là bật.
struct AlwaysOn;

impl Features for AlwaysOn {
    fn enabled<'a>(&'a self, _conn: &'a mut PgConnection, _key: &'a str) -> impl Future<Output = bool> + Send + 'a {
        ready(true)
    }
}

/// 4 route `/lead-scoring` (cờ `lead_scoring`) và 4 route `/stale-work` (cờ `stale_reminders`).
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["contacts.view"]);
    let catalog = Access::Can(&["contacts.catalog"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/lead-scoring/rules", view)
            .status_ok(200)
            .org_feature(LEAD),
        RouteSpec::new(Method::PUT, "/api/v1/lead-scoring/rules", catalog)
            .status_ok(200)
            .org_feature(LEAD),
        RouteSpec::new(Method::POST, "/api/v1/lead-scoring/recompute-all", catalog)
            .status_ok(200)
            .org_feature(LEAD),
        RouteSpec::new(Method::POST, "/api/v1/lead-scoring/contacts/:id/recompute", view)
            .status_ok(200)
            .org_feature(LEAD)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/stale-work/summary", Access::AuthOnly)
            .status_ok(200)
            .org_feature(STALE),
        RouteSpec::new(Method::GET, "/api/v1/stale-work/config", Access::AuthOnly)
            .status_ok(200)
            .org_feature(STALE),
        RouteSpec::new(Method::PUT, "/api/v1/stale-work/config", catalog)
            .status_ok(200)
            .org_feature(STALE),
        RouteSpec::new(Method::POST, "/api/v1/stale-work/run", catalog)
            .status_ok(200)
            .org_feature(STALE),
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

/// Công ty của token; không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
fn company(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

/// `company(&u)` hoặc trả ngay phản hồi 401.
macro_rules! co {
    ($u:expr) => {
        match company(&$u) {
            Ok(c) => c,
            Err(r) => return r,
        }
    };
}

async fn conn(c: &Ctx, company: CompanyRef) -> Result<TenantConn, AppError> {
    let t = c.db.tenant(company).await.map_err(AppError::internal)?;
    t.acquire().await.map_err(AppError::internal)
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có khách nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy").into())
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

async fn get_rules(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let co = co!(u);
    let res = async {
        let mut cn = conn(&c, co).await?;
        lead::rules_response(&mut cn, c.lead_job_enabled).await
    }
    .await;
    ok(res)
}

async fn put_rules(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let co = co!(u);
    let res = async {
        let mut cn = conn(&c, co).await?;
        let rules = lead::save_rules(&mut cn, &body, u.user.user_id).await?;
        Ok::<_, AppError>(json!({ "rules": rules }))
    }
    .await;
    ok(res)
}

async fn recompute_all(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let co = co!(u);
    let res = async {
        let mut cn = conn(&c, co).await?;
        let rescored = lead::rescore_stale(&mut cn, RESCORE_LIMIT, Utc::now()).await?;
        Ok::<_, AppError>(json!({ "rescored": rescored }))
    }
    .await;
    ok(res)
}

async fn recompute_one(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let co = co!(u);
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let res = async {
        let view = c
            .scopes
            .owner_ids(co, u.user.user_id, &u.grants.grants, "contacts.view")
            .await
            .map_err(AppError::internal)?;
        let mut cn = conn(&c, co).await?;
        lead::recompute_one(&mut cn, view.as_ref(), id, Utc::now()).await
    }
    .await;
    ok(res)
}

async fn stale_summary(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let co = co!(u);
    let res = async {
        let mut cn = conn(&c, co).await?;
        stale::summary_for(&mut cn, u.user.user_id, Utc::now()).await
    }
    .await;
    ok(res)
}

async fn get_config(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let co = co!(u);
    let res = async {
        let mut cn = conn(&c, co).await?;
        let config = stale::get_config(&mut cn).await?;
        Ok::<_, AppError>(json!({ "config": config, "job_enabled": c.stale_job_enabled }))
    }
    .await;
    ok(res)
}

async fn put_config(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let co = co!(u);
    let res = async {
        let mut cn = conn(&c, co).await?;
        let config = stale::save_config(&mut cn, &body, u.user.user_id).await?;
        Ok::<_, AppError>(json!({ "config": config }))
    }
    .await;
    ok(res)
}

async fn run_now(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let co = co!(u);
    let res = async {
        let t = c.db.tenant(co).await.map_err(AppError::internal)?;
        let run = stale::run_once(&t, &AlwaysOn, Utc::now(), true).await?;
        Ok::<_, AppError>(run.result)
    }
    .await;
    ok(res)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`,
/// và `deps.features` phải có cổng tính năng (route khai `org_feature`).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = routes();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/lead-scoring/rules"), get_rules)
        .route(spec(&Method::PUT, "/api/v1/lead-scoring/rules"), put_rules)
        .route(spec(&Method::POST, "/api/v1/lead-scoring/recompute-all"), recompute_all)
        .route(
            spec(&Method::POST, "/api/v1/lead-scoring/contacts/:id/recompute"),
            recompute_one,
        )
        .route(spec(&Method::GET, "/api/v1/stale-work/summary"), stale_summary)
        .route(spec(&Method::GET, "/api/v1/stale-work/config"), get_config)
        .route(spec(&Method::PUT, "/api/v1/stale-work/config"), put_config)
        .route(spec(&Method::POST, "/api/v1/stale-work/run"), run_now)
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

    #[test]
    fn id_ngoai_int4_la_404() {
        assert_eq!(id_of("12").unwrap(), 12);
        assert!(id_of("99999999999").is_err());
    }
}
