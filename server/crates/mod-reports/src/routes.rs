//! Bảng route và handler (K14) của 20 route `/api/v1/reports/…`: 8 route Tổng quan (M20 + `dashboard-command-center` của #606) và 12 route khách hàng, hiệu suất, tuyển dụng,
//! báo cáo tuỳ biến (M21). Quyền, mã thành công và chế độ kiểm dữ liệu (strict) khớp `contracts/routes.json`.

use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::extract::query_to_json;
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::customers::Uncontacted;
use crate::filter::Filter;
use crate::recruitment::Query as RecruitmentQuery;
use crate::{
    Actor, Ctx, channels, command_center, custom, customers, dashboard, overview, performance, recruitment, roster,
    stats_today, tasks, trend,
};

const OVERVIEW: Access = Access::Can(&["reports.overview"]);
const CUSTOMERS: Access = Access::Can(&["reports.customers"]);
const STAFF: Access = Access::Can(&["reports.staff"]);
const CONFIG: Access = Access::Can(&["custom_objects.manage"]);

/// 20 dòng của bảng route, so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let s = |p: &'static str, a: Access| RouteSpec::new(Method::GET, p, a).status_ok(200);
    let custom = |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok);
    vec![
        s("/api/v1/reports/overview", OVERVIEW),
        s("/api/v1/reports/dashboard-overview", OVERVIEW),
        s("/api/v1/reports/dashboard-tasks", OVERVIEW),
        s("/api/v1/reports/dashboard-filter-roster", OVERVIEW),
        s("/api/v1/reports/dashboard-channels", Access::AuthOnly),
        s("/api/v1/reports/dashboard-stats-today", OVERVIEW),
        s("/api/v1/reports/dashboard-trend-14d", OVERVIEW),
        s("/api/v1/reports/dashboard-command-center", OVERVIEW),
        s("/api/v1/reports/customers/overview", CUSTOMERS),
        s("/api/v1/reports/customers/uncontacted", CUSTOMERS),
        s("/api/v1/reports/employee-performance", STAFF),
        RouteSpec::new(
            Method::GET,
            "/api/v1/reports/employee-performance/export",
            Access::Can(&["reports.staff", "reports.export"]),
        ),
        s(
            "/api/v1/reports/marketing/recruitment-overview",
            Access::Can(&["reports.channels"]),
        ),
        custom(Method::GET, "/api/v1/reports/custom", Access::AuthOnly, 200),
        custom(Method::PUT, "/api/v1/reports/custom", CONFIG, 200),
        custom(Method::GET, "/api/v1/reports/custom/sources", CONFIG, 200),
        custom(Method::GET, "/api/v1/reports/custom/definitions", CONFIG, 200),
        custom(Method::GET, "/api/v1/reports/custom/presets", CONFIG, 200),
        custom(Method::POST, "/api/v1/reports/custom/presets/:key/install", CONFIG, 201),
        custom(Method::GET, "/api/v1/reports/custom/:id", Access::AuthOnly, 200),
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

async fn get_command_center(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("QueryReportRangeDto", &uri) {
        Ok(v) => {
            let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
            ok(command_center::get(&c, &a, s("date_from").as_deref(), s("date_to").as_deref()).await)
        }
        Err(e) => fail(e),
    }
}

async fn get_stats(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(stats_today::get(&c, &ac!(u)).await)
}

async fn get_trend(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(trend::get(&c, &ac!(u)).await)
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

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

async fn customers_overview(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("QueryReportRangeDto", &uri) {
        Ok(v) => {
            ok(customers::overview(&c, &a, text(&v, "date_from").as_deref(), text(&v, "date_to").as_deref()).await)
        }
        Err(e) => fail(e),
    }
}

async fn customers_uncontacted(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("QueryReportUncontactedDto", &uri) {
        Ok(v) => ok(customers::uncontacted(&c, &a, &Uncontacted::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn employee_performance(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("QueryReportRangeDto", &uri) {
        Ok(v) => ok(performance::get(&c, &a, text(&v, "date_from").as_deref(), text(&v, "date_to").as_deref()).await),
        Err(e) => fail(e),
    }
}

async fn employee_performance_export(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    uri: Uri,
) -> Response {
    let a = ac!(u);
    let v = match query("QueryReportRangeDto", &uri) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match performance::export(&c, &a, text(&v, "date_from").as_deref(), text(&v, "date_to").as_deref()).await {
        Ok(bytes) => {
            let mut resp = Response::new(axum::body::Body::from(bytes));
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            );
            if let Ok(v) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                performance::export_filename(chrono::Utc::now())
            )) {
                h.insert(header::CONTENT_DISPOSITION, v);
            }
            resp
        }
        Err(e) => fail(e),
    }
}

async fn marketing_recruitment(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let a = ac!(u);
    match query("QueryMarketingAccountReportDto", &uri) {
        Ok(v) => ok(recruitment::overview(&c, &a, &RecruitmentQuery::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn custom_list(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(custom::list(&c, &ac!(u)).await)
}

async fn custom_sources(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(custom::sources(&c, &ac!(u)).await)
}

async fn custom_definitions(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(custom::definitions(&c, &ac!(u)).await)
}

async fn custom_presets(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(custom::presets(&c, &ac!(u)).await)
}

async fn custom_install(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
) -> Response {
    ok(custom::install_preset(&c, &ac!(u), &key).await)
}

async fn custom_save(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(b): JsonBody,
) -> Response {
    let a = ac!(u);
    match validate_value("SaveCustomReportsDto", &b, Mode::Strict) {
        Ok(v) => ok(custom::save(&c, &a, v.get("reports").unwrap_or(&Value::Null)).await),
        Err(e) => fail(e),
    }
}

async fn custom_run(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    uri: Uri,
) -> Response {
    let a = ac!(u);
    match query("RunCustomReportQueryDto", &uri) {
        Ok(v) => ok(custom::run(&c, &a, &id, text(&v, "period").as_deref()).await),
        Err(e) => fail(e),
    }
}

/// Router của module (người gọi gắn state `Arc<Ctx>` khi lắp `serve`).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: Method, p: &str| {
        s.iter()
            .find(|x| x.method == m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let get = |p: &str| spec(Method::GET, p);
    ApiRouter::new(deps)
        .route(get("/api/v1/reports/overview"), get_overview)
        .route(get("/api/v1/reports/dashboard-overview"), get_dashboard)
        .route(get("/api/v1/reports/dashboard-tasks"), get_tasks)
        .route(get("/api/v1/reports/dashboard-filter-roster"), get_roster)
        .route(get("/api/v1/reports/dashboard-channels"), get_channels)
        .route(get("/api/v1/reports/dashboard-stats-today"), get_stats)
        .route(get("/api/v1/reports/dashboard-trend-14d"), get_trend)
        .route(get("/api/v1/reports/dashboard-command-center"), get_command_center)
        .route(get("/api/v1/reports/customers/overview"), customers_overview)
        .route(get("/api/v1/reports/customers/uncontacted"), customers_uncontacted)
        .route(get("/api/v1/reports/employee-performance"), employee_performance)
        .route(
            get("/api/v1/reports/employee-performance/export"),
            employee_performance_export,
        )
        .route(
            get("/api/v1/reports/marketing/recruitment-overview"),
            marketing_recruitment,
        )
        .route(get("/api/v1/reports/custom"), custom_list)
        .route(spec(Method::PUT, "/api/v1/reports/custom"), custom_save)
        .route(get("/api/v1/reports/custom/sources"), custom_sources)
        .route(get("/api/v1/reports/custom/definitions"), custom_definitions)
        .route(get("/api/v1/reports/custom/presets"), custom_presets)
        .route(
            spec(Method::POST, "/api/v1/reports/custom/presets/:key/install"),
            custom_install,
        )
        .route(get("/api/v1/reports/custom/:id"), custom_run)
}
