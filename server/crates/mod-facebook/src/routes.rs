//! Bảng route của M46 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Quyền `integrations.webhooks` cho mọi route trừ callback OAuth, công khai và xác thực bằng `state`
//! ký HMAC gắn với người bấm "Kết nối". Webhook (M47a) công khai, xác thực bằng verify token và chữ ký trên byte thô; sự kiện
//! đi qua [`FacebookIngest`] (M47b). Link mở chat, hội thoại, bình luận… thuộc M48 trở đi.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http::Method;
use mod_channel_guard::ChannelGuard;
use serde::Serialize;
use serde_json::{Map, Value, json};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, OrgFeatureGate, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;

use crate::config::{Env, FORWARDED_HEADER, load_facebook_config};
use crate::graph::{GRAPH_TIMEOUT, GraphClient, Observer};
use crate::ingest::{FacebookIngest, GraphFactory};
use crate::pages::{self, UpdatePage};
use crate::webhook::{HttpForwarder, PlatformRouter, Receiver, verify};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 7 route của `FacebookController` (kết nối) và `callback`, 2 route webhook (M47a), 3 route hộp thư (M48).
pub fn routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["integrations.webhooks"]);
    // Tính năng tổ chức `facebook_page` (kèm `OrgFeatureGuard`) áp cho mọi route quản trị; callback công khai không có.
    let r =
        |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, manage).status_ok(ok).org_feature("facebook_page");
    vec![
        r(Method::GET, "/api/v1/facebook/status", 200),
        r(Method::POST, "/api/v1/facebook/connect-url", 200),
        r(Method::GET, "/api/v1/facebook/pages", 200),
        r(Method::PATCH, "/api/v1/facebook/pages/:id", 200).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/pages/:id/check", 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/facebook/pages/:id", 204).param_pipes(ID),
        // Hộp thư Messenger (M48).
        r(Method::GET, "/api/v1/facebook/conversations", 200),
        r(Method::GET, "/api/v1/facebook/conversations/:id/messages", 200).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/conversations/:id/messages", 201).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/facebook/oauth/callback", Access::Public),
        // Webhook của Meta (M47a): công khai, xác thực bằng verify token (GET) và chữ ký `X-Hub-Signature-256` (POST).
        RouteSpec::new(Method::GET, "/api/v1/facebook/webhook", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/facebook/webhook", Access::Public).status_ok(200),
    ]
}

/// 7 route bình luận và luật tự động của `FacebookController` (M49). Tầng route (api_router) gộp vào bảng chung.
pub fn comment_routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["integrations.webhooks"]);
    let r =
        |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, manage).status_ok(ok).org_feature("facebook_page");
    vec![
        r(Method::GET, "/api/v1/facebook/comments", 200),
        r(Method::POST, "/api/v1/facebook/comments/:id/reply", 201),
        r(Method::GET, "/api/v1/facebook/comment-rules", 200),
        r(Method::POST, "/api/v1/facebook/comment-rules", 201),
        r(Method::PATCH, "/api/v1/facebook/comment-rules/:id", 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/facebook/comment-rules/:id", 204).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/comment-rules/dry-run", 200),
    ]
}

/// Dựng client Graph cho từng công ty: mỗi lời gọi báo kết quả cho `ChannelGuard` của công ty đó (M45).
pub fn graph_factory(env: Env, guard: ChannelGuard) -> GraphFactory {
    let http = reqwest::Client::builder()
        .timeout(GRAPH_TIMEOUT)
        .build()
        .unwrap_or_default();
    Arc::new(move |company: CompanyRef| {
        let g = guard.clone();
        let observer: Observer = Arc::new(move |o| g.record_graph(company, o));
        GraphClient::with_http(env.clone(), observer, http.clone())
    })
}

/// Trạng thái của router: DB, nền tảng đa công ty, env, phạm vi quyền, Graph và bộ nhận webhook (xử lý bằng
/// [`FacebookIngest`] của M47b).
pub struct FacebookState {
    pub db: Db,
    pub platform: Platform,
    pub env: Env,
    pub scopes: ScopeService,
    pub graph_for: GraphFactory,
    pub receiver: Receiver,
}

impl FacebookState {
    pub fn new(
        db: Db,
        platform: Platform,
        env: Env,
        scopes: ScopeService,
        guard: ChannelGuard,
        features: Arc<dyn OrgFeatureGate>,
    ) -> Self {
        let graph_for = graph_factory(env.clone(), guard);
        let receiver = Receiver {
            env: env.clone(),
            router: Arc::new(PlatformRouter {
                db: db.clone(),
                platform: platform.clone(),
            }),
            features,
            processor: Arc::new(
                FacebookIngest::new(db.clone(), env.clone(), graph_for.clone()).with_guard(Arc::new(guard.clone())),
            ),
            forwarder: Arc::new(HttpForwarder {
                http: reqwest::Client::new(),
            }),
        };
        Self {
            db,
            platform,
            env,
            scopes,
            graph_for,
            receiver,
        }
    }

    /// Ngữ cảnh của `pages` cho một công ty; `graph` do người gọi giữ (client Graph của công ty đó).
    fn pages_ctx<'a>(&'a self, graph: &'a GraphClient, company: CompanyRef) -> pages::Ctx<'a> {
        pages::Ctx {
            db: &self.db,
            env: &self.env,
            graph,
            platform: &self.platform,
            company,
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
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
macro_rules! company {
    ($u:expr) => {
        match CompanyRef::new(i64::from($u.user.company_id)) {
            Ok(c) => c,
            Err(_) => return fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")),
        }
    };
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có Page nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy Fanpage").into())
}

async fn tenant_conn(db: &Db, company: CompanyRef) -> Result<TenantConn, AppError> {
    db.tenant(company)
        .await
        .map_err(AppError::internal)?
        .acquire()
        .await
        .map_err(AppError::internal)
}

fn found(url: &str) -> Response {
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::FOUND;
    if let Ok(v) = HeaderValue::from_str(url) {
        r.headers_mut().insert(header::LOCATION, v);
    }
    r
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

async fn status(State(s): State<Arc<FacebookState>>) -> Response {
    Json(pages::status(&s.env)).into_response()
}

async fn connect_url(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    let graph = (s.graph_for)(company);
    ok(pages::connect_url(&s.pages_ctx(&graph, company), u.user.user_id, now_ms()).await)
}

async fn list(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    let rows = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        pages::list(&mut conn).await
    }
    .await;
    ok(rows.map(|data| json!({ "data": data })))
}

async fn update(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match UpdatePage::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    // Phạm vi `contacts.transfer` của người gọi, để kiểm người nhận Lead Ads.
    let transfer = match s
        .scopes
        .owner_ids(company, u.user.user_id, &u.grants.grants, "contacts.transfer")
        .await
    {
        Ok(t) => t,
        Err(e) => return fail(AppError::internal(e)),
    };
    let view = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        pages::update(&mut conn, id, &input, u.user.user_id, transfer.as_ref()).await
    }
    .await;
    ok(view)
}

async fn check(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let graph = (s.graph_for)(company);
    // `refreshMissingNames` (M48) chưa có ở Rust: bổ sung khi M48 vào.
    ok(pages::check_token(&s.pages_ctx(&graph, company), id, now_ms()).await)
}

async fn disconnect(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_of(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let graph = (s.graph_for)(company);
    match pages::disconnect(&s.pages_ctx(&graph, company), id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

fn param<'a>(q: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    q.get(key).map(String::as_str)
}

/// Công ty đã mở luồng OAuth theo `state` (nhiều công ty); một công ty thì luôn công ty mặc định.
async fn oauth_company(platform: &Platform, state: &str) -> Option<CompanyRef> {
    if !platform.multi_tenant() {
        return Some(CompanyRef::DEFAULT);
    }
    let id = platform.company_for_oauth_state(state).await.ok()??;
    CompanyRef::new(i64::from(id)).ok()
}

async fn callback(State(s): State<Arc<FacebookState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let base = load_facebook_config(&s.env).base_url.unwrap_or_default();
    let back = |tail: &str| found(&format!("{base}/connections?muc=facebook&{tail}"));
    let get = |k: &str| param(&q, k).filter(|v| !v.is_empty());
    let (Some(code), Some(state)) = (get("code"), get("state")) else {
        return back("facebook=cancelled");
    };
    if get("error").is_some() {
        return back("facebook=cancelled");
    }
    let Some(company) = oauth_company(&s.platform, state).await else {
        return back("facebook=error");
    };
    let graph = (s.graph_for)(company);
    match pages::handle_callback(&s.pages_ctx(&graph, company), code, state, now_ms()).await {
        Ok(r) => back(&format!(
            "facebook=connected&pages={}&failed={}&posting={}",
            r.connected, r.failed, r.posting
        )),
        Err(_) => back("facebook=error"),
    }
}

/// `GET /facebook/webhook`: trả nguyên `hub.challenge` (Express gửi chuỗi dạng `text/html`).
async fn webhook_verify(State(s): State<Arc<FacebookState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let get = |k: &str| param(&q, k);
    let (mode, token, challenge) = (get("hub.mode"), get("hub.verify_token"), get("hub.challenge"));
    match verify(&s.env, mode, token, challenge) {
        Ok(challenge) => (
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            )],
            challenge,
        )
            .into_response(),
        Err(e) => fail(e),
    }
}

/// `POST /facebook/webhook`: chữ ký tính trên BYTE THÔ của thân nên đọc `Bytes` rồi mới parse JSON.
async fn webhook_receive(State(s): State<Arc<FacebookState>>, headers: HeaderMap, body: Bytes) -> Response {
    let parsed = if body.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Map::new())
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => v,
            Err(_) => return fail(HttpError::bad_request("Unexpected token in JSON")),
        }
    };
    let signature = headers.get("x-hub-signature-256").and_then(|v| v.to_str().ok());
    let forwarded = headers.contains_key(FORWARDED_HEADER);
    let raw = (!body.is_empty()).then_some(body.as_ref());
    match s.receiver.receive(raw, signature, &parsed, forwarded).await {
        Ok(_) => Json(json!({ "status": "ok" })).into_response(),
        Err(e) => fail(e),
    }
}

/// Router của module: 9 route, quyền và mã thành công khớp `routes.json`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<FacebookState>> {
    let table = routes();
    let spec = |m: &Method, p: &str| {
        table
            .iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/facebook/status"), status)
        .route(spec(&Method::POST, "/api/v1/facebook/connect-url"), connect_url)
        .route(spec(&Method::GET, "/api/v1/facebook/pages"), list)
        .route(spec(&Method::PATCH, "/api/v1/facebook/pages/:id"), update)
        .route(spec(&Method::POST, "/api/v1/facebook/pages/:id/check"), check)
        .route(spec(&Method::DELETE, "/api/v1/facebook/pages/:id"), disconnect)
        .route(spec(&Method::GET, "/api/v1/facebook/oauth/callback"), callback)
        .route(spec(&Method::GET, "/api/v1/facebook/webhook"), webhook_verify)
        .route(spec(&Method::POST, "/api/v1/facebook/webhook"), webhook_receive)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 12);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 12);
    }
}
