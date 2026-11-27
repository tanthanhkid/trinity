//! Router axum của M06: nối extractor → `validate_*` → hàm nghiệp vụ → JSON cho 12 route ở [`crate::routes::routes`].
//! Đo lường sản phẩm (`trackProductEvent`) chưa có ở Rust nên `feature_toggled`/`plan_changed` chưa được gọi.

#![allow(clippy::result_large_err)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::edge::client_ip::{ClientIp, ClientIpResolver};
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser, GuardFuture, NamedGuard, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};

use crate::features::{self, PLAN_TOKEN_HEADER};
use crate::{
    Ctx, general, options, validate_create_option, validate_org_features, validate_plan_body, validate_query_options,
    validate_update_departments, validate_update_notification_sound, validate_update_option,
};

/// Trạng thái dùng chung của router: pool DB (công ty lấy từ token của từng request).
pub struct SettingsState {
    pub db: Db,
    /// Bộ xác định IP khách dùng chung của tiến trình: nguồn câu cảnh báo TRUSTED_PROXY.
    pub client_ip: Arc<ClientIpResolver>,
}

/// `PlanTokenGuard`: `expected` là `TRINITY_PLAN_ADMIN_TOKEN` đọc lúc khởi động (rỗng/thiếu ⇒ khoá với mọi người).
pub struct PlanTokenGuard {
    pub expected: Option<String>,
}

impl NamedGuard for PlanTokenGuard {
    fn check<'a>(&'a self, req: &'a mut Request) -> GuardFuture<'a> {
        Box::pin(async move {
            let provided = req.headers().get(PLAN_TOKEN_HEADER).and_then(|v| v.to_str().ok());
            if features::verify_plan_token(provided, self.expected.as_deref()) {
                Ok(())
            } else {
                Err(features::plan_token_denied())
            }
        })
    }
}

/// Guard theo tên cho `AccessDeps::guards` của router này.
pub fn named_guards(expected: Option<String>) -> BTreeMap<&'static str, Arc<dyn NamedGuard>> {
    BTreeMap::from([(
        "PlanTokenGuard",
        Arc::new(PlanTokenGuard { expected }) as Arc<dyn NamedGuard>,
    )])
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

/// Công ty của token không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
async fn open(s: &SettingsState, u: &CurrentUser) -> Result<(TenantConn, Ctx), Response> {
    let Ok(company) = CompanyRef::new(i64::from(u.user.company_id)) else {
        return Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")));
    };
    let ctx = Ctx {
        company_id: s.db.multi_tenant().then_some(company.id()),
    };
    let tenant = s.db.tenant(company).await.map_err(|e| fail(AppError::internal(e)))?;
    let conn = tenant.acquire().await.map_err(|e| fail(AppError::internal(e)))?;
    Ok((conn, ctx))
}

macro_rules! open {
    ($s:expr, $u:expr) => {
        match open(&$s, &$u).await {
            Ok(x) => x,
            Err(r) => return r,
        }
    };
}

/// `ParseIntPipe` đã chạy ở router: số ngoài int4 thì không có tuỳ chọn nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy option ID {raw}")).into())
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

fn query_value(q: &HashMap<String, String>) -> Value {
    Value::Object(q.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
}

async fn options_list(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let query = match validate_query_options(&query_value(&q)) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _) = open!(s, u);
    ok(options::list(&mut c, &query).await)
}

async fn options_create(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match validate_create_option(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _) = open!(s, u);
    ok(options::create(&mut c, &dto, u.user.user_id).await)
}

async fn options_update(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match validate_update_option(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _) = open!(s, u);
    ok(options::update(&mut c, id, &dto, u.user.user_id).await)
}

async fn options_remove(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let id = match id_of(&id) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _) = open!(s, u);
    ok(options::remove(&mut c, id, u.user.user_id).await)
}

async fn sound_get(State(s): State<Arc<SettingsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let (mut c, _) = open!(s, u);
    Json(general::get_notification_sound(&mut c).await).into_response()
}

async fn sound_update(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let sound = match validate_update_notification_sound(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _) = open!(s, u);
    ok(general::update_notification_sound(&mut c, &sound, u.user.user_id).await)
}

/// Cảnh báo "không xác định được IP thật" chỉ dành cho quản trị viên (`settings.integrations`) của công ty vận hành
/// (công ty 1); người khác nhận `warning: null`.
async fn client_ip_alerts(State(s): State<Arc<SettingsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let operator = u.user.company_id == 1 && trinity_rbac::can(&u.grants.grants, "settings.integrations", None);
    let warning = if operator { s.client_ip.warning() } else { None };
    Json(serde_json::json!({ "warning": warning })).into_response()
}

async fn departments_get(State(s): State<Arc<SettingsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let (mut c, _) = open!(s, u);
    Json(general::get_departments(&mut c).await).into_response()
}

async fn departments_update(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let list = match validate_update_departments(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, _) = open!(s, u);
    ok(general::update_departments(&mut c, &list, u.user.user_id).await)
}

async fn features_get(State(s): State<Arc<SettingsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let (mut c, ctx) = open!(s, u);
    ok(features::get(&mut c, ctx).await)
}

async fn features_update(
    State(s): State<Arc<SettingsState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let dto = match validate_org_features(&body) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (mut c, ctx) = open!(s, u);
    let r = features::update(&mut c, ctx, &dto, u.user.user_id).await;
    ok(r.map(|updated| updated.features))
}

async fn usage_get(State(s): State<Arc<SettingsState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let (mut c, ctx) = open!(s, u);
    ok(features::usage_summary(&mut c, ctx).await)
}

async fn plan_set(State(s): State<Arc<SettingsState>>, Extension(u): Extension<CurrentUser>, req: Request) -> Response {
    let ip = req
        .extensions()
        .get::<ClientIp>()
        .and_then(|c| c.ip)
        .map(|i| i.to_string());
    let JsonBody(body) = match JsonBody::from_request(req, &()).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let plan = match validate_plan_body(&body) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let (mut c, ctx) = open!(s, u);
    if let Err(e) = features::set_plan(&mut c, ctx, plan, Some(u.user.user_id), "api", ip.as_deref()).await {
        return fail(e);
    }
    ok(features::usage_summary(&mut c, ctx).await)
}

/// Router của module (13 route). Người gọi gắn state `Arc<SettingsState>`; `deps.guards` phải có `PlanTokenGuard`
/// ([`named_guards`]).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<SettingsState>> {
    let s = crate::routes::routes();
    let spec = |m: &Method, p: &str| -> RouteSpec {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/settings/options"), options_list)
        .route(spec(&Method::POST, "/api/v1/settings/options"), options_create)
        .route(spec(&Method::PATCH, "/api/v1/settings/options/:id"), options_update)
        .route(spec(&Method::DELETE, "/api/v1/settings/options/:id"), options_remove)
        .route(spec(&Method::GET, "/api/v1/settings/notification-sound"), sound_get)
        .route(
            spec(&Method::PATCH, "/api/v1/settings/notification-sound"),
            sound_update,
        )
        .route(spec(&Method::GET, "/api/v1/settings/client-ip/alerts"), client_ip_alerts)
        .route(spec(&Method::GET, "/api/v1/settings/departments"), departments_get)
        .route(spec(&Method::PATCH, "/api/v1/settings/departments"), departments_update)
        .route(spec(&Method::GET, "/api/v1/settings/org-features"), features_get)
        .route(spec(&Method::PUT, "/api/v1/settings/org-features"), features_update)
        .route(spec(&Method::GET, "/api/v1/settings/usage"), usage_get)
        .route(spec(&Method::PUT, "/api/v1/settings/plan"), plan_set)
}
