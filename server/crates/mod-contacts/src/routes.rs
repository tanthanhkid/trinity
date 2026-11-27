//! Bảng route và handler của khách hàng (M07, K14): 14 route `/api/v1/contacts`, quyền và mã thành công khớp
//! `contracts/routes.json`. Route `GET /contacts/:contactId/activities` thuộc module hoạt động, không khai ở đây.
//!
//! Dữ liệu vào: query của danh sách/xuất và body tạo/sửa đi qua metadata THẬT của class-validator (`ValidQuery`/`ValidJson`
//! đọc `contracts/dto/schema.json`); body chuyển quyền phụ trách chưa có trong `schema.json` nên kiểm tay đúng thứ tự câu
//! lỗi của class-validator (whitelist trước, rồi từng thuộc tính theo thứ tự khai, decorator khai sau chạy trước).
//!
//! Việc phụ thuộc module khác đi qua [`Hooks`] (tầng `serve` cài, mặc định [`NoHooks`] không làm gì): dọn bản ghi mẫu
//! (`SampleRecordsService.purgeIfReal`) và xoá cache Tổng quan sau khi tạo/xoá/khôi phục khách, đồng bộ thẻ @ của
//! `reminder_notes` (`RecordLinksService.syncMentions`) và đẩy socket nội bộ cho thông báo giao thương vụ. Mọi hook chạy
//! SAU khi việc chính đã commit và không bao giờ làm hỏng nó.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use trinity_db::outbox::CreatedNotification;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;

use crate::list::{CountCache, ListQuery};
use crate::write::{CreateContact, UpdateContact};
use crate::{Actor, Scopes, export, list, read, recent, transfer, write};

const BASE: &str = "/api/v1/contacts";
const ID: &[&str] = &["param.id:ParseIntPipe"];
const VIEW: Access = Access::Can(&["contacts.view"]);
const CREATE: Access = Access::Can(&["contacts.create"]);
const UPDATE: Access = Access::Can(&["contacts.update"]);
const DELETE: Access = Access::Can(&["contacts.delete"]);
const TRANSFER: Access = Access::Can(&["contacts.transfer"]);
const EXPORT: Access = Access::Can(&["contacts.export"]);

/// Future của một hook (không trả gì: lỗi của hook tự ghi log).
pub type HookFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// Việc phụ sau khi ghi khách thành công, do module khác sở hữu. Gọi SAU commit; không được làm hỏng việc chính.
pub trait Hooks: Send + Sync {
    /// Sau `POST /contacts`: xoá cache Tổng quan, dọn bản ghi mẫu khi đã có khách thật, đẩy socket cho `notifications`
    /// (thông báo "được giao thương vụ" đã ghi trong giao dịch tạo khách).
    fn after_create<'a>(&'a self, company: CompanyRef, notifications: &'a [CreatedNotification]) -> HookFuture<'a>;

    /// Sau xoá hoặc khôi phục khách: xoá cache Tổng quan.
    fn after_remove_or_restore(&self, company: CompanyRef) -> HookFuture<'_>;

    /// Sau `PATCH /contacts/:id` có gửi `reminder_notes` (`Some(None)` = `null`): đồng bộ thẻ @ trong ghi chú nhắc việc.
    fn after_update_notes<'a>(
        &'a self,
        company: CompanyRef,
        user: &'a CurrentUser,
        contact_id: i32,
        reminder_notes: Option<&'a str>,
    ) -> HookFuture<'a>;
}

/// Không làm gì (test, môi trường chưa nối module phụ).
pub struct NoHooks;

impl Hooks for NoHooks {
    fn after_create<'a>(&'a self, _company: CompanyRef, _notifications: &'a [CreatedNotification]) -> HookFuture<'a> {
        Box::pin(async {})
    }

    fn after_remove_or_restore(&self, _company: CompanyRef) -> HookFuture<'_> {
        Box::pin(async {})
    }

    fn after_update_notes<'a>(
        &'a self,
        _company: CompanyRef,
        _user: &'a CurrentUser,
        _contact_id: i32,
        _reminder_notes: Option<&'a str>,
    ) -> HookFuture<'a> {
        Box::pin(async {})
    }
}

/// Trạng thái dùng chung của router khách hàng.
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
    /// Cache đếm tổng của danh sách (xoá sau khi tạo, xoá, khôi phục).
    pub cache: CountCache,
    /// Việc phụ sau khi ghi (module khác); `Arc::new(NoHooks)` khi không có.
    pub hooks: Arc<dyn Hooks>,
}

/// 14 route của `ContactsController` (bảng so với `routes.json` bởi `trinity check-routes`).
pub fn specs() -> Vec<RouteSpec> {
    let by_id = |m: Method, suffix: &'static str, a: Access, code: u16| {
        RouteSpec::new(m, suffix, a).status_ok(code).param_pipes(ID)
    };
    vec![
        RouteSpec::new(Method::GET, BASE, VIEW).status_ok(200),
        RouteSpec::new(Method::POST, BASE, CREATE).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/contacts/export", EXPORT),
        RouteSpec::new(Method::GET, "/api/v1/contacts/search", CREATE).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/contacts/assignable-users", VIEW).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/contacts/assignable-sales", TRANSFER).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/contacts/bulk-transfer", TRANSFER).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/contacts/recent", VIEW).status_ok(200),
        by_id(Method::POST, "/api/v1/contacts/:id/transfer", TRANSFER, 201),
        by_id(Method::POST, "/api/v1/contacts/:id/viewed", VIEW, 201),
        by_id(Method::POST, "/api/v1/contacts/:id/restore", DELETE, 201),
        by_id(Method::GET, "/api/v1/contacts/:id", VIEW, 200),
        by_id(Method::PATCH, "/api/v1/contacts/:id", UPDATE, 200),
        by_id(Method::DELETE, "/api/v1/contacts/:id", DELETE, 200),
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

/// Người gọi đã dựng xong: công ty (token sai ⇒ 401, không rơi về công ty mặc định), người thực hiện và phạm vi.
struct Req {
    company: CompanyRef,
    actor: Actor,
    scopes: Scopes,
}

async fn prepare(c: &Ctx, u: &CurrentUser) -> Result<Req, Response> {
    let Ok(company) = CompanyRef::new(i64::from(u.user.company_id)) else {
        return Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")));
    };
    let scopes = Scopes::resolve(&c.scopes, company, u.user.user_id, &u.grants.grants)
        .await
        .map_err(fail)?;
    Ok(Req {
        company,
        actor: Actor {
            user_id: u.user.user_id,
            is_admin: u.grants.is_admin,
            email: Some(u.user.email.clone()).filter(|e| !e.is_empty()),
        },
        scopes,
    })
}

/// `prepare(&c, &u)` hoặc trả ngay phản hồi lỗi.
macro_rules! prep {
    ($c:expr, $u:expr) => {
        match prepare(&$c, &$u).await {
            Ok(r) => r,
            Err(resp) => return resp,
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
        .map_err(|_| HttpError::not_found("Không tìm thấy khách hàng").into())
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

/// `QueryContactDto` (cũng dùng cho xuất Excel).
#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct QueryContactDto(ListQuery);

impl Dto for QueryContactDto {
    const NAME: &'static str = "QueryContactDto";
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct CreateContactDto(CreateContact);

impl Dto for CreateContactDto {
    const NAME: &'static str = "CreateContactDto";
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct UpdateContactDto(UpdateContact);

impl Dto for UpdateContactDto {
    const NAME: &'static str = "UpdateContactDto";
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

/// `Number.isInteger` trên giá trị JSON.
fn is_int(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n.fract() == 0.0)
}

/// Số nguyên đã qua `IsInt` mà không vừa int4 ⇒ 400 trơn (như `validate_into`).
fn int4(v: &Value) -> Result<i32, AppError> {
    match v.as_f64() {
        Some(n) if n.fract() == 0.0 && n >= f64::from(i32::MIN) && n <= f64::from(i32::MAX) => Ok(n as i32),
        _ => Err(HttpError::nest(400, None).into()),
    }
}

/// Lỗi whitelist của `forbidNonWhitelisted`: chạy trước mọi luật của từng thuộc tính.
fn unknown_props(body: &Value, known: &[&str]) -> Vec<String> {
    body.as_object()
        .map(|o| {
            o.keys()
                .filter(|k| !known.contains(&k.as_str()))
                .map(|k| format!("property {k} should not exist"))
                .collect()
        })
        .unwrap_or_default()
}

/// `new_assigned_to`: `@IsNotEmpty` rồi `@IsInt` (decorator khai sau chạy trước ⇒ câu `IsInt` đứng trước).
fn assignee_errors(v: Option<&Value>, out: &mut Vec<String>) {
    if !v.is_some_and(is_int) {
        out.push("new_assigned_to phải là số nguyên".to_owned());
    }
    if matches!(v, None | Some(Value::Null)) || matches!(v, Some(Value::String(s)) if s.is_empty()) {
        out.push("new_assigned_to không được để trống".to_owned());
    }
}

/// `reason`: `@IsOptional() @IsString()`.
fn reason_errors(v: Option<&Value>, out: &mut Vec<String>) {
    if v.is_some_and(|x| !x.is_null() && !x.is_string()) {
        out.push("reason must be a string".to_owned());
    }
}

fn reason_of(body: &Value) -> String {
    let reason = body.get("reason").and_then(Value::as_str);
    reason.unwrap_or("").to_owned()
}

/// `TransferContactDto`: `(new_assigned_to, reason)`.
fn parse_transfer(body: &Value) -> Result<(i32, String), AppError> {
    let mut errs = unknown_props(body, &["new_assigned_to", "reason"]);
    assignee_errors(body.get("new_assigned_to"), &mut errs);
    reason_errors(body.get("reason"), &mut errs);
    if !errs.is_empty() {
        return Err(HttpError::validation(errs).into());
    }
    let to = int4(body.get("new_assigned_to").unwrap_or(&Value::Null))?;
    Ok((to, reason_of(body)))
}

/// `BulkTransferContactsDto`: `(contact_ids, new_assigned_to, reason)`.
fn parse_bulk(body: &Value) -> Result<(Vec<i32>, i32, String), AppError> {
    let mut errs = unknown_props(body, &["contact_ids", "new_assigned_to", "reason"]);
    let ids = body.get("contact_ids");
    let arr = ids.and_then(Value::as_array);
    // Khai: IsArray, ArrayNotEmpty, ArrayMaxSize, IsInt({ each }) ⇒ chạy ngược lại.
    let int_ok = match (arr, ids) {
        (Some(a), _) => a.iter().all(is_int),
        (None, Some(v)) => is_int(v),
        (None, None) => false,
    };
    if !int_ok {
        errs.push("contact_ids phải là mảng số nguyên".to_owned());
    }
    if !arr.is_some_and(|a| a.len() <= transfer::BULK_TRANSFER_MAX) {
        errs.push(format!(
            "Tối đa {} khách hàng mỗi lần chuyển",
            transfer::BULK_TRANSFER_MAX
        ));
    }
    if !arr.is_some_and(|a| !a.is_empty()) {
        errs.push("contact_ids không được để trống".to_owned());
    }
    if arr.is_none() {
        errs.push("contact_ids must be an array".to_owned());
    }
    assignee_errors(body.get("new_assigned_to"), &mut errs);
    reason_errors(body.get("reason"), &mut errs);
    if !errs.is_empty() {
        return Err(HttpError::validation(errs).into());
    }
    let mut ids = Vec::new();
    for v in arr.map_or(&[][..], |a| a.as_slice()) {
        ids.push(int4(v)?);
    }
    let to = int4(body.get("new_assigned_to").unwrap_or(&Value::Null))?;
    Ok((ids, to, reason_of(body)))
}

async fn list_all(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidQuery(QueryContactDto(q)): ValidQuery<QueryContactDto>,
) -> Response {
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        list::find_all(&mut cn, &r.scopes, &r.actor, &q, &c.cache).await
    }
    .await;
    ok(res)
}

async fn export_xlsx(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidQuery(QueryContactDto(q)): ValidQuery<QueryContactDto>,
) -> Response {
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        export::export_xlsx(&mut cn, &r.scopes, &q.filters).await
    }
    .await;
    match res {
        Ok(bytes) => {
            let name = export::export_filename(Utc::now());
            let len = bytes.len();
            let mut resp = Response::new(Body::from(bytes));
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            );
            if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
                h.insert(header::CONTENT_DISPOSITION, v);
            }
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
            resp
        }
        Err(e) => fail(e),
    }
}

async fn search(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let r = prep!(c, u);
    let term = q.get("q").map_or("", String::as_str);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        read::search(&mut cn, &r.scopes, term).await
    }
    .await;
    ok(res)
}

async fn assignable_users(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        read::assignable_users(&mut cn, &r.scopes).await
    }
    .await;
    ok(res)
}

async fn assignable_sales(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        transfer::assignable_sales(&mut cn, &r.scopes).await
    }
    .await;
    ok(res)
}

async fn bulk_transfer(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let (ids, to, reason) = match parse_bulk(&body) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        transfer::bulk_transfer(&t, &r.scopes, &r.actor, &ids, to, &reason).await
    }
    .await;
    ok(res)
}

async fn transfer_one(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let (to, reason) = match parse_transfer(&body) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        transfer::transfer(&t, &r.scopes, &r.actor, id, to, &reason).await
    }
    .await;
    ok(res)
}

async fn recent_list(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let r = prep!(c, u);
    // `Number(limit)`: không phải số hữu hạn ⇒ bỏ (dùng mặc định).
    let limit = q.get("limit").and_then(|s| js_number(s));
    let limit = limit.map(|n| n as i64);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        recent::list_recent(&mut cn, &r.scopes, &r.actor, limit).await
    }
    .await;
    ok(res)
}

async fn viewed(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        recent::record_view(&mut cn, &r.scopes, &r.actor, id).await?;
        Ok::<_, AppError>(json!({ "success": true }))
    }
    .await;
    ok(res)
}

async fn get_one(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        read::find_by_id(&mut cn, &r.scopes, id).await
    }
    .await;
    ok(res)
}

async fn create(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidJson(CreateContactDto(dto)): ValidJson<CreateContactDto>,
) -> Response {
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        write::create(&t, &r.scopes, &r.actor, &dto).await
    }
    .await;
    if let Ok(created) = &res {
        c.cache.invalidate_with(&c.db, r.company).await;
        c.hooks.after_create(r.company, &created.notifications).await;
    }
    ok(res)
}

async fn update(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    ValidJson(UpdateContactDto(dto)): ValidJson<UpdateContactDto>,
) -> Response {
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        write::update(&t, &r.scopes, &r.actor, id, &dto).await
    }
    .await;
    if res.is_ok()
        && let Some(notes) = &dto.reminder_notes
    {
        c.hooks.after_update_notes(r.company, &u, id, notes.as_deref()).await;
    }
    ok(res)
}

async fn remove(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        write::remove(&t, &r.scopes, &r.actor, id).await
    }
    .await;
    if res.is_ok() {
        c.cache.invalidate_with(&c.db, r.company).await;
        c.hooks.after_remove_or_restore(r.company).await;
    }
    ok(res)
}

async fn restore(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        write::restore(&t, &r.scopes, &r.actor, id).await
    }
    .await;
    if res.is_ok() {
        c.cache.invalidate_with(&c.db, r.company).await;
        c.hooks.after_remove_or_restore(r.company).await;
    }
    ok(res)
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
        .route(spec(&Method::GET, BASE), list_all)
        .route(spec(&Method::POST, BASE), create)
        .route(spec(&Method::GET, "/api/v1/contacts/export"), export_xlsx)
        .route(spec(&Method::GET, "/api/v1/contacts/search"), search)
        .route(
            spec(&Method::GET, "/api/v1/contacts/assignable-users"),
            assignable_users,
        )
        .route(
            spec(&Method::GET, "/api/v1/contacts/assignable-sales"),
            assignable_sales,
        )
        .route(spec(&Method::POST, "/api/v1/contacts/bulk-transfer"), bulk_transfer)
        .route(spec(&Method::GET, "/api/v1/contacts/recent"), recent_list)
        .route(spec(&Method::POST, "/api/v1/contacts/:id/transfer"), transfer_one)
        .route(spec(&Method::POST, "/api/v1/contacts/:id/viewed"), viewed)
        .route(spec(&Method::POST, "/api/v1/contacts/:id/restore"), restore)
        .route(spec(&Method::GET, "/api/v1/contacts/:id"), get_one)
        .route(spec(&Method::PATCH, "/api/v1/contacts/:id"), update)
        .route(spec(&Method::DELETE, "/api/v1/contacts/:id"), remove)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn messages(e: AppError) -> Vec<String> {
        match e {
            AppError::Http(h) => match h.body().message {
                trinity_kernel::error::Message::Many(m) => m,
                trinity_kernel::error::Message::One(m) => vec![m],
            },
            other => vec![other.to_string()],
        }
    }

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 14);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 14);
    }

    #[test]
    fn chuyen_mot_khach_dung_cau_loi_class_validator() {
        assert_eq!(
            parse_transfer(&json!({ "new_assigned_to": 5, "reason": "x" })).unwrap(),
            (5, "x".to_owned())
        );
        let (to, _) = parse_transfer(&json!({ "new_assigned_to": 5.0 })).unwrap();
        assert_eq!(to, 5);
        let e = parse_transfer(&json!({ "la": 1, "reason": 3 })).unwrap_err();
        assert_eq!(
            messages(e),
            [
                "property la should not exist",
                "new_assigned_to phải là số nguyên",
                "new_assigned_to không được để trống",
                "reason must be a string"
            ]
        );
        let e = parse_transfer(&json!({ "new_assigned_to": "5" })).unwrap_err();
        assert_eq!(messages(e), ["new_assigned_to phải là số nguyên"]);
        assert!(parse_transfer(&json!({ "new_assigned_to": 5_000_000_000_i64 })).is_err());
    }

    #[test]
    fn chuyen_hang_loat_dung_cau_loi_class_validator() {
        let (ids, to, reason) = parse_bulk(&json!({ "contact_ids": [1, 2], "new_assigned_to": 9 })).unwrap();
        assert_eq!((ids, to, reason.as_str()), (vec![1, 2], 9, ""));
        let e = parse_bulk(&json!({ "contact_ids": [], "new_assigned_to": 9 })).unwrap_err();
        assert_eq!(messages(e), ["contact_ids không được để trống"]);
        let e = parse_bulk(&json!({})).unwrap_err();
        assert_eq!(
            messages(e),
            [
                "contact_ids phải là mảng số nguyên",
                "Tối đa 500 khách hàng mỗi lần chuyển",
                "contact_ids không được để trống",
                "contact_ids must be an array",
                "new_assigned_to phải là số nguyên",
                "new_assigned_to không được để trống"
            ]
        );
        let e = parse_bulk(&json!({ "contact_ids": [1, "a"], "new_assigned_to": 9 })).unwrap_err();
        assert_eq!(messages(e), ["contact_ids phải là mảng số nguyên"]);
    }

    #[test]
    fn no_hooks_dung_lam_hooks_mac_dinh() {
        let hooks: Arc<dyn Hooks> = Arc::new(NoHooks);
        let company = CompanyRef::new(1).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            hooks.after_create(company, &[]).await;
            hooks.after_remove_or_restore(company).await;
        });
    }

    #[test]
    fn js_number_nhu_javascript() {
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("7"), Some(7.0));
        assert_eq!(js_number("abc"), None);
    }
}
