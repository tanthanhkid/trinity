//! Router axum của POS (K14): 25 route của [`crate::routes::routes`]; mã thành công và quyền do `ApiRouter` thực thi.
//!
//! Mỗi handler: người gọi (`CurrentUser`) → kiểm dữ liệu vào → phạm vi `pos.sell` (nếu cần, tính TRƯỚC khi lấy kết nối
//! để không giữ hai kết nối cùng lúc) → hàm nghiệp vụ → JSON.

use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use trinity_db::CompanyRef;
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser};
use trinity_http::validate::extract::query_to_json;
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, OwnerIds};

use crate::catalog::{self, MenuQuery, UpdateSettings};
use crate::layout::{self, CreateArea, CreateModifier, CreateTable, UpdateArea, UpdateModifier, UpdateTable};
use crate::orders::{self, CreateOrder, ListOrders, PayOrder, QrQuery, UpdateOrder, VoidOrder};
use crate::reports::{self, DailyQuery};
use crate::shifts::{self, CloseShift, ListShifts, OpenShift};
use crate::{Ctx, MAX_MONEY, finish, range};

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

const SELL: &str = "pos.sell";
const INT4_MAX: i64 = 2_147_483_647;

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn out<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        // trinity-lint: allow-json-value (model cần vá thêm khoá rồi trả Value (hoặc ghi cột jsonb), giữ hành vi cũ; không phải đường ghi chuỗi JSON thẳng)
        Ok(v) => match serde_json::to_value(v) {
            Ok(j) => Json(j).into_response(),
            Err(e) => fail(AppError::internal(e)),
        },
        Err(e) => fail(e),
    }
}

/// Người gọi đã xác thực.
struct Who {
    user_id: i32,
    company: CompanyRef,
    grants: Grants,
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
fn who(u: &CurrentUser) -> Result<Who, Response> {
    match CompanyRef::new(i64::from(u.user.company_id)) {
        Ok(company) => Ok(Who {
            user_id: u.user.user_id,
            company,
            grants: u.grants.grants.clone(),
        }),
        Err(_) => Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn"))),
    }
}

/// `who(&u)` hoặc trả ngay phản hồi 401.
macro_rules! act {
    ($u:expr) => {
        match who(&$u) {
            Ok(a) => a,
            Err(r) => return r,
        }
    };
}

/// Phạm vi dữ liệu của `pos.sell`; không có quyền (`None`) ⇒ tập rỗng, như `?? []` của bản TS.
async fn owner(c: &Ctx, w: &Who) -> Result<OwnerIds, AppError> {
    let g = &w.grants;
    let found = c.scopes.owner_ids(w.company, w.user_id, g, SELL).await;
    let found = found.map_err(AppError::internal)?;
    Ok(found.unwrap_or(OwnerIds::Ids(vec![])))
}

/// `ParseInt4Pipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy").into())
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`.
struct JsonBody(Value);

impl<St: Send + Sync> FromRequest<St> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &St) -> Result<Self, Response> {
        let ct = req.headers().get(header::CONTENT_TYPE);
        let ct = ct.and_then(|v| v.to_str().ok()).unwrap_or("");
        let essence = ct.split(';').next().unwrap_or("").trim();
        let is_json = essence.eq_ignore_ascii_case("application/json");
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

/// Kiểm theo metadata DTO thật (`schema.json`, chế độ strict của POS) rồi deserialize vào struct.
fn dto<T: DeserializeOwned>(name: &str, input: &Value) -> Result<T, AppError> {
    let v = validate_value(name, input, Mode::Strict)?;
    let v = if v.is_array() { Value::Object(Map::new()) } else { v };
    serde_json::from_value(v).map_err(|e| HttpError::bad_request(e.to_string()).into())
}

fn query_of(uri: &Uri) -> Value {
    query_to_json(uri.query().unwrap_or(""))
}

fn query_map(uri: &Uri) -> Map<String, Value> {
    match query_of(uri) {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

fn body_map(body: &Value) -> Map<String, Value> {
    match body {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    }
}

/// `forbidNonWhitelisted`: khoá lạ ⇒ "property x should not exist".
fn only_keys(m: &Map<String, Value>, allowed: &[&str], errs: &mut Vec<String>) {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            errs.push(format!("property {k} should not exist"));
        }
    }
}

/// `Number(s)` của JS: chuỗi rỗng là 0, không phải số là `None`.
fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        Some(0.0)
    } else {
        t.parse::<f64>().ok().filter(|n| n.is_finite())
    }
}

/// `@IsOptional() @Type(() => Number) @IsInt() @Min(min) @Max(max)` cho tham số query.
fn query_int(m: &Map<String, Value>, key: &str, min: i64, max: i64, errs: &mut Vec<String>) -> Option<i64> {
    let raw = m.get(key)?;
    let parsed = raw.as_str().and_then(js_number);
    let num = parsed.filter(|n| n.fract() == 0.0);
    let Some(n) = num else {
        errs.push(format!("{key} must be an integer number"));
        return None;
    };
    let before = errs.len();
    let n = n as i64;
    range(key, n, min, max, errs);
    (errs.len() == before).then_some(n)
}

fn query_text(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(Value::as_str).map(str::to_owned)
}

// ---------------------------------------------------------------- layout

async fn areas_list(State(c): S, Extension(u): U) -> Response {
    let w = act!(u);
    let r = async {
        let mut conn = c.conn(w.company).await?;
        layout::list_areas(&mut conn).await
    };
    out(r.await)
}

async fn area_create(State(c): S, Extension(u): U, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: CreateArea = dto("CreateAreaDto", &b)?;
        input.normalize();
        input.validate()?;
        let mut conn = c.conn(w.company).await?;
        layout::create_area(&mut conn, &input).await
    };
    out(r.await)
}

async fn area_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: UpdateArea = dto("UpdateAreaDto", &b)?;
        input.normalize();
        input.validate()?;
        let id = id_of(&id)?;
        let mut conn = c.conn(w.company).await?;
        layout::update_area(&mut conn, id, &input).await
    };
    out(r.await)
}

async fn tables_list(State(c): S, Extension(u): U) -> Response {
    let w = act!(u);
    let r = async {
        let mut conn = c.conn(w.company).await?;
        layout::list_tables(&mut conn).await
    };
    out(r.await)
}

async fn table_create(State(c): S, Extension(u): U, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: CreateTable = dto("CreateTableDto", &b)?;
        input.normalize();
        input.validate()?;
        let mut conn = c.conn(w.company).await?;
        layout::create_table(&mut conn, &input).await
    };
    out(r.await)
}

async fn table_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: UpdateTable = dto("UpdateTableDto", &b)?;
        input.normalize();
        input.validate()?;
        let id = id_of(&id)?;
        let mut conn = c.conn(w.company).await?;
        layout::update_table(&mut conn, id, &input).await
    };
    out(r.await)
}

async fn modifiers_list(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let w = act!(u);
    let r = async {
        let v = validate_value("ListModifiersQueryDto", &query_of(&uri), Mode::Strict)?;
        let flag = v.get("include_inactive").and_then(Value::as_bool);
        let include = flag.unwrap_or(false);
        let can_manage = trinity_rbac::can(&w.grants, "pos.manage", None);
        let mut conn = c.conn(w.company).await?;
        layout::list_modifiers(&mut conn, include, can_manage).await
    };
    out(r.await)
}

async fn modifier_create(State(c): S, Extension(u): U, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: CreateModifier = dto("CreateModifierDto", &b)?;
        input.normalize();
        input.validate()?;
        let mut conn = c.conn(w.company).await?;
        layout::create_modifier(&mut conn, &input).await
    };
    out(r.await)
}

async fn modifier_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: UpdateModifier = dto("UpdateModifierDto", &b)?;
        input.normalize();
        input.validate()?;
        let id = id_of(&id)?;
        let mut conn = c.conn(w.company).await?;
        layout::update_modifier(&mut conn, id, &input).await
    };
    out(r.await)
}

// ---------------------------------------------------------------- cấu hình quán, menu

async fn settings_get(State(c): S, Extension(u): U) -> Response {
    let w = act!(u);
    let r = async {
        let mut conn = c.conn(w.company).await?;
        catalog::get_settings(&mut conn).await
    };
    out(r.await)
}

async fn settings_update(State(c): S, Extension(u): U, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: UpdateSettings = dto("UpdateSettingsDto", &b)?;
        input.normalize();
        input.validate()?;
        let mut conn = c.conn(w.company).await?;
        catalog::update_settings(&mut conn, &input).await
    };
    out(r.await)
}

async fn menu(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let w = act!(u);
    let r = async {
        let mut q: MenuQuery = dto("MenuQueryDto", &query_of(&uri))?;
        q.normalize();
        q.validate()?;
        let mut conn = c.conn(w.company).await?;
        catalog::menu(&mut conn, &q).await
    };
    out(r.await)
}

// ---------------------------------------------------------------- ca, báo cáo

/// `OpenShiftDto` (không có trong `schema.json`): `opening_cash` số nguyên 0..MAX_MONEY.
fn open_shift_input(body: &Value) -> Result<OpenShift, AppError> {
    let m = body_map(body);
    let mut errs = Vec::new();
    only_keys(&m, &["opening_cash"], &mut errs);
    let cash = m.get("opening_cash").and_then(Value::as_f64);
    let cash = cash.filter(|n| n.fract() == 0.0);
    let Some(cash) = cash else {
        errs.push(format!("opening_cash must not be greater than {MAX_MONEY}"));
        errs.push("opening_cash must not be less than 0".to_owned());
        errs.push("opening_cash must be an integer number".to_owned());
        return Err(HttpError::validation(errs).into());
    };
    finish(errs)?;
    let input = OpenShift {
        opening_cash: cash as i64,
    };
    input.validate()?;
    Ok(input)
}

async fn shift_open(State(c): S, Extension(u): U, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let input = open_shift_input(&b)?;
        let mut conn = c.conn(w.company).await?;
        shifts::open(&mut conn, w.user_id, &input).await
    };
    out(r.await)
}

async fn shift_current(State(c): S, Extension(u): U) -> Response {
    let w = act!(u);
    let r = async {
        let mut conn = c.conn(w.company).await?;
        shifts::current(&mut conn, w.user_id).await
    };
    out(r.await)
}

async fn shifts_list(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let w = act!(u);
    let r = async {
        let m = query_map(&uri);
        let mut errs = Vec::new();
        only_keys(&m, &["cursor", "limit"], &mut errs);
        let cursor = query_int(&m, "cursor", 1, INT4_MAX, &mut errs);
        let limit = query_int(&m, "limit", 1, 100, &mut errs);
        finish(errs)?;
        let q = ListShifts {
            cursor: cursor.and_then(|n| i32::try_from(n).ok()),
            limit,
        };
        q.validate()?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        shifts::list(&mut conn, &q, &scope).await
    };
    out(r.await)
}

async fn shift_summary(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let w = act!(u);
    let r = async {
        let id = id_of(&id)?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        shifts::summary(&mut conn, id, &scope).await
    };
    out(r.await)
}

async fn shift_close(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: CloseShift = dto("CloseShiftDto", &b)?;
        input.normalize();
        input.validate()?;
        let id = id_of(&id)?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        shifts::close(&mut conn, id, &input, w.user_id, &scope).await
    };
    out(r.await)
}

async fn report_daily(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let w = act!(u);
    let r = async {
        let m = query_map(&uri);
        let mut errs = Vec::new();
        only_keys(&m, &["date"], &mut errs);
        let bad_type = m.get("date").is_some_and(|d| !d.is_string());
        if bad_type {
            errs.push("date phải dạng YYYY-MM-DD".to_owned());
        }
        finish(errs)?;
        let q = DailyQuery {
            date: query_text(&m, "date"),
        };
        q.validate()?;
        let mut conn = c.conn(w.company).await?;
        reports::daily(&mut conn, q.date.as_deref(), chrono::Utc::now()).await
    };
    out(r.await)
}

// ---------------------------------------------------------------- đơn hàng

async fn orders_list(State(c): S, Extension(u): U, uri: Uri) -> Response {
    let w = act!(u);
    let r = async {
        let m = query_map(&uri);
        let mut errs = Vec::new();
        only_keys(&m, &["status", "table_id", "shift_id", "cursor", "limit"], &mut errs);
        let table_id = query_int(&m, "table_id", 1, INT4_MAX, &mut errs);
        let shift_id = query_int(&m, "shift_id", 1, INT4_MAX, &mut errs);
        let cursor = query_int(&m, "cursor", 1, INT4_MAX, &mut errs);
        let limit = query_int(&m, "limit", 1, 100, &mut errs);
        finish(errs)?;
        let q = ListOrders {
            status: query_text(&m, "status"),
            table_id: table_id.and_then(|n| i32::try_from(n).ok()),
            shift_id: shift_id.and_then(|n| i32::try_from(n).ok()),
            cursor: cursor.and_then(|n| i32::try_from(n).ok()),
            limit,
        };
        q.validate()?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        orders::list(&mut conn, &q, &scope).await
    };
    out(r.await)
}

async fn order_create(State(c): S, Extension(u): U, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: CreateOrder = dto("CreateOrderDto", &b)?;
        input.normalize();
        input.validate()?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        orders::create(&mut conn, w.user_id, &input, chrono::Utc::now(), &scope).await
    };
    out(r.await)
}

async fn order_get(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let w = act!(u);
    let r = async {
        let id = id_of(&id)?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        orders::get_by_id(&mut conn, id, &scope).await
    };
    out(r.await)
}

async fn order_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: UpdateOrder = dto("UpdateOrderDto", &b)?;
        input.normalize();
        input.validate()?;
        let id = id_of(&id)?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        orders::update(&mut conn, id, &input, &scope).await
    };
    out(r.await)
}

/// `PayOrderDto` (không có trong `schema.json`): `payments` mảng ≤ 5 dòng; từng dòng do `PayOrder::validate` kiểm.
fn pay_input(body: &Value) -> Result<PayOrder, AppError> {
    let m = body_map(body);
    let mut errs = Vec::new();
    only_keys(&m, &["payments"], &mut errs);
    let is_array = m.get("payments").is_some_and(Value::is_array);
    if !is_array {
        errs.push("payments must contain no more than 5 elements".to_owned());
        errs.push("payments must be an array".to_owned());
    }
    finish(errs)?;
    let parsed = serde_json::from_value::<PayOrder>(Value::Object(m));
    let mut input = parsed.map_err(|e| HttpError::bad_request(e.to_string()))?;
    input.normalize();
    input.validate()?;
    Ok(input)
}

async fn order_pay(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let input = pay_input(&b)?;
        let id = id_of(&id)?;
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        orders::pay(&mut conn, id, w.user_id, &input, &scope).await
    };
    out(r.await)
}

async fn order_void(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(b): JsonBody) -> Response {
    let w = act!(u);
    let r = async {
        let mut input: VoidOrder = dto("VoidOrderDto", &b)?;
        input.normalize();
        input.validate()?;
        let id = id_of(&id)?;
        let can_manage = trinity_rbac::can(&w.grants, "pos.manage", None);
        let scope = owner(&c, &w).await?;
        let mut conn = c.conn(w.company).await?;
        orders::void_order(&mut conn, id, w.user_id, &input, can_manage, &scope).await
    };
    out(r.await)
}

async fn order_qr(State(c): S, Extension(u): U, Path(id): Path<String>, uri: Uri) -> Response {
    let w = act!(u);
    let r = async {
        let m = query_map(&uri);
        let mut errs = Vec::new();
        only_keys(&m, &["amount"], &mut errs);
        let amount = query_int(&m, "amount", 1, MAX_MONEY, &mut errs);
        finish(errs)?;
        let q = QrQuery { amount };
        q.validate()?;
        let id = id_of(&id)?;
        let mut conn = c.conn(w.company).await?;
        orders::qr(&mut conn, id, q.amount).await
    };
    out(r.await)
}

/// Router của POS: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = crate::routes::routes();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let base = "/api/v1/pos";
    let order = "/api/v1/pos/orders";
    ApiRouter::new(deps)
        .route(spec(&Method::GET, &format!("{base}/areas")), areas_list)
        .route(spec(&Method::POST, &format!("{base}/areas")), area_create)
        .route(spec(&Method::PATCH, &format!("{base}/areas/:id")), area_update)
        .route(spec(&Method::GET, &format!("{base}/tables")), tables_list)
        .route(spec(&Method::POST, &format!("{base}/tables")), table_create)
        .route(spec(&Method::PATCH, &format!("{base}/tables/:id")), table_update)
        .route(spec(&Method::GET, &format!("{base}/modifiers")), modifiers_list)
        .route(spec(&Method::POST, &format!("{base}/modifiers")), modifier_create)
        .route(spec(&Method::PATCH, &format!("{base}/modifiers/:id")), modifier_update)
        .route(spec(&Method::GET, &format!("{base}/settings")), settings_get)
        .route(spec(&Method::PATCH, &format!("{base}/settings")), settings_update)
        .route(spec(&Method::GET, &format!("{base}/menu")), menu)
        .route(spec(&Method::POST, &format!("{base}/shifts/open")), shift_open)
        .route(spec(&Method::GET, &format!("{base}/shifts/current")), shift_current)
        .route(spec(&Method::GET, &format!("{base}/shifts")), shifts_list)
        .route(spec(&Method::GET, &format!("{base}/shifts/:id/summary")), shift_summary)
        .route(spec(&Method::POST, &format!("{base}/shifts/:id/close")), shift_close)
        .route(spec(&Method::GET, &format!("{base}/reports/daily")), report_daily)
        .route(spec(&Method::GET, order), orders_list)
        .route(spec(&Method::POST, order), order_create)
        .route(spec(&Method::GET, &format!("{order}/:id")), order_get)
        .route(spec(&Method::PATCH, &format!("{order}/:id")), order_update)
        .route(spec(&Method::POST, &format!("{order}/:id/pay")), order_pay)
        .route(spec(&Method::GET, &format!("{order}/:id/qr")), order_qr)
        .route(spec(&Method::POST, &format!("{order}/:id/void")), order_void)
}
