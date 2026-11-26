//! Bảng route và handler của module (K14): mỗi route khai [`Access`] bắt buộc, quyền và mã thành công khớp
//! `contracts/routes.json`. Thứ tự guard → pipe tham số → handler do `ApiRouter` bảo đảm.

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use trinity_docgen::xlsx::{Cell, Column, SheetSpec, write_xlsx};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::guards::Actor;
use crate::pinned;
use crate::service::{self, CreateUser, Ctx, ListParams, ManagerFilter, SortBy, UpdateUser};

const USERS: &str = "/api/v1/users";
const ID_PIPE: &[&str] = &["param.id:ParseIntPipe"];
const MANAGE: Access = Access::Can(&["users.manage"]);

/// Bảng route của module (13 dòng), so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let by_id = |m: Method, suffix: &'static str, access: Access| {
        RouteSpec::new(m, suffix, access).status_ok(200).param_pipes(ID_PIPE)
    };
    vec![
        RouteSpec::new(Method::GET, USERS, Access::Can(&["users.view"])).status_ok(200),
        RouteSpec::new(Method::POST, USERS, MANAGE).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/users/export", Access::Can(&["users.export"])),
        RouteSpec::new(Method::GET, "/api/v1/users/me/pinned-menu", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::PUT, "/api/v1/users/me/pinned-menu", Access::AuthOnly).status_ok(200),
        by_id(Method::GET, "/api/v1/users/:id", Access::Can(&["users.view"])),
        by_id(Method::PATCH, "/api/v1/users/:id", MANAGE),
        by_id(Method::DELETE, "/api/v1/users/:id", MANAGE),
        by_id(Method::DELETE, "/api/v1/users/:id/permanent", MANAGE),
        by_id(Method::PATCH, "/api/v1/users/:id/reset-password", MANAGE),
        by_id(Method::GET, "/api/v1/users/:id/password-history", MANAGE),
        by_id(Method::PATCH, "/api/v1/users/:id/team", MANAGE),
        by_id(Method::PUT, "/api/v1/users/:id/roles", MANAGE),
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

fn actor(u: &CurrentUser) -> Actor {
    Actor {
        user_id: u.user.user_id,
        company: trinity_db::CompanyRef::new(i64::from(u.user.company_id)).unwrap_or(trinity_db::CompanyRef::DEFAULT),
        grants: u.grants.grants.clone(),
        is_admin: u.grants.is_admin,
    }
}

fn ok(r: Result<Value, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có người dùng nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy người dùng").into())
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

/// `Number(s)` của JS: chuỗi rỗng là 0, không phải số là `None` (NaN).
fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        Some(0.0)
    } else {
        t.parse::<f64>().ok().filter(|n| n.is_finite())
    }
}

/// Query của `GET /users` và `/users/export` như controller: `page`/`limit` (mặc định 1/20, trần 1000), `team_id`, `role`,
/// `roles` (CSV), `manager_id` (`none` = chưa có quản lý), `search`, `status`, `sort_by`, `sort_order`.
pub fn list_params(q: &HashMap<String, String>) -> ListParams {
    let get = |k: &str| q.get(k).map(String::as_str);
    let int = |k: &str| get(k).filter(|s| !s.is_empty()).and_then(js_number).map(|n| n as i64);
    let roles = get("roles").filter(|s| !s.is_empty()).map(|r| {
        r.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    ListParams {
        page: get("page").and_then(js_number).map_or(1, |n| n as i64).max(1),
        limit: get("limit").and_then(js_number).map_or(20, |n| (n as i64).min(1000)),
        team_id: int("team_id").and_then(|n| i32::try_from(n).ok()),
        role: get("role").filter(|s| !s.is_empty()).map(str::to_owned),
        roles,
        manager: match get("manager_id") {
            Some("none") => ManagerFilter::Nobody,
            Some(s) if !s.is_empty() => int("manager_id")
                .and_then(|n| i32::try_from(n).ok())
                .map_or(ManagerFilter::Any, ManagerFilter::Is),
            _ => ManagerFilter::Any,
        },
        search: get("search").filter(|s| !s.is_empty()).map(str::to_owned),
        status: get("status").filter(|s| !s.is_empty()).map(str::to_owned),
        sort_by: get("sort_by").and_then(SortBy::parse),
        desc: match get("sort_order") {
            Some("desc") => Some(true),
            Some("asc") => Some(false),
            _ => None,
        },
    }
}

/// `reassign_to` của `LockUserDto`: tuỳ chọn, `null` = mồ côi, còn lại phải là số nguyên.
fn reassign_to(body: &Value) -> Result<Option<i32>, HttpError> {
    match body.get("reassign_to") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .filter(|_| v.is_i64() || v.is_u64())
        {
            Some(n) => Ok(Some(n)),
            None => Err(HttpError::validation(vec![
                "reassign_to must be an integer number".to_owned(),
            ])),
        },
    }
}

async fn list(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    ok(service::list(&c, &actor(&u), &list_params(&q)).await)
}

async fn export(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let rows = match service::export_rows(&c, &actor(&u), &list_params(&q)).await {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    tracing::info!("Exporting {} user rows", rows.len());
    let label = |s: &str| match s {
        "active" => "Hoạt động".to_owned(),
        "locked" => "Đã khoá".to_owned(),
        other => other.to_owned(),
    };
    let cells: Vec<Vec<Cell>> = rows
        .iter()
        .enumerate()
        .map(|(i, (name, roles, status))| {
            vec![
                Cell::int(i64::try_from(i + 1).unwrap_or(0)),
                Cell::text(name.clone()),
                Cell::text(roles.join(", ")),
                Cell::text(label(status)),
            ]
        })
        .collect();
    let width = |header: &str, col: usize| {
        let longest = cells.iter().map(|r| match &r[col] {
            Cell::Text(t) => t.chars().count(),
            Cell::Number(n, _) => format!("{n}").len(),
            _ => 0,
        });
        (longest.max().unwrap_or(0).max(header.chars().count()) as f64 + 2.0).clamp(10.0, 50.0)
    };
    let heads = ["STT", "Họ và tên", "Vai trò", "Tình trạng tài khoản"];
    let sheet = SheetSpec {
        name: "Người dùng".to_owned(),
        title: Some(format!(
            "DANH SÁCH TÀI KHOẢN NGƯỜI DÙNG · Tổng {} tài khoản",
            rows.len()
        )),
        subtitle: None,
        columns: heads
            .iter()
            .enumerate()
            .map(|(i, h)| Column::new(*h, width(h, i)))
            .collect(),
        rows: cells,
    };
    match write_xlsx(&[sheet]) {
        Ok(bytes) => {
            let mut resp = Response::new(Body::from(bytes));
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            );
            h.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"danh-sach-nguoi-dung.xlsx\""),
            );
            resp
        }
        Err(e) => fail(AppError::internal(e)),
    }
}

async fn get_one(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    match id_of(&id) {
        Ok(id) => ok(service::find_by_id(&c, &actor(&u), id).await),
        Err(e) => fail(e),
    }
}

async fn create(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, JsonBody(body): JsonBody) -> Response {
    match CreateUser::parse(&body) {
        Ok(input) => ok(service::create(&c, &actor(&u), &input).await),
        Err(e) => fail(e),
    }
}

async fn update(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let v = match validate_value("UpdateUserDto", &body, Mode::Lenient) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match id_of(&id) {
        Ok(id) => ok(service::update(&c, &actor(&u), id, &UpdateUser::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn lock(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let to = match reassign_to(&body) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };
    match id_of(&id) {
        Ok(id) => ok(service::lock(&c, &actor(&u), id, to).await),
        Err(e) => fail(e),
    }
}

async fn permanent(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let to = match reassign_to(&body) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };
    match id_of(&id) {
        Ok(id) => ok(service::permanent_delete(&c, &actor(&u), id, to).await),
        Err(e) => fail(e),
    }
}

async fn reset_password(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    // `ResetPasswordDto`: mật khẩu tuỳ chọn (để kiểm quyền chạy trước câu "bắt buộc"), có thì phải chuỗi từ 8 ký tự.
    let pw = match body.get("password") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.chars().count() >= 8 => Some(s.clone()),
        Some(Value::String(_)) => {
            return fail(HttpError::validation(vec![
                "Mật khẩu phải có ít nhất 8 ký tự".to_owned(),
            ]));
        }
        Some(_) => {
            return fail(HttpError::validation(vec![
                "password must be a string".to_owned(),
                "Mật khẩu phải có ít nhất 8 ký tự".to_owned(),
            ]));
        }
    };
    match id_of(&id) {
        Ok(id) => ok(service::reset_password(&c, &actor(&u), id, pw.as_deref()).await),
        Err(e) => fail(e),
    }
}

async fn history(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    match id_of(&id) {
        Ok(id) => ok(service::password_history(&c, &actor(&u), id).await),
        Err(e) => fail(e),
    }
}

async fn team(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let Some(team_id) = body
        .get("team_id")
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
    else {
        return fail(HttpError::validation(vec!["team_id phải là số nguyên".to_owned()]));
    };
    match id_of(&id) {
        Ok(id) => ok(service::assign_team(&c, &actor(&u), id, team_id).await),
        Err(e) => fail(e),
    }
}

async fn set_roles(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let ids = match service::parse_role_ids(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    match id_of(&id) {
        Ok(id) => ok(service::set_roles(&c, &actor(&u), id, &ids).await),
        Err(e) => fail(e),
    }
}

async fn pinned_get(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let a = actor(&u);
    let r = async {
        let mut conn = c.conn(a.company).await?;
        pinned::get(&mut conn, a.user_id).await
    }
    .await;
    ok(r)
}

async fn pinned_put(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let keys = match pinned::validate_keys(&body) {
        Ok(k) => k,
        Err(e) => return fail(e),
    };
    let a = actor(&u);
    let r = async {
        let mut conn = c.conn(a.company).await?;
        pinned::update(&mut conn, a.user_id, keys).await
    }
    .await;
    ok(r)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, USERS), list)
        .route(spec(&Method::POST, USERS), create)
        .route(spec(&Method::GET, "/api/v1/users/export"), export)
        .route(spec(&Method::GET, "/api/v1/users/me/pinned-menu"), pinned_get)
        .route(spec(&Method::PUT, "/api/v1/users/me/pinned-menu"), pinned_put)
        .route(spec(&Method::GET, "/api/v1/users/:id"), get_one)
        .route(spec(&Method::PATCH, "/api/v1/users/:id"), update)
        .route(spec(&Method::DELETE, "/api/v1/users/:id"), lock)
        .route(spec(&Method::DELETE, "/api/v1/users/:id/permanent"), permanent)
        .route(spec(&Method::PATCH, "/api/v1/users/:id/reset-password"), reset_password)
        .route(spec(&Method::GET, "/api/v1/users/:id/password-history"), history)
        .route(spec(&Method::PATCH, "/api/v1/users/:id/team"), team)
        .route(spec(&Method::PUT, "/api/v1/users/:id/roles"), set_roles)
}
