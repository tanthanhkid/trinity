//! Bảng route và handler của M13a (K14): 11 route `management/attendance/*`, mỗi route khai [`Access`] bắt buộc, quyền và mã
//! thành công khớp `contracts/routes.json`. Dữ liệu vào kiểm bằng metadata THẬT của class-validator (`ValidJson`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use serde::Serialize;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::ValidJson;
use trinity_kernel::error::{AppError, HttpError};

use crate::dto::{
    CreateOfficeDto, UpdateAttendanceSettingsDto, UpdateOfficeDto, UpdateRequestConfigDto, UpdateWorkingSaturdaysDto,
};
use crate::{config, offices};

const BASE: &str = "/api/v1/management/attendance";
const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 11 route của phần cấu hình chấm công (bảng so với `routes.json` bởi `trinity check-routes`).
pub fn specs() -> Vec<RouteSpec> {
    let view = Access::Can(&["attendance.view"]);
    let cfg = Access::Can(&["attendance.config"]);
    vec![
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 11);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 11);
    }
}
