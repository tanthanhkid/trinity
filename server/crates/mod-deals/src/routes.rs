//! Bảng route và handler của M08 (K14): mỗi route khai [`Access`] bắt buộc, quyền và mã thành công khớp
//! `contracts/routes.json`. Thứ tự guard → pipe tham số → handler do `ApiRouter` bảo đảm.
//!
//! Mỗi handler tính phạm vi ([`Scopes`]) TRƯỚC khi mượn kết nối (không giữ hai kết nối của pool cùng lúc), rồi gọi hàm
//! dịch vụ. Chưa làm: đẩy socket nội bộ cho thông báo "được giao thương vụ" (`Created::notifications`); thông báo vẫn được
//! ghi vào DB cùng giao dịch, chỉ thiếu cú đẩy realtime (TODO khi `NotifSocket` được chia sẻ cho các module).

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use http::Method;
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::plan::{
    OrgFeatures, PlanKey, apply_plan_to_features, blank_system_features, plan_from_setting, resolve_org_features,
};
use trinity_rbac::{Grants, ScopeService};

use crate::activities::{self, Timeline};
use crate::deals::{self, CreateDeal, Deal, DealList, DealQuery, Removed, Sale, UpdateDeal};
use crate::interactions::{self, InteractionList, InteractionQuery, Stats};
use crate::{Actor, Scopes};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const CONTACT_ACTIVITIES: &str = "/api/v1/contacts/:contactId/activities";
const DEALS: &str = "/api/v1/deals";
const DEAL_ID: &str = "/api/v1/deals/:id";

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

/// Phụ thuộc của handler: kết nối DB theo công ty và dịch vụ phạm vi (K13).
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
}

impl Ctx {
    async fn conn(&self, company: CompanyRef) -> Result<TenantConn, AppError> {
        let tenant = self.db.tenant(company).await.map_err(AppError::internal)?;
        tenant.acquire().await.map_err(AppError::internal)
    }

    async fn scopes_of(&self, w: &Who) -> Result<Scopes, AppError> {
        Scopes::resolve(&self.scopes, w.company, w.user_id, &w.grants).await
    }
}

/// Người gọi đã xác thực.
struct Who {
    user_id: i32,
    email: String,
    company: CompanyRef,
    grants: Grants,
    is_admin: bool,
}

impl Who {
    /// Công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
    fn of(u: &CurrentUser) -> Result<Self, AppError> {
        let company = CompanyRef::new(i64::from(u.user.company_id))
            .map_err(|_| HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn"))?;
        Ok(Self {
            user_id: u.user.user_id,
            email: u.user.email.clone(),
            company,
            grants: u.grants.grants.clone(),
            is_admin: u.grants.is_admin,
        })
    }

    fn actor(&self) -> Actor {
        Actor {
            user_id: self.user_id,
            is_admin: self.is_admin,
            email: Some(self.email.clone()).filter(|e| !e.is_empty()),
        }
    }
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

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
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

impl Dto for CreateDeal {
    const NAME: &'static str = "CreateDealDto";
}

impl Dto for DealQuery {
    const NAME: &'static str = "QueryDealDto";
}

const UPDATE_KEYS: [&str; 5] = ["title", "description", "value", "status", "note"];

/// `UpdateDealDto` (không có trong `schema.json` nên kiểm tay, cùng thứ tự luật và câu lỗi của class-validator: trường lạ
/// trước, rồi từng trường theo khai báo, luật đăng ký sau chạy trước). `title`/`status` có mặt thì không nhận `null`.
fn parse_update(body: &Value) -> Result<UpdateDeal, AppError> {
    let empty = Map::new();
    let obj = body.as_object().unwrap_or(&empty);
    let mut e: Vec<String> = obj
        .keys()
        .filter(|k| !UPDATE_KEYS.contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect();
    let text = |key: &str, max: usize, null_ok: bool, e: &mut Vec<String>| -> Option<Option<String>> {
        match obj.get(key) {
            None => None,
            Some(Value::Null) if null_ok => Some(None),
            Some(Value::String(s)) => {
                if s.encode_utf16().count() > max {
                    e.push(format!("{key} must be shorter than or equal to {max} characters"));
                }
                Some(Some(s.clone()))
            }
            Some(_) => {
                e.push(format!("{key} must be shorter than or equal to {max} characters"));
                e.push(format!("{key} must be a string"));
                None
            }
        }
    };
    let title = text("title", 255, false, &mut e).flatten();
    let description = text("description", 1000, true, &mut e);
    let value = match obj.get("value") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => {
            let num = v.as_f64();
            if num.is_none_or(|n| n < 0.0) {
                e.push("value must not be less than 0".to_owned());
            }
            let int = v.as_i64().or_else(|| {
                num.filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                    .map(|n| n as i64)
            });
            if int.is_none() {
                e.push("value must be an integer number".to_owned());
            }
            int.map(Some)
        }
    };
    let status = match obj.get("status") {
        None => None,
        Some(Value::String(s)) if matches!(s.as_str(), "open" | "won" | "lost") => Some(s.clone()),
        Some(_) => {
            e.push("status must be one of the following values: open, won, lost".to_owned());
            None
        }
    };
    let note = text("note", 2000, true, &mut e);
    if e.is_empty() {
        Ok(UpdateDeal {
            title,
            description,
            value,
            status,
            note,
        })
    } else {
        Err(HttpError::validation(e).into())
    }
}

/// `OrgFeaturesService.get`: tính năng của tổ chức (đã tính gói). Lỗi đọc từng phần như bản TS: không đọc được gói ⇒ gói
/// `custom`; không đọc được `setup_status` ⇒ coi như đã dựng; không đọc được hoặc không parse được `org_features` ⇒ mặc định
/// bật hết (bỏ qua cả gói).
async fn load_features(conn: &mut PgConnection, company_id: i32) -> OrgFeatures {
    async fn setting(conn: &mut PgConnection, k: &str) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(k)
            .fetch_optional(&mut *conn)
            .await
    }
    let plan: PlanKey = match setting(conn, "org_plan").await {
        Ok(raw) => plan_from_setting(raw.as_deref(), Some(company_id)),
        Err(e) => {
            tracing::error!("getPlan failed: {e}");
            PlanKey::Custom
        }
    };
    let stored = match setting(conn, "org_features").await {
        Ok(None) => Ok(Value::Null),
        Ok(Some(s)) if s.is_empty() => Ok(Value::Null),
        Ok(Some(s)) => serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let setup = match setting(conn, "setup_status").await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("đọc setup_status lỗi: {e}");
            None
        }
    };
    let Ok(raw) = stored else {
        tracing::error!("getOrgFeatures failed: không đọc được org_features");
        return resolve_org_features(&Value::Null, None);
    };
    let blank = blank_system_features();
    let defaults = (setup.as_deref().map(str::trim) == Some("chua_dung")).then_some(&blank);
    apply_plan_to_features(&resolve_org_features(&raw, defaults), plan)
}

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;
type Q = Query<HashMap<String, String>>;

async fn contact_activities_inner(
    c: &Ctx,
    u: &CurrentUser,
    raw_id: &str,
    q: &HashMap<String, String>,
) -> Result<Timeline, AppError> {
    let w = Who::of(u)?;
    let contact_id = raw_id
        .parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy khách hàng ID {raw_id}")))?;
    let scopes = c.scopes_of(&w).await?;
    let mut conn = c.conn(w.company).await?;
    let get = |k: &str| q.get(k).map(String::as_str).filter(|s| !s.is_empty());
    activities::find_by_contact(&mut conn, &scopes, contact_id, get("cursor"), get("limit")).await
}

async fn contact_activities(State(c): S, Extension(u): U, Path(id): Path<String>, Query(q): Q) -> Response {
    ok(contact_activities_inner(&c, &u, &id, &q).await)
}

async fn list_inner(c: &Ctx, u: &CurrentUser, q: &DealQuery) -> Result<DealList, AppError> {
    let w = Who::of(u)?;
    let scopes = c.scopes_of(&w).await?;
    let mut conn = c.conn(w.company).await?;
    deals::find_all(&mut conn, &scopes, q).await
}

async fn list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<DealQuery>) -> Response {
    ok(list_inner(&c, &u, &q).await)
}

async fn create_inner(c: &Ctx, u: &CurrentUser, dto: &CreateDeal) -> Result<Deal, AppError> {
    let w = Who::of(u)?;
    let scopes = c.scopes_of(&w).await?;
    let tenant = c.db.tenant(w.company).await.map_err(AppError::internal)?;
    let created = deals::create(&tenant, &scopes, &w.actor(), dto).await?;
    Ok(created.deal)
}

async fn create(State(c): S, Extension(u): U, ValidJson(dto): ValidJson<CreateDeal>) -> Response {
    ok(create_inner(&c, &u, &dto).await)
}

async fn search_sales_inner(c: &Ctx, u: &CurrentUser, q: Option<&str>) -> Result<Vec<Sale>, AppError> {
    let w = Who::of(u)?;
    let scopes = c.scopes_of(&w).await?;
    let mut conn = c.conn(w.company).await?;
    deals::search_sales(&mut conn, &scopes, q).await
}

async fn search_sales(State(c): S, Extension(u): U, Query(q): Q) -> Response {
    ok(search_sales_inner(&c, &u, q.get("q").map(String::as_str)).await)
}

async fn get_one_inner(c: &Ctx, u: &CurrentUser, raw_id: &str) -> Result<Deal, AppError> {
    let w = Who::of(u)?;
    let id = id_of(raw_id, "thương vụ")?;
    let scopes = c.scopes_of(&w).await?;
    let mut conn = c.conn(w.company).await?;
    deals::find_one(&mut conn, &scopes, id).await
}

async fn get_one(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(get_one_inner(&c, &u, &id).await)
}

async fn update_inner(c: &Ctx, u: &CurrentUser, raw_id: &str, body: &Value) -> Result<Deal, AppError> {
    let w = Who::of(u)?;
    let dto = parse_update(body)?;
    let id = id_of(raw_id, "thương vụ")?;
    let scopes = c.scopes_of(&w).await?;
    let tenant = c.db.tenant(w.company).await.map_err(AppError::internal)?;
    deals::update(&tenant, &scopes, &w.actor(), id, &dto).await
}

async fn update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(update_inner(&c, &u, &id, &body).await)
}

async fn remove_inner(c: &Ctx, u: &CurrentUser, raw_id: &str) -> Result<Removed, AppError> {
    let w = Who::of(u)?;
    let id = id_of(raw_id, "thương vụ")?;
    let scopes = c.scopes_of(&w).await?;
    let mut conn = c.conn(w.company).await?;
    deals::remove(&mut conn, &scopes, id).await
}

async fn remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(remove_inner(&c, &u, &id).await)
}

async fn interactions_list_inner(
    c: &Ctx,
    u: &CurrentUser,
    q: &HashMap<String, String>,
) -> Result<InteractionList, AppError> {
    let w = Who::of(u)?;
    let get = |k: &str| q.get(k).map(String::as_str);
    let query = InteractionQuery::from_raw(
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
    )?;
    let mut conn = c.conn(w.company).await?;
    let features = load_features(&mut conn, u.user.company_id).await;
    let src = interactions::sources(&features, &w.grants);
    interactions::list(&mut conn, src, &query).await
}

async fn interactions_list(State(c): S, Extension(u): U, Query(q): Q) -> Response {
    ok(interactions_list_inner(&c, &u, &q).await)
}

async fn interactions_stats_inner(c: &Ctx, u: &CurrentUser) -> Result<Stats, AppError> {
    let w = Who::of(u)?;
    let mut conn = c.conn(w.company).await?;
    let features = load_features(&mut conn, u.user.company_id).await;
    let src = interactions::sources(&features, &w.grants);
    interactions::stats(&mut conn, src, Utc::now()).await
}

async fn interactions_stats(State(c): S, Extension(u): U) -> Response {
    ok(interactions_stats_inner(&c, &u).await)
}

async fn interactions_thread_inner(c: &Ctx, u: &CurrentUser, id: &str) -> Result<Value, AppError> {
    let w = Who::of(u)?;
    let mut conn = c.conn(w.company).await?;
    let features = load_features(&mut conn, u.user.company_id).await;
    let src = interactions::sources(&features, &w.grants);
    interactions::thread(&mut conn, src, id, Utc::now()).await
}

async fn interactions_thread(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(interactions_thread_inner(&c, &u, &id).await)
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
        .route(spec(&Method::GET, CONTACT_ACTIVITIES), contact_activities)
        .route(spec(&Method::GET, DEALS), list)
        .route(spec(&Method::POST, DEALS), create)
        .route(spec(&Method::GET, "/api/v1/deals/search-sales"), search_sales)
        .route(spec(&Method::GET, DEAL_ID), get_one)
        .route(spec(&Method::PATCH, DEAL_ID), update)
        .route(spec(&Method::DELETE, DEAL_ID), remove)
        .route(spec(&Method::GET, "/api/v1/interactions"), interactions_list)
        .route(spec(&Method::GET, "/api/v1/interactions/stats"), interactions_stats)
        .route(
            spec(&Method::GET, "/api/v1/interactions/comments/:id/thread"),
            interactions_thread,
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 10);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 10);
    }

    fn messages(e: AppError) -> Vec<String> {
        match e.response(true).1.message {
            trinity_kernel::error::Message::Many(m) => m,
            trinity_kernel::error::Message::One(s) => vec![s],
        }
    }

    #[test]
    fn update_chap_nhan_null_cho_mo_ta_gia_tri_ghi_chu() {
        let d = parse_update(&json!({ "description": null, "value": null, "note": null })).unwrap();
        assert_eq!(d.description, Some(None));
        assert_eq!(d.value, Some(None));
        assert_eq!(d.note, Some(None));
        assert_eq!(d.title, None);
    }

    #[test]
    fn update_tu_choi_null_tieu_de_va_truong_la() {
        let m = messages(parse_update(&json!({ "title": null, "x": 1 })).unwrap_err());
        assert_eq!(
            m,
            [
                "property x should not exist".to_owned(),
                "title must be shorter than or equal to 255 characters".to_owned(),
                "title must be a string".to_owned(),
            ]
        );
    }

    #[test]
    fn update_kiem_gia_tri_va_trang_thai() {
        let m = messages(parse_update(&json!({ "value": -1.5, "status": "x" })).unwrap_err());
        assert_eq!(
            m,
            [
                "value must not be less than 0".to_owned(),
                "value must be an integer number".to_owned(),
                "status must be one of the following values: open, won, lost".to_owned(),
            ]
        );
        let d = parse_update(&json!({ "value": 5.0, "status": "won" })).unwrap();
        assert_eq!(d.value, Some(Some(5)));
        assert_eq!(d.status.as_deref(), Some("won"));
    }
}
