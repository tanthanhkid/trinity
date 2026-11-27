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
use axum::extract::{Extension, Multipart, Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use mod_users::guards::Actor;
use serde::Serialize;
use trinity_http::edge::body::read_field_limited;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};

use crate::contract_dto::{CreateContractDto, QueryContractStatsDto, QueryContractsDto, UpdateContractDto};
use crate::contracts::{
    self, CONTRACT_FILE_MIME, CONTRACT_FILE_MIME_ERROR, ContractsCtx, FILE_MAX_BYTES, FileOut, TEMPLATE_MIME,
    TEMPLATE_MIME_ERROR, Upload, encode_uri_component,
};
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

// ───────────────────────────── hợp đồng (M11) ─────────────────────────────

const CBASE: &str = "/api/v1/management/contracts";

/// 13 route của `ContractsController` (bảng so với `routes.json` bởi `trinity check-routes`). Route tĩnh (`stats`, `templates`)
/// đứng trước `:id` như bản Nest.
pub fn contract_specs() -> Vec<RouteSpec> {
    let view = Access::Can(&["contracts.view"]);
    let manage = Access::Can(&["contracts.manage"]);
    let tid: &[&str] = &["param.tid:ParseIntPipe"];
    vec![
        RouteSpec::new(Method::GET, CBASE, view).status_ok(200),
        RouteSpec::new(Method::POST, CBASE, manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/management/contracts/stats", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/contracts/templates", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/management/contracts/templates", manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/management/contracts/templates/:tid/file", view)
            .status_ok(200)
            .param_pipes(tid),
        RouteSpec::new(Method::DELETE, "/api/v1/management/contracts/templates/:tid", manage)
            .status_ok(200)
            .param_pipes(tid),
        RouteSpec::new(Method::GET, "/api/v1/management/contracts/:id", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/management/contracts/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/contracts/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/management/contracts/:id/file", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/management/contracts/:id/file", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/contracts/:id/file", manage)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

fn cid_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
}

/// Phần tải lên đã đọc: tệp (nếu có) và các trường chữ.
struct Parsed {
    file: Option<Upload>,
    fields: Vec<(String, String)>,
}

/// Đọc multipart như `FileInterceptor('file')` của multer: trường tệp duy nhất tên `file` (tệp khác hoặc trùng ⇒ 400 `Unexpected
/// field`), loại tệp ngoài danh sách ⇒ 400 ngay, vượt cỡ ⇒ 413 `File too large`.
async fn read_upload(mut mp: Multipart, allowed: &[&str], bad_mime: &str) -> Result<Parsed, AppError> {
    let mut out = Parsed {
        file: None,
        fields: Vec::new(),
    };
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        let name = f.name().unwrap_or("").to_owned();
        if f.file_name().is_some() {
            if name != "file" || out.file.is_some() {
                return Err(HttpError::bad_request("Unexpected field").into());
            }
            // Chuẩn hoá loại: bỏ phần sau `;` (charset…), cắt khoảng trắng, chữ thường rồi mới so với danh sách.
            let mime = f
                .content_type()
                .unwrap_or("text/plain")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !allowed.contains(&mime.as_str()) {
                return Err(HttpError::bad_request(bad_mime).into());
            }
            let file_name = f.file_name().map(str::to_owned);
            let data = read_field_limited(&mut f, FILE_MAX_BYTES).await?;
            out.file = Some(Upload { file_name, mime, data });
        } else {
            let data = read_field_limited(&mut f, 1024 * 1024).await?;
            out.fields.push((name, String::from_utf8_lossy(&data).into_owned()));
        }
    }
    Ok(out)
}

fn file_response(f: FileOut, disposition: &str) -> Response {
    let mut resp = Response::new(f.download.body);
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&f.content_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!(
        "{disposition}; filename*=UTF-8''{}",
        encode_uri_component(&f.file_name)
    )) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    if let Some(len) = f.download.content_length
        && let Ok(v) = HeaderValue::from_str(&len.to_string())
    {
        h.insert(header::CONTENT_LENGTH, v);
    }
    resp
}

fn created_status(mut r: Response) -> Response {
    if r.status().is_success() {
        *r.status_mut() = StatusCode::CREATED;
    }
    r
}

type CS = State<Arc<ContractsCtx>>;

async fn c_list(State(c): CS, Extension(u): U, ValidQuery(q): ValidQuery<QueryContractsDto>) -> Response {
    ok(contracts::find_all(&c.ctx, &act!(u), &q, Utc::now()).await)
}

async fn c_stats(State(c): CS, Extension(u): U, ValidQuery(q): ValidQuery<QueryContractStatsDto>) -> Response {
    ok(contracts::get_stats(&c.ctx, &act!(u), &q, Utc::now()).await)
}

async fn c_get(State(c): CS, Extension(u): U, Path(id): Path<String>) -> Response {
    match cid_of(&id, "hợp đồng") {
        Ok(id) => ok(contracts::find_by_id(&c.ctx, &act!(u), id, Utc::now()).await),
        Err(e) => fail(e),
    }
}

async fn c_create(State(c): CS, Extension(u): U, ValidJson(dto): ValidJson<CreateContractDto>) -> Response {
    created_status(ok(contracts::create(&c.ctx, &act!(u), &dto, Utc::now()).await))
}

async fn c_update(
    State(c): CS,
    Extension(u): U,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<UpdateContractDto>,
) -> Response {
    match cid_of(&id, "hợp đồng") {
        Ok(id) => ok(contracts::update(&c.ctx, &act!(u), id, &dto, Utc::now()).await),
        Err(e) => fail(e),
    }
}

async fn c_remove(State(c): CS, Extension(u): U, Path(id): Path<String>) -> Response {
    match cid_of(&id, "hợp đồng") {
        Ok(id) => ok(contracts::remove(&c, &act!(u), id).await),
        Err(e) => fail(e),
    }
}

async fn c_upload_file(State(c): CS, Extension(u): U, Path(id): Path<String>, mp: Multipart) -> Response {
    let a = act!(u);
    let id = match cid_of(&id, "hợp đồng") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let parsed = match read_upload(mp, &CONTRACT_FILE_MIME, CONTRACT_FILE_MIME_ERROR).await {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let Some(file) = parsed.file else {
        return fail(HttpError::bad_request("Vui lòng chọn file để tải lên"));
    };
    created_status(ok(contracts::upload_file(&c, &a, id, file, Utc::now()).await))
}

async fn c_get_file(State(c): CS, Extension(u): U, Path(id): Path<String>) -> Response {
    match cid_of(&id, "hợp đồng") {
        Ok(id) => match contracts::stream_file(&c, &act!(u), id).await {
            Ok(f) => file_response(f, "inline"),
            Err(e) => fail(e),
        },
        Err(e) => fail(e),
    }
}

async fn c_remove_file(State(c): CS, Extension(u): U, Path(id): Path<String>) -> Response {
    match cid_of(&id, "hợp đồng") {
        Ok(id) => ok(contracts::remove_file(&c, &act!(u), id, Utc::now()).await),
        Err(e) => fail(e),
    }
}

async fn t_list(State(c): CS, Extension(u): U) -> Response {
    ok(contracts::list_templates(&c.ctx, &act!(u)).await)
}

async fn t_upload(State(c): CS, Extension(u): U, mp: Multipart) -> Response {
    let a = act!(u);
    let parsed = match read_upload(mp, &TEMPLATE_MIME, TEMPLATE_MIME_ERROR).await {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let Some(file) = parsed.file else {
        return fail(HttpError::bad_request("Vui lòng chọn file để tải lên"));
    };
    let name = parsed
        .fields
        .iter()
        .rev()
        .find(|(k, _)| k == "name")
        .map(|(_, v)| v.as_str());
    created_status(ok(contracts::upload_template(&c, &a, file, name, Utc::now()).await))
}

async fn t_get_file(State(c): CS, Extension(u): U, Path(tid): Path<String>) -> Response {
    match cid_of(&tid, "hồ sơ mẫu") {
        Ok(id) => match contracts::stream_template(&c, &act!(u), id).await {
            Ok(f) => file_response(f, "attachment"),
            Err(e) => fail(e),
        },
        Err(e) => fail(e),
    }
}

async fn t_delete(State(c): CS, Extension(u): U, Path(tid): Path<String>) -> Response {
    match cid_of(&tid, "hồ sơ mẫu") {
        Ok(id) => ok(contracts::delete_template(&c, &act!(u), id).await),
        Err(e) => fail(e),
    }
}

/// Router của hợp đồng (state `Arc<ContractsCtx>`). Hai route tải lên nhận thân tới `FILE_MAX_BYTES` + 1 MB (multer giới hạn
/// từng tệp 20 MB; mặc định 2 MB của axum không đủ).
pub fn contract_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<ContractsCtx>> {
    use axum::extract::DefaultBodyLimit;
    use axum::handler::Handler;
    let s = contract_specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let limit = || DefaultBodyLimit::max(FILE_MAX_BYTES + 1024 * 1024);
    ApiRouter::new(deps)
        .route(spec(&Method::GET, CBASE), c_list)
        .route(spec(&Method::POST, CBASE), c_create)
        .route(spec(&Method::GET, "/api/v1/management/contracts/stats"), c_stats)
        .route(spec(&Method::GET, "/api/v1/management/contracts/templates"), t_list)
        .route(
            spec(&Method::POST, "/api/v1/management/contracts/templates"),
            t_upload.layer(limit()),
        )
        .route(
            spec(&Method::GET, "/api/v1/management/contracts/templates/:tid/file"),
            t_get_file,
        )
        .route(
            spec(&Method::DELETE, "/api/v1/management/contracts/templates/:tid"),
            t_delete,
        )
        .route(spec(&Method::GET, "/api/v1/management/contracts/:id"), c_get)
        .route(spec(&Method::PATCH, "/api/v1/management/contracts/:id"), c_update)
        .route(spec(&Method::DELETE, "/api/v1/management/contracts/:id"), c_remove)
        .route(
            spec(&Method::POST, "/api/v1/management/contracts/:id/file"),
            c_upload_file.layer(limit()),
        )
        .route(spec(&Method::GET, "/api/v1/management/contracts/:id/file"), c_get_file)
        .route(
            spec(&Method::DELETE, "/api/v1/management/contracts/:id/file"),
            c_remove_file,
        )
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = contract_specs();
        assert_eq!(table.len(), 13);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 13);
    }
}
