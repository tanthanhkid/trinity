//! Kết nối Fanpage (`facebook-pages.service.ts`): đăng nhập Facebook ⇒ lấy page token (mã hoá) ⇒ đăng ký webhook ⇒ kiểm hạn.
//! Hàm nhận `&mut PgConnection` đã gắn công ty và trả `AppError` của K05; tầng route chỉ việc: extractor K15 → `validate()` →
//! hàm ở đây → JSON. Quyền `integrations.webhooks` cho mọi route trừ callback OAuth (công khai, xác thực bằng `state`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::FacebookPage;
use trinity_db::pg_error::app_error;
use trinity_db::platform::{Platform, PlatformError, RouteKind, conflict_from_trigger};
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_integrations::webhooks::secret::{Key, decrypt_secret, encrypt_secret, load_secret_key};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::OwnerIds;

use crate::config::{
    Env, FACEBOOK_SOCIAL_SCOPES, SUBSCRIBED_FIELDS, comment_automation_enabled, connect_scopes, form_encode,
    is_facebook_configured, load_facebook_config, oauth_redirect_uri, subscribed_fields,
};
use crate::graph::{GraphApiError, GraphClient, GraphPage, TokenDebug, utf16_prefix};

/// Một Page đã đủ trường để nối (`id`, `name`, `access_token`).
#[derive(Debug, Clone)]
struct ConnectPage {
    id: String,
    name: String,
    access_token: String,
    tasks: Option<Vec<String>>,
    picture: Option<String>,
}

impl ConnectPage {
    /// Thiếu một trong ba trường ⇒ `None`: bản Node ném lỗi ở `slice`/`encryptSecret` và tính là Page lỗi.
    fn from_graph(p: &GraphPage) -> Option<Self> {
        Some(Self {
            id: p.id.clone().filter(|s| !s.is_empty())?,
            name: p.name.clone()?,
            access_token: p.access_token.clone().filter(|s| !s.is_empty())?,
            tasks: p.tasks.clone(),
            picture: p.picture_url().map(str::to_owned),
        })
    }
}
use crate::state::{jwt_secret, sign_state, verify_state};

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn platform_db(d: trinity_db::DbError) -> AppError {
    HttpError::new(500, d.to_string()).into()
}

fn platform_err(e: PlatformError) -> AppError {
    match e {
        PlatformError::Conflict(m) => HttpError::conflict(m).into(),
        PlatformError::Db(d) => platform_db(d),
        other => HttpError::new(500, other.to_string()).into(),
    }
}

/// Môi trường gọi của một công ty: nguồn env, client Graph (đã gắn `observer` của công ty), nền tảng đa công ty.
pub struct Ctx<'a> {
    /// Kết nối chỉ được giữ trong từng bước đọc/ghi DB, KHÔNG giữ khi gọi Graph (HTTP chậm không được chiếm kết nối pool).
    pub db: &'a Db,
    pub env: &'a Env,
    pub graph: &'a GraphClient,
    pub platform: &'a Platform,
    pub company: CompanyRef,
}

/// Xin một kết nối đã gắn công ty cho một bước DB.
async fn acquire(ctx: &Ctx<'_>) -> Result<TenantConn, AppError> {
    ctx.db
        .tenant(ctx.company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

/// Khoá mã hoá secret (`INTEGRATIONS_SECRET_KEY`); thiếu hoặc sai ⇒ 503 với câu của bản Node.
fn secret_key(env: &Env) -> Result<Key, AppError> {
    load_secret_key(&|k: &str| env(k)).map_err(|e| HttpError::service_unavailable(e.0).into())
}

/// Page có phần đăng bài khi quyền `pages_manage_posts` được cấp thật VÀ người nối có task đăng nội dung trên Page.
pub fn can_post_to_page(granted: &[String], tasks: Option<&[String]>) -> bool {
    if !granted.iter().any(|g| g == "pages_manage_posts") {
        return false;
    }
    tasks.is_none_or(|t| t.iter().any(|x| x == "CREATE_CONTENT" || x == "MANAGE"))
}

/// Trạng thái token lưu cho một Page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenState {
    /// `active` | `expired` | `invalid`.
    pub status: &'static str,
    pub expires_at: Option<DateTime<Utc>>,
    pub data_access_expires_at: Option<DateTime<Utc>>,
}

fn to_date(s: Option<i64>) -> Option<DateTime<Utc>> {
    s.filter(|v| *v != 0).and_then(|v| DateTime::from_timestamp(v, 0))
}

/// `debug_token` ⇒ trạng thái lưu. `expires_at` = 0 hoặc thiếu: không hết hạn (page token dài hạn).
pub fn token_state_from_debug(d: &TokenDebug, now_ms: i64) -> TokenState {
    let expires_at = to_date(d.expires_at);
    let data_access_expires_at = to_date(d.data_access_expires_at);
    if !d.is_valid {
        return TokenState {
            status: "invalid",
            expires_at,
            data_access_expires_at,
        };
    }
    let gone = |t: Option<DateTime<Utc>>| t.is_some_and(|t| t.timestamp_millis() <= now_ms);
    let status = if gone(expires_at) || gone(data_access_expires_at) {
        "expired"
    } else {
        "active"
    };
    TokenState {
        status,
        expires_at,
        data_access_expires_at,
    }
}

const CHECK_FAILED: &str = "Không kiểm tra được token với Facebook, thử lại sau.";

/// Một Page trả cho giao diện: KHÔNG có `token_enc`; thứ tự khoá như `toPageView` của bản Node.
#[derive(Debug, Clone, Serialize)]
pub struct PageView {
    pub id: i32,
    pub page_id: String,
    pub name: String,
    pub token_status: String,
    pub token_checked_at: Option<Timestamp>,
    pub token_expires_at: Option<Timestamp>,
    pub data_access_expires_at: Option<Timestamp>,
    pub subscribed: bool,
    pub default_assignee_id: i32,
    pub contact_source_id: i32,
    pub project_id: Option<i32>,
    pub is_active: bool,
    pub connected_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// `on` (đang dùng) | `removed` (người dùng đã gỡ) | `null` (chưa nối phần đăng bài).
    pub posting: Option<&'static str>,
    /// Đã ngắt: tắt và không còn token.
    pub disconnected: bool,
}

pub fn to_page_view(p: FacebookPage, posting: Option<&'static str>) -> PageView {
    let disconnected = !p.is_active && p.token_enc.is_empty();
    PageView {
        id: p.id,
        page_id: p.page_id,
        name: p.name,
        token_status: p.token_status,
        token_checked_at: p.token_checked_at,
        token_expires_at: p.token_expires_at,
        data_access_expires_at: p.data_access_expires_at,
        subscribed: p.subscribed,
        default_assignee_id: p.default_assignee_id,
        contact_source_id: p.contact_source_id,
        project_id: p.project_id,
        is_active: p.is_active,
        connected_by: p.connected_by,
        created_at: p.created_at,
        updated_at: p.updated_at,
        posting,
        disconnected,
    }
}

/// Body `PATCH /facebook/pages/:id` (`UpdateFacebookPageDto`) đã kiểm. Dựng bằng [`UpdatePage::from_json`], vì thông điệp lỗi
/// phải là của class-validator chứ không phải của serde.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdatePage {
    pub default_assignee_id: Option<i32>,
    pub contact_source_id: Option<i32>,
    pub is_active: Option<bool>,
}

impl UpdatePage {
    /// `default_assignee_id`/`contact_source_id` (`@ValidateIf(v !== undefined) @IsInt()`): có khoá thì PHẢI là số nguyên trong
    /// `int4` (`null`, chuỗi, số lẻ, số ngoài khoảng ⇒ 400, không để DB báo tràn hay lưu NULL); `is_active`
    /// (`@IsOptional() @IsBoolean()`): `null` như vắng, còn lại phải là boolean. Báo đủ lỗi theo thứ tự thuộc tính.
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let Some(o) = v.as_object() else {
            return Err(HttpError::validation(vec!["body must be an object".to_owned()]));
        };
        let mut e = Vec::new();
        for k in o.keys() {
            if !["default_assignee_id", "contact_source_id", "is_active"].contains(&k.as_str()) {
                e.push(format!("property {k} should not exist"));
            }
        }
        let mut int = |name: &str| -> Option<i32> {
            let raw = o.get(name)?;
            let n = raw.as_i64().and_then(|n| i32::try_from(n).ok());
            if n.is_none() {
                e.push(format!("{name} must be an integer number"));
            }
            n
        };
        let assignee = int("default_assignee_id");
        let source = int("contact_source_id");
        let active = match o.get("is_active") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => {
                e.push("is_active must be a boolean value".to_owned());
                None
            }
        };
        if e.is_empty() {
            Ok(Self {
                default_assignee_id: assignee,
                contact_source_id: source,
                is_active: active,
            })
        } else {
            Err(HttpError::validation(e))
        }
    }
}

/// `GET /facebook/status`: cấu hình đã đủ chưa (không lộ giá trị bí mật).
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub configured: bool,
    pub app_id_set: bool,
    pub app_secret_set: bool,
    pub base_url_set: bool,
    pub verify_token_set: bool,
    pub secret_key_configured: bool,
    pub graph_version: String,
    pub webhook_url: Option<String>,
    pub oauth_redirect_uri: Option<String>,
    pub scopes: Vec<String>,
    pub comment_automation: bool,
}

pub fn status(env: &Env) -> Status {
    let c = load_facebook_config(env);
    Status {
        configured: is_facebook_configured(&c),
        app_id_set: !c.app_id.is_empty(),
        app_secret_set: !c.app_secret.is_empty(),
        base_url_set: c.base_url.is_some(),
        verify_token_set: !c.verify_token.is_empty(),
        secret_key_configured: secret_key(env).is_ok(),
        webhook_url: c.base_url.as_ref().map(|b| format!("{b}/api/v1/facebook/webhook")),
        oauth_redirect_uri: c.base_url.as_ref().map(|_| oauth_redirect_uri(&c)),
        graph_version: c.graph_version,
        scopes: connect_scopes(env),
        comment_automation: comment_automation_enabled(env),
    }
}

/// `POST /facebook/connect-url`: URL hộp thoại đăng nhập Facebook kèm `state` ký cho người bấm. Chưa cấu hình ⇒ 503.
pub async fn connect_url(ctx: &Ctx<'_>, actor_user_id: i32, now_ms: i64) -> Result<serde_json::Value, AppError> {
    let c = load_facebook_config(ctx.env);
    if !is_facebook_configured(&c) {
        return Err(HttpError::service_unavailable(
            "Chưa cấu hình FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / INTEGRATIONS_PUBLIC_BASE_URL trên máy chủ.",
        )
        .into());
    }
    secret_key(ctx.env)?;
    let secret = jwt_secret(ctx.env).map_err(|e| HttpError::new(500, e.to_string()))?;
    let claim = ctx.platform.multi_tenant().then_some(ctx.company.id());
    let state = sign_state(&secret, actor_user_id, claim, now_ms);
    // Nhiều công ty: callback công khai chọn công ty theo `state`.
    ctx.platform
        .remember_oauth_state(&state, ctx.company)
        .await
        .map_err(platform_db)?;
    let query = vec![
        ("client_id".to_owned(), c.app_id.clone()),
        ("redirect_uri".to_owned(), oauth_redirect_uri(&c)),
        ("state".to_owned(), state),
        ("scope".to_owned(), connect_scopes(ctx.env).join(",")),
        ("response_type".to_owned(), "code".to_owned()),
    ];
    Ok(
        serde_json::json!({ "url": format!("https://www.facebook.com/{}/dialog/oauth?{}", c.graph_version, form_encode(&query)) }),
    )
}

/// Nguồn khách mặc định cho Page mới: option `contact_source` đang bật, ưu tiên nhãn chứa "facebook" hoặc "fb".
async fn default_source_id(conn: &mut PgConnection) -> Result<i32, AppError> {
    let opts: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, label FROM setting_options WHERE group_key = 'contact_source' AND is_active ORDER BY id ASC",
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    let pick = opts.iter().find(|(_, l)| {
        let l = l.to_lowercase();
        l.contains("facebook") || l.contains("fb")
    });
    pick.or(opts.first()).map(|(id, _)| *id).ok_or_else(|| {
        HttpError::bad_request(
            "Chưa có nguồn khách (Cài đặt > Danh mục > Nguồn khách) — tạo một nguồn rồi kết nối lại.",
        )
        .into()
    })
}

/// Kết quả callback OAuth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CallbackResult {
    /// Số Page đã nối (nhận tin).
    pub connected: usize,
    pub failed: usize,
    /// Số Page có phần đăng bài.
    pub posting: usize,
}

/// Xử lý callback đăng nhập. `state` sai/hết hạn/sai công ty ⇒ 400. Mỗi Page nối độc lập: một Page lỗi không chặn Page khác.
pub async fn handle_callback(ctx: &Ctx<'_>, code: &str, state: &str, now_ms: i64) -> Result<CallbackResult, AppError> {
    let secret = jwt_secret(ctx.env).map_err(|e| HttpError::new(500, e.to_string()))?;
    let Some(user_id) = verify_state(
        &secret,
        state,
        now_ms,
        ctx.platform.multi_tenant(),
        Some(ctx.company.id()),
    ) else {
        return Err(HttpError::bad_request(
            "Phiên kết nối Facebook không hợp lệ hoặc đã hết hạn. Hãy bấm \"Kết nối\" lại.",
        )
        .into());
    };
    let c = load_facebook_config(ctx.env);
    if !is_facebook_configured(&c) {
        return Err(HttpError::service_unavailable("Chưa cấu hình Facebook App trên máy chủ.").into());
    }
    let key = secret_key(ctx.env)?;
    let source_id = default_source_id(&mut *acquire(ctx).await?).await?;
    let short = ctx
        .graph
        .exchange_code(code, &oauth_redirect_uri(&c))
        .await
        .map_err(graph_to_app)?;
    let user = ctx.graph.to_long_lived(&short).await.map_err(graph_to_app)?;
    let pages = ctx.graph.list_pages(&user).await.map_err(graph_to_app)?;
    let granted = match ctx.graph.granted_permissions(&user).await {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("Không đọc được me/permissions, bỏ qua phần đăng bài: {e}");
            Vec::new()
        }
    };
    let (mut failed, mut posting) = (0, 0);
    for raw in &pages {
        // Page thiếu `id`/`name`/`access_token` chỉ tính là một Page lỗi, không làm hỏng cả lần kết nối.
        let Some(p) = ConnectPage::from_graph(raw) else {
            failed += 1;
            tracing::warn!("Kết nối Page lỗi: phần tử me/accounts thiếu id, name hoặc access_token");
            continue;
        };
        // Mỗi Page nối độc lập: một Page lỗi không chặn Page khác. Phần HTTP (đăng ký webhook, kiểm token) chạy TRƯỚC khi xin
        // kết nối; phần ghi nằm trong một giao dịch, phần đăng bài trong savepoint riêng (lỗi không cuốn theo việc nối Page).
        let pre = match prepare_page(ctx, &p, now_ms).await {
            Ok(x) => x,
            Err(e) => {
                failed += 1;
                tracing::warn!("Kết nối Page {} lỗi: {e}", p.id);
                continue;
            }
        };
        match write_page(ctx, &p, &pre, &granted, user_id, source_id, &key).await {
            Ok(has_posting) => posting += usize::from(has_posting),
            Err(e) => {
                failed += 1;
                tracing::warn!("Kết nối Page {} lỗi: {e}", p.id);
            }
        }
    }
    Ok(CallbackResult {
        connected: pages.len() - failed,
        failed,
        posting,
    })
}

/// Lỗi Graph ở bước đăng nhập ⇒ 502 với thông báo của Facebook (callback công khai sẽ chuyển thành `facebook=error`).
fn graph_to_app(e: GraphApiError) -> AppError {
    HttpError::new(502, e.message).into()
}

/// Kết quả bước HTTP của một Page.
struct Prepared {
    subscribed: bool,
    state: Option<TokenState>,
}

/// Bước HTTP: kiểm Page chưa thuộc công ty khác, đăng ký webhook, kiểm token.
async fn prepare_page(ctx: &Ctx<'_>, p: &ConnectPage, now_ms: i64) -> Result<Prepared, AppError> {
    // Một Page chỉ một công ty: báo sớm, trước khi đăng ký webhook (trigger DB vẫn là chốt chặn cứng).
    ctx.platform
        .assert_route_available(RouteKind::FacebookPage, &p.id, ctx.company)
        .await
        .map_err(platform_err)?;
    let subscribed = subscribe(ctx, &p.id, &p.access_token).await;
    let state = ctx
        .graph
        .debug_token(&p.access_token)
        .await
        .ok()
        .map(|d| token_state_from_debug(&d, now_ms));
    Ok(Prepared { subscribed, state })
}

/// Bước ghi: nối Page rồi (savepoint riêng) phần đăng bài. Trả `true` nếu Page có phần đăng bài sau lần nối.
async fn write_page(
    ctx: &Ctx<'_>,
    p: &ConnectPage,
    pre: &Prepared,
    granted: &[String],
    user_id: i32,
    source_id: i32,
    key: &Key,
) -> Result<bool, AppError> {
    let mut conn = acquire(ctx).await?;
    let mut tx = sqlx::Acquire::begin(&mut *conn).await.map_err(db)?;
    upsert_page(&mut tx, p, pre, user_id, source_id, key).await?;
    let posting = {
        let mut sp = sqlx::Acquire::begin(&mut *tx).await.map_err(db)?;
        match save_social_account(&mut sp, p, granted, user_id, key).await {
            Ok(v) => {
                sp.commit().await.map_err(db)?;
                v
            }
            Err(_) => {
                tracing::warn!("Lưu phần đăng bài của Page {} lỗi", p.id);
                let _ = sp.rollback().await;
                false
            }
        }
    };
    tx.commit().await.map_err(db)?;
    Ok(posting)
}

async fn upsert_page(
    conn: &mut PgConnection,
    p: &ConnectPage,
    pre: &Prepared,
    user_id: i32,
    source_id: i32,
    key: &Key,
) -> Result<(), AppError> {
    let state = pre.state.as_ref();
    // KHÔNG đụng `is_active` ở nhánh update: Page người dùng đã tắt/gỡ không tự bật lại khi nối lại.
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, token_checked_at, token_expires_at, \
         data_access_expires_at, is_active, default_assignee_id, contact_source_id, connected_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7, true, $8, $9, $8, now()) \
         ON CONFLICT (page_id) DO UPDATE SET name = EXCLUDED.name, token_enc = EXCLUDED.token_enc, subscribed = EXCLUDED.subscribed, \
         token_status = EXCLUDED.token_status, token_checked_at = EXCLUDED.token_checked_at, \
         token_expires_at = EXCLUDED.token_expires_at, data_access_expires_at = EXCLUDED.data_access_expires_at, updated_at = now()",
    )
    .bind(&p.id)
    .bind(utf16_prefix(&p.name, 200))
    .bind(encrypt_secret(&p.access_token, key))
    .bind(pre.subscribed)
    .bind(state.map_or("unknown", |s| s.status))
    .bind(state.and_then(|s| s.expires_at))
    .bind(state.and_then(|s| s.data_access_expires_at))
    .bind(user_id)
    .bind(source_id)
    .execute(conn)
    .await
    .map_err(|e| match conflict_from_trigger(&e) {
        Some(m) => HttpError::conflict(m).into(),
        None => db(e),
    })?;
    Ok(())
}

/// Phần đăng bài (Đăng đa kênh) của cùng Page, cùng lần nối. Kênh đã `disabled` (người dùng gỡ) thì chỉ làm mới token và tên,
/// giữ `disabled`. Trả `true` nếu Page có phần đăng bài sau lần nối này.
async fn save_social_account(
    conn: &mut PgConnection,
    p: &ConnectPage,
    granted: &[String],
    user_id: i32,
    key: &Key,
) -> Result<bool, AppError> {
    if !can_post_to_page(granted, p.tasks.as_deref()) {
        return Ok(false);
    }
    let existing: Option<(i32, String)> =
        sqlx::query_as("SELECT id, status FROM social_accounts WHERE network = 'facebook' AND external_id = $1")
            .bind(&p.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let scopes = FACEBOOK_SOCIAL_SCOPES
        .iter()
        .filter(|x| granted.iter().any(|g| g == *x))
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let name = utf16_prefix(&p.name, 200);
    let token = encrypt_secret(&p.access_token, key);
    match existing {
        None => {
            sqlx::query(
                "INSERT INTO social_accounts (network, external_id, name, avatar_url, access_token_enc, refresh_token_enc, token_expires_at, \
                 scopes, connected_by, status, last_error, updated_at) VALUES ('facebook', $1, $2, $3, $4, NULL, NULL, $5, $6, 'active', NULL, now())",
            )
            .bind(&p.id)
            .bind(&name)
            .bind(p.picture.as_deref())
            .bind(&token)
            .bind(&scopes)
            .bind(user_id)
            .execute(conn)
            .await
            .map_err(db)?;
            Ok(true)
        }
        Some((id, status)) => {
            let keep = status == "disabled";
            sqlx::query(
                "UPDATE social_accounts SET name = $2, avatar_url = $3, access_token_enc = $4, refresh_token_enc = NULL, \
                 token_expires_at = NULL, scopes = $5, connected_by = $6, \
                 status = CASE WHEN $7 THEN status ELSE 'active' END, last_error = CASE WHEN $7 THEN last_error ELSE NULL END, \
                 updated_at = now() WHERE id = $1",
            )
            .bind(id)
            .bind(&name)
            .bind(p.picture.as_deref())
            .bind(&token)
            .bind(&scopes)
            .bind(user_id)
            .bind(keep)
            .execute(conn)
            .await
            .map_err(db)?;
            Ok(!keep)
        }
    }
}

/// Trạng thái phần đăng bài theo `social_accounts`: `on`, `removed` hoặc không có.
async fn posting_map(
    conn: &mut PgConnection,
    page_ids: &[String],
) -> Result<std::collections::HashMap<String, &'static str>, AppError> {
    if page_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT external_id, status FROM social_accounts WHERE network = 'facebook' AND external_id = ANY($1)",
    )
    .bind(page_ids)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|(id, s)| (id, if s == "disabled" { "removed" } else { "on" }))
        .collect())
}

const PAGE_COLS: &str = "id, page_id, name, token_enc, token_status, token_checked_at, token_expires_at, data_access_expires_at, subscribed, \
                         default_assignee_id, contact_source_id, project_id, is_active, connected_by, created_at, updated_at";

async fn view_of(conn: &mut PgConnection, row: FacebookPage) -> Result<PageView, AppError> {
    let posting = posting_map(conn, std::slice::from_ref(&row.page_id))
        .await?
        .get(&row.page_id)
        .copied();
    Ok(to_page_view(row, posting))
}

/// `GET /facebook/pages` ⇒ `{ data }`: theo `id`, không lộ token.
pub async fn list(conn: &mut PgConnection) -> Result<Vec<PageView>, AppError> {
    let rows = sqlx::query_as::<_, FacebookPage>(sqlx::AssertSqlSafe(format!(
        "SELECT {PAGE_COLS} FROM facebook_pages ORDER BY id ASC"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let ids: Vec<String> = rows.iter().map(|r| r.page_id.clone()).collect();
    let posting = posting_map(conn, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let p = posting.get(&r.page_id).copied();
            to_page_view(r, p)
        })
        .collect())
}

async fn find(conn: &mut PgConnection, id: i32) -> Result<FacebookPage, AppError> {
    sqlx::query_as::<_, FacebookPage>(sqlx::AssertSqlSafe(format!(
        "SELECT {PAGE_COLS} FROM facebook_pages WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy Fanpage").into())
}

/// Người nhận phải đang hoạt động VÀ nằm trong phạm vi `contacts.transfer` của người cấu hình (như webhook vào).
async fn assert_assignable(
    conn: &mut PgConnection,
    actor: i32,
    transfer: Option<&OwnerIds>,
    assignee: i32,
) -> Result<(), AppError> {
    let u: Option<(String, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT status, deleted_at FROM users WHERE id = $1")
            .bind(assignee)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    if !u.is_some_and(|(s, d)| s == "active" && d.is_none()) {
        return Err(HttpError::bad_request("Người nhận không tồn tại hoặc không còn hoạt động").into());
    }
    if assignee == actor || transfer.is_some_and(|t| t.contains_any(&[Some(assignee)])) {
        return Ok(());
    }
    Err(HttpError::forbidden("Không có quyền gán khách cho người này (cần contacts.transfer phủ người nhận)").into())
}

/// `PATCH /facebook/pages/:id`. `transfer`: phạm vi `contacts.transfer` của người gọi; `None` = không có quyền đó (chỉ tự gán cho mình).
pub async fn update(
    conn: &mut PgConnection,
    id: i32,
    input: &UpdatePage,
    actor_user_id: i32,
    transfer: Option<&OwnerIds>,
) -> Result<PageView, AppError> {
    let current = find(&mut *conn, id).await?;
    if input.is_active == Some(true) && current.token_enc.is_empty() {
        return Err(HttpError::bad_request("Kết nối lại Facebook để bật lại Page này").into());
    }
    let (assignee, source) = (input.default_assignee_id, input.contact_source_id);
    if let Some(a) = assignee {
        assert_assignable(&mut *conn, actor_user_id, transfer, a).await?;
    }
    if let Some(s) = source {
        let o: Option<(String, bool)> =
            sqlx::query_as("SELECT group_key, is_active FROM setting_options WHERE id = $1")
                .bind(s)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        if !o.is_some_and(|(g, a)| g == "contact_source" && a) {
            return Err(HttpError::bad_request("Nguồn khách không hợp lệ hoặc đang tắt").into());
        }
    }
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE facebook_pages SET updated_at = now()");
    if let Some(a) = assignee {
        qb.push(", default_assignee_id = ").push_bind(a);
    }
    if let Some(s) = source {
        qb.push(", contact_source_id = ").push_bind(s);
    }
    if let Some(a) = input.is_active {
        qb.push(", is_active = ").push_bind(a);
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(format!(" RETURNING {PAGE_COLS}"));
    let row = qb
        .build_query_as::<FacebookPage>()
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    view_of(conn, row).await
}

/// `DELETE /facebook/pages/:id`: huỷ đăng ký webhook (best-effort), xoá token, tắt Page. Giữ dòng (nối lại không tự bật lại
/// Page đã gỡ; hội thoại cũ vẫn có tên Page).
pub async fn disconnect(ctx: &Ctx<'_>, id: i32) -> Result<(), AppError> {
    let p = find(&mut *acquire(ctx).await?, id).await?;
    if !p.token_enc.is_empty() {
        let token = secret_key(ctx.env)
            .ok()
            .and_then(|k| decrypt_secret(&p.token_enc, &k).ok());
        match token {
            Some(t) => {
                if let Err(e) = ctx.graph.unsubscribe_page(&p.page_id, &t).await {
                    tracing::warn!("Huỷ đăng ký webhook Page {}: {e}", p.page_id);
                }
            }
            None => tracing::warn!("Huỷ đăng ký webhook Page {}: không giải mã được token", p.page_id),
        }
    }
    sqlx::query("UPDATE facebook_pages SET is_active = false, token_enc = '', subscribed = false, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *acquire(ctx).await?)
        .await
        .map_err(db)?;
    Ok(())
}

/// Đăng ký Page nhận webhook; thành công thì bật nút "Bắt đầu" (lỗi bật nút chỉ ghi log, không làm hỏng kết nối).
async fn subscribe(ctx: &Ctx<'_>, page_id: &str, token: &str) -> bool {
    let ok = subscribe_fields(ctx, page_id, token).await;
    if ok && let Err(e) = ctx.graph.ensure_get_started(token).await {
        tracing::warn!("Page {page_id}: không bật được nút \"Bắt đầu\": {e}");
    }
    ok
}

/// Có thêm `feed` (bình luận) mà Facebook từ chối (app/token chưa có quyền) ⇒ đăng ký lại bộ cũ, vì Facebook từ chối CẢ lệnh
/// khi có một trường không hợp lệ và Page sẽ mất luôn tin nhắn.
async fn subscribe_fields(ctx: &Ctx<'_>, page_id: &str, token: &str) -> bool {
    let fields = subscribed_fields(ctx.env);
    match ctx.graph.subscribe_page(page_id, token, &fields).await {
        Ok(()) => return true,
        Err(e) => tracing::warn!(
            "Đăng ký webhook Page {page_id} ({}) lỗi (cần pages_manage_metadata): {e}",
            fields.join(",")
        ),
    }
    if fields.len() == SUBSCRIBED_FIELDS.len() {
        return false;
    }
    let base: Vec<String> = SUBSCRIBED_FIELDS.iter().map(|s| (*s).to_owned()).collect();
    match ctx.graph.subscribe_page(page_id, token, &base).await {
        Ok(()) => {
            tracing::warn!(
                "Page {page_id}: chỉ nhận tin nhắn, chưa nhận bình luận (app/token chưa có quyền đọc bình luận)"
            );
            true
        }
        Err(e) => {
            tracing::warn!("Đăng ký webhook Page {page_id} lỗi: {e}");
            false
        }
    }
}

/// `POST /facebook/pages/:id/check`: kiểm hạn/hiệu lực token ngay; token còn sống thì đăng ký lại webhook với đủ trường hiện
/// hành (Page nối từ trước cũng nhận trường mới). Lỗi 190 ⇒ `invalid`; lỗi Graph khác ⇒ 503.
pub async fn check_token(ctx: &Ctx<'_>, id: i32, now_ms: i64) -> Result<PageView, AppError> {
    let p = find(&mut *acquire(ctx).await?, id).await?;
    if p.token_enc.is_empty() {
        return Err(HttpError::bad_request("Page đã ngắt — kết nối lại Facebook để dùng").into());
    }
    let key = secret_key(ctx.env)?;
    // Không giải mã được token đã lưu (khoá đổi, dữ liệu hỏng) cũng là "không kiểm tra được": 503 như lỗi Graph tạm thời.
    let token = decrypt_secret(&p.token_enc, &key).map_err(|_| HttpError::service_unavailable(CHECK_FAILED))?;
    let mut subscribed_now = false;
    let state = match ctx.graph.debug_token(&token).await {
        Ok(d) => {
            let s = token_state_from_debug(&d, now_ms);
            if s.status == "active" {
                subscribed_now = subscribe(ctx, &p.page_id, &token).await;
            }
            Some(s)
        }
        Err(e) if e.is_token_error() => None,
        Err(_) => {
            return Err(HttpError::service_unavailable(CHECK_FAILED).into());
        }
    };
    let mut qb: QueryBuilder<Postgres> =
        QueryBuilder::new("UPDATE facebook_pages SET token_checked_at = now(), updated_at = now()");
    match &state {
        Some(s) => {
            qb.push(", token_status = ").push_bind(s.status);
            qb.push(", token_expires_at = ").push_bind(s.expires_at);
            qb.push(", data_access_expires_at = ")
                .push_bind(s.data_access_expires_at);
            if subscribed_now {
                qb.push(", subscribed = true");
            }
        }
        None => {
            qb.push(", token_status = 'invalid'");
        }
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(format!(" RETURNING {PAGE_COLS}"));
    let mut conn = acquire(ctx).await?;
    let row = qb
        .build_query_as::<FacebookPage>()
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    view_of(&mut conn, row).await
}

/// Page và token giải mã cho nội bộ (gửi tin, lấy lead). Page tắt hoặc không có ⇒ `None`.
pub async fn active_page_with_token(
    conn: &mut PgConnection,
    env: &Env,
    page_id: &str,
) -> Result<Option<(FacebookPage, String)>, AppError> {
    let page = sqlx::query_as::<_, FacebookPage>(sqlx::AssertSqlSafe(format!(
        "SELECT {PAGE_COLS} FROM facebook_pages WHERE page_id = $1"
    )))
    .bind(page_id)
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    let Some(page) = page.filter(|p| p.is_active && !p.token_enc.is_empty()) else {
        return Ok(None);
    };
    let token = decrypt_secret(&page.token_enc, &secret_key(env)?).map_err(|e| HttpError::service_unavailable(e.0))?;
    Ok(Some((page, token)))
}

/// Graph trả lỗi token (190) ⇒ đánh dấu Page để giao diện báo "cần kết nối lại".
pub async fn mark_token_invalid(conn: &mut PgConnection, page_id: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE facebook_pages SET token_status = 'invalid', token_checked_at = now() WHERE page_id = $1")
        .bind(page_id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trang_thai_token() {
        let now = 1_800_000_000_000_i64;
        let d = |valid, e, da| TokenDebug {
            is_valid: valid,
            expires_at: e,
            data_access_expires_at: da,
        };
        assert_eq!(
            token_state_from_debug(&d(true, Some(0), None), now).status,
            "active",
            "0 = không hết hạn"
        );
        assert_eq!(token_state_from_debug(&d(true, None, None), now).status, "active");
        assert_eq!(
            token_state_from_debug(&d(true, Some(1_800_000_001), None), now).status,
            "active"
        );
        assert_eq!(
            token_state_from_debug(&d(true, Some(1_800_000_000), None), now).status,
            "expired",
            "đúng lúc hết hạn"
        );
        assert_eq!(
            token_state_from_debug(&d(true, Some(0), Some(1_700_000_000)), now).status,
            "expired",
            "quyền dữ liệu hết hạn"
        );
        let s = token_state_from_debug(&d(false, Some(1_900_000_000), None), now);
        assert_eq!(
            (s.status, s.expires_at.map(|t| t.timestamp())),
            ("invalid", Some(1_900_000_000))
        );
        assert!(
            token_state_from_debug(&d(true, Some(0), None), now)
                .expires_at
                .is_none()
        );
    }

    #[test]
    fn quyen_dang_bai() {
        let g = |xs: &[&str]| xs.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(!can_post_to_page(&g(&["pages_show_list"]), None));
        assert!(can_post_to_page(&g(&["pages_manage_posts"]), None));
        assert!(can_post_to_page(&g(&["pages_manage_posts"]), Some(&g(&["MANAGE"]))));
        assert!(can_post_to_page(
            &g(&["pages_manage_posts"]),
            Some(&g(&["CREATE_CONTENT", "MESSAGING"]))
        ));
        assert!(!can_post_to_page(&g(&["pages_manage_posts"]), Some(&g(&["MESSAGING"]))));
    }

    #[test]
    fn kiem_luat_dto_trang() {
        let ok = |v: serde_json::Value| UpdatePage::from_json(&v);
        assert_eq!(ok(json!({})).unwrap(), UpdatePage::default());
        assert_eq!(
            ok(json!({ "default_assignee_id": 5, "contact_source_id": 2, "is_active": false })).unwrap(),
            UpdatePage {
                default_assignee_id: Some(5),
                contact_source_id: Some(2),
                is_active: Some(false)
            }
        );
        assert_eq!(
            ok(json!({ "is_active": null })).unwrap().is_active,
            None,
            "null như vắng"
        );
        // Mọi giá trị không phải số nguyên int4 ⇒ câu của class-validator, báo đủ theo thứ tự thuộc tính.
        for bad in [
            json!(null),
            json!("5"),
            json!(1.5),
            json!(2_147_483_648_i64),
            json!(-2_147_483_649_i64),
            json!(true),
            json!([1]),
        ] {
            let e =
                ok(json!({ "default_assignee_id": bad, "contact_source_id": bad, "is_active": "yes" })).unwrap_err();
            let (_, body) = trinity_kernel::error::AppError::from(e).response(true);
            assert_eq!(
                serde_json::to_value(&body.message).unwrap(),
                json!([
                    "default_assignee_id must be an integer number",
                    "contact_source_id must be an integer number",
                    "is_active must be a boolean value"
                ]),
                "{bad}"
            );
        }
        assert!(ok(json!([])).is_err());
    }
}
