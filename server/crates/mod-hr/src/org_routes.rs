//! Route HTTP của team (M09, 9 route), chức danh (M09, 5 route) và tuyển dụng (M12, 10 route), mỗi route khai [`Access`] và mã
//! thành công khớp `contracts/routes.json`. Dịch vụ nằm ở [`crate::teams`], [`crate::job_titles`], [`crate::recruitment`]; file
//! này chỉ lo tầng route: extractor K15, kiểm dữ liệu vào, quyền, JSON.
//!
//! Dữ liệu vào: DTO có trong `contracts/dto/schema.json` (chức danh tạo/truy vấn, ứng viên, vị trí) đi qua metadata THẬT của
//! class-validator; DTO chưa có trong `schema.json` (`CreateTeamDto`, `UpdateTeamDto`, `TeamMembersDto`, `UpdateJobTitleDto`)
//! kiểm tay đúng thứ tự câu lỗi của class-validator: whitelist trước, rồi từng thuộc tính theo thứ tự khai, decorator khai sau
//! chạy trước.
//!
//! Route tĩnh (`for-filter`, `lead-filter`, `stats`, `recruiters`) khai trước route có tham số như bản Nest.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{Method, Uri, header};
use axum::response::Response;
use mod_users::guards::Actor;
use serde_json::{Map, Value};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidJson, ValidQuery, query_to_json};
use trinity_kernel::error::{AppError, HttpError};

use crate::employees::Ctx;
use crate::job_titles::{self, CreateJobTitle, JobTitleRow, QueryJobTitles, UpdateJobTitle};
use crate::routes::{actor, fail, ok};
use crate::teams::{self, COLOR_MSG, CreateTeam, TeamMembers, UpdateTeam, is_hex_color};
use crate::{len16, recruitment as rc};

const TEAMS: &str = "/api/v1/management/teams";
const JOB_TITLES: &str = "/api/v1/management/job-titles";
const ID: &[&str] = &["param.id:ParseIntPipe"];
const TEAM_MEMBER: &[&str] = &["param.id:ParseIntPipe", "param.userId:ParseIntPipe"];

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

macro_rules! act {
    ($u:expr) => {
        match actor(&$u) {
            Ok(a) => a,
            Err(r) => return r,
        }
    };
}

// ───────────────────────────── bảng route (K14) ─────────────────────────────

/// 9 route của `TeamsController` (bảng so với `routes.json` bởi `trinity check-routes`).
pub fn team_specs() -> Vec<RouteSpec> {
    let org = Access::Can(&["org.manage"]);
    let by_id = |m: Method, path: &'static str| RouteSpec::new(m, path, org).status_ok(200).param_pipes(ID);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/management/teams/for-filter", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/teams/lead-filter", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, TEAMS, org).status_ok(200),
        RouteSpec::new(Method::POST, TEAMS, org).status_ok(201),
        by_id(Method::PATCH, "/api/v1/management/teams/:id"),
        by_id(Method::DELETE, "/api/v1/management/teams/:id"),
        by_id(Method::GET, "/api/v1/management/teams/:id/members"),
        RouteSpec::new(Method::POST, "/api/v1/management/teams/:id/members", org)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/teams/:id/members/:userId", org)
            .status_ok(200)
            .param_pipes(TEAM_MEMBER),
    ]
}

/// 5 route của `JobTitlesController`.
pub fn job_title_specs() -> Vec<RouteSpec> {
    let org = Access::Can(&["org.manage"]);
    vec![
        RouteSpec::new(Method::GET, JOB_TITLES, Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::POST, JOB_TITLES, org).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/management/job-titles/:id", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/management/job-titles/:id", org)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/job-titles/:id", org)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

/// 10 route của `RecruitmentController` (bảng nằm ở [`rc::routes`]).
pub fn recruitment_specs() -> Vec<RouteSpec> {
    rc::routes()
}

fn pick(table: &[RouteSpec], m: &Method, p: &str) -> RouteSpec {
    table
        .iter()
        .find(|x| x.method == *m && x.path == p)
        .cloned()
        .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
}

// ───────────────────────────── dữ liệu vào ─────────────────────────────

impl Dto for CreateJobTitle {
    const NAME: &'static str = "CreateJobTitleDto";
}

impl Dto for QueryJobTitles {
    const NAME: &'static str = "QueryJobTitlesDto";
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`.
struct JsonBody(Value);

impl<St: Send + Sync> FromRequest<St> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &St) -> Result<Self, Response> {
        let is_json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
            .is_some_and(|ct| ct == "application/json" || ct.ends_with("+json"));
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

fn obj(body: &Value) -> Map<String, Value> {
    match body {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    }
}

/// Lỗi whitelist của `forbidNonWhitelisted`: chạy trước mọi luật của từng thuộc tính.
fn unknown_props(m: &Map<String, Value>, known: &[&str]) -> Vec<String> {
    m.keys()
        .filter(|k| !known.contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect()
}

/// `Number.isInteger` trên giá trị JSON.
fn is_int(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n.fract() == 0.0)
}

/// Số nguyên đã qua `IsInt` mà không vừa int4 ⇒ 400 trơn (như `validate_into`).
fn int4(v: &Value) -> Result<i32, AppError> {
    match v.as_f64() {
        Some(n) if n.fract() == 0.0 && n >= f64::from(i32::MIN) && n <= f64::from(i32::MAX) =>
        {
            #[allow(clippy::cast_possible_truncation)]
            Ok(n as i32)
        }
        _ => Err(HttpError::nest(400, None).into()),
    }
}

/// Trường chuỗi: `required` ⇒ `@IsString() @MaxLength(max)`; không thì thêm `@IsOptional()` (vắng/`null` bỏ qua). `hex` thêm
/// `@Matches(màu hex)`. Decorator khai sau chạy trước nên báo Matches, MaxLength, IsString.
fn check_str(m: &Map<String, Value>, f: &str, max: usize, flags: (bool, bool), out: &mut Vec<String>) {
    let (required, hex) = flags;
    let too_long = format!("{f} must be shorter than or equal to {max} characters");
    match m.get(f) {
        None | Some(Value::Null) if !required => {}
        Some(Value::String(s)) => {
            if hex && !is_hex_color(s) {
                out.push(COLOR_MSG.to_owned());
            }
            if len16(s) > max {
                out.push(too_long);
            }
        }
        _ => {
            if hex {
                out.push(COLOR_MSG.to_owned());
            }
            out.push(too_long);
            out.push(format!("{f} must be a string"));
        }
    }
}

/// `@IsOptional() @ValidateIf(v !== null) @IsInt()`: vắng/`null` bỏ qua.
fn check_opt_int(m: &Map<String, Value>, f: &str, out: &mut Vec<String>) {
    if let Some(v) = m.get(f)
        && !v.is_null()
        && !is_int(v)
    {
        out.push(format!("{f} must be an integer number"));
    }
}

/// Đổi `team_lead_id` số thực nguyên (`1.0`) về số nguyên để serde nhận; ngoài int4 ⇒ 400.
fn norm_lead(m: &mut Map<String, Value>) -> Result<(), AppError> {
    if let Some(v) = m.get("team_lead_id")
        && !v.is_null()
    {
        let n = int4(v)?;
        m.insert("team_lead_id".to_owned(), Value::from(n));
    }
    Ok(())
}

const TEAM_KEYS: [&str; 5] = ["name", "department", "description", "team_lead_id", "color"];

/// `CreateTeamDto`.
fn parse_create_team(body: &Value) -> Result<CreateTeam, AppError> {
    let mut m = obj(body);
    let mut e = unknown_props(&m, &TEAM_KEYS);
    check_str(&m, "name", 100, (true, false), &mut e);
    check_str(&m, "department", 100, (false, false), &mut e);
    check_str(&m, "description", 500, (false, false), &mut e);
    check_opt_int(&m, "team_lead_id", &mut e);
    check_str(&m, "color", 20, (false, true), &mut e);
    if !e.is_empty() {
        return Err(HttpError::validation(e).into());
    }
    norm_lead(&mut m)?;
    serde_json::from_value(Value::Object(m)).map_err(AppError::internal)
}

/// `UpdateTeamDto`: mọi trường tuỳ chọn; `null` ở `department`/`description`/`team_lead_id`/`color` là xoá.
fn parse_update_team(body: &Value) -> Result<UpdateTeam, AppError> {
    let mut m = obj(body);
    let mut e = unknown_props(&m, &TEAM_KEYS);
    check_str(&m, "name", 100, (false, false), &mut e);
    check_str(&m, "department", 100, (false, false), &mut e);
    check_str(&m, "description", 500, (false, false), &mut e);
    check_opt_int(&m, "team_lead_id", &mut e);
    check_str(&m, "color", 20, (false, true), &mut e);
    if !e.is_empty() {
        return Err(HttpError::validation(e).into());
    }
    norm_lead(&mut m)?;
    serde_json::from_value(Value::Object(m)).map_err(AppError::internal)
}

/// `TeamMembersDto`: `@IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @IsInt({ each: true })` (báo ngược thứ tự khai).
fn parse_members(body: &Value) -> Result<TeamMembers, AppError> {
    let m = obj(body);
    let mut e = unknown_props(&m, &["user_ids"]);
    let v = m.get("user_ids");
    let arr = v.and_then(Value::as_array);
    let ints_ok = match (arr, v) {
        (Some(a), _) => a.iter().all(is_int),
        (None, Some(x)) => is_int(x),
        (None, None) => false,
    };
    if !ints_ok {
        e.push("each value in user_ids must be an integer number".to_owned());
    }
    if !arr.is_some_and(|a| a.len() <= 500) {
        e.push("user_ids must contain no more than 500 elements".to_owned());
    }
    if !arr.is_some_and(|a| !a.is_empty()) {
        e.push("user_ids should not be empty".to_owned());
    }
    if arr.is_none() {
        e.push("user_ids must be an array".to_owned());
    }
    if !e.is_empty() {
        return Err(HttpError::validation(e).into());
    }
    let mut user_ids = Vec::new();
    for x in arr.map_or(&[][..], |a| a.as_slice()) {
        user_ids.push(int4(x)?);
    }
    Ok(TeamMembers { user_ids })
}

const JOB_TITLE_UPDATE_KEYS: [&str; 9] = [
    "category",
    "name",
    "symbol",
    "base_salary",
    "standard_target",
    "default_insurance_salary",
    "review_cycle_months",
    "is_active",
    "sort_order",
];

/// `UpdateJobTitleDto`: whitelist (không có `rank_code`) rồi `UpdateJobTitle::validate`.
fn parse_update_job_title(body: &Value) -> Result<UpdateJobTitle, AppError> {
    let m = obj(body);
    let e = unknown_props(&m, &JOB_TITLE_UPDATE_KEYS);
    if !e.is_empty() {
        return Err(HttpError::validation(e).into());
    }
    let dto: UpdateJobTitle = serde_json::from_value(Value::Object(m)).map_err(AppError::internal)?;
    dto.validate().map_err(AppError::from)?;
    Ok(dto)
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
}

// ───────────────────────────── team ─────────────────────────────

async fn team_for_filter(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    let q = query_to_json(uri.query().unwrap_or(""));
    let include = q.get("include_unled").and_then(Value::as_str) == Some("true");
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::list_for_filter(&mut conn, include).await
    }
    .await;
    ok(r)
}

async fn team_lead_filter(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::list_team_lead_filter(&mut conn).await
    }
    .await;
    ok(r)
}

async fn team_list(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::find_all(&mut conn).await
    }
    .await;
    ok(r)
}

async fn team_create(State(c): S, Extension(u): U, JsonBody(body): JsonBody) -> Response {
    let a = act!(u);
    let dto = match parse_create_team(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::create(&mut conn, &dto).await
    }
    .await;
    ok(r)
}

async fn team_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "team") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let dto = match parse_update_team(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::update(&mut conn, id, &dto).await
    }
    .await;
    ok(r)
}

async fn team_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "team") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::remove(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn team_members(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "team") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::list_members(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn team_add_members(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "team") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let dto = match parse_members(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::add_members(&mut conn, id, &dto.user_ids).await
    }
    .await;
    ok(r)
}

async fn team_remove_member(State(c): S, Extension(u): U, Path((id, user_id)): Path<(String, String)>) -> Response {
    let a = act!(u);
    let (id, user_id) = match (id_of(&id, "team"), id_of(&user_id, "nhân viên")) {
        (Ok(i), Ok(j)) => (i, j),
        (Err(e), _) | (_, Err(e)) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        teams::remove_member(&mut conn, id, user_id).await
    }
    .await;
    ok(r)
}

/// Router của team (state `Arc<Ctx>`).
pub fn team_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = team_specs();
    ApiRouter::new(deps)
        .route(
            pick(&s, &Method::GET, "/api/v1/management/teams/for-filter"),
            team_for_filter,
        )
        .route(
            pick(&s, &Method::GET, "/api/v1/management/teams/lead-filter"),
            team_lead_filter,
        )
        .route(pick(&s, &Method::GET, TEAMS), team_list)
        .route(pick(&s, &Method::POST, TEAMS), team_create)
        .route(pick(&s, &Method::PATCH, "/api/v1/management/teams/:id"), team_update)
        .route(pick(&s, &Method::DELETE, "/api/v1/management/teams/:id"), team_remove)
        .route(
            pick(&s, &Method::GET, "/api/v1/management/teams/:id/members"),
            team_members,
        )
        .route(
            pick(&s, &Method::POST, "/api/v1/management/teams/:id/members"),
            team_add_members,
        )
        .route(
            pick(&s, &Method::DELETE, "/api/v1/management/teams/:id/members/:userId"),
            team_remove_member,
        )
}

// ───────────────────────────── chức danh ─────────────────────────────

/// `canSeeSalary`: quản trị, hoặc có `org.manage`/`payroll.view`/`payroll.manage`.
fn can_see_salary(a: &Actor) -> bool {
    a.is_admin
        || ["org.manage", "payroll.view", "payroll.manage"]
            .iter()
            .any(|p| trinity_rbac::can(&a.grants, p, None))
}

/// Dòng trả về; người không được xem lương thì ba cột lương thành `null` (`redactSalary`).
fn present(row: &JobTitleRow, see_salary: bool) -> Result<Value, AppError> {
    let mut v = serde_json::to_value(row).map_err(AppError::internal)?;
    if !see_salary && let Some(o) = v.as_object_mut() {
        for k in ["base_salary", "standard_target", "default_insurance_salary"] {
            o.insert(k.to_owned(), Value::Null);
        }
    }
    Ok(v)
}

async fn jt_list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<QueryJobTitles>) -> Response {
    let a = act!(u);
    let see = can_see_salary(&a);
    let r: Result<Value, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        let rows = job_titles::find_all(&mut conn, &q).await?;
        let out: Result<Vec<Value>, AppError> = rows.iter().map(|x| present(x, see)).collect();
        Ok(Value::Array(out?))
    }
    .await;
    ok(r)
}

async fn jt_get(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    let see = can_see_salary(&a);
    let id = match id_of(&id, "chức danh") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r: Result<Value, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        let row = job_titles::find_one(&mut conn, id).await?;
        present(&row, see)
    }
    .await;
    ok(r)
}

async fn jt_create(State(c): S, Extension(u): U, ValidJson(dto): ValidJson<CreateJobTitle>) -> Response {
    let a = act!(u);
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        job_titles::create(&mut conn, &dto).await
    }
    .await;
    ok(r)
}

async fn jt_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "chức danh") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let dto = match parse_update_job_title(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        job_titles::update(&mut conn, id, &dto).await
    }
    .await;
    ok(r)
}

async fn jt_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "chức danh") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        job_titles::remove(&mut conn, id).await
    }
    .await;
    ok(r)
}

/// Router của chức danh (state `Arc<Ctx>`).
pub fn job_title_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = job_title_specs();
    ApiRouter::new(deps)
        .route(pick(&s, &Method::GET, JOB_TITLES), jt_list)
        .route(pick(&s, &Method::POST, JOB_TITLES), jt_create)
        .route(pick(&s, &Method::GET, "/api/v1/management/job-titles/:id"), jt_get)
        .route(pick(&s, &Method::PATCH, "/api/v1/management/job-titles/:id"), jt_update)
        .route(
            pick(&s, &Method::DELETE, "/api/v1/management/job-titles/:id"),
            jt_remove,
        )
}

// ───────────────────────────── tuyển dụng ─────────────────────────────

fn q_of(uri: &Uri, dto: &str) -> Result<Map<String, Value>, AppError> {
    rc::validate(dto, &query_to_json(uri.query().unwrap_or("")))
}

async fn rc_stats(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    let q = match q_of(&uri, "QueryRecruitmentStatsDto") {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::stats(&mut conn, &q).await
    }
    .await;
    ok(r)
}

async fn rc_candidates(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    let q = match q_of(&uri, "QueryCandidatesDto") {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::list_candidates(&mut conn, &q).await
    }
    .await;
    ok(r)
}

async fn rc_candidate_create(State(c): S, Extension(u): U, JsonBody(body): JsonBody) -> Response {
    let a = act!(u);
    let dto = match rc::validate("CreateCandidateDto", &body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::create_candidate(&mut conn, &dto, a.user_id).await
    }
    .await;
    ok(r)
}

async fn rc_candidate_update(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "ứng viên") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let dto = match rc::validate("UpdateCandidateDto", &body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::update_candidate(&mut conn, id, &dto).await
    }
    .await;
    ok(r)
}

async fn rc_candidate_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "ứng viên") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::remove_candidate(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn rc_recruiters(State(c): S, Extension(u): U) -> Response {
    let a = act!(u);
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::list_recruiters(&mut conn).await
    }
    .await;
    ok(r)
}

async fn rc_positions(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let a = act!(u);
    let q = match q_of(&uri, "QueryPositionsDto") {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::list_positions(&mut conn, &q).await
    }
    .await;
    ok(r)
}

async fn rc_position_create(State(c): S, Extension(u): U, JsonBody(body): JsonBody) -> Response {
    let a = act!(u);
    let dto = match rc::validate("CreatePositionDto", &body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::create_position(&mut conn, &dto, a.user_id).await
    }
    .await;
    ok(r)
}

async fn rc_position_update(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "vị trí tuyển dụng") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let dto = match rc::validate("UpdatePositionDto", &body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::update_position(&mut conn, id, &dto).await
    }
    .await;
    ok(r)
}

async fn rc_position_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let a = act!(u);
    let id = match id_of(&id, "vị trí tuyển dụng") {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r: Result<_, AppError> = async {
        let mut conn = c.conn(a.company).await?;
        rc::remove_position(&mut conn, id).await
    }
    .await;
    ok(r)
}

/// Router của tuyển dụng (state `Arc<Ctx>`).
pub fn recruitment_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    const R: &str = "/api/v1/management/recruitment";
    let s = recruitment_specs();
    let p = |suffix: &str| format!("{R}{suffix}");
    ApiRouter::new(deps)
        .route(pick(&s, &Method::GET, &p("/stats")), rc_stats)
        .route(pick(&s, &Method::GET, &p("/candidates")), rc_candidates)
        .route(pick(&s, &Method::POST, &p("/candidates")), rc_candidate_create)
        .route(pick(&s, &Method::PATCH, &p("/candidates/:id")), rc_candidate_update)
        .route(pick(&s, &Method::DELETE, &p("/candidates/:id")), rc_candidate_remove)
        .route(pick(&s, &Method::GET, &p("/recruiters")), rc_recruiters)
        .route(pick(&s, &Method::GET, &p("/positions")), rc_positions)
        .route(pick(&s, &Method::POST, &p("/positions")), rc_position_create)
        .route(pick(&s, &Method::PATCH, &p("/positions/:id")), rc_position_update)
        .route(pick(&s, &Method::DELETE, &p("/positions/:id")), rc_position_remove)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn team_khop_routes_json() {
        let table = team_specs();
        assert_eq!(table.len(), 9);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 9);
    }

    #[test]
    fn chuc_danh_khop_routes_json() {
        let table = job_title_specs();
        assert_eq!(table.len(), 5);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 5);
    }

    fn msgs(r: Result<impl std::fmt::Debug, AppError>) -> Vec<String> {
        match r {
            Err(AppError::Http(h)) => match h.body().message {
                trinity_kernel::error::Message::Many(m) => m,
                trinity_kernel::error::Message::One(m) => vec![m],
            },
            other => panic!("cần lỗi 400, được {other:?}"),
        }
    }

    #[test]
    fn tao_team_hop_le_va_chuan_hoa_so_thuc() {
        let t = parse_create_team(&json!({"name": "A", "team_lead_id": 3.0, "color": "#FFF"})).unwrap();
        assert_eq!(t.name, "A");
        assert_eq!(t.team_lead_id, Some(3));
    }

    #[test]
    fn tao_team_loi_theo_thu_tu_class_validator() {
        let m = msgs(parse_create_team(
            &json!({"zzz": 1, "color": "red", "team_lead_id": "x"}),
        ));
        assert_eq!(m[0], "property zzz should not exist");
        let at = |s: &str| {
            m.iter()
                .position(|x| x == s)
                .unwrap_or_else(|| panic!("thiếu {s}: {m:?}"))
        };
        assert!(at("name must be a string") < at("team_lead_id must be an integer number"));
        assert!(at("team_lead_id must be an integer number") < at(COLOR_MSG));
    }

    #[test]
    fn team_lead_ngoai_int4_la_400_tron() {
        let r = parse_update_team(&json!({"team_lead_id": 3_000_000_000_i64}));
        assert!(matches!(r, Err(AppError::Http(_))));
    }

    #[test]
    fn sua_team_cho_phep_null_de_xoa() {
        let t = parse_update_team(&json!({"department": null, "color": null, "team_lead_id": null})).unwrap();
        assert_eq!(t.department, Some(None));
        assert_eq!(t.team_lead_id, Some(None));
        assert_eq!(t.color, Some(None));
        assert_eq!(t.name, None);
    }

    #[test]
    fn thanh_vien_kiem_dung_cau() {
        let m = msgs(parse_members(&json!({})));
        assert_eq!(
            m,
            [
                "each value in user_ids must be an integer number",
                "user_ids must contain no more than 500 elements",
                "user_ids should not be empty",
                "user_ids must be an array",
            ]
        );
        assert_eq!(parse_members(&json!({"user_ids": [1, 2.0]})).unwrap().user_ids, [1, 2]);
        assert!(parse_members(&json!({"user_ids": [1.5]})).is_err());
    }

    #[test]
    fn sua_chuc_danh_chan_rank_code_va_null_cot_not_null() {
        let m = msgs(parse_update_job_title(&json!({"rank_code": "X1"})));
        assert_eq!(m, ["property rank_code should not exist"]);
        assert!(parse_update_job_title(&json!({"name": null})).is_err());
        assert!(parse_update_job_title(&json!({"default_insurance_salary": null})).is_ok());
    }

    #[test]
    fn id_ngoai_int4_la_404() {
        assert!(matches!(id_of("99999999999", "team"), Err(AppError::Http(_))));
        assert_eq!(id_of("7", "team").unwrap(), 7);
    }
}
