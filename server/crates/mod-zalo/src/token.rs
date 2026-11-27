//! OAuth v4 của OA (`zalo-oa-token.service.ts`): URL cấp quyền (PKCE S256 + `state` chống CSRF), đổi code lấy token, lưu MÃ HOÁ,
//! tự làm mới.
//!
//! Refresh token Zalo dùng MỘT LẦN (mỗi lần làm mới Zalo cấp cặp mới, cặp cũ chết) nên làm mới đi qua
//! `pg_advisory_xact_lock` theo (công ty, OA): single-flight trong RAM của bản Node không đủ khi có nhiều tiến trình/luồng
//! hoặc khi sở hữu đổi giữa chừng. Đây là chỗ DUY NHẤT giữ một kết nối pool trong lúc gọi HTTP (một lời gọi, hạn 15 giây, không
//! xin kết nối thứ hai): khoá phải sống tới lúc lưu cặp token mới, nếu không luồng khác sẽ dùng refresh token đã chết.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, PgConnection};
use trinity_db::models::ZaloOaConnection;
use trinity_db::pg_error::app_error;
use trinity_db::platform::{Platform, PlatformError, RouteKind, conflict_from_trigger};
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_integrations::webhooks::secret::{Key, decrypt_secret, encrypt_secret, load_secret_key};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::js_iso_string;

use crate::client::{ZaloClient, ZaloTokenSet};
use crate::config::{
    Env, OAUTH_STATE_TTL_MS, REFRESH_SKEW_MS, REFRESH_TOKEN_TTL_MS, ZaloEndpoint, is_zalo_oa_configured,
    zalo_oa_config, zalo_url,
};
use crate::errors::{Channel, ZaloApiError, describe_zalo_error};

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

pub(crate) fn platform_db(d: trinity_db::DbError) -> AppError {
    HttpError::new(500, d.to_string()).into()
}

fn platform_err(e: PlatformError) -> AppError {
    match e {
        PlatformError::Conflict(m) => HttpError::conflict(m).into(),
        PlatformError::Db(d) => platform_db(d),
        other => HttpError::new(500, other.to_string()).into(),
    }
}

/// Môi trường gọi của một công ty. Kết nối chỉ được giữ trong từng bước DB, không giữ khi gọi Zalo (ngoại lệ duy nhất: làm
/// mới token, xem đầu tệp).
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub db: &'a Db,
    pub env: &'a Env,
    pub client: &'a ZaloClient,
    pub platform: &'a Platform,
    pub company: CompanyRef,
}

pub(crate) async fn acquire(ctx: &Ctx<'_>) -> Result<TenantConn, AppError> {
    ctx.db
        .tenant(ctx.company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

/// Khoá mã hoá token (`INTEGRATIONS_SECRET_KEY`); thiếu hoặc sai ⇒ 503.
fn key(env: &Env) -> Result<Key, AppError> {
    load_secret_key(&|k: &str| env(k)).map_err(|_| {
        HttpError::service_unavailable("INTEGRATIONS_SECRET_KEY chưa cấu hình hợp lệ — không lưu được token an toàn")
            .into()
    })
}

fn config_wrong(e: &ZaloApiError) -> AppError {
    HttpError::service_unavailable(format!("Cấu hình kết nối Zalo của máy chủ sai: {}", e.message)).into()
}

fn random_b64(n: usize) -> Result<String, AppError> {
    let mut b = vec![0_u8; n];
    getrandom::fill(&mut b).map_err(|_| HttpError::new(500, "Không sinh được số ngẫu nhiên"))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

fn at(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// `GET /zalo-oa/status`: không trả token; thêm `redirect_uri` và `webhook_path` để khai trên Zalo.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub configured: bool,
    pub webhook_secret_configured: bool,
    pub secret_key_configured: bool,
    pub connected: bool,
    pub oa_id: Option<String>,
    /// `active` | `needs_reauth` | `disconnected`.
    pub status: String,
    pub access_expires_at: Option<String>,
    pub refresh_expires_at: Option<String>,
    pub last_error: Option<String>,
    pub redirect_uri: Option<String>,
    pub webhook_path: &'static str,
}

const CONN_COLS: &str = "id, oa_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, status, last_error, last_refreshed_at, connected_by, created_at, updated_at";

/// Kết nối OA mới nhất (`ORDER BY id DESC`), hoặc `None`.
pub async fn get_connection(conn: &mut PgConnection) -> Result<Option<ZaloOaConnection>, AppError> {
    sqlx::query_as::<_, ZaloOaConnection>(sqlx::AssertSqlSafe(format!(
        "SELECT {CONN_COLS} FROM zalo_oa_connections ORDER BY id DESC LIMIT 1"
    )))
    .fetch_optional(conn)
    .await
    .map_err(db)
}

pub async fn status(ctx: &Ctx<'_>) -> Result<Status, AppError> {
    let cfg = zalo_oa_config(ctx.env);
    let conn = get_connection(&mut *acquire(ctx).await?).await?;
    Ok(Status {
        configured: is_zalo_oa_configured(&cfg),
        webhook_secret_configured: cfg.webhook_secret.is_some(),
        secret_key_configured: key(ctx.env).is_ok(),
        connected: conn.as_ref().is_some_and(|c| c.status == "active"),
        oa_id: conn.as_ref().map(|c| c.oa_id.clone()),
        status: conn
            .as_ref()
            .map_or_else(|| "disconnected".to_owned(), |c| c.status.clone()),
        access_expires_at: conn.as_ref().map(|c| js_iso_string(c.access_expires_at.0)),
        refresh_expires_at: conn
            .as_ref()
            .and_then(|c| c.refresh_expires_at.map(|t| js_iso_string(t.0))),
        last_error: conn.as_ref().and_then(|c| c.last_error.clone()),
        redirect_uri: cfg.redirect_uri,
        webhook_path: "/api/v1/zalo-oa/webhook",
    })
}

/// `POST /zalo-oa/connect` ⇒ `{ authorize_url }`. Thiếu cấu hình ⇒ 503.
pub async fn start_connect(ctx: &Ctx<'_>, user_id: i32, now_ms: i64) -> Result<serde_json::Value, AppError> {
    let cfg = zalo_oa_config(ctx.env);
    let (Some(app_id), Some(_), Some(redirect)) = (
        cfg.app_id.as_deref(),
        cfg.app_secret.as_deref(),
        cfg.redirect_uri.as_deref(),
    ) else {
        return Err(HttpError::service_unavailable(
            "Chưa cấu hình ZALO_OA_APP_ID / ZALO_OA_APP_SECRET / ZALO_OA_REDIRECT_URI",
        )
        .into());
    };
    let k = key(ctx.env)?;
    let state = random_b64(24)?;
    let verifier = random_b64(48)?;
    {
        let mut c = acquire(ctx).await?;
        sqlx::query("DELETE FROM zalo_oa_oauth_states WHERE expires_at < $1")
            .bind(at(now_ms))
            .execute(&mut *c)
            .await
            .map_err(db)?;
        sqlx::query(
            "INSERT INTO zalo_oa_oauth_states (state, code_verifier_enc, user_id, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(&state)
        .bind(encrypt_secret(&verifier, &k))
        .bind(user_id)
        .bind(at(now_ms + OAUTH_STATE_TTL_MS))
        .execute(&mut *c)
        .await
        .map_err(db)?;
    }
    // Nhiều công ty: callback công khai chọn công ty theo `state`.
    ctx.platform
        .remember_oauth_state(&state, ctx.company)
        .await
        .map_err(platform_db)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("app_id", app_id),
            ("redirect_uri", redirect),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
        ])
        .finish();
    let permission = zalo_url(ZaloEndpoint::Permission, ctx.env)
        .map_err(|m| HttpError::service_unavailable(format!("Cấu hình kết nối Zalo của máy chủ sai: {m}")))?;
    Ok(serde_json::json!({ "authorize_url": format!("{permission}?{query}") }))
}

/// `oa_id` hợp lệ: `^[\w-]{1,64}$`.
fn valid_oa_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Callback: kiểm `state` (dùng một lần, còn hạn) ⇒ đổi code ⇒ lưu. Trả `oa_id` đã kết nối.
pub async fn complete_connect(
    ctx: &Ctx<'_>,
    code: &str,
    oa_id: &str,
    state: &str,
    now_ms: i64,
) -> Result<String, AppError> {
    let cfg = zalo_oa_config(ctx.env);
    let (Some(app_id), Some(app_secret), Some(_)) = (
        cfg.app_id.as_deref(),
        cfg.app_secret.as_deref(),
        cfg.redirect_uri.as_deref(),
    ) else {
        return Err(HttpError::service_unavailable("Chưa cấu hình Zalo OA").into());
    };
    if code.is_empty() || state.is_empty() || !valid_oa_id(oa_id) {
        return Err(HttpError::bad_request("Thiếu tham số callback").into());
    }
    // Lấy và xoá `state` trong MỘT câu: hai callback đồng thời với cùng `state` không cùng dùng được.
    let st: Option<(String, i32, DateTime<Utc>)> = sqlx::query_as(
        "DELETE FROM zalo_oa_oauth_states WHERE state = $1 RETURNING code_verifier_enc, user_id, expires_at",
    )
    .bind(state)
    .fetch_optional(&mut *acquire(ctx).await?)
    .await
    .map_err(db)?;
    let Some((verifier_enc, user_id, _)) = st.filter(|s| s.2.timestamp_millis() >= now_ms) else {
        return Err(
            HttpError::bad_request("Phiên cấp quyền không hợp lệ hoặc đã hết hạn — hãy thử kết nối lại").into(),
        );
    };
    // Một OA chỉ một công ty (trigger DB vẫn là chốt chặn cứng).
    ctx.platform
        .assert_route_available(RouteKind::ZaloOa, oa_id, ctx.company)
        .await
        .map_err(platform_err)?;
    let k = key(ctx.env)?;
    let verifier = decrypt_secret(&verifier_enc, &k)
        .map_err(|_| HttpError::service_unavailable("Không giải mã được phiên cấp quyền"))?;
    let tokens = ctx
        .client
        .exchange_code(app_id, app_secret, code, &verifier)
        .await
        .map_err(|e| {
            if e.is_config_error() {
                config_wrong(&e)
            } else {
                HttpError::new(502, describe_zalo_error(&e, Channel::Zns)).into()
            }
        })?;
    save(&mut *acquire(ctx).await?, &k, oa_id, &tokens, user_id, now_ms).await?;
    Ok(oa_id.to_owned())
}

/// Lưu cặp token mới (mã hoá) và đưa kết nối về `active`. `connected_by` chỉ đặt lúc tạo.
async fn save(
    conn: &mut PgConnection,
    k: &Key,
    oa_id: &str,
    t: &ZaloTokenSet,
    user_id: i32,
    now_ms: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO zalo_oa_connections (oa_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, status, last_error, \
         last_refreshed_at, connected_by, updated_at) VALUES ($1, $2, $3, $4, $5, 'active', NULL, $6, $7, $6) \
         ON CONFLICT (oa_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, \
         access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, status = 'active', last_error = NULL, \
         last_refreshed_at = EXCLUDED.last_refreshed_at, updated_at = EXCLUDED.updated_at",
    )
    .bind(oa_id)
    .bind(encrypt_secret(&t.access_token, k))
    .bind(encrypt_secret(&t.refresh_token, k))
    .bind(at(now_ms.saturating_add(t.expires_in.saturating_mul(1000))))
    .bind(at(now_ms + REFRESH_TOKEN_TTL_MS))
    .bind(at(now_ms))
    .bind(user_id)
    .execute(conn)
    .await
    .map_err(|e| match conflict_from_trigger(&e) {
        Some(m) => HttpError::conflict(m).into(),
        None => db(e),
    })?;
    Ok(())
}

/// Access token còn hạn.
#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    pub oa_id: String,
    pub connected_by: i32,
}

/// Access token còn hạn (tự làm mới nếu sắp hết). Chưa kết nối hoặc cần cấp quyền lại ⇒ 400.
pub async fn get_access_token(ctx: &Ctx<'_>, now_ms: i64) -> Result<AccessToken, AppError> {
    let conn = get_connection(&mut *acquire(ctx).await?).await?;
    let Some(conn) = conn.filter(|c| c.status == "active") else {
        return Err(HttpError::bad_request("Zalo OA chưa kết nối hoặc cần kết nối lại").into());
    };
    let k = key(ctx.env)?;
    let token = if conn.access_expires_at.0.timestamp_millis() - now_ms > REFRESH_SKEW_MS {
        decrypt_secret(&conn.access_token_enc, &k)
            .map_err(|_| HttpError::service_unavailable("Không giải mã được token Zalo OA"))?
    } else {
        refresh_locked(ctx, &conn.oa_id, now_ms).await?
    };
    Ok(AccessToken {
        token,
        oa_id: conn.oa_id,
        connected_by: conn.connected_by,
    })
}

/// Làm mới dưới `pg_advisory_xact_lock` theo (schema, OA). Vào được khoá thì đọc lại dòng: luồng khác vừa làm mới xong thì dùng
/// token mới, KHÔNG gọi Zalo lần nữa (refresh token đã chết). Lỗi cấu hình ⇒ 503 và giữ nguyên kết nối; lỗi tạm thời (mạng,
/// 5xx, phản hồi hỏng) ⇒ 400 "thử lại sau" và giữ nguyên; Zalo từ chối thật ⇒ `needs_reauth` rồi 400 "cần kết nối lại".
async fn refresh_locked(ctx: &Ctx<'_>, oa_id: &str, now_ms: i64) -> Result<String, AppError> {
    let cfg = zalo_oa_config(ctx.env);
    let (Some(app_id), Some(app_secret)) = (cfg.app_id.as_deref(), cfg.app_secret.as_deref()) else {
        return Err(HttpError::service_unavailable("Chưa cấu hình Zalo OA").into());
    };
    let k = key(ctx.env)?;
    let mut c = acquire(ctx).await?;
    let mut tx = c.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.zalo_oa_refresh.' || $1))")
        .bind(oa_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let cur = sqlx::query_as::<_, ZaloOaConnection>(sqlx::AssertSqlSafe(format!(
        "SELECT {CONN_COLS} FROM zalo_oa_connections WHERE oa_id = $1 FOR UPDATE"
    )))
    .bind(oa_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let Some(cur) = cur.filter(|c| c.status == "active") else {
        return Err(HttpError::bad_request("Zalo OA chưa kết nối hoặc cần kết nối lại").into());
    };
    if cur.access_expires_at.0.timestamp_millis() - now_ms > REFRESH_SKEW_MS {
        return decrypt_secret(&cur.access_token_enc, &k)
            .map_err(|_| HttpError::service_unavailable("Không giải mã được token Zalo OA").into());
    }
    let refresh = decrypt_secret(&cur.refresh_token_enc, &k)
        .map_err(|_| HttpError::service_unavailable("Không giải mã được token Zalo OA"))?;
    match ctx.client.refresh(app_id, app_secret, &refresh).await {
        Ok(t) => {
            save(&mut tx, &k, oa_id, &t, cur.connected_by, now_ms).await?;
            tx.commit().await.map_err(db)?;
            Ok(t.access_token)
        }
        Err(e) if e.is_config_error() => {
            // Refresh token vẫn tốt: không đánh dấu cần kết nối lại, không báo "tạm thời" (thử lại vẫn hỏng tới khi sửa env).
            tracing::error!("Làm mới token: cấu hình Zalo sai oa={oa_id}: {}", e.message);
            Err(config_wrong(&e))
        }
        Err(e) if e.is_transient() => {
            tracing::error!("Làm mới token thất bại (tạm thời, mã {}) oa={oa_id}", e.code);
            Err(HttpError::bad_request("Chưa làm mới được token Zalo OA (lỗi tạm thời) — thử lại sau").into())
        }
        Err(e) => {
            let msg = format!("Làm mới token thất bại (mã {})", e.code);
            tracing::error!("{msg} oa={oa_id}");
            sqlx::query("UPDATE zalo_oa_connections SET status = 'needs_reauth', last_error = left($2, 300), updated_at = now() WHERE oa_id = $1")
                .bind(oa_id)
                .bind(&msg)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            Err(HttpError::bad_request("Không làm mới được token Zalo OA — cần kết nối lại").into())
        }
    }
}

pub async fn mark_needs_reauth(ctx: &Ctx<'_>, oa_id: &str, reason: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE zalo_oa_connections SET status = 'needs_reauth', last_error = left($2, 300), updated_at = now() WHERE oa_id = $1")
        .bind(oa_id)
        .bind(reason)
        .execute(&mut *acquire(ctx).await?)
        .await
        .map_err(db)?;
    Ok(())
}

/// `DELETE /zalo-oa/connection`: xoá token đã lưu; hội thoại giữ nguyên.
pub async fn disconnect(ctx: &Ctx<'_>) -> Result<(), AppError> {
    sqlx::query("DELETE FROM zalo_oa_connections")
        .execute(&mut *acquire(ctx).await?)
        .await
        .map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oa_id_hop_le() {
        for (s, ok) in [
            ("12345", true),
            ("a_b-C9", true),
            ("", false),
            ("a b", false),
            ("a/b", false),
            ("é", false),
        ] {
            assert_eq!(valid_oa_id(s), ok, "{s}");
        }
        assert!(valid_oa_id(&"a".repeat(64)) && !valid_oa_id(&"a".repeat(65)));
    }
}
