//! Router axum của `SocialController` và `SocialPublicController` (K14): path, method, quyền, mã thành công và `org_feature` lấy
//! từ [`crate::routes`] (đã so với `contracts/routes.json`).
//!
//! Mount: 40 route của [`crate::routes::routes`] (gồm import CSV và bài lặp M55b, nối `PostsAdapter` của M54b) và 5 route
//! tải video theo phần ([`crate::routes::upload_routes`]).
//!
//! Ngoài bảng route hiện có (chưa port): `POST /social/drafts/:id/publish`, `posts/:id/metrics`, `posts/sync`, `stats`, `tick`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{DefaultBodyLimit, Extension, FromRequest, Multipart, Path, Query, Request, State};
use axum::handler::Handler;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::TryStreamExt;
use mod_channel_guard::ChannelGuard;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::ingest::GraphFactory;
use mod_facebook::pages::Ctx as PagesCtx;
use mod_facebook::state::jwt_secret;
use serde::Serialize;
use serde_json::{Map, Value, json};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::js_iso_string;

use crate::adapters::{DraftsAdapter, PostsAdapter, QueueAdapter};
use crate::drafts::{self, DraftInput};
use crate::dto::{PostInput, SocialConnect, parse_reschedule};
use crate::dto_recur::{ImportBody, ImportPlanBody, RecurrenceBody};
use crate::import::{self, ImportPorts};
use crate::media::{self, LibraryQuery, MAX_IMAGE_BYTES, MAX_STORED_VIDEO_BYTES, MediaCtx, MediaFile, MediaStore};
use crate::posts::{self, ListQuery, PostCtx};
use crate::snippets::{self, SnippetInput};
use crate::{accounts, chunked, queue, recurrences, routes};

/// Thân JSON tối đa (như `body-parser` mặc định của Express).
const JSON_LIMIT: usize = 5 * 1024 * 1024;
const MIB: usize = 1024 * 1024;

/// Trạng thái của router: DB, nền tảng đa công ty, env, Graph theo công ty, bộ chặn kênh và kho tệp.
pub struct SocialState {
    pub db: Db,
    pub platform: Platform,
    pub env: Env,
    pub graph_for: GraphFactory,
    pub guard: ChannelGuard,
    pub store: MediaStore,
}

impl SocialState {
    fn media_ctx(&self, company: CompanyRef, user_id: i32) -> MediaCtx<'_> {
        MediaCtx {
            db: &self.db,
            company,
            store: &self.store,
            env: &self.env,
            user_id,
            now_ms: now_ms(),
        }
    }

    fn post_ctx<'a>(&'a self, graph: &'a GraphClient, company: CompanyRef, user_id: i32) -> PostCtx<'a> {
        PostCtx {
            db: &self.db,
            company,
            env: &self.env,
            store: &self.store,
            graph,
            guard: &self.guard,
            user_id,
            now_ms: now_ms(),
        }
    }
}

type St = State<Arc<SocialState>>;
type Usr = Extension<CurrentUser>;

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

/// `{ data }` như các route trả `{ data: await ... }` ở bản Node.
fn data<T: Serialize>(r: Result<T, AppError>) -> Response {
    ok(r.map(|d| json!({ "data": d })))
}

fn no_content(r: Result<(), AppError>) -> Response {
    match r {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
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

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
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
        let bytes: Bytes = to_bytes(req.into_body(), JSON_LIMIT)
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

fn param<'a>(q: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    q.get(key).map(String::as_str)
}

// ───────────────────────────── tài khoản ─────────────────────────────

async fn networks(State(s): St) -> Response {
    Json(json!({ "data": accounts::networks(&s.env) })).into_response()
}

async fn list_accounts(State(s): St, Extension(u): Usr) -> Response {
    let company = company!(u);
    let r = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        accounts::list(&mut conn).await
    }
    .await;
    data(r)
}

async fn connect_url(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let dto = match SocialConnect::from_json(&body) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let graph = (s.graph_for)(company);
    let ctx = PagesCtx {
        db: &s.db,
        env: &s.env,
        graph: &graph,
        platform: &s.platform,
        company,
    };
    ok(accounts::connect_url(&ctx, &dto.network, u.user.user_id, now_ms()).await)
}

async fn enable_account(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "kênh")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        accounts::enable(&mut conn, id).await
    }
    .await;
    data(r)
}

async fn disconnect_account(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "kênh")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        accounts::disconnect(&mut conn, id).await
    }
    .await;
    no_content(r)
}

/// Công ty đã mở luồng OAuth theo `state` (nhiều công ty); một công ty thì luôn công ty mặc định.
async fn oauth_company(platform: &Platform, state: &str) -> Option<CompanyRef> {
    if !platform.multi_tenant() {
        return Some(CompanyRef::DEFAULT);
    }
    let id = platform.company_for_oauth_state(state).await.ok()??;
    CompanyRef::new(i64::from(id)).ok()
}

/// Callback OAuth công khai: luôn chuyển hướng về `/social?tab=channels`; `state` ký HMAC là xác thực thật.
async fn oauth_callback(
    State(s): St,
    Path(network): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let state = param(&q, "state").filter(|v| !v.is_empty());
    let company = match state {
        Some(st) => oauth_company(&s.platform, st).await,
        None => None,
    }
    .unwrap_or(CompanyRef::DEFAULT);
    let graph = (s.graph_for)(company);
    let ctx = PagesCtx {
        db: &s.db,
        env: &s.env,
        graph: &graph,
        platform: &s.platform,
        company,
    };
    let url = accounts::callback_location(&ctx, &network, param(&q, "code"), state, param(&q, "error"), now_ms()).await;
    found(&url)
}

// ───────────────────────────── media ─────────────────────────────

async fn library(State(s): St, Extension(u): Usr, Query(q): Query<HashMap<String, String>>) -> Response {
    let company = company!(u);
    let r = async {
        let query = LibraryQuery::from_query(
            param(&q, "type"),
            param(&q, "q"),
            param(&q, "limit"),
            param(&q, "cursor"),
        )?;
        let mut conn = tenant_conn(&s.db, company).await?;
        media::list(&mut conn, &query).await
    }
    .await;
    ok(r)
}

/// Đọc multipart như `FileInterceptor('file')`: một trường tệp tên `file` (tệp khác hoặc trùng ⇒ 400), thiếu ⇒ 400 "Thiếu tệp".
async fn read_upload(c: &MediaCtx<'_>, mut mp: Multipart) -> Result<media::SocialMedia, AppError> {
    let mut out = None;
    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        let Some(file_name) = field.file_name().map(str::to_owned) else {
            continue;
        };
        if field.name() != Some("file") || out.is_some() {
            return Err(HttpError::bad_request("Unexpected field").into());
        }
        let stream = Box::pin(field.map_err(std::io::Error::other));
        let reader = tokio_util::io::StreamReader::new(stream);
        out = Some(media::upload_stream(c, &file_name, reader).await?);
    }
    out.ok_or_else(|| HttpError::bad_request("Thiếu tệp").into())
}

async fn upload(State(s): St, Extension(u): Usr, mp: Multipart) -> Response {
    let company = company!(u);
    ok(read_upload(&s.media_ctx(company, u.user.user_id), mp).await)
}

fn file_response(f: MediaFile, disposition: Option<&str>, cache: &'static str) -> Response {
    let mut resp = Response::new(Body::from_stream(f.body.into_stream()));
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&f.content_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if let Some(d) = disposition {
        h.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(d).unwrap_or(HeaderValue::from_static("inline")),
        );
    }
    if let Some(len) = f.content_length
        && let Ok(v) = HeaderValue::from_str(&len.to_string())
    {
        h.insert(header::CONTENT_LENGTH, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    resp
}

async fn media_file(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "tệp trong thư viện")?;
        media::open(&s.db, company, &s.store, id).await
    }
    .await;
    match r {
        Ok(f) => file_response(f, Some("inline"), "private, max-age=3600"),
        Err(e) => fail(e),
    }
}

async fn media_hide(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "tệp trong thư viện")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        media::hide(&mut conn, id).await
    }
    .await;
    ok(r)
}

/// Công ty của link công khai: `?cid=`/`x-trinity-company` nếu có; không thì công ty đã ký trong token (nhiều công ty). Công ty
/// không có hoặc bị treo ⇒ 404.
async fn link_company(
    s: &SocialState,
    q: &HashMap<String, String>,
    headers: &axum::http::HeaderMap,
    token: &str,
) -> Result<CompanyRef, AppError> {
    let not_found = || AppError::from(HttpError::not_found("Not Found"));
    if !s.platform.multi_tenant() {
        return CompanyRef::new(1).map_err(AppError::internal);
    }
    let raw = q
        .get("cid")
        .map(String::as_str)
        .or_else(|| headers.get("x-trinity-company").and_then(|v| v.to_str().ok()));
    let hint = raw
        .and_then(|r| r.trim().parse::<f64>().ok())
        .filter(|n| n.fract() == 0.0 && *n > 0.0)
        .map(|n| n as i64);
    let id = match hint {
        Some(id) => id,
        None => {
            let secret = jwt_secret(&s.env).map_err(|e| HttpError::new(500, e.to_string()))?;
            let v = crate::media_link::verify_media_link(&secret, token, now_ms()).ok_or_else(not_found)?;
            i64::from(v.company_id)
        }
    };
    s.platform
        .active_company(id)
        .await
        .map_err(AppError::internal)?
        .ok_or_else(not_found)
}

async fn media_link(
    State(s): St,
    Path((token, _name)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let r = async {
        let company = link_company(&s, &q, &headers, &token).await?;
        media::open_link(&s.env, company, &s.store, &token, now_ms()).await
    }
    .await;
    match r {
        Ok(f) => file_response(f, None, "private, max-age=600"),
        Err(e) => fail(e),
    }
}

// ───────────────────────────── bài đăng ─────────────────────────────

async fn posts_list(State(s): St, Extension(u): Usr, Query(q): Query<HashMap<String, String>>) -> Response {
    let company = company!(u);
    let r = async {
        let query = ListQuery::from_query(
            param(&q, "status"),
            param(&q, "from"),
            param(&q, "to"),
            param(&q, "limit"),
            param(&q, "cursor"),
        )?;
        let mut conn = tenant_conn(&s.db, company).await?;
        posts::list(&mut conn, &query).await
    }
    .await;
    ok(r)
}

async fn posts_create(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let mut input = PostInput::from_json(&body)?;
        input.source = Some("web".to_owned());
        let graph = (s.graph_for)(company);
        posts::create(&s.post_ctx(&graph, company, u.user.user_id), &input).await
    }
    .await;
    ok(r)
}

async fn posts_preview(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = PostInput::from_json(&body)?;
        let graph = (s.graph_for)(company);
        posts::preview(&s.post_ctx(&graph, company, u.user.user_id), &input).await
    }
    .await;
    data(r)
}

async fn posts_get(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "bài đăng")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        posts::get(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn posts_update(State(s): St, Extension(u): Usr, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = PostInput::from_json(&body)?;
        let id = id_of(&id, "bài đăng")?;
        let graph = (s.graph_for)(company);
        posts::update(&s.post_ctx(&graph, company, u.user.user_id), id, &input).await
    }
    .await;
    ok(r)
}

async fn posts_reschedule(
    State(s): St,
    Extension(u): Usr,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let r = async {
        let at = parse_reschedule(&body)?;
        let id = id_of(&id, "bài đăng")?;
        let graph = (s.graph_for)(company);
        posts::reschedule(&s.post_ctx(&graph, company, u.user.user_id), id, &at).await
    }
    .await;
    ok(r)
}

async fn posts_cancel(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "bài đăng")?;
        let graph = (s.graph_for)(company);
        posts::cancel(&s.post_ctx(&graph, company, u.user.user_id), id).await
    }
    .await;
    ok(r)
}

async fn target_retry(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "kênh của bài")?;
        let graph = (s.graph_for)(company);
        posts::retry(&s.post_ctx(&graph, company, u.user.user_id), id).await
    }
    .await;
    ok(r)
}

async fn target_remote_delete(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        // `id <= 0` ⇒ 400 như `deleteRemote` của Node.
        let n = id.parse::<i64>().unwrap_or(0);
        if n <= 0 {
            return Err(HttpError::bad_request("id không hợp lệ").into());
        }
        let id = id_of(&id, "kênh của bài")?;
        let graph = (s.graph_for)(company);
        posts::delete_remote(&s.post_ctx(&graph, company, u.user.user_id), id).await
    }
    .await;
    ok(r)
}

// ───────────────────────────── nháp ─────────────────────────────

async fn drafts_list(State(s): St, Extension(u): Usr) -> Response {
    let company = company!(u);
    let r = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        drafts::list(&mut conn, now_ms()).await
    }
    .await;
    // Node: `listDrafts` trả thẳng `{ data }` của service.
    data(r)
}

async fn drafts_get(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "bài nháp")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        drafts::get(&mut conn, id, now_ms()).await
    }
    .await;
    data(r)
}

async fn drafts_create(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = DraftInput::from_json(&body)?;
        drafts::create(&s.media_ctx(company, u.user.user_id), &input, "web", None).await
    }
    .await;
    data(r)
}

async fn drafts_update(State(s): St, Extension(u): Usr, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = DraftInput::from_json(&body)?;
        let id = id_of(&id, "bài nháp")?;
        drafts::update(&s.media_ctx(company, u.user.user_id), id, &input).await
    }
    .await;
    data(r)
}

async fn drafts_remove(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "bài nháp")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        drafts::remove(&mut conn, id, now_ms()).await
    }
    .await;
    no_content(r)
}

// ───────────────────────────── mẫu chữ, hàng đợi, bài lặp ─────────────────────────────

async fn snippets_list(State(s): St, Extension(u): Usr, Query(q): Query<HashMap<String, String>>) -> Response {
    let company = company!(u);
    let r = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        snippets::list(&mut conn, param(&q, "kind")).await
    }
    .await;
    data(r)
}

async fn snippets_create(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = SnippetInput::from_json(&body)?;
        let mut conn = tenant_conn(&s.db, company).await?;
        snippets::create(&mut conn, u.user.user_id, &input).await
    }
    .await;
    data(r)
}

async fn snippets_update(
    State(s): St,
    Extension(u): Usr,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let r = async {
        let input = SnippetInput::from_json(&body)?;
        let id = id_of(&id, "mẫu")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        snippets::update(&mut conn, id, &input).await
    }
    .await;
    data(r)
}

async fn snippets_remove(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "mẫu")?;
        let mut conn = tenant_conn(&s.db, company).await?;
        snippets::remove(&mut conn, id).await
    }
    .await;
    no_content(r)
}

async fn queue_slots(State(s): St, Extension(u): Usr) -> Response {
    let company = company!(u);
    let r = async {
        let mut conn = tenant_conn(&s.db, company).await?;
        queue::slots(&mut conn).await
    }
    .await;
    data(r)
}

async fn queue_set_slots(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let slots = queue::parse_slots(&body)?;
        let mut conn = tenant_conn(&s.db, company).await?;
        queue::set_slots(&mut conn, &slots).await
    }
    .await;
    data(r)
}

async fn queue_next(State(s): St, Extension(u): Usr, Query(q): Query<HashMap<String, String>>) -> Response {
    let company = company!(u);
    let r = async {
        let n = queue::next_count_param(param(&q, "count"));
        let mut conn = tenant_conn(&s.db, company).await?;
        let at = queue::next_free(&mut conn, n, now_ms()).await?;
        Ok::<_, AppError>(at.into_iter().map(js_iso_string).collect::<Vec<String>>())
    }
    .await;
    data(r)
}

async fn recurrences_list(State(s): St, Extension(u): Usr) -> Response {
    let company = company!(u);
    let r = async {
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        recurrences::list(&tdb, chrono::Utc::now()).await
    }
    .await;
    data(r)
}

/// Chạy `f` với `PostsAdapter` của công ty (M54b) trên kết nối thuê bao.
macro_rules! with_posts {
    ($s:expr, $company:expr, $posts:ident, $body:block) => {{
        let graph = ($s.graph_for)($company);
        let $posts = PostsAdapter {
            db: &$s.db,
            company: $company,
            env: &$s.env,
            store: &$s.store,
            graph: &graph,
            guard: &$s.guard,
            now_ms: now_ms(),
        };
        $body
    }};
}

async fn recurrences_create(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = RecurrenceBody::from_json(&body)?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        with_posts!(s, company, posts, {
            recurrences::create(&tdb, &posts, u.user.user_id, &input, chrono::Utc::now()).await
        })
    }
    .await;
    data(r)
}

async fn recurrences_update(
    State(s): St,
    Extension(u): Usr,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "id")?;
        let input = RecurrenceBody::from_json(&body)?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        with_posts!(s, company, posts, {
            recurrences::update(&tdb, &posts, u.user.user_id, id, &input, chrono::Utc::now()).await
        })
    }
    .await;
    data(r)
}

async fn recurrences_pause(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "id")?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        with_posts!(s, company, posts, {
            recurrences::pause(&tdb, &posts, id, chrono::Utc::now()).await
        })
    }
    .await;
    data(r)
}

async fn recurrences_resume(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "id")?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        with_posts!(s, company, posts, {
            recurrences::resume(&tdb, &posts, id, chrono::Utc::now()).await
        })
    }
    .await;
    data(r)
}

async fn recurrences_remove(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    let r = async {
        let id = id_of(&id, "id")?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        with_posts!(s, company, posts, { recurrences::remove(&tdb, &posts, id).await })
    }
    .await;
    no_content(r)
}

async fn import_plan(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = ImportPlanBody::from_json(&body)?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        let drafts = DraftsAdapter {
            db: &s.db,
            company,
            store: &s.store,
            env: &s.env,
            now_ms: now_ms(),
        };
        let queue = QueueAdapter {
            db: &tdb,
            now_ms: now_ms(),
        };
        with_posts!(s, company, posts, {
            let ports = ImportPorts {
                posts: &posts,
                drafts: &drafts,
                queue: &queue,
            };
            import::plan(&tdb, &ports, u.user.user_id, &input.csv, input.mode, chrono::Utc::now()).await
        })
    }
    .await;
    data(r)
}

async fn import_posts(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let input = ImportBody::from_json(&body)?;
        let tdb = s.db.tenant(company).await.map_err(AppError::internal)?;
        let drafts = DraftsAdapter {
            db: &s.db,
            company,
            store: &s.store,
            env: &s.env,
            now_ms: now_ms(),
        };
        let queue = QueueAdapter {
            db: &tdb,
            now_ms: now_ms(),
        };
        with_posts!(s, company, posts, {
            let ports = ImportPorts {
                posts: &posts,
                drafts: &drafts,
                queue: &queue,
            };
            import::import_csv(
                &tdb,
                &ports,
                u.user.user_id,
                &input.csv,
                input.mode,
                &input.plan_hash,
                chrono::Utc::now(),
            )
            .await
        })
    }
    .await;
    ok(r)
}

// ───────────────────────────── tải video theo phần (X15a) ─────────────────────────────

async fn upload_init(State(s): St, Extension(u): Usr, JsonBody(body): JsonBody) -> Response {
    let company = company!(u);
    let r = async {
        let b = chunked::InitBody::from_json(&body)?;
        chunked::init(&s.media_ctx(company, u.user.user_id), &b).await
    }
    .await;
    ok(r)
}

async fn upload_status(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    ok(chunked::status(&s.media_ctx(company, u.user.user_id), &id).await)
}

async fn upload_part(
    State(s): St,
    Extension(u): Usr,
    Path((id, index)): Path<(String, String)>,
    req: Request,
) -> Response {
    let company = company!(u);
    let r = async {
        let index = chunked::parse_index(&index)?;
        let stream = Box::pin(req.into_body().into_data_stream().map_err(std::io::Error::other));
        let reader = tokio_util::io::StreamReader::new(stream);
        chunked::put_part(&s.media_ctx(company, u.user.user_id), &id, index, reader).await
    }
    .await;
    ok(r)
}

async fn upload_complete(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    ok(chunked::complete(&s.media_ctx(company, u.user.user_id), &id).await)
}

async fn upload_cancel(State(s): St, Extension(u): Usr, Path(id): Path<String>) -> Response {
    let company = company!(u);
    no_content(chunked::cancel(&s.media_ctx(company, u.user.user_id), &id).await)
}

/// Router của module: mọi route đã mount (xem đầu tệp), quyền và mã thành công khớp `routes.json`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<SocialState>> {
    let mut table = routes::routes();
    table.extend(routes::upload_routes());
    let spec = |m: &Method, p: &str| -> RouteSpec {
        table
            .iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    const B: &str = "/api/v1/social";
    let p = |tail: &str| format!("{B}{tail}");
    let (get, post, patch, put, delete) = (Method::GET, Method::POST, Method::PATCH, Method::PUT, Method::DELETE);
    // Tải tệp: ảnh ≤ 10 MB, video ≤ 200 MB; thân nhận tới trần lớn nhất + 1 MB (axum mặc định 2 MB không đủ).
    let cap = |n: u64| usize::try_from(n).unwrap_or(usize::MAX).saturating_add(MIB);
    let upload_limit = move || DefaultBodyLimit::max(cap(MAX_STORED_VIDEO_BYTES.max(MAX_IMAGE_BYTES)));
    let part_limit = move || DefaultBodyLimit::max(cap(chunked::MAX_PART_BYTES));
    ApiRouter::new(deps)
        .route(spec(&get, &p("/networks")), networks)
        .route(spec(&get, &p("/accounts")), list_accounts)
        .route(spec(&post, &p("/accounts/connect-url")), connect_url)
        .route(spec(&post, &p("/accounts/:id/enable")), enable_account)
        .route(spec(&delete, &p("/accounts/:id")), disconnect_account)
        .route(spec(&get, &p("/oauth/callback/:network")), oauth_callback)
        .route(spec(&get, &p("/media")), library)
        .route(spec(&post, &p("/media")), upload.layer(upload_limit()))
        .route(spec(&get, &p("/media/:id/file")), media_file)
        .route(spec(&post, &p("/media/:id/hide")), media_hide)
        .route(spec(&get, &p("/media-link/:token/:name")), media_link)
        .route(spec(&get, &p("/posts")), posts_list)
        .route(spec(&post, &p("/posts")), posts_create)
        .route(spec(&post, &p("/posts/preview")), posts_preview)
        .route(spec(&get, &p("/posts/:id")), posts_get)
        .route(spec(&patch, &p("/posts/:id")), posts_update)
        .route(spec(&post, &p("/posts/:id/reschedule")), posts_reschedule)
        .route(spec(&post, &p("/posts/:id/cancel")), posts_cancel)
        .route(spec(&post, &p("/targets/:id/retry")), target_retry)
        .route(spec(&delete, &p("/targets/:id/remote")), target_remote_delete)
        .route(spec(&get, &p("/drafts")), drafts_list)
        .route(spec(&post, &p("/drafts")), drafts_create)
        .route(spec(&get, &p("/drafts/:id")), drafts_get)
        .route(spec(&patch, &p("/drafts/:id")), drafts_update)
        .route(spec(&delete, &p("/drafts/:id")), drafts_remove)
        .route(spec(&get, &p("/snippets")), snippets_list)
        .route(spec(&post, &p("/snippets")), snippets_create)
        .route(spec(&patch, &p("/snippets/:id")), snippets_update)
        .route(spec(&delete, &p("/snippets/:id")), snippets_remove)
        .route(spec(&get, &p("/queue/slots")), queue_slots)
        .route(spec(&put, &p("/queue/slots")), queue_set_slots)
        .route(spec(&get, &p("/queue/next")), queue_next)
        .route(spec(&get, &p("/recurrences")), recurrences_list)
        .route(spec(&post, &p("/recurrences")), recurrences_create)
        .route(spec(&patch, &p("/recurrences/:id")), recurrences_update)
        .route(spec(&delete, &p("/recurrences/:id")), recurrences_remove)
        .route(spec(&post, &p("/recurrences/:id/pause")), recurrences_pause)
        .route(spec(&post, &p("/recurrences/:id/resume")), recurrences_resume)
        .route(spec(&post, &p("/posts/import/plan")), import_plan)
        .route(spec(&post, &p("/posts/import")), import_posts)
        .route(spec(&post, &p("/media/uploads")), upload_init)
        .route(spec(&get, &p("/media/uploads/:id")), upload_status)
        .route(
            spec(&put, &p("/media/uploads/:id/parts/:index")),
            upload_part.layer(part_limit()),
        )
        .route(spec(&post, &p("/media/uploads/:id/complete")), upload_complete)
        .route(spec(&delete, &p("/media/uploads/:id")), upload_cancel)
}
