//! Router axum của payroll (K14): ghép bảng route ([`crate::routes`]) với handler gọi hàm nghiệp vụ của các module con.
//! Thứ tự guard → pipe tham số → handler do `ApiRouter` bảo đảm; mã thành công lấy từ bảng route. Hàm ghi chạy trong một giao
//! dịch (lỗi ⇒ rollback). Route xuất/nhập tệp và PDF thuộc M31 nên chưa có ở đây.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{DefaultBodyLimit, Extension, FromRequest, Multipart, Path, Query, Request, State};
use axum::handler::Handler;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};
use trinity_db::outbox::CreatedNotification;
use trinity_db::{CompanyRef, Db, TenantConn, TenantTx};
use trinity_http::edge::body::read_field_limited;
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, OwnerIds, ScopeService, can};
use trinity_realtime::{NotifSocket, NotificationPayload};

use crate::components::{self, CreateComponent, UpdateComponent};
use crate::employees::{self, CreateEmployee, QueryEmployee, UpdateEmployee};
use crate::insurance::{self, CreateInsurance, UpdateInsurance};
use crate::kpi::{self, CalculateInput, CreateConfig, KpiQuery};
use crate::payslips::files::{self, FileOut, ListExcelInput, MISSING_FILE};
use crate::payslips::{self, AddToPeriodInput, ApproveInput, Approver, GenerateInput, QueryPayslips, UpdatePayslip};
use crate::reports::{self, QueryComparison, QuerySummary};
use crate::rules::{self, CreateRule, UpdateRule};
use crate::tax::{self, CreateBracket, CreateSetting, UpdateBracket, UpdateSetting};

type R<T> = Result<T, AppError>;
type St = State<Arc<Ctx>>;
type Cu = Extension<CurrentUser>;
type Id = Path<String>;
type Q = Query<HashMap<String, String>>;

/// Phụ thuộc của router. `socket` được điền sau khi `/notif-ws` dựng xong (router mount trước socket); chưa có ⇒ không đẩy
/// thông báo tức thời (người nhận vẫn thấy ở lần tải sau và qua `NOTIFY bell`).
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
    pub socket: Arc<OnceLock<NotifSocket>>,
}

impl Ctx {
    async fn conn(&self, company: CompanyRef) -> R<TenantConn> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.acquire().await.map_err(AppError::internal)
    }

    async fn begin(&self, company: CompanyRef) -> R<TenantTx> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.begin().await.map_err(AppError::internal)
    }
}

/// Người gọi.
struct Actor {
    user_id: i32,
    company: CompanyRef,
    grants: Grants,
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn ok<T: Serialize>(r: R<T>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty trong token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
fn actor(u: &CurrentUser) -> Result<Actor, Response> {
    match CompanyRef::new(i64::from(u.user.company_id)) {
        Ok(company) => Ok(Actor {
            user_id: u.user.user_id,
            company,
            grants: u.grants.grants.clone(),
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

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào.
fn id_of(raw: &str) -> Result<i32, HttpError> {
    raw.parse::<i32>().map_err(|_| HttpError::not_found("Không tìm thấy"))
}

macro_rules! pid {
    ($raw:expr) => {
        match id_of(&$raw) {
            Ok(i) => i,
            Err(e) => return fail(e),
        }
    };
}

/// Body ⇒ DTO ⇒ `validate()`; sai kiểu hoặc thiếu trường ⇒ 400.
macro_rules! input {
    ($ty:ty, $body:expr) => {
        match serde_json::from_value::<$ty>($body)
            .map_err(|e| HttpError::bad_request(e.to_string()))
            .and_then(|d| d.validate().map(|()| d))
        {
            Ok(d) => d,
            Err(e) => return fail(e),
        }
    };
}

/// Đọc trên một kết nối công ty.
macro_rules! on_conn {
    ($c:expr, $a:expr, $conn:ident => $body:expr) => {
        match $c.conn($a.company).await {
            Ok(mut $conn) => $body,
            Err(e) => Err(e),
        }
    };
}

/// Ghi trong một giao dịch: `Ok` ⇒ commit, `Err` ⇒ bỏ giao dịch (rollback).
macro_rules! in_tx {
    ($c:expr, $a:expr, $tx:ident => $body:expr) => {
        match $c.begin($a.company).await {
            Ok(mut $tx) => match $body {
                Ok(v) => match $tx.commit().await {
                    Ok(()) => Ok(v),
                    Err(e) => Err(AppError::internal(e)),
                },
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        }
    };
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

/// Phạm vi chủ phiếu/hồ sơ cho một quyền: `OwnerIds` của `trinity-rbac` ⇒ `Option<Vec<i32>>` (`None` = tất cả). Không giữ
/// quyền (guard đã chặn trước) ⇒ rỗng. Gọi TRƯỚC khi mượn kết nối để không giữ hai kết nối cùng lúc.
async fn scope_of(c: &Ctx, a: &Actor, permission: &str) -> R<Option<Vec<i32>>> {
    let owners = c
        .scopes
        .owner_ids(a.company, a.user_id, &a.grants, permission)
        .await
        .map_err(AppError::internal)?;
    Ok(match owners {
        Some(OwnerIds::All) => None,
        Some(OwnerIds::Ids(ids)) => Some(ids),
        None => Some(Vec::new()),
    })
}

macro_rules! scope {
    ($c:expr, $a:expr, $perm:expr) => {
        match scope_of(&$c, &$a, $perm).await {
            Ok(s) => s,
            Err(e) => return fail(e),
        }
    };
}

/// Số nguyên trong query (`team_id`, `employee_id`): không phải số ⇒ ghi lỗi.
fn qint(q: &HashMap<String, String>, key: &str, errs: &mut Vec<String>) -> Option<i64> {
    let raw = q.get(key)?;
    match raw.trim().parse::<i64>() {
        Ok(n) => Some(n),
        Err(_) => {
            errs.push(format!("{key} must be an integer number"));
            None
        }
    }
}

fn qstr(q: &HashMap<String, String>, key: &str) -> Option<String> {
    q.get(key).cloned()
}

macro_rules! no_errs {
    ($errs:expr) => {
        if !$errs.is_empty() {
            return fail(HttpError::validation($errs));
        }
    };
}

// ---------------------------------------------------------------- cấu hình lương

async fn component_list(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let kind = qstr(&q, "component_type");
    ok(on_conn!(c, a, conn => components::find_all(&mut conn, kind.as_deref()).await))
}

async fn component_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateComponent, b);
    ok(in_tx!(c, a, tx => components::create(&mut tx, &input, Some(a.user_id)).await))
}

async fn component_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdateComponent, b);
    ok(in_tx!(c, a, tx => components::update(&mut tx, id, &input).await))
}

async fn component_remove(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    ok(in_tx!(c, a, tx => components::remove(&mut tx, id).await))
}

async fn insurance_list(State(c): St, Extension(u): Cu) -> Response {
    let a = act!(u);
    ok(on_conn!(c, a, conn => insurance::find_all(&mut conn).await))
}

async fn insurance_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateInsurance, b);
    ok(in_tx!(c, a, tx => insurance::create(&mut tx, &input, Some(a.user_id)).await))
}

async fn insurance_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdateInsurance, b);
    ok(in_tx!(c, a, tx => insurance::update(&mut tx, id, &input).await))
}

async fn insurance_remove(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    ok(in_tx!(c, a, tx => insurance::remove(&mut tx, id).await))
}

async fn tax_get(State(c): St, Extension(u): Cu) -> Response {
    let a = act!(u);
    ok(on_conn!(c, a, conn => tax::get_config(&mut conn).await))
}

async fn bracket_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateBracket, b);
    ok(in_tx!(c, a, tx => tax::create_bracket(&mut tx, &input, Some(a.user_id)).await))
}

async fn bracket_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdateBracket, b);
    ok(in_tx!(c, a, tx => tax::update_bracket(&mut tx, id, &input).await))
}

async fn bracket_remove(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    ok(in_tx!(c, a, tx => tax::remove_bracket(&mut tx, id).await))
}

async fn setting_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateSetting, b);
    ok(in_tx!(c, a, tx => tax::create_setting(&mut tx, &input, Some(a.user_id)).await))
}

async fn setting_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdateSetting, b);
    ok(in_tx!(c, a, tx => tax::update_setting(&mut tx, id, &input).await))
}

async fn rule_list(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let position = qstr(&q, "position");
    ok(on_conn!(c, a, conn => rules::find_all(&mut conn, position.as_deref()).await))
}

async fn rule_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateRule, b);
    ok(in_tx!(c, a, tx => rules::create(&mut tx, &input).await))
}

async fn rule_get(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    ok(on_conn!(c, a, conn => rules::find_by_id(&mut conn, id).await))
}

async fn rule_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdateRule, b);
    ok(in_tx!(c, a, tx => rules::update(&mut tx, id, &input).await))
}

// ---------------------------------------------------------------- KPI

async fn kpi_configs(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let role = qstr(&q, "role");
    ok(on_conn!(c, a, conn => kpi::get_configs(&mut conn, role.as_deref()).await))
}

async fn kpi_config_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateConfig, b);
    ok(in_tx!(c, a, tx => kpi::create_config(&mut tx, &input).await))
}

async fn kpi_calculate(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CalculateInput, b);
    let ids = input.employee_ids.as_deref();
    // Chưa có nguồn số liệu KPI (bộ gom thật thuộc module nguồn): hàm trả 501 như bản đã khai.
    ok(in_tx!(c, a, tx => kpi::calculate(&mut tx, &input.month, ids, None).await))
}

async fn kpi_close_month(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CalculateInput, b);
    ok(in_tx!(c, a, tx => kpi::close_month(&mut tx, &input.month).await))
}

/// `GET /kpi`: chỉ KPI của hồ sơ nhân viên của chính người gọi.
async fn kpi_mine(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let mut errs = Vec::new();
    let employee_id = qint(&q, "employee_id", &mut errs);
    let team_id = qint(&q, "team_id", &mut errs);
    if employee_id.is_none() && errs.is_empty() {
        errs.push("employee_id must be an integer number".to_owned());
    }
    no_errs!(errs);
    let query = KpiQuery {
        employee_id: employee_id.unwrap_or(0),
        month: qstr(&q, "month").unwrap_or_default(),
        team_id,
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    let Ok(employee_id) = i32::try_from(query.employee_id) else {
        return fail(HttpError::not_found("Không tìm thấy"));
    };
    ok(on_conn!(c, a, conn => kpi::get_mine(&mut conn, a.user_id, employee_id, &query.month).await))
}

// ---------------------------------------------------------------- phiếu lương

async fn payslip_mine(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let month = qstr(&q, "month");
    ok(on_conn!(c, a, conn => payslips::find_mine(&mut conn, a.user_id, month.as_deref()).await))
}

async fn payslip_list(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let mut errs = Vec::new();
    let team_id = qint(&q, "team_id", &mut errs);
    no_errs!(errs);
    let query = QueryPayslips {
        month: qstr(&q, "month").unwrap_or_default(),
        team_id,
        status: qstr(&q, "status"),
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    let scope = scope!(c, a, "payroll.view");
    ok(on_conn!(c, a, conn => payslips::find_all(&mut conn, &query, scope.as_deref()).await))
}

async fn payslip_addable(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let query = payslips::MonthQuery {
        month: qstr(&q, "month").unwrap_or_default(),
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    ok(on_conn!(c, a, conn => payslips::list_addable(&mut conn, &query.month).await))
}

async fn payslip_get(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let scope = scope!(c, a, "payroll.view");
    ok(on_conn!(c, a, conn => payslips::find_by_id(&mut conn, id, scope.as_deref()).await))
}

async fn payslip_generate(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(GenerateInput, b);
    ok(in_tx!(c, a, tx => payslips::generate(&mut tx, &input).await))
}

async fn payslip_add(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(AddToPeriodInput, b);
    let scope = scope!(c, a, "payroll.view");
    ok(in_tx!(c, a, tx => payslips::add_to_period(&mut tx, &input, scope.as_deref()).await))
}

async fn payslip_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdatePayslip, b);
    let scope = scope!(c, a, "payroll.view");
    ok(in_tx!(c, a, tx => payslips::update(&mut tx, id, &input, scope.as_deref()).await))
}

async fn payslip_remove(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let can_final = can(&a.grants, "payroll.approve_final", None);
    ok(in_tx!(c, a, tx => payslips::remove_from_period(&mut tx, id, a.user_id, can_final).await))
}

/// `PATCH /payslips/:id/approve`: commit xong mới đẩy socket nội bộ từ `Approved::notifications` (tiến trình khác nhận qua
/// `NOTIFY bell`); lỗi tạo thông báo chỉ ghi log, không làm hỏng việc duyệt.
async fn payslip_approve(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(ApproveInput, b);
    let can_team = can(&a.grants, "payroll.approve_team", None);
    let team_scope = if can_team {
        scope!(c, a, "payroll.approve_team")
    } else {
        None
    };
    let who = Approver {
        user_id: a.user_id,
        can_team,
        can_final: can(&a.grants, "payroll.approve_final", None),
        team_scope,
    };
    let mut tx = match c.begin(a.company).await {
        Ok(tx) => tx,
        Err(e) => return fail(e),
    };
    let out = match payslips::approve(&mut tx, id, &input, &who).await {
        Ok(out) => out,
        Err(e) => return fail(e),
    };
    if let Err(e) = tx.commit().await {
        return fail(AppError::internal(e));
    }
    if let Some(e) = &out.notify_error {
        tracing::error!(payslip = id, error = %e, "tạo thông báo phiếu lương đã duyệt lỗi");
    }
    push_notifications(&c, a.company, &out.notifications).await;
    Json(out).into_response()
}

/// Đẩy `notification:new` + số chưa đọc tới socket của tiến trình này (K33). Lỗi chỉ ghi log.
async fn push_notifications(c: &Ctx, company: CompanyRef, items: &[CreatedNotification]) {
    let Some(socket) = c.socket.get() else {
        return;
    };
    if items.is_empty() {
        return;
    }
    let ids: Vec<i32> = items.iter().map(|n| n.id).collect();
    let rows: Vec<(i32, String)> = {
        let mut conn = match c.conn(company).await {
            Ok(conn) => conn,
            Err(e) => {
                tracing::warn!(error = ?e, "đọc thời điểm thông báo lỗi");
                return;
            }
        };
        let loaded = sqlx::query_as::<_, (i32, String)>(
            "SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
             FROM notification_logs WHERE id = ANY($1)",
        )
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await;
        match loaded {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(error = %e, "đọc thời điểm thông báo lỗi");
                Vec::new()
            }
        }
    };
    for n in items {
        let created_at = rows
            .iter()
            .find(|r| r.0 == n.id)
            .map(|r| r.1.clone())
            .unwrap_or_default();
        let payload = NotificationPayload {
            id: Some(n.id),
            title: n.title.clone(),
            body: n.body.clone(),
            channel: "in_app".to_owned(),
            event_type: Some(n.event_type.clone()),
            action_url: n.action_url.clone(),
            is_read: false,
            created_at,
        };
        socket
            .push_local(&c.db, i64::from(company.id()), i64::from(n.recipient_id), &payload)
            .await;
    }
}

// ---------------------------------------------------------------- tệp phiếu lương (M31)

/// Tệp tải về như `res.set({...}); res.end(buffer)` của bản TS: kiểu nội dung và `attachment; filename="…"` (tên tệp chỉ gồm
/// chữ số, chữ Latinh và `-`).
fn file(r: R<FileOut>) -> Response {
    let f = match r {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let mut resp = Response::new(Body::from(f.bytes));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(f.content_type));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", f.filename)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    resp
}

/// `BulkExcelPayslipsDto` ở query: `month` `YYYY-MM`.
fn month_query(q: &HashMap<String, String>) -> Result<String, Response> {
    let query = payslips::MonthQuery {
        month: qstr(q, "month").unwrap_or_default(),
    };
    query.validate().map(|()| query.month).map_err(fail)
}

macro_rules! month {
    ($q:expr) => {
        match month_query(&$q) {
            Ok(m) => m,
            Err(r) => return r,
        }
    };
}

async fn slip_excel(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let scope = scope!(c, a, "payroll.export");
    file(on_conn!(c, a, conn => files::export_excel(&mut conn, id, scope.as_deref()).await))
}

async fn slip_pdf(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let scope = scope!(c, a, "payroll.export");
    file(on_conn!(c, a, conn => files::export_pdf(&mut conn, id, scope.as_deref()).await))
}

async fn slip_excel_bulk(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let month = month!(q);
    let scope = scope!(c, a, "payroll.export");
    file(on_conn!(c, a, conn => files::export_bulk(&mut conn, &month, scope.as_deref()).await))
}

async fn slip_excel_list(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let month = month!(q);
    let scope = scope!(c, a, "payroll.export");
    file(on_conn!(c, a, conn => files::export_list(&mut conn, &month, scope.as_deref(), None).await))
}

async fn slip_excel_list_ordered(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(ListExcelInput, b);
    let ids = input.ids();
    let scope = scope!(c, a, "payroll.export");
    file(on_conn!(c, a, conn => {
        files::export_list(&mut conn, &input.month, scope.as_deref(), ids.as_deref()).await
    }))
}

async fn slip_import_template(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let month = month!(q);
    file(on_conn!(c, a, conn => files::import_template(&mut conn, &month).await))
}

/// Trần tệp nhập: bản TS không đặt `limits.fileSize` cho `FileInterceptor('file')`; Rust chặn ở 20 MB (mẫu có ~20 cột × vài
/// nghìn dòng chỉ vài trăm KB) để tệp lớn bất thường không làm đầy bộ nhớ.
const IMPORT_MAX_BYTES: usize = 20 * 1024 * 1024;

/// Đọc multipart như `FileInterceptor('file')`: trường tệp duy nhất tên `file` (tệp khác tên hoặc trùng ⇒ 400 `Unexpected
/// field`), vượt trần ⇒ 413 `File too large`. Trường chữ bị bỏ qua. Không có tệp ⇒ `None`.
async fn read_file(mut mp: Multipart) -> R<Option<Bytes>> {
    let mut file = None;
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        if f.file_name().is_none() {
            read_field_limited(&mut f, 1024 * 1024).await?;
            continue;
        }
        if f.name() != Some("file") || file.is_some() {
            return Err(HttpError::bad_request("Unexpected field").into());
        }
        file = Some(read_field_limited(&mut f, IMPORT_MAX_BYTES).await?);
    }
    Ok(file)
}

/// Thứ tự như bản TS: lỗi multipart → kiểm query (`BulkExcelPayslipsDto`) → thiếu tệp (400 `Thiếu file upload`).
async fn upload(q: &HashMap<String, String>, mp: Multipart) -> Result<(String, Bytes), Response> {
    let file = read_file(mp).await.map_err(fail)?;
    let month = month_query(q)?;
    match file {
        Some(bytes) => Ok((month, bytes)),
        None => Err(fail(HttpError::bad_request(MISSING_FILE))),
    }
}

async fn slip_import_preview(State(c): St, Extension(u): Cu, Query(q): Q, mp: Multipart) -> Response {
    let a = act!(u);
    let (month, bytes) = match upload(&q, mp).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ok(on_conn!(c, a, conn => files::preview_import(&mut conn, &bytes, &month).await))
}

async fn slip_import_apply(State(c): St, Extension(u): Cu, Query(q): Q, mp: Multipart) -> Response {
    let a = act!(u);
    let (month, bytes) = match upload(&q, mp).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ok(in_tx!(c, a, tx => files::apply_import(&mut tx, &bytes, &month).await))
}

// ---------------------------------------------------------------- báo cáo (M31)

async fn report_summary(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let query = QuerySummary {
        month: qstr(&q, "month").unwrap_or_default(),
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    ok(on_conn!(c, a, conn => reports::summary(&mut conn, &query.month).await))
}

async fn report_by_department(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let query = QuerySummary {
        month: qstr(&q, "month").unwrap_or_default(),
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    ok(on_conn!(c, a, conn => reports::by_department(&mut conn, &query.month).await))
}

async fn report_comparison(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let query = QueryComparison {
        months: qstr(&q, "months").unwrap_or_default(),
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    let months = query.list();
    ok(on_conn!(c, a, conn => reports::comparison(&mut conn, &months).await))
}

// ---------------------------------------------------------------- nhân viên (payroll)

async fn employee_list(State(c): St, Extension(u): Cu, Query(q): Q) -> Response {
    let a = act!(u);
    let mut errs = Vec::new();
    let team_id = qint(&q, "team_id", &mut errs);
    no_errs!(errs);
    let query = QueryEmployee {
        team_id,
        position: qstr(&q, "position"),
        status: qstr(&q, "status"),
        search: qstr(&q, "search"),
    };
    if let Err(e) = query.validate() {
        return fail(e);
    }
    let scope = scope!(c, a, "employees.view");
    ok(on_conn!(c, a, conn => employees::find_all(&mut conn, &query, scope.as_deref()).await))
}

async fn employee_create(State(c): St, Extension(u): Cu, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let input = input!(CreateEmployee, b);
    ok(in_tx!(c, a, tx => employees::create(&mut tx, &input).await))
}

async fn employee_get(State(c): St, Extension(u): Cu, Path(id): Id) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let scope = scope!(c, a, "employees.view");
    ok(on_conn!(c, a, conn => employees::find_by_id(&mut conn, id, scope.as_deref()).await))
}

async fn employee_update(State(c): St, Extension(u): Cu, Path(id): Id, JsonBody(b): JsonBody) -> Response {
    let a = act!(u);
    let id = pid!(id);
    let input = input!(UpdateEmployee, b);
    ok(in_tx!(c, a, tx => employees::update(&mut tx, id, &input).await))
}

/// Router của payroll: 23 route cấu hình/KPI + 13 route M30b (phiếu lương không trả tệp, nhân viên) + 11 route M31 (8 tệp/PDF,
/// 3 báo cáo) = 47 route.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let mut table = crate::routes::routes();
    table.extend(crate::routes::payslip_specs());
    table.extend(crate::routes::file_specs());
    table.extend(crate::routes::report_specs());
    let limit = || DefaultBodyLimit::max(IMPORT_MAX_BYTES + 1024 * 1024);
    let spec = |m: &Method, p: &str| {
        table
            .iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/salary-components"), component_list)
        .route(spec(&Method::POST, "/api/v1/salary-components"), component_create)
        .route(spec(&Method::PATCH, "/api/v1/salary-components/:id"), component_update)
        .route(spec(&Method::DELETE, "/api/v1/salary-components/:id"), component_remove)
        .route(spec(&Method::GET, "/api/v1/insurance-settings"), insurance_list)
        .route(spec(&Method::POST, "/api/v1/insurance-settings"), insurance_create)
        .route(spec(&Method::PATCH, "/api/v1/insurance-settings/:id"), insurance_update)
        .route(
            spec(&Method::DELETE, "/api/v1/insurance-settings/:id"),
            insurance_remove,
        )
        .route(spec(&Method::GET, "/api/v1/tax-config"), tax_get)
        .route(spec(&Method::POST, "/api/v1/tax-config/brackets"), bracket_create)
        .route(spec(&Method::PATCH, "/api/v1/tax-config/brackets/:id"), bracket_update)
        .route(spec(&Method::DELETE, "/api/v1/tax-config/brackets/:id"), bracket_remove)
        .route(spec(&Method::POST, "/api/v1/tax-config/settings"), setting_create)
        .route(spec(&Method::PATCH, "/api/v1/tax-config/settings/:id"), setting_update)
        .route(spec(&Method::GET, "/api/v1/salary-rules"), rule_list)
        .route(spec(&Method::POST, "/api/v1/salary-rules"), rule_create)
        .route(spec(&Method::GET, "/api/v1/salary-rules/:id"), rule_get)
        .route(spec(&Method::PATCH, "/api/v1/salary-rules/:id"), rule_update)
        .route(spec(&Method::GET, "/api/v1/kpi/configs"), kpi_configs)
        .route(spec(&Method::POST, "/api/v1/kpi/configs"), kpi_config_create)
        .route(spec(&Method::POST, "/api/v1/kpi/calculate"), kpi_calculate)
        .route(spec(&Method::POST, "/api/v1/kpi/close-month"), kpi_close_month)
        .route(spec(&Method::GET, "/api/v1/kpi"), kpi_mine)
        .route(spec(&Method::GET, "/api/v1/payslips/me"), payslip_mine)
        .route(spec(&Method::GET, "/api/v1/payslips"), payslip_list)
        .route(spec(&Method::GET, "/api/v1/payslips/addable"), payslip_addable)
        .route(spec(&Method::GET, "/api/v1/payslips/:id"), payslip_get)
        .route(spec(&Method::POST, "/api/v1/payslips/generate"), payslip_generate)
        .route(spec(&Method::POST, "/api/v1/payslips/add-to-period"), payslip_add)
        .route(spec(&Method::PATCH, "/api/v1/payslips/:id/approve"), payslip_approve)
        .route(spec(&Method::PATCH, "/api/v1/payslips/:id"), payslip_update)
        .route(spec(&Method::DELETE, "/api/v1/payslips/:id"), payslip_remove)
        .route(spec(&Method::GET, "/api/v1/employees"), employee_list)
        .route(spec(&Method::POST, "/api/v1/employees"), employee_create)
        .route(spec(&Method::GET, "/api/v1/employees/:id"), employee_get)
        .route(spec(&Method::PATCH, "/api/v1/employees/:id"), employee_update)
        .route(spec(&Method::GET, "/api/v1/payslips/excel-bulk"), slip_excel_bulk)
        .route(spec(&Method::GET, "/api/v1/payslips/excel-list"), slip_excel_list)
        .route(spec(&Method::POST, "/api/v1/payslips/excel-list"), slip_excel_list_ordered)
        .route(spec(&Method::GET, "/api/v1/payslips/import-template"), slip_import_template)
        .route(
            spec(&Method::POST, "/api/v1/payslips/import/preview"),
            slip_import_preview.layer(limit()),
        )
        .route(
            spec(&Method::POST, "/api/v1/payslips/import/apply"),
            slip_import_apply.layer(limit()),
        )
        .route(spec(&Method::GET, "/api/v1/payslips/:id/pdf"), slip_pdf)
        .route(spec(&Method::GET, "/api/v1/payslips/:id/excel"), slip_excel)
        .route(spec(&Method::GET, "/api/v1/reports/summary"), report_summary)
        .route(spec(&Method::GET, "/api/v1/reports/by-department"), report_by_department)
        .route(spec(&Method::GET, "/api/v1/reports/comparison"), report_comparison)
}
