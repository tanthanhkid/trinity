//! Bảng route và handler (K14) của 7 route `/api/v1/reports/…` thuộc M20. Quyền, mã thành công và chế độ kiểm dữ liệu (strict)
//! khớp `contracts/routes.json`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::extract::query_to_json;
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::filter::Filter;
use crate::{Actor, Ctx, channels, dashboard, overview, roster, stats_today, tasks, trend};

const OVERVIEW: Access = Access::Can(&["reports.overview"]);

/// 7 dòng của bảng route, so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let s = |p: &'static str, a: Access| RouteSpec::new(Method::GET, p, a).status_ok(200);
    vec![
        s("/api/v1/reports/overview", OVERVIEW),
        s("/api/v1/reports/dashboard-overview", OVERVIEW),
        s("/api/v1/reports/dashboard-tasks", OVERVIEW),
        s("/api/v1/reports/dashboard-filter-roster", OVERVIEW),
        s("/api/v1/reports/dashboard-channels", Access::AuthOnly),
        s("/api/v1/reports/dashboard-stats-today", OVERVIEW),
        s("/api/v1/reports/dashboard-trend-14d", OVERVIEW),
    ]
}

fn fail(e: impl Into<AppError>) -> Response {
    let e: AppError = e.into();
    let (status, body) = e.response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn ok(r: Result<Value, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty trong token không hợp lệ ⇒ 401 như guard (không đoán công ty 1).
fn actor(u: &CurrentUser) -> Result<Actor, Response> {
    match trinity_db::CompanyRef::new(i64::from(u.user.company_id)) {
        Ok(company) => Ok(Actor {
            user_id: u.user.user_id,
            company,
            grants: u.grants.grants.clone(),
            is_admin: u.grants.is_admin,
        }),
        Err(_) => Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn"))),
    }
}

macro_rules! ac {
    ($u:expr) => {
        match actor(&$u) {
            Ok(a) => a,
            Err(r) => return r,
        }
    };
}

fn query(name: &str, uri: &Uri) -> Result<Value, AppError> {
    validate_value(name, &query_to_json(uri.query().unwrap_or("")), Mode::Strict)
}

async fn get_overview(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("QueryReportRangeDto", &uri) {
        Ok(v) => {
            let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
            ok(overview::get(&c, &a, s("date_from").as_deref(), s("date_to").as_deref()).await)
        }
        Err(e) => fail(e),
    }
}

async fn get_dashboard(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("DashboardFilterQuery", &uri) {
        Ok(v) => ok(dashboard::get_overview(&c, &a, &Filter::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn get_tasks(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("DashboardFilterQuery", &uri) {
        Ok(v) => ok(tasks::get(&c, &a, &Filter::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn get_roster(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(roster::get(&c, &ac!(u)).await)
}

async fn get_channels(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(channels::get(&c, &ac!(u)).await)
}

async fn get_stats(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(stats_today::get(&c, &ac!(u)).await)
}

async fn get_trend(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(trend::get(&c, &ac!(u)).await)
}

/// Router của module (người gọi gắn state `Arc<Ctx>` khi lắp `serve`).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |p: &str| {
        s.iter()
            .find(|x| x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec GET {p}"))
    };
    ApiRouter::new(deps)
        .route(spec("/api/v1/reports/overview"), get_overview)
        .route(spec("/api/v1/reports/dashboard-overview"), get_dashboard)
        .route(spec("/api/v1/reports/dashboard-tasks"), get_tasks)
        .route(spec("/api/v1/reports/dashboard-filter-roster"), get_roster)
        .route(spec("/api/v1/reports/dashboard-channels"), get_channels)
        .route(spec("/api/v1/reports/dashboard-stats-today"), get_stats)
        .route(spec("/api/v1/reports/dashboard-trend-14d"), get_trend)
}
