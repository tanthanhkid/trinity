//! Bảng route của M46 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Quyền `integrations.webhooks` cho mọi route trừ callback OAuth, công khai và xác thực bằng `state`
//! ký HMAC gắn với người bấm "Kết nối". Webhook (M47a) công khai, xác thực bằng verify token và chữ ký trên byte thô; sự kiện
//! đi qua [`FacebookIngest`] (M47b). Bảng [`routes`] gộp cả hộp thư (M48), bình luận (M49), link mở chat (M50 phần 1) và gửi hàng
//! loạt (M51); 6 route `flows` thuộc M50 phần 2 nên chưa có (TODO).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use http::Method;
use mod_channel_guard::ChannelGuard;
use serde::Serialize;
use serde_json::{Map, Value, json};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, OrgFeatureGate, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;

use crate::broadcast::{BroadcastInput, parse_preview, parse_send};
use crate::chat_links::{ChatLinkInput, LinkUrls};
use crate::comments::{CommentCtx, CommentReply, DryRunInput, ListQuery, validate_rule_body};
use crate::config::{Env, FORWARDED_HEADER, load_facebook_config};
use crate::graph::{GRAPH_TIMEOUT, GraphClient, Observer};
use crate::inbox::parse_reply_text;
use crate::ingest::{FacebookIngest, GraphFactory};
use crate::pages::{self, UpdatePage};
use crate::webhook::{HttpForwarder, PlatformRouter, Receiver, verify};
use crate::{chat_links, comments};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// Mọi route Facebook đã có service (34): kết nối và hộp thư (17), bình luận (7), gửi hàng loạt (9), `tick`. 6 route `flows` ở `flows::flow_routes`
/// (M50b). `trinity-bin` khai bảng này.
pub fn routes() -> Vec<RouteSpec> {
    let mut v = connect_routes();
    v.extend(comment_routes());
    v.extend(crate::broadcast::broadcast_routes());
    v.push(
        RouteSpec::new(
            Method::POST,
            "/api/v1/facebook/tick",
            Access::Can(&["integrations.webhooks"]),
        )
        .status_ok(200)
        .org_feature("facebook_page"),
    );
    v
}

/// 7 route của `FacebookController` (kết nối) và `callback`, 2 route webhook (M47a), 3 route hộp thư (M48), 4 route link mở chat
/// và `go/:code` (M50 phần 1).
pub fn connect_routes() -> Vec<RouteSpec> {
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
        // Link/QR mở chat (M50).
        r(Method::GET, "/api/v1/facebook/chat-links", 200),
        r(Method::POST, "/api/v1/facebook/chat-links", 201),
        r(Method::PATCH, "/api/v1/facebook/chat-links/:id", 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/facebook/chat-links/:id", 204).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/facebook/go/:code", Access::Public),
        RouteSpec::new(Method::GET, "/api/v1/facebook/oauth/callback", Access::Public),
        // Webhook của Meta (M47a): công khai, xác thực bằng verify token (GET) và chữ ký `X-Hub-Signature-256` (POST).
        RouteSpec::new(Method::GET, "/api/v1/facebook/webhook", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/facebook/webhook", Access::Public).status_ok(200),
    ]
}

/// 7 route bình luận và luật tự động của `FacebookController` (M49); [`routes`] gộp vào bảng chung.
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
    /// Dịch vụ hộp thư, bình luận, link chat, gửi hàng loạt (cùng bản cài `EntryProcessor` của `receiver`).
    pub ingest: Arc<FacebookIngest>,
    pub guard: ChannelGuard,
    /// Công ty đang có lượt chạy nền gửi hàng loạt do `send`/`tick` kích (không chồng lượt trong một tiến trình).
    running: Arc<Mutex<HashSet<CompanyRef>>>,
}

/// Quỹ thời gian một lượt chạy nền do `send`/`tick` kích; nhỏ hơn ngân sách job (30 giây).
const KICK_BUDGET: Duration = Duration::from_secs(25);

impl FacebookState {
    pub fn new(
        db: Db,
        platform: Platform,
        env: Env,
        scopes: ScopeService,
        guard: ChannelGuard,
        features: Arc<dyn OrgFeatureGate>,
    ) -> Self {
        let graph_for = graph_factory(env.clone(), guard.clone());
        let ingest = Arc::new(
            FacebookIngest::new(db.clone(), env.clone(), graph_for.clone()).with_guard(Arc::new(guard.clone())),
        );
        let receiver = Receiver {
            env: env.clone(),
            router: Arc::new(PlatformRouter {
                db: db.clone(),
                platform: platform.clone(),
            }),
            features,
            processor: ingest.clone(),
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
            ingest,
            guard,
            running: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// `kick()`: chạy nền một lượt gửi hàng loạt cho công ty (không chồng nhau trong tiến trình; job nền và lượt khác nếu có vẫn an
    /// toàn vì người nhận được giành bằng điều kiện trạng thái).
    fn kick_broadcasts(&self, company: CompanyRef) {
        let first = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(company);
        if !first {
            return;
        }
        let ingest = Arc::clone(&self.ingest);
        let guard = self.guard.clone();
        let running = Arc::clone(&self.running);
        tokio::spawn(async move {
            let res = ingest
                .broadcasts_run_due(company, Some(&guard), KICK_BUDGET, Utc::now())
                .await;
            if let Err(e) = res {
                tracing::error!("Gửi hàng loạt nền lỗi: {e}");
            }
            running.lock().unwrap_or_else(PoisonError::into_inner).remove(&company);
        });
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

pub(crate) fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

pub(crate) fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
macro_rules! company {
    ($u:expr) => {
        match trinity_db::CompanyRef::new(i64::from($u.user.company_id)) {
            Ok(c) => c,
            Err(_) => return fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")),
        }
    };
}
pub(crate) use company;

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
pub(crate) struct JsonBody(pub(crate) Value);

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
    let page = pages::check_token(&s.pages_ctx(&graph, company), id, now_ms()).await;
    // Token còn sống thì lấy lại tên khách còn tên tạm; lỗi ở đây không làm hỏng việc chính (`.catch(() => 0)`).
    if let Ok(p) = &page
        && p.token_status == "active"
    {
        let _ = s.ingest.refresh_missing_names(company, &p.page_id).await;
    }
    ok(page)
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

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào ⇒ 404 với câu của từng loại.
fn id_or_404(raw: &str, what: &'static str) -> Result<i32, AppError> {
    raw.parse::<i32>().map_err(|_| HttpError::not_found(what).into())
}

fn data<T: Serialize>(r: Result<T, AppError>) -> Response {
    ok(r.map(|d| json!({ "data": d })))
}

fn no_content(r: Result<(), AppError>) -> Response {
    match r {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

fn link_urls(s: &FacebookState, company: CompanyRef) -> LinkUrls {
    LinkUrls::from_env(&s.env, s.platform.multi_tenant(), company)
}

// ───────────────────────── hộp thư (M48)

async fn conversations(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let company = company!(u);
    ok(s.ingest
        .list_conversations(company, param(&q, "limit"), param(&q, "unanswered"), now_ms())
        .await)
}

async fn conversation_messages(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, "Không tìm thấy hội thoại") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    ok(s.ingest.messages(company, id, now_ms()).await)
}

async fn conversation_reply(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let text = match parse_reply_text(&body) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };
    let id = match id_or_404(&id, "Không tìm thấy hội thoại") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    ok(s.ingest
        .reply(company, Some(&s.guard), id, &text, u.user.user_id, Utc::now())
        .await)
}

// ───────────────────────── bình luận và luật tự động (M49)

async fn list_comments(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let company = company!(u);
    let query = ListQuery::from_params(param(&q, "limit"), param(&q, "status"), param(&q, "unanswered"));
    let rows = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        comments::list_comments(&mut conn, &query, Utc::now()).await
    }
    .await;
    data(rows)
}

async fn reply_comment(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match CommentReply::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let graph = (s.graph_for)(company);
    let ctx = CommentCtx {
        db: &s.db,
        env: &s.env,
        graph: &graph,
        guard: Some(&s.guard),
        company,
    };
    ok(comments::reply_manually(&ctx, &id, &input, Some(u.user.user_id), Utc::now()).await)
}

async fn list_rules(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    let rows = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        comments::list_rules(&mut conn).await
    }
    .await;
    data(rows)
}

async fn create_rule(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let rule = match validate_rule_body(&body) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let saved = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        comments::create_rule(&mut conn, &rule, u.user.user_id).await
    }
    .await;
    ok(saved)
}

async fn update_rule(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let rule = match validate_rule_body(&body) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let id = match id_or_404(&id, "Không tìm thấy luật") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let saved = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        comments::update_rule(&mut conn, id, &rule).await
    }
    .await;
    ok(saved)
}

async fn delete_rule(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, "Không tìm thấy luật") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let done = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        comments::delete_rule(&mut conn, id).await
    }
    .await;
    no_content(done)
}

async fn dry_run(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match DryRunInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let out = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        comments::dry_run(&mut conn, &input).await
    }
    .await;
    ok(out)
}

// ───────────────────────── link/QR mở chat (M50 phần 1)

async fn list_chat_links(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    let urls = link_urls(&s, company);
    let out = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        chat_links::list(&mut conn, &urls).await
    }
    .await;
    ok(out)
}

async fn create_chat_link(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match ChatLinkInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let urls = link_urls(&s, company);
    let out = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        chat_links::create(&mut conn, &input, u.user.user_id, &urls).await
    }
    .await;
    ok(out)
}

async fn update_chat_link(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match ChatLinkInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let id = match id_or_404(&id, "Không tìm thấy link") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let urls = link_urls(&s, company);
    let out = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        chat_links::update(&mut conn, id, &input, &urls).await
    }
    .await;
    ok(out)
}

async fn delete_chat_link(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, "Không tìm thấy link") {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let done = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        chat_links::remove(&mut conn, id).await
    }
    .await;
    no_content(done)
}

/// Công ty của đường công khai `go/:code` (không có JWT): bản một công ty ⇒ công ty mặc định; nhiều công ty ⇒ `?cid=` hoặc header
/// `x-trinity-company` (số nguyên dương), không có thì công ty 1; công ty không tồn tại hoặc bị treo ⇒ 404 (không rơi về công ty 1).
async fn public_company(
    platform: &Platform,
    q: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<CompanyRef, AppError> {
    if !platform.multi_tenant() {
        return Ok(CompanyRef::DEFAULT);
    }
    let raw = param(q, "cid").or_else(|| headers.get("x-trinity-company").and_then(|v| v.to_str().ok()));
    let id = raw
        .and_then(|r| r.trim().parse::<f64>().ok())
        .filter(|n| n.fract() == 0.0 && *n > 0.0)
        .map_or(1, |n| n as i64);
    platform
        .active_company(id)
        .await
        .map_err(AppError::internal)?
        .ok_or_else(|| HttpError::not_found(LINK_NOT_FOUND).into())
}

const LINK_NOT_FOUND: &str = "Link không tồn tại hoặc đã bị xoá";

/// `GET /facebook/go/:code` (công khai): đếm lượt mở rồi chuyển sang Messenger của Page kèm mã nguồn (302, `no-store`).
async fn go(
    State(s): State<Arc<FacebookState>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let target = async {
        let company = public_company(&s.platform, &q, &headers).await?;
        let mut conn = tenant_conn(&s.db, company).await?;
        chat_links::open(&mut conn, &code).await
    }
    .await;
    match target {
        Ok(Some(url)) => {
            let mut r = found(&url);
            r.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r
        }
        Ok(None) => fail(HttpError::not_found(LINK_NOT_FOUND)),
        Err(e) => fail(e),
    }
}

// ───────────────────────── gửi hàng loạt (M51) và tick

async fn list_broadcasts(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    ok(s.ingest.list_broadcasts(company).await)
}

async fn create_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match BroadcastInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    ok(s.ingest.create_broadcast(company, &input, u.user.user_id, "web").await)
}

async fn preview_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let (page_id, audience) = match parse_preview(&body) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    ok(s.ingest
        .preview_broadcast(company, &page_id, &audience, Utc::now())
        .await)
}

async fn get_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, BROADCAST_NOT_FOUND) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    ok(s.ingest.get_broadcast(company, id).await)
}

const BROADCAST_NOT_FOUND: &str = "Không tìm thấy lượt gửi";

async fn update_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match BroadcastInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let id = match id_or_404(&id, BROADCAST_NOT_FOUND) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    ok(s.ingest.update_broadcast(company, id, &input).await)
}

async fn delete_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, BROADCAST_NOT_FOUND) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    no_content(s.ingest.delete_broadcast(company, id).await)
}

async fn broadcast_recipients(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, BROADCAST_NOT_FOUND) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    ok(s.ingest.broadcast_recipients(company, id).await)
}

async fn send_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let at = match parse_send(&body) {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    let id = match id_or_404(&id, BROADCAST_NOT_FOUND) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    let sent = s
        .ingest
        .send_broadcast(company, Some(&s.guard), id, at.as_deref(), Utc::now())
        .await;
    // Gửi ngay (không hẹn giờ) thì chạy nền luôn như `kick()`; hẹn giờ để job/tick lo.
    if sent.is_ok() && at.is_none() {
        s.kick_broadcasts(company);
    }
    ok(sent)
}

async fn cancel_broadcast(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match id_or_404(&id, BROADCAST_NOT_FOUND) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    ok(s.ingest.cancel_broadcast(company, id).await)
}

async fn tick(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    ok(s.ingest.facebook_tick(company, chrono::Utc::now()).await)
}

/// Router của module: 34 route, quyền và mã thành công khớp `routes.json`.
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
        // Hộp thư (M48).
        .route(spec(&Method::GET, "/api/v1/facebook/conversations"), conversations)
        .route(spec(&Method::GET, "/api/v1/facebook/conversations/:id/messages"), conversation_messages)
        .route(spec(&Method::POST, "/api/v1/facebook/conversations/:id/messages"), conversation_reply)
        // Bình luận và luật tự động (M49).
        .route(spec(&Method::GET, "/api/v1/facebook/comments"), list_comments)
        .route(spec(&Method::POST, "/api/v1/facebook/comments/:id/reply"), reply_comment)
        .route(spec(&Method::GET, "/api/v1/facebook/comment-rules"), list_rules)
        .route(spec(&Method::POST, "/api/v1/facebook/comment-rules"), create_rule)
        .route(spec(&Method::POST, "/api/v1/facebook/comment-rules/dry-run"), dry_run)
        .route(spec(&Method::PATCH, "/api/v1/facebook/comment-rules/:id"), update_rule)
        .route(spec(&Method::DELETE, "/api/v1/facebook/comment-rules/:id"), delete_rule)
        // Link/QR mở chat (M50 phần 1).
        .route(spec(&Method::GET, "/api/v1/facebook/chat-links"), list_chat_links)
        .route(spec(&Method::POST, "/api/v1/facebook/chat-links"), create_chat_link)
        .route(spec(&Method::PATCH, "/api/v1/facebook/chat-links/:id"), update_chat_link)
        .route(spec(&Method::DELETE, "/api/v1/facebook/chat-links/:id"), delete_chat_link)
        .route(spec(&Method::GET, "/api/v1/facebook/go/:code"), go)
        // Gửi hàng loạt (M51) và tick.
        .route(spec(&Method::GET, "/api/v1/facebook/broadcasts"), list_broadcasts)
        .route(spec(&Method::POST, "/api/v1/facebook/broadcasts"), create_broadcast)
        .route(spec(&Method::POST, "/api/v1/facebook/broadcasts/preview"), preview_broadcast)
        .route(spec(&Method::GET, "/api/v1/facebook/broadcasts/:id"), get_broadcast)
        .route(spec(&Method::PATCH, "/api/v1/facebook/broadcasts/:id"), update_broadcast)
        .route(spec(&Method::DELETE, "/api/v1/facebook/broadcasts/:id"), delete_broadcast)
        .route(spec(&Method::GET, "/api/v1/facebook/broadcasts/:id/recipients"), broadcast_recipients)
        .route(spec(&Method::POST, "/api/v1/facebook/broadcasts/:id/send"), send_broadcast)
        .route(spec(&Method::POST, "/api/v1/facebook/broadcasts/:id/cancel"), cancel_broadcast)
        .route(spec(&Method::POST, "/api/v1/facebook/tick"), tick)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 34);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 34);
    }
}
