//! Bảng route và handler của M08 (K14): 1 route hoạt động theo khách, 6 route `/deals`, 3 route `/interactions`; quyền và
//! mã thành công khớp `contracts/routes.json` (test cuối file).
//!
//! Dữ liệu vào: query danh sách thương vụ và body tạo đi qua metadata THẬT của class-validator (`ValidQuery`/`ValidJson`
//! đọc `contracts/dto/schema.json`); `UpdateDealDto` chưa có trong `schema.json` nên kiểm tay đúng thứ tự câu lỗi của
//! class-validator (whitelist trước, rồi từng thuộc tính theo thứ tự khai, decorator khai sau chạy trước).
//!
//! Chưa làm ở tầng route: đẩy socket nội bộ cho thông báo "được giao thương vụ" (thông báo đã ghi trong giao dịch tạo và
//! phát `NOTIFY bell`, người dùng vẫn thấy ở lần tải sau).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use http::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;
use trinity_rbac::plan::{OrgFeatures, resolve_org_features};

use crate::deals::{CreateDeal, DealQuery, UpdateDeal};
use crate::interactions::InteractionQuery;
use crate::{Actor, Scopes, activities, deals, interactions};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 1 route hoạt động theo khách, 6 route `/deals`, 3 route `/interactions`.
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["deals.view"]);
    let manage = Access::Can(&["deals.manage"]);
    let delete = Access::Can(&["deals.delete"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/contacts/:contactId/activities", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(&["param.contactId:ParseIntPipe"]),
        RouteSpec::new(Method::GET, "/api/v1/deals", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/deals", manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/deals/search-sales", manage).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/deals/:id", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/deals/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/deals/:id", delete)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/interactions", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/interactions/stats", Access::AuthOnly).status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/interactions/comments/:id/thread",
            Access::AuthOnly,
        )
        .status_ok(200),
    ]
}

/// Trạng thái dùng chung của router thương vụ.
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
    /// Có nhiều công ty trong một DB không (cờ gói của `mod_settings` đọc theo công ty).
    pub multi_tenant: bool,
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

/// Công ty của token: sai ⇒ 401, không rơi về công ty mặc định.
fn company_of(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

/// Người gọi đã dựng xong: công ty, người thực hiện và phạm vi.
struct Req {
    company: CompanyRef,
    actor: Actor,
    scopes: Scopes,
}

async fn prepare(c: &Ctx, u: &CurrentUser) -> Result<Req, Response> {
    let company = company_of(u)?;
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

/// Công ty của token hoặc trả ngay 401.
macro_rules! company {
    ($u:expr) => {
        match company_of(&$u) {
            Ok(c) => c,
            Err(resp) => return resp,
        }
    };
}

async fn conn(c: &Ctx, company: CompanyRef) -> Result<TenantConn, AppError> {
    let t = c.db.tenant(company).await.map_err(AppError::internal)?;
    t.acquire().await.map_err(AppError::internal)
}

/// `OrgFeaturesService.get()`: đủ khoá đã áp gói; lỗi đọc ⇒ bật hết (fail-open, như bản TS).
async fn org_features(c: &Ctx, conn: &mut PgConnection, company: CompanyRef) -> OrgFeatures {
    let ctx = mod_settings::Ctx {
        company_id: c.multi_tenant.then_some(company.id()),
    };
    let mut features = resolve_org_features(&Value::Null, None);
    if let Ok(flags) = mod_settings::features::get(conn, ctx).await {
        for (key, on) in &flags.0 {
            features.set(key, on.unwrap_or(true));
        }
    }
    features
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có thương vụ nào.
fn deal_id(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy thương vụ").into())
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

/// `QueryDealDto`.
#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct QueryDealDto(DealQuery);

impl Dto for QueryDealDto {
    const NAME: &'static str = "QueryDealDto";
}

/// `CreateDealDto`.
#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct CreateDealDto(CreateDeal);

impl Dto for CreateDealDto {
    const NAME: &'static str = "CreateDealDto";
}

/// Khoá của `UpdateDealDto` theo thứ tự khai báo.
const UPDATE_KEYS: [&str; 5] = ["title", "description", "value", "status", "note"];

/// `Number.isInteger` trên giá trị JSON.
fn is_int(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n.fract() == 0.0)
}

/// Số đơn vị UTF-16 như `String.prototype.length`.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Chuỗi tuỳ chọn `@IsOptional() @IsString() @MaxLength(max)`: `null` bị bỏ qua; sai kiểu ⇒ cả hai câu (MaxLength chạy trước).
fn text_errors(name: &str, v: Option<&Value>, max: usize, out: &mut Vec<String>) {
    let long = format!("{name} must be shorter than or equal to {max} characters");
    let not_string = format!("{name} must be a string");
    match v {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            if utf16_len(s) > max {
                out.push(long);
            }
        }
        Some(_) => out.extend([long, not_string]),
    }
}

/// `UpdateDealDto`: `title`/`status` chỉ nhận giá trị (`@ValidateIf(v !== undefined)`, `null` bị bắt); `description`, `value`,
/// `note` nhận `null` để xoá.
fn parse_update(body: &Value) -> Result<UpdateDeal, AppError> {
    let mut errs: Vec<String> = body
        .as_object()
        .map(|o| {
            o.keys()
                .filter(|k| !UPDATE_KEYS.contains(&k.as_str()))
                .map(|k| format!("property {k} should not exist"))
                .collect()
        })
        .unwrap_or_default();
    match body.get("title") {
        None => {}
        Some(Value::String(s)) => {
            if utf16_len(s) > 255 {
                errs.push("title must be shorter than or equal to 255 characters".to_owned());
            }
        }
        Some(_) => errs.extend([
            "title must be shorter than or equal to 255 characters".to_owned(),
            "title must be a string".to_owned(),
        ]),
    }
    text_errors("description", body.get("description"), 1000, &mut errs);
    // `@IsOptional() @IsInt() @Min(0)`: Min chạy trước, sai kiểu ⇒ cả hai câu.
    if let Some(v) = body.get("value").filter(|v| !v.is_null()) {
        if !v.as_f64().is_some_and(|n| n >= 0.0) {
            errs.push("value must not be less than 0".to_owned());
        }
        if !is_int(v) {
            errs.push("value must be an integer number".to_owned());
        }
    }
    if let Some(v) = body.get("status")
        && !matches!(v.as_str(), Some("open" | "won" | "lost"))
    {
        errs.push("status must be one of the following values: open, won, lost".to_owned());
    }
    text_errors("note", body.get("note"), 2000, &mut errs);
    if !errs.is_empty() {
        return Err(HttpError::validation(errs).into());
    }
    let text = |k: &str| body.get(k).map(|v| v.as_str().map(str::to_owned));
    let value = match body.get("value") {
        None => None,
        Some(Value::Null) => Some(None),
        // Số nguyên ≥ 0 ngoài khoảng bigint: cột không chứa được ⇒ 400 trơn.
        Some(v) => match v.as_f64() {
            Some(n) if n < 9.2e18 => Some(Some(n as i64)),
            _ => return Err(HttpError::nest(400, None).into()),
        },
    };
    Ok(UpdateDeal {
        title: body.get("title").and_then(Value::as_str).map(str::to_owned),
        description: text("description"),
        value,
        status: body.get("status").and_then(Value::as_str).map(str::to_owned),
        note: text("note"),
    })
}

async fn timeline(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(contact_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Ok(id) = contact_id.parse::<i32>() else {
        return fail(HttpError::not_found(format!("Không tìm thấy khách hàng ID {contact_id}")));
    };
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        let get = |k: &str| q.get(k).map(String::as_str);
        activities::find_by_contact(&mut cn, &r.scopes, id, get("cursor"), get("limit")).await
    }
    .await;
    ok(res)
}

async fn deal_list(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidQuery(QueryDealDto(q)): ValidQuery<QueryDealDto>,
) -> Response {
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        deals::find_all(&mut cn, &r.scopes, &q).await
    }
    .await;
    ok(res)
}

async fn deal_create(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidJson(CreateDealDto(dto)): ValidJson<CreateDealDto>,
) -> Response {
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        deals::create(&t, &r.scopes, &r.actor, &dto).await
    }
    .await;
    ok(res.map(|created| created.deal))
}

async fn search_sales(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        deals::search_sales(&mut cn, &r.scopes, q.get("q").map(String::as_str)).await
    }
    .await;
    ok(res)
}

async fn deal_get(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let id = match deal_id(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        deals::find_one(&mut cn, &r.scopes, id).await
    }
    .await;
    ok(res)
}

async fn deal_update(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match parse_update(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let id = match deal_id(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let t = c.db.tenant(r.company).await.map_err(AppError::internal)?;
        deals::update(&t, &r.scopes, &r.actor, id, &dto).await
    }
    .await;
    ok(res)
}

async fn deal_remove(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match deal_id(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let r = prep!(c, u);
    let res = async {
        let mut cn = conn(&c, r.company).await?;
        deals::remove(&mut cn, &r.scopes, id).await
    }
    .await;
    ok(res)
}

async fn interaction_list(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| q.get(k).map(String::as_str);
    let query = match InteractionQuery::from_raw(
        get("channel"),
        get("type"),
        get("page_id"),
        get("status"),
        get("has_rule"),
        get("from"),
        get("to"),
        get("q"),
        get("limit"),
        get("before"),
    ) {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let company = company!(u);
    let res = async {
        let mut cn = conn(&c, company).await?;
        let features = org_features(&c, &mut cn, company).await;
        let src = interactions::sources(&features, &u.grants.grants);
        interactions::list(&mut cn, src, &query).await
    }
    .await;
    ok(res)
}

async fn interaction_stats(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    let res = async {
        let mut cn = conn(&c, company).await?;
        let features = org_features(&c, &mut cn, company).await;
        let src = interactions::sources(&features, &u.grants.grants);
        interactions::stats(&mut cn, src, Utc::now()).await
    }
    .await;
    ok(res)
}

async fn interaction_thread(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let res = async {
        let mut cn = conn(&c, company).await?;
        let features = org_features(&c, &mut cn, company).await;
        let src = interactions::sources(&features, &u.grants.grants);
        interactions::thread(&mut cn, src, &id, Utc::now()).await
    }
    .await;
    ok(res)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = routes();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/contacts/:contactId/activities"), timeline)
        .route(spec(&Method::GET, "/api/v1/deals"), deal_list)
        .route(spec(&Method::POST, "/api/v1/deals"), deal_create)
        .route(spec(&Method::GET, "/api/v1/deals/search-sales"), search_sales)
        .route(spec(&Method::GET, "/api/v1/deals/:id"), deal_get)
        .route(spec(&Method::PATCH, "/api/v1/deals/:id"), deal_update)
        .route(spec(&Method::DELETE, "/api/v1/deals/:id"), deal_remove)
        .route(spec(&Method::GET, "/api/v1/interactions"), interaction_list)
        .route(spec(&Method::GET, "/api/v1/interactions/stats"), interaction_stats)
        .route(
            spec(&Method::GET, "/api/v1/interactions/comments/:id/thread"),
            interaction_thread,
        )
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
    fn sua_thuong_vu_giu_null_de_xoa_va_bo_qua_khoa_vang() {
        let d = parse_update(&json!({ "title": "A", "description": null, "value": 5, "status": "won" })).unwrap();
        assert_eq!(d.title.as_deref(), Some("A"));
        assert_eq!(d.description, Some(None));
        assert_eq!(d.value, Some(Some(5)));
        assert_eq!(d.status.as_deref(), Some("won"));
        assert_eq!(d.note, None);
        let d = parse_update(&json!({ "value": null, "note": "x" })).unwrap();
        assert_eq!((d.value, d.note), (Some(None), Some(Some("x".to_owned()))));
        let d = parse_update(&json!({})).unwrap();
        assert_eq!((d.title, d.value, d.note), (None, None, None));
    }

    #[test]
    fn sua_thuong_vu_dung_cau_loi_class_validator() {
        let e = parse_update(&json!({ "la": 1, "title": null, "status": null, "value": -1.5 })).unwrap_err();
        assert_eq!(
            messages(e),
            [
                "property la should not exist",
                "title must be shorter than or equal to 255 characters",
                "title must be a string",
                "value must not be less than 0",
                "value must be an integer number",
                "status must be one of the following values: open, won, lost"
            ]
        );
        let e = parse_update(&json!({ "description": 3, "note": "n".repeat(2001) })).unwrap_err();
        assert_eq!(
            messages(e),
            [
                "description must be shorter than or equal to 1000 characters",
                "description must be a string",
                "note must be shorter than or equal to 2000 characters"
            ]
        );
        let e = parse_update(&json!({ "value": 1.5 })).unwrap_err();
        assert_eq!(messages(e), ["value must be an integer number"]);
        assert!(parse_update(&json!({ "value": 1e19 })).is_err());
    }

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 10);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 10);
    }
}
