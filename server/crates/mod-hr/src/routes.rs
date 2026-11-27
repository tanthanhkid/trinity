//! Bảng route và handler của nhân viên (M10, K14): 12 route `management/employees`, mỗi route khai [`Access`] bắt buộc, quyền
//! và mã thành công khớp `contracts/routes.json`. Dữ liệu vào kiểm bằng metadata THẬT của class-validator
//! (`ValidQuery`/`ValidJson` đọc `contracts/dto/schema.json`) rồi mới tới handler.
//!
//! Route tĩnh (`stats`, `hr-stats`, `birthdays`, `birthdays/export`, `export`) đứng trước `:id` như bản Nest; axum cũng ưu tiên
//! đường tĩnh nên không route nào bị `:id` nuốt.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use mod_users::guards::Actor;
use serde::Serialize;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};

use crate::employee_dto::{
    BirthdayListQueryDto, CreateEmployeeDto, HrStatsQueryDto, QueryEmployeesDto, UpdateEmployeeDto,
};
use crate::employees::{self, Ctx};
use crate::{employees_export, employees_write};

const BASE: &str = "/api/v1/management/employees";
const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 12 route của `EmployeesController` (bảng so với `routes.json` bởi `trinity check-routes`).
pub fn employee_specs() -> Vec<RouteSpec> {
    let view = Access::Can(&["employees.view"]);
    let manage = Access::Can(&["employees.manage"]);
    let export = Access::Can(&["employees.export"]);
    let by_id =
        |m: Method, suffix: &'static str, a: Access| RouteSpec::new(m, suffix, a).status_ok(200).param_pipes(ID);
    vec![
        RouteSpec::new(Method::GET, BASE, view).status_ok(200),
        RouteSpec::new(Method::POST, BASE, manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/management/employees/stats", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/employees/hr-stats", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/employees/birthdays", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/employees/birthdays/export", export),
        RouteSpec::new(Method::GET, "/api/v1/management/employees/export", export),
        by_id(Method::GET, "/api/v1/management/employees/:id", view),
        by_id(Method::PATCH, "/api/v1/management/employees/:id", manage),
        by_id(Method::PATCH, "/api/v1/management/employees/:id/lock", manage),
        by_id(Method::PATCH, "/api/v1/management/employees/:id/unlock", manage),
        by_id(Method::DELETE, "/api/v1/management/employees/:id", manage),
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

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => match serde_json::to_string(&v) {
            Ok(text) => {
                let mut resp = Response::new(Body::from(text));
                resp.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json; charset=utf-8"),
                );
                resp
            }
            Err(e) => fail(AppError::internal(e)),
        },
        Err(e) => fail(e),
    }
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có nhân viên nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy nhân viên").into())
}

fn xlsx(bytes: Vec<u8>, filename: &str) -> Response {
    let mut resp = Response::new(Body::from(bytes));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    resp
}

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

async fn list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryEmployeesDto>) -> Response {
    ok(employees::find_all(&c, &act!(u), &q).await)
}

async fn stats(State(c): S, Extension(u): U) -> Response {
    ok(employees::get_stats(&c, &act!(u)).await)
}

async fn hr_stats(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<HrStatsQueryDto>) -> Response {
    ok(employees::get_hr_stats(&c, &act!(u), &q).await)
}

async fn birthdays(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<BirthdayListQueryDto>) -> Response {
    ok(employees::get_birthday_list(&c, &act!(u), &q, "employees.view").await)
}

async fn birthdays_export(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<BirthdayListQueryDto>) -> Response {
    match employees_export::export_birthdays(&c, &act!(u), &q).await {
        Ok(bytes) => xlsx(bytes, &employees_export::birthday_filename(q.month)),
        Err(e) => fail(e),
    }
}

async fn export(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryEmployeesDto>) -> Response {
    match employees_export::export_list(&c, &act!(u), &q).await {
        Ok(bytes) => xlsx(bytes, "danh-sach-nhan-vien.xlsx"),
        Err(e) => fail(e),
    }
}

async fn get_one(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    match id_of(&id) {
        Ok(id) => ok(employees::find_by_id(&c, &act!(u), id).await),
        Err(e) => fail(e),
    }
}

async fn create(State(c): S, Extension(u): U, ValidJson(dto): ValidJson<CreateEmployeeDto>) -> Response {
    ok(employees_write::create(&c, &act!(u), dto).await)
}

async fn update(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<UpdateEmployeeDto>,
) -> Response {
    match id_of(&id) {
        Ok(id) => ok(employees_write::update(&c, &act!(u), id, dto).await),
        Err(e) => fail(e),
    }
}

async fn lock(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    match id_of(&id) {
        Ok(id) => ok(employees_write::lock(&c, &act!(u), id).await),
        Err(e) => fail(e),
    }
}

async fn unlock(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    match id_of(&id) {
        Ok(id) => ok(employees_write::unlock(&c, &act!(u), id).await),
        Err(e) => fail(e),
    }
}

async fn remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    match id_of(&id) {
        Ok(id) => ok(employees_write::remove(&c, &act!(u), id).await),
        Err(e) => fail(e),
    }
}

/// Router của nhân viên: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn employee_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = employee_specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, BASE), list)
        .route(spec(&Method::POST, BASE), create)
        .route(spec(&Method::GET, "/api/v1/management/employees/stats"), stats)
        .route(spec(&Method::GET, "/api/v1/management/employees/hr-stats"), hr_stats)
        .route(spec(&Method::GET, "/api/v1/management/employees/birthdays"), birthdays)
        .route(
            spec(&Method::GET, "/api/v1/management/employees/birthdays/export"),
            birthdays_export,
        )
        .route(spec(&Method::GET, "/api/v1/management/employees/export"), export)
        .route(spec(&Method::GET, "/api/v1/management/employees/:id"), get_one)
        .route(spec(&Method::PATCH, "/api/v1/management/employees/:id"), update)
        .route(spec(&Method::PATCH, "/api/v1/management/employees/:id/lock"), lock)
        .route(spec(&Method::PATCH, "/api/v1/management/employees/:id/unlock"), unlock)
        .route(spec(&Method::DELETE, "/api/v1/management/employees/:id"), remove)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = employee_specs();
        assert_eq!(table.len(), 12);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 12);
    }
}
