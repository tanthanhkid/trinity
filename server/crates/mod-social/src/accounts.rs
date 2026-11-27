//! Tài khoản đăng bài (`social-accounts.service.ts`): kết nối OAuth, bật lại, gỡ, token mã hoá. Hàm nhận `&mut PgConnection`
//! đã gắn công ty hoặc [`Ctx`] (khi phải gọi Graph); tầng route chỉ việc: extractor K15 → `validate()` → hàm ở đây → JSON.
//! Token KHÔNG bao giờ có trong view. KHÔNG giữ kết nối pool khi gọi Graph hay nền tảng; mỗi bước DB xin một kết nối rồi nhả.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;

use mod_facebook::config::{Env, encode_uri_component};
use mod_facebook::graph::utf16_prefix;
use mod_facebook::pages::Ctx;
use mod_facebook::state::jwt_secret;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::models::SocialAccount;
use trinity_db::pg_error::app_error;
use trinity_db::platform::{PlatformError, RouteKind, conflict_from_trigger};
use trinity_db::types::Timestamp;
use trinity_db::TenantConn;
use trinity_integrations::status::public_base_url;
use trinity_integrations::webhooks::secret::{Key, decrypt_secret, encrypt_secret, load_secret_key};
use trinity_kernel::error::{AppError, HttpError, Message};

use crate::config::{SOCIAL_NETWORKS, is_social_network, network_label, removed_network_message, social_redirect_uri};
use crate::provider::{self, ConnectedAccount, FACEBOOK_ENV_NAMES};
use crate::state::{sign_social_state, verify_social_state};

const COLS: &str = "id, network, external_id, name, avatar_url, access_token_enc, refresh_token_enc, token_expires_at, scopes, status, \
                    last_error, connected_by, created_at, updated_at";

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

async fn acquire(ctx: &Ctx<'_>) -> Result<TenantConn, AppError> {
    ctx.db
        .tenant(ctx.company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

/// Khoá mã hoá token; thiếu hoặc sai ⇒ 503 (`INTEGRATIONS_SECRET_KEY` chưa đặt).
fn secret_key(env: &Env) -> Result<Key, AppError> {
    load_secret_key(&|k: &str| env(k))
        .map_err(|_| HttpError::service_unavailable("Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY (khoá mã hoá token).").into())
}

/// Dạng trả ra API (`SocialAccountView`) — KHÔNG có token. `removed`/`inbox` chỉ có ở danh sách.
#[derive(Debug, Clone, Serialize)]
pub struct SocialAccountView {
    pub id: i32,
    pub network: String,
    pub external_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
    pub token_expires_at: Option<Timestamp>,
    pub connected_by: i32,
    pub created_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
    /// Chỉ Facebook: `on` | `off` | `null` (chưa nối nhận tin).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbox: Option<Option<&'static str>>,
}

pub fn to_account_view(a: SocialAccount) -> SocialAccountView {
    SocialAccountView {
        id: a.id,
        network: a.network,
        external_id: a.external_id,
        name: a.name,
        avatar_url: a.avatar_url,
        status: a.status,
        last_error: a.last_error,
        token_expires_at: a.token_expires_at,
        connected_by: a.connected_by,
        created_at: a.created_at,
        removed: None,
        inbox: None,
    }
}

/// Một dòng của `GET /social/networks`.
#[derive(Debug, Clone, Serialize)]
pub struct NetworkView {
    pub network: &'static str,
    pub label: &'static str,
    pub supported: bool,
    pub configured: bool,
    pub env: Vec<&'static str>,
    pub scopes: Vec<&'static str>,
    pub redirect_uri: Option<String>,
}

/// `GET /social/networks` ⇒ `{ data }`: đã làm chưa, đủ env chưa, URL callback để dán vào app Meta.
pub fn networks(env: &Env) -> Vec<NetworkView> {
    let base = public_base_url(&|k: &str| env(k));
    SOCIAL_NETWORKS
        .iter()
        .copied()
        .map(|n| NetworkView {
            network: n,
            label: network_label(n),
            supported: true,
            configured: provider::configured(env) && base.is_some(),
            env: FACEBOOK_ENV_NAMES.to_vec(),
            scopes: mod_facebook::config::FACEBOOK_SOCIAL_SCOPES.to_vec(),
            redirect_uri: base.as_deref().map(|b| social_redirect_uri(b, n)),
        })
        .collect()
}

/// `GET /social/accounts` ⇒ `{ data }`: kênh đang dùng và kênh đã gỡ mà còn token (`removed`, để bật lại); kênh gỡ và đã xoá
/// token thì ẩn; mạng đã ngừng hỗ trợ không hiện.
pub async fn list(conn: &mut PgConnection) -> Result<Vec<SocialAccountView>, AppError> {
    let rows = sqlx::query_as::<_, SocialAccount>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM social_accounts WHERE network = ANY($1) AND (status <> 'disabled' OR access_token_enc <> '') \
         ORDER BY network ASC, name ASC"
    )))
    .bind(SOCIAL_NETWORKS.iter().map(|s| (*s).to_owned()).collect::<Vec<String>>())
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let fb_ids: Vec<String> = rows
        .iter()
        .filter(|r| r.network == "facebook")
        .map(|r| r.external_id.clone())
        .collect();
    let mut inbox: HashMap<String, &'static str> = HashMap::new();
    if !fb_ids.is_empty() {
        let pages: Vec<(String, bool, String)> =
            sqlx::query_as("SELECT page_id, is_active, token_enc FROM facebook_pages WHERE page_id = ANY($1)")
                .bind(&fb_ids)
                .fetch_all(&mut *conn)
                .await
                .map_err(db)?;
        for (id, active, token) in pages {
            inbox.insert(id, if active && !token.is_empty() { "on" } else { "off" });
        }
    }
    Ok(rows
        .into_iter()
        .map(|r| {
            let removed = r.status == "disabled";
            let inbox_state = (r.network == "facebook").then(|| inbox.get(&r.external_id).copied());
            let mut v = to_account_view(r);
            v.removed = Some(removed);
            v.inbox = inbox_state;
            v
        })
        .collect())
}

async fn find(conn: &mut PgConnection, id: i32) -> Result<Option<SocialAccount>, AppError> {
    sqlx::query_as::<_, SocialAccount>(sqlx::AssertSqlSafe(format!("SELECT {COLS} FROM social_accounts WHERE id = $1")))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// `POST /social/accounts/:id/enable`: bật lại kênh đã gỡ, chỉ khi còn token (gỡ kênh xoá token nên thường phải liên kết lại).
pub async fn enable(conn: &mut PgConnection, id: i32) -> Result<SocialAccountView, AppError> {
    let a = find(&mut *conn, id)
        .await?
        .ok_or_else(|| HttpError::not_found("Không tìm thấy kênh"))?;
    if let Some(m) = removed_network_message(&a.network) {
        return Err(HttpError::bad_request(m).into());
    }
    if a.status != "disabled" {
        return Err(HttpError::bad_request("Kênh này đang bật").into());
    }
    if a.access_token_enc.is_empty() {
        return Err(HttpError::bad_request("Liên kết lại để bật kênh này").into());
    }
    let row = sqlx::query_as::<_, SocialAccount>(sqlx::AssertSqlSafe(format!(
        "UPDATE social_accounts SET status = 'active', last_error = NULL, updated_at = now() WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    Ok(to_account_view(row))
}

/// `POST /social/accounts/connect-url` ⇒ `{ url }`. `network` đã qua [`crate::dto::SocialConnect`].
pub async fn connect_url(ctx: &Ctx<'_>, network: &str, actor_user_id: i32, now_ms: i64) -> Result<Value, AppError> {
    if let Some(m) = removed_network_message(network) {
        return Err(HttpError::bad_request(m).into());
    }
    if !is_social_network(network) {
        return Err(HttpError::bad_request("Mạng không hợp lệ").into());
    }
    let base = public_base_url(&|k: &str| (ctx.env)(k));
    if !provider::configured(ctx.env) || base.is_none() {
        return Err(HttpError::service_unavailable(format!(
            "Chưa cấu hình {} trên máy chủ ({}).",
            network_label(network),
            FACEBOOK_ENV_NAMES.join(", ")
        ))
        .into());
    }
    secret_key(ctx.env)?;
    let secret = jwt_secret(ctx.env).map_err(|e| HttpError::new(500, e.to_string()))?;
    let claim = ctx.platform.multi_tenant().then_some(ctx.company.id());
    let state = sign_social_state(&secret, actor_user_id, network, None, claim, now_ms);
    // Nhiều công ty: callback công khai chọn công ty theo `state`.
    ctx.platform
        .remember_oauth_state(&state, ctx.company)
        .await
        .map_err(platform_db)?;
    let redirect = social_redirect_uri(base.as_deref().unwrap_or_default(), network);
    Ok(serde_json::json!({ "url": provider::authorize_url(ctx.env, &state, &redirect) }))
}

/// Lưu/ghi đè một tài khoản nhận được. Kênh người dùng đã gỡ (`disabled`) chỉ làm mới token/tên, bật lại phải có chủ đích.
async fn upsert_account(
    conn: &mut PgConnection,
    network: &str,
    a: &ConnectedAccount,
    user_id: i32,
    key: &Key,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO social_accounts (network, external_id, name, avatar_url, access_token_enc, refresh_token_enc, token_expires_at, \
         scopes, connected_by, status, last_error, updated_at) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, 'active', NULL, now()) \
         ON CONFLICT (network, external_id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, \
         access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, \
         token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, connected_by = EXCLUDED.connected_by, \
         status = CASE WHEN social_accounts.status = 'disabled' THEN social_accounts.status ELSE 'active' END, \
         last_error = CASE WHEN social_accounts.status = 'disabled' THEN social_accounts.last_error ELSE NULL END, updated_at = now()",
    )
    .bind(network)
    .bind(&a.external_id)
    .bind(utf16_prefix(&a.name, 200))
    .bind(a.avatar_url.as_deref())
    .bind(encrypt_secret(&a.access_token, key))
    .bind(a.scopes.join(" "))
    .bind(user_id)
    .execute(conn)
    .await
    .map_err(|e| match conflict_from_trigger(&e) {
        Some(m) => HttpError::conflict(m).into(),
        None => db(e),
    })?;
    Ok(())
}

/// Callback OAuth (công khai, xác thực bằng `state`): lưu/ghi đè mọi Page nhận được. `state` sai/hết hạn/sai công ty/sai mạng ⇒ 400.
/// Page đã thuộc công ty khác thì bỏ qua (không lưu token của họ vào công ty này); mọi Page bị bỏ ⇒ 409. Trả số Page đã nối.
pub async fn handle_callback(ctx: &Ctx<'_>, network: &str, code: &str, state: &str, now_ms: i64) -> Result<usize, AppError> {
    if let Some(m) = removed_network_message(network) {
        return Err(HttpError::bad_request(m).into());
    }
    if !is_social_network(network) {
        return Err(HttpError::bad_request("Mạng không hợp lệ").into());
    }
    let secret = jwt_secret(ctx.env).map_err(|e| HttpError::new(500, e.to_string()))?;
    let Some(st) = verify_social_state(
        &secret,
        state,
        network,
        now_ms,
        ctx.platform.multi_tenant(),
        Some(ctx.company.id()),
    ) else {
        return Err(HttpError::bad_request(
            "Phiên liên kết không hợp lệ hoặc đã hết hạn. Hãy bấm \"Liên kết\" lại.",
        )
        .into());
    };
    let base = public_base_url(&|k: &str| (ctx.env)(k));
    let Some(base) = base.filter(|_| provider::configured(ctx.env)) else {
        return Err(HttpError::service_unavailable(format!("Chưa cấu hình {} trên máy chủ.", network_label(network))).into());
    };
    let key = secret_key(ctx.env)?;
    let accounts = provider::exchange(ctx.graph, code, &social_redirect_uri(&base, network))
        .await
        .map_err(|e| HttpError::new(502, e.message))?;
    let mut skipped = 0_usize;
    for a in &accounts {
        // Một Fanpage chỉ một công ty. Chỉ "thuộc công ty khác" (409) mới bỏ qua Page; lỗi DB phải nổi lên, không được coi là đã bị chiếm.
        let free = match ctx
            .platform
            .assert_route_available(RouteKind::FacebookPage, &a.external_id, ctx.company)
            .await
        {
            Ok(()) => true,
            Err(PlatformError::Conflict(_)) => false,
            Err(e) => return Err(platform_err(e)),
        };
        if !free {
            skipped += 1;
            continue;
        }
        let mut conn = acquire(ctx).await?;
        upsert_account(&mut conn, network, a, st.user_id, &key).await?;
    }
    if skipped > 0 && skipped == accounts.len() {
        return Err(HttpError::conflict("Trang Facebook này đã được một công ty khác kết nối với Trinity").into());
    }
    tracing::info!("Liên kết {network}: {} tài khoản (user {})", accounts.len() - skipped, st.user_id);
    Ok(accounts.len() - skipped)
}

/// Câu của lỗi đã viết cho người dùng (không chứa token), cắt 300 đơn vị UTF-16; lỗi khác ⇒ rỗng.
fn public_reason(e: &AppError) -> String {
    match e {
        AppError::Http(h) => match h.body().message {
            Message::One(m) => utf16_prefix(&m, 300),
            Message::Many(ms) => utf16_prefix(&ms.join(","), 300),
        },
        _ => String::new(),
    }
}

/// Địa chỉ trình duyệt được chuyển về sau callback (`SocialPublicController.callback`): luôn là redirect về `/social?tab=channels`.
pub async fn callback_location(
    ctx: &Ctx<'_>,
    network: &str,
    code: Option<&str>,
    state: Option<&str>,
    error: Option<&str>,
    now_ms: i64,
) -> String {
    let base = public_base_url(&|k: &str| (ctx.env)(k)).unwrap_or_default();
    let back = |q: String| format!("{base}/social?tab=channels&{q}");
    let enc = encode_uri_component;
    if let Some(m) = removed_network_message(network) {
        return back(format!("social=error&network={}&reason={}", enc(network), enc(&m)));
    }
    if !is_social_network(network) {
        return back("social=error".to_owned());
    }
    let code = code.filter(|s| !s.is_empty());
    let state = state.filter(|s| !s.is_empty());
    let has_error = error.is_some_and(|s| !s.is_empty());
    let (Some(code), Some(state), false) = (code, state, has_error) else {
        return back(format!("social=cancelled&network={network}"));
    };
    match handle_callback(ctx, network, code, state, now_ms).await {
        Ok(n) => back(format!("social=connected&network={network}&count={n}")),
        Err(e) => {
            tracing::warn!("Callback {network} lỗi");
            let reason = public_reason(&e);
            if reason.is_empty() {
                back(format!("social=error&network={network}"))
            } else {
                back(format!("social=error&network={network}&reason={}", enc(&reason)))
            }
        }
    }
}

/// `DELETE /social/accounts/:id`: xoá token, đặt `disabled`; bài hẹn giờ còn chờ (`queued`) trên kênh này chuyển "đã huỷ".
/// Hai lệnh ghi trong một giao dịch.
pub async fn disconnect(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let a = find(&mut *conn, id).await?;
    if a.is_none_or(|a| a.status == "disabled") {
        return Err(HttpError::not_found("Không tìm thấy kênh").into());
    }
    let mut tx = sqlx::Acquire::begin(&mut *conn).await.map_err(db)?;
    sqlx::query(
        "UPDATE social_post_targets SET status = 'cancelled', last_error = 'Kênh đã bị gỡ', updated_at = now() \
         WHERE account_id = $1 AND status = 'queued'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    sqlx::query(
        "UPDATE social_accounts SET status = 'disabled', access_token_enc = '', refresh_token_enc = NULL, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(())
}

/// Tài khoản đã giải mã token để đăng (chỉ dùng nội bộ job, M54b).
#[derive(Debug, Clone)]
pub struct AccountForPublish {
    pub id: i32,
    pub external_id: String,
    pub name: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<Timestamp>,
}

pub fn for_publish(env: &Env, a: &SocialAccount) -> Result<AccountForPublish, AppError> {
    let key = secret_key(env)?;
    let dec = |s: &str| decrypt_secret(s, &key).map_err(|e| AppError::from(HttpError::service_unavailable(e.0)));
    Ok(AccountForPublish {
        id: a.id,
        external_id: a.external_id.clone(),
        name: a.name.clone(),
        access_token: dec(&a.access_token_enc)?,
        refresh_token: a.refresh_token_enc.as_deref().map(dec).transpose()?,
        token_expires_at: a.token_expires_at,
    })
}

/// Lưu token mới sau khi provider làm mới (`saveRefreshed`). Facebook Page không cần làm mới nên chưa có nơi gọi trong M53a.
pub async fn save_refreshed(
    conn: &mut PgConnection,
    env: &Env,
    id: i32,
    access_token: &str,
    refresh_token: Option<&str>,
    token_expires_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<(), AppError> {
    let key = secret_key(env)?;
    sqlx::query(
        "UPDATE social_accounts SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), \
         token_expires_at = $4, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(encrypt_secret(access_token, &key))
    .bind(refresh_token.filter(|s| !s.is_empty()).map(|t| encrypt_secret(t, &key)))
    .bind(token_expires_at)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Kênh cần liên kết lại (`markReauth`): `status = 'reauth'`, ghi lý do (tối đa 500 đơn vị UTF-16).
pub async fn mark_reauth(conn: &mut PgConnection, id: i32, message: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE social_accounts SET status = 'reauth', last_error = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(utf16_prefix(message, 500))
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}
