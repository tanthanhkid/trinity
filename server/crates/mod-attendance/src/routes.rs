//! Bảng route và handler của M13a (K14): 11 route `management/attendance/*`, mỗi route khai [`Access`] bắt buộc, quyền và mã
//! thành công khớp `contracts/routes.json`. Dữ liệu vào kiểm bằng metadata THẬT của class-validator (`ValidJson`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Extension, FromRequest, Multipart, Path, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use serde::Serialize;
use trinity_http::edge::body::read_field_limited;
use trinity_http::edge::client_ip::resolve_client_ip;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Mode, ValidJson, ValidQuery, query_to_json, validate_into};
use trinity_kernel::error::{AppError, HttpError};

use crate::check::{self, CheckCtx, CheckInput, SELFIE_ALLOWED_MIME, SELFIE_MAX_SIZE, SELFIE_MIME_ERROR, Selfie};
use crate::dto::{
    CreateAttendanceRequestDto, CreateOfficeDto, DeviceCheckDto, PatchAttendanceDto, QueryAttendanceDto,
    QueryAttendanceExportDto, QueryAttendanceRequestsDto, QueryTodaySummaryDto, RejectRequestDto,
    UpdateAttendanceSettingsDto, UpdateOfficeDto, UpdateRequestConfigDto, UpdateWorkingSaturdaysDto,
};
use crate::stats::QueryAttendanceStatsDto;
use crate::{config, export, offices, records, requests, stats};

const BASE: &str = "/api/v1/management/attendance";
const ID: &[&str] = &["param.id:ParseIntPipe"];
/// Đường dẫn khai dạng Express `:id(\\d+)` như `routes.json`; `ParseIntPipe` vẫn chạy sau khi khớp.
const REC: &str = "/api/v1/management/attendance/:id(\\d+)";
const PROOF: &str = "/api/v1/management/attendance/:id(\\d+)/proof/:slot";

/// 40 route của M13a (cấu hình), M13b (chấm công vào/ra) và M14a (đơn từ, thống kê, sổ chấm công) và M14b (8 tệp xuất xlsx) (bảng so với `routes.json` bởi `trinity check-routes`).
pub fn specs() -> Vec<RouteSpec> {
    let view = Access::Can(&["attendance.view"]);
    let cfg = Access::Can(&["attendance.config"]);
    let manage = Access::Can(&["attendance.manage"]);
    let exp = Access::Can(&["attendance.export"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/management/attendance", view).status_ok(200),
        RouteSpec::new(Method::GET, REC, view).status_ok(200).param_pipes(ID),
        RouteSpec::new(Method::PATCH, REC, manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, REC, manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, PROOF, view).status_ok(200).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/absent", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/today", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/workdays-matrix", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/management/attendance/check-in", Access::AuthOnly).status_ok(201),
        RouteSpec::new(
            Method::POST,
            "/api/v1/management/attendance/check-out",
            Access::AuthOnly,
        )
        .status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/offices", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/management/attendance/offices", cfg).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/management/attendance/offices/:id", cfg)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/attendance/offices/:id", cfg)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/management/attendance/reset-device/:userId", cfg)
            .status_ok(201)
            .param_pipes(&["param.userId:ParseIntPipe"]),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/settings", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::PATCH, "/api/v1/management/attendance/settings", cfg).status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/management/attendance/working-saturdays",
            Access::AuthOnly,
        )
        .status_ok(200),
        RouteSpec::new(Method::PATCH, "/api/v1/management/attendance/working-saturdays", cfg).status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/management/attendance/request-config",
            Access::AuthOnly,
        )
        .status_ok(200),
        RouteSpec::new(Method::PATCH, "/api/v1/management/attendance/request-config", cfg).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/management/attendance/requests", Access::AuthOnly).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/requests", view).status_ok(200),
        RouteSpec::new(
            Method::POST,
            "/api/v1/management/attendance/requests/:id/approve",
            manage,
        )
        .status_ok(201)
        .param_pipes(ID),
        RouteSpec::new(
            Method::POST,
            "/api/v1/management/attendance/requests/:id/reject",
            manage,
        )
        .status_ok(201)
        .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/filters", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/discipline", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/leave-analytics", view).status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/management/attendance/stats/weekly",
            Access::AuthOnly,
        )
        .status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/management/attendance/stats/monthly",
            Access::AuthOnly,
        )
        .status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/management/attendance/stats/weekly-hours",
            Access::AuthOnly,
        )
        .status_ok(200),
        // M14b: tệp xuất, trả thẳng bytes xlsx nên không có mã thành công khai ở `routes.json`.
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/export", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/workdays-matrix/export", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/absent-export", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/export-by-team", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/export-by-department", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/export-top-absent", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/export-top-late-early", exp),
        RouteSpec::new(Method::GET, "/api/v1/management/attendance/stats/export-by-gender", exp),
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

/// Người thực hiện; công ty của token không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
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

macro_rules! act {
    ($u:expr) => {
        match actor(&$u) {
            Ok(a) => a,
            Err(r) => return r,
        }
    };
}

fn json_response(text: String, status: StatusCode) -> Response {
    let mut resp = Response::new(Body::from(text));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp
}

fn respond<T: Serialize>(r: Result<T, AppError>, status: StatusCode) -> Response {
    match r {
        Ok(v) => match serde_json::to_string(&v) {
            Ok(text) => json_response(text, status),
            Err(e) => fail(AppError::internal(e)),
        },
        Err(e) => fail(e),
    }
}

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    respond(r, StatusCode::OK)
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có dòng nào.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
}

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

async fn office_list(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(offices::list(&mut conn).await),
        Err(e) => fail(e),
    }
}

async fn office_create(State(c): S, Extension(u): U, ValidJson(dto): ValidJson<CreateOfficeDto>) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => respond(offices::create(&mut conn, &dto).await, StatusCode::CREATED),
        Err(e) => fail(e),
    }
}

async fn office_update(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<UpdateOfficeDto>,
) -> Response {
    let a = act!(u);
    match id_of(&id, "văn phòng.") {
        Ok(id) => match c.conn(a.company).await {
            Ok(mut conn) => ok(offices::update(&mut conn, id, &dto).await),
            Err(e) => fail(e),
        },
        Err(e) => fail(e),
    }
}

async fn office_delete(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    match id_of(&id, "văn phòng.") {
        Ok(id) => match c.conn(a.company).await {
            Ok(mut conn) => ok(offices::remove(&mut conn, id).await),
            Err(e) => fail(e),
        },
        Err(e) => fail(e),
    }
}

async fn reset_device(State(c): S, Extension(u): U, Path(user_id): Path<String>) -> Response {
    let a = act!(u);
    match id_of(&user_id, "hồ sơ nhân viên.") {
        Ok(id) => match c.conn(a.company).await {
            Ok(mut conn) => respond(offices::reset_device(&mut conn, id).await, StatusCode::CREATED),
            Err(e) => fail(e),
        },
        Err(e) => fail(e),
    }
}

async fn settings_get(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(config::get_shift(&mut conn).await.map(|s| s.to_json())),
        Err(e) => fail(e),
    }
}

async fn settings_update(
    State(c): S,
    Extension(u): U,
    ValidJson(dto): ValidJson<UpdateAttendanceSettingsDto>,
) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(config::update_shift(&mut conn, &dto, a.user_id)
            .await
            .map(|s| s.to_json())),
        Err(e) => fail(e),
    }
}

async fn saturdays_get(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(config::get_saturdays(&mut conn)
            .await
            .map(|d| serde_json::json!({ "dates": d }))),
        Err(e) => fail(e),
    }
}

async fn saturdays_update(
    State(c): S,
    Extension(u): U,
    ValidJson(dto): ValidJson<UpdateWorkingSaturdaysDto>,
) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(config::set_saturdays(&mut conn, &dto, a.user_id).await),
        Err(e) => fail(e),
    }
}

async fn request_config_get(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(config::get_request_config(&mut conn).await.map(|r| r.to_json())),
        Err(e) => fail(e),
    }
}

async fn request_config_update(
    State(c): S,
    Extension(u): U,
    ValidJson(dto): ValidJson<UpdateRequestConfigDto>,
) -> Response {
    let a = act!(u);
    match c.conn(a.company).await {
        Ok(mut conn) => ok(config::update_request_config(&mut conn, &dto, a.user_id)
            .await
            .map(|r| r.to_json())),
        Err(e) => fail(e),
    }
}

async fn request_create(
    State(c): S,
    Extension(u): U,
    ValidJson(dto): ValidJson<CreateAttendanceRequestDto>,
) -> Response {
    let a = act!(u);
    respond(requests::create(&c, &a, &dto).await, StatusCode::CREATED)
}

async fn request_list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceRequestsDto>) -> Response {
    let a = act!(u);
    ok(requests::list(&c, &a, &q).await)
}

async fn request_approve(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    match id_of(&id, "đơn chấm công.") {
        Ok(id) => respond(requests::approve(&c, &a, id).await, StatusCode::CREATED),
        Err(e) => fail(e),
    }
}

async fn request_reject(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<RejectRequestDto>,
) -> Response {
    let a = act!(u);
    match id_of(&id, "đơn chấm công.") {
        Ok(id) => respond(requests::reject(&c, &a, id, &dto).await, StatusCode::CREATED),
        Err(e) => fail(e),
    }
}

async fn stats_main(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>) -> Response {
    let a = act!(u);
    ok(stats::stats(&c, &a, &q).await)
}

async fn stats_filters(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    ok(stats::filters(&c, &a).await)
}

async fn stats_discipline(
    State(c): S,
    Extension(u): U,
    ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>,
) -> Response {
    let a = act!(u);
    ok(stats::discipline(&c, &a, &q).await)
}

async fn stats_leave(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>) -> Response {
    let a = act!(u);
    ok(stats::leave_analytics(&c, &a, &q).await)
}

async fn stats_weekly(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    ok(stats::weekly(&c, &a, &query_to_json(uri.query().unwrap_or(""))).await)
}

async fn stats_monthly(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    ok(stats::monthly(&c, &a, &query_to_json(uri.query().unwrap_or(""))).await)
}

async fn stats_weekly_hours(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    ok(stats::weekly_hours(&c, &a, &query_to_json(uri.query().unwrap_or(""))).await)
}

async fn record_list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceDto>) -> Response {
    let a = act!(u);
    ok(records::list(&c, &a, &q).await)
}

async fn record_get(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    match id_of(&id, "bản ghi chấm công.") {
        Ok(id) => ok(records::get(&c, &a, id).await),
        Err(e) => fail(e),
    }
}

async fn record_patch(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<PatchAttendanceDto>,
) -> Response {
    let a = act!(u);
    match id_of(&id, "bản ghi chấm công.") {
        Ok(id) => ok(records::patch(&c, &a, id, &dto).await),
        Err(e) => fail(e),
    }
}

async fn record_delete(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    match id_of(&id, "bản ghi chấm công.") {
        Ok(id) => ok(records::remove(&c, &a, id).await),
        Err(e) => fail(e),
    }
}

async fn today(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryTodaySummaryDto>) -> Response {
    let a = act!(u);
    ok(records::today(&c, &a, &q).await)
}

/// `@Query('date'|'sort_by'|'sort_dir') x?: string`: không có DTO, giá trị không phải chuỗi (mảng, đối tượng) coi như vắng.
async fn absent(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    let q = query_to_json(uri.query().unwrap_or(""));
    let text = |k: &str| q.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let (date, sort_by, sort_dir) = (text("date"), text("sort_by"), text("sort_dir"));
    ok(records::absent(&c, &a, date.as_deref(), sort_by.as_deref(), sort_dir.as_deref()).await)
}

async fn workdays_matrix(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceDto>) -> Response {
    let a = act!(u);
    ok(records::matrix(&c, &a, &q).await)
}

// ───────────────────────────── tệp xuất xlsx (M14b) ─────────────────────────────

const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// Tệp xlsx tải về: `Content-Type`, `Content-Disposition: attachment`, `Content-Length` như `res.end(buffer)` của bản TS.
fn xlsx(r: Result<Vec<u8>, AppError>, file_name: &str) -> Response {
    match r {
        Ok(bytes) => {
            let len = bytes.len();
            let mut resp = Response::new(Body::from(bytes));
            let h = resp.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(XLSX_MIME));
            if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{file_name}\"")) {
                h.insert(header::CONTENT_DISPOSITION, v);
            }
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
            resp
        }
        Err(e) => fail(e),
    }
}

async fn export_records(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceExportDto>) -> Response {
    let a = act!(u);
    xlsx(export::records_xlsx(&c, &a, &q).await, &export::records_filename())
}

async fn export_matrix(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceExportDto>) -> Response {
    let a = act!(u);
    xlsx(export::matrix_xlsx(&c, &a, &q).await, &export::matrix_filename())
}

/// Như `absent`: `date`/`sort_by`/`sort_dir` không qua DTO, giá trị không phải chuỗi coi như vắng.
async fn export_absent(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    let q = query_to_json(uri.query().unwrap_or(""));
    let text = |k: &str| q.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let (date, sort_by, sort_dir) = (text("date"), text("sort_by"), text("sort_dir"));
    match export::absent_xlsx(&c, &a, date.as_deref(), sort_by.as_deref(), sort_dir.as_deref()).await {
        Ok((bytes, day)) => xlsx(Ok(bytes), &format!("nv-chua-cham-cong_{day}.xlsx")),
        Err(e) => fail(e),
    }
}

async fn export_by_team(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>) -> Response {
    let a = act!(u);
    xlsx(export::by_team_xlsx(&c, &a, &q).await, "thong-ke-cham-cong-theo-team.xlsx")
}

async fn export_by_department(
    State(c): S,
    Extension(u): U,
    ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>,
) -> Response {
    let a = act!(u);
    xlsx(
        export::by_department_xlsx(&c, &a, &q).await,
        "thong-ke-cham-cong-theo-phong-ban.xlsx",
    )
}

async fn export_top_absent(
    State(c): S,
    Extension(u): U,
    ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>,
) -> Response {
    let a = act!(u);
    xlsx(export::top_absent_xlsx(&c, &a, &q).await, "top-nv-nghi-nhieu.xlsx")
}

async fn export_top_late_early(
    State(c): S,
    Extension(u): U,
    ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>,
) -> Response {
    let a = act!(u);
    xlsx(
        export::top_late_early_xlsx(&c, &a, &q).await,
        "top-nv-di-muon-ve-som.xlsx",
    )
}

async fn export_by_gender(
    State(c): S,
    Extension(u): U,
    ValidQuery(q): ValidQuery<QueryAttendanceStatsDto>,
) -> Response {
    let a = act!(u);
    xlsx(
        export::by_gender_xlsx(&c, &a, &q).await,
        "thong-ke-cham-cong-theo-gioi-tinh.xlsx",
    )
}

/// Router của M13a (state `Arc<Ctx>` của module nhân sự). Người gọi gắn state khi lắp `serve`.
pub fn router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let p = |suffix: &str| format!("{BASE}/{suffix}");
    ApiRouter::new(deps)
        .route(spec(&Method::GET, &p("offices")), office_list)
        .route(spec(&Method::POST, &p("offices")), office_create)
        .route(spec(&Method::PATCH, &p("offices/:id")), office_update)
        .route(spec(&Method::DELETE, &p("offices/:id")), office_delete)
        .route(spec(&Method::POST, &p("reset-device/:userId")), reset_device)
        .route(spec(&Method::GET, &p("settings")), settings_get)
        .route(spec(&Method::PATCH, &p("settings")), settings_update)
        .route(spec(&Method::GET, &p("working-saturdays")), saturdays_get)
        .route(spec(&Method::PATCH, &p("working-saturdays")), saturdays_update)
        .route(spec(&Method::GET, &p("request-config")), request_config_get)
        .route(spec(&Method::PATCH, &p("request-config")), request_config_update)
        .route(spec(&Method::POST, &p("requests")), request_create)
        .route(spec(&Method::GET, &p("requests")), request_list)
        .route(spec(&Method::POST, &p("requests/:id/approve")), request_approve)
        .route(spec(&Method::POST, &p("requests/:id/reject")), request_reject)
        .route(spec(&Method::GET, &p("stats")), stats_main)
        .route(spec(&Method::GET, &p("stats/filters")), stats_filters)
        .route(spec(&Method::GET, &p("stats/discipline")), stats_discipline)
        .route(spec(&Method::GET, &p("stats/leave-analytics")), stats_leave)
        .route(spec(&Method::GET, &p("stats/weekly")), stats_weekly)
        .route(spec(&Method::GET, &p("stats/monthly")), stats_monthly)
        .route(spec(&Method::GET, &p("stats/weekly-hours")), stats_weekly_hours)
        .route(spec(&Method::GET, BASE), record_list)
        .route(spec(&Method::GET, REC), record_get)
        .route(spec(&Method::PATCH, REC), record_patch)
        .route(spec(&Method::DELETE, REC), record_delete)
        .route(spec(&Method::GET, &p("today")), today)
        .route(spec(&Method::GET, &p("absent")), absent)
        .route(spec(&Method::GET, &p("workdays-matrix")), workdays_matrix)
        .route(spec(&Method::GET, &p("export")), export_records)
        .route(spec(&Method::GET, &p("workdays-matrix/export")), export_matrix)
        .route(spec(&Method::GET, &p("absent-export")), export_absent)
        .route(spec(&Method::GET, &p("stats/export-by-team")), export_by_team)
        .route(spec(&Method::GET, &p("stats/export-by-department")), export_by_department)
        .route(spec(&Method::GET, &p("stats/export-top-absent")), export_top_absent)
        .route(spec(&Method::GET, &p("stats/export-top-late-early")), export_top_late_early)
        .route(spec(&Method::GET, &p("stats/export-by-gender")), export_by_gender)
}

// ───────────────────────────── ảnh selfie (M14a) ─────────────────────────────

/// `GET /:id/proof/:slot`: stream ảnh từ kho tệp nên cần `CheckCtx`; `Content-Disposition: inline` như bản TS.
async fn record_proof(State(c): CC, Extension(u): U, Path((id, slot)): Path<(String, String)>) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "bản ghi chấm công.") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    match records::proof(&c, &a, id, &slot).await {
        Ok(d) => {
            let mut resp = Response::new(d.body);
            let h = resp.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&d.content_type) {
                h.insert(header::CONTENT_TYPE, v);
            }
            h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline"));
            if let Some(len) = d.content_length
                && let Ok(v) = HeaderValue::from_str(&len.to_string())
            {
                h.insert(header::CONTENT_LENGTH, v);
            }
            resp
        }
        Err(e) => fail(e),
    }
}

/// Router của ảnh selfie (state `Arc<CheckCtx>`, cùng state với [`check_router`]).
pub fn proof_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<CheckCtx>> {
    let spec = specs()
        .into_iter()
        .find(|x| x.method == Method::GET && x.path == PROOF)
        .unwrap_or_else(|| panic!("thiếu spec GET {PROOF}"));
    ApiRouter::new(deps).route(spec, record_proof)
}

// ───────────────────────────── chấm công vào/ra (M13b) ─────────────────────────────

type CC = State<Arc<CheckCtx>>;

/// Đọc multipart như `FileInterceptor('selfie')` của multer: tệp duy nhất tên `selfie` (tệp khác tên hoặc thêm một tệp nữa ⇒ 400
/// `Unexpected field`), loại ngoài danh sách ⇒ 400, quá 5 MB ⇒ 413. Trường chữ gom thành object (trùng tên thành mảng như multer).
async fn read_check_form(mut mp: Multipart) -> Result<(serde_json::Value, Option<Selfie>), AppError> {
    let mut fields = serde_json::Map::new();
    let mut selfie: Option<Selfie> = None;
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        let name = f.name().unwrap_or("").to_owned();
        if f.file_name().is_some() {
            if name != "selfie" || selfie.is_some() {
                return Err(HttpError::bad_request("Unexpected field").into());
            }
            let mime = f
                .content_type()
                .unwrap_or("text/plain")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !SELFIE_ALLOWED_MIME.contains(&mime.as_str()) {
                return Err(HttpError::bad_request(SELFIE_MIME_ERROR).into());
            }
            let data = read_field_limited(&mut f, SELFIE_MAX_SIZE).await?;
            selfie = Some(Selfie { mime, data });
        } else {
            let data = read_field_limited(&mut f, 1024 * 1024).await?;
            let text = serde_json::Value::String(String::from_utf8_lossy(&data).into_owned());
            match fields.remove(&name) {
                None => {
                    fields.insert(name, text);
                }
                Some(serde_json::Value::Array(mut a)) => {
                    a.push(text);
                    fields.insert(name, serde_json::Value::Array(a));
                }
                Some(prev) => {
                    fields.insert(name, serde_json::Value::Array(vec![prev, text]));
                }
            }
        }
    }
    Ok((serde_json::Value::Object(fields), selfie))
}

async fn do_check(c: Arc<CheckCtx>, u: CurrentUser, req: Request, checkin: bool) -> Response {
    let a = act!(u);
    // IP khách: hàm dùng chung (đọc header theo TRUSTED_PROXY), TRƯỚC khi đọc thân.
    let client = resolve_client_ip(&c.ip, &req);
    let mp = match Multipart::from_request(req, &()).await {
        Ok(m) => m,
        Err(_) => return fail(HttpError::bad_request("Bad Request")),
    };
    let (form, selfie) = match read_check_form(mp).await {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let dto = match validate_into::<DeviceCheckDto>(&form, Mode::Strict) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let input = CheckInput {
        user_id: a.user_id,
        device_id: &dto.device_id,
        note: dto.note.as_deref(),
        selfie,
        is_super_admin: a.is_admin,
        client_ip: client.ip,
        now: chrono::Utc::now(),
    };
    match c.ctx.conn(a.company).await {
        Ok(mut conn) => {
            let r = if checkin {
                check::check_in(&c, &mut conn, input).await
            } else {
                check::check_out(&c, &mut conn, input).await
            };
            respond(r, StatusCode::CREATED)
        }
        Err(e) => fail(e),
    }
}

async fn check_in(State(c): CC, Extension(u): U, req: Request) -> Response {
    do_check(c, u, req, true).await
}

async fn check_out(State(c): CC, Extension(u): U, req: Request) -> Response {
    do_check(c, u, req, false).await
}

/// Router của chấm công vào/ra (state `Arc<CheckCtx>`). Thân nhận tới 5 MB ảnh + 1 MB trường chữ.
pub fn check_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<CheckCtx>> {
    use axum::handler::Handler;
    let s = specs();
    let spec = |p: &str| {
        s.iter()
            .find(|x| x.method == Method::POST && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec POST {p}"))
    };
    let limit = || DefaultBodyLimit::max(SELFIE_MAX_SIZE + 1024 * 1024);
    ApiRouter::new(deps)
        .route(spec(&format!("{BASE}/check-in")), check_in.layer(limit()))
        .route(spec(&format!("{BASE}/check-out")), check_out.layer(limit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 40);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 40);
    }
}
