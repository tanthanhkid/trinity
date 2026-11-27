//! Trạng thái dựng quy trình và màn "Bắt đầu" (`setup-status.service.ts`, `setup.controller.ts`).

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::can;

use crate::{Actor, Ctx, R, bad, connect, db, iso, now_iso, read_setting, samples, write_setting};

pub const SETUP_STATUS_KEY: &str = "setup_status";
/// Quá ngần này không có hoạt động ⇒ không khẳng định AI còn nối.
const AI_ACTIVE_WINDOW: Duration = Duration::hours(1);

/// `onboarding_seen:user:<id>`.
pub fn seen_key(user_id: i32) -> String {
    format!("onboarding_seen:user:{user_id}")
}

/// `resolveSetupStatus`: ba trạng thái, rác ⇒ `da_dung`.
pub fn resolve_status(raw: Option<&str>) -> &'static str {
    match raw.map(trinity_kernel::vi::trim_js) {
        Some("chua_dung") => "chua_dung",
        Some("dang_dung") => "dang_dung",
        _ => "da_dung",
    }
}

/// Vắng / rác / lỗi đọc = `da_dung` (fail-open: bản cài đang chạy không bao giờ bị khoá vì thiếu dòng này hay vì DB chập chờn).
pub async fn get(conn: &mut PgConnection) -> &'static str {
    match read_setting(conn, SETUP_STATUS_KEY).await {
        Ok(v) => resolve_status(v.as_deref()),
        Err(e) => {
            tracing::error!("đọc setup_status lỗi: {e}");
            "da_dung"
        }
    }
}

pub async fn set(conn: &mut PgConnection, status: &'static str, user: Option<i32>) -> R<&'static str> {
    write_setting(conn, SETUP_STATUS_KEY, status, user).await?;
    tracing::info!(
        "setup_status -> {status} (user {})",
        user.map_or("-".to_owned(), |u| u.to_string())
    );
    Ok(status)
}

/// Kết nối AI của mình / của mọi người (token OAuth còn sống, chưa thu hồi). Claude/ChatGPT KHÔNG báo cho Trinity khi người dùng
/// ngắt bên họ, nên "còn token" không có nghĩa "đang nối": chỉ coi là `active` khi có hoạt động trong 1 giờ gần đây.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiState {
    pub granted: bool,
    pub active: bool,
    pub last_active_at: Option<DateTime<Utc>>,
}

pub async fn ai_connection(conn: &mut PgConnection, user: Option<i32>, now: DateTime<Utc>) -> R<AiState> {
    let heads: Vec<(Option<DateTime<Utc>>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT last_used_at, created_at FROM oauth_tokens
         WHERE revoked_at IS NULL AND refresh_used_at IS NULL AND refresh_expires_at > now() AND ($1::int IS NULL OR user_id = $1)
         ORDER BY id DESC LIMIT 200",
    )
    .bind(user)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let Some(last) = heads.iter().map(|(used, created)| used.unwrap_or(*created)).max() else {
        return Ok(AiState {
            granted: false,
            active: false,
            last_active_at: None,
        });
    };
    Ok(AiState {
        granted: true,
        active: now - last <= AI_ACTIVE_WINDOW,
        last_active_at: Some(last),
    })
}

fn json_time(t: Option<DateTime<Utc>>) -> Value {
    t.map_or(Value::Null, |t| json!(iso(t)))
}

async fn exists(conn: &mut PgConnection, sql: &str) -> R<bool> {
    let r: Option<i32> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    Ok(r.is_some())
}

/// `GET /setup/status`: trạng thái dựng + địa chỉ MCP + AI đã nối chưa.
pub async fn status(ctx: &Ctx, actor: &Actor) -> R<Value> {
    // Mỗi trang đều hỏi trạng thái này ⇒ làm lưới an toàn dọn bản ghi mẫu khi đã có bản ghi thật (mọi đường tạo).
    samples::purge_if_real(ctx, actor.company).await;
    let mut c = ctx.conn(actor.company).await?;
    let now = Utc::now();
    let st = get(&mut c).await;
    let mine = ai_connection(&mut c, Some(actor.user_id), now).await?;
    let anyone = ai_connection(&mut c, None, now).await?;
    let sample = samples::remaining(&mut c).await;
    Ok(json!({
        "status": st,
        "mcp_url": connect::mcp_url(ctx),
        "ai_connected": mine.active,
        "ai_granted": mine.granted,
        "ai_last_active_at": json_time(mine.last_active_at),
        "ai_connected_anyone": anyone.active,
        "can_build": can(&actor.grants, "custom_objects.manage", None),
        "has_sample_data": sample.is_some(),
    }))
}

/// `GET /setup/onboarding`: đã xem màn hướng dẫn chưa + các bước bắt đầu đã xong chưa (theo dữ liệu thật).
pub async fn onboarding(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let seen: Option<String> = read_setting(&mut c, &seen_key(actor.user_id)).await?;
    let ai = ai_connection(&mut c, Some(actor.user_id), Utc::now()).await?;
    let workspace = exists(
        &mut c,
        "SELECT id FROM custom_objects WHERE deleted_at IS NULL AND is_active LIMIT 1",
    )
    .await?;
    let record = exists(&mut c, "SELECT id FROM custom_records WHERE deleted_at IS NULL LIMIT 1").await?;
    let contact = exists(&mut c, "SELECT id FROM contacts WHERE deleted_at IS NULL LIMIT 1").await?;
    let account = exists(&mut c, "SELECT id FROM social_accounts WHERE status = 'active' LIMIT 1").await?;
    let page = exists(&mut c, "SELECT id FROM facebook_pages WHERE is_active LIMIT 1").await?;
    let post = exists(
        &mut c,
        "SELECT id FROM social_post_targets WHERE status = 'published' LIMIT 1",
    )
    .await?;
    Ok(json!({
        "seen": seen.is_some(),
        "ai_connected": ai.granted,
        "workspace_built": workspace,
        "has_data": record || contact,
        "channel_linked": account || page,
        "first_post": post,
    }))
}

/// `POST /setup/onboarding/seen`.
pub async fn mark_seen(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    write_setting(&mut c, &seen_key(actor.user_id), &now_iso(), Some(actor.user_id)).await?;
    Ok(json!({ "seen": true }))
}

/// `POST /setup/complete`: dang_dung → da_dung; chưa dựng (chua_dung) thì 400.
pub async fn complete(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    if get(&mut c).await == "chua_dung" {
        return Err(bad("Chưa dựng quy trình: hãy để AI đề xuất gói dựng và duyệt trước."));
    }
    let st = set(&mut c, "da_dung", Some(actor.user_id)).await?;
    Ok(json!({ "status": st }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trang_thai() {
        for raw in [None, Some(""), Some("xyz")] {
            assert_eq!(resolve_status(raw), "da_dung");
        }
        assert_eq!(resolve_status(Some("chua_dung")), "chua_dung");
        assert_eq!(resolve_status(Some(" dang_dung ")), "dang_dung");
    }
}
