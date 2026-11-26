//! Hai job dọn theo từng công ty: outbox `integration_events` và các bảng OAuth. Bản Node chạy 6 giờ một lượt, chỉ khi
//! cờ tích hợp bật (`integrations.outbox-purge`: một trong hai cờ; `integrations.oauth-purge`: cờ MCP và URL gốc).

use std::time::Duration;

use chrono::{DateTime, Duration as Span, Utc};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db};
use trinity_jobs::{JobSpec, SchedulerError};

pub const JOB_OUTBOX_PURGE: &str = "integrations.outbox-purge";
pub const JOB_OAUTH_PURGE: &str = "integrations.oauth-purge";

pub const OUTBOX_DISPATCHED_RETENTION_DAYS: i64 = 30;
pub const OUTBOX_UNDISPATCHED_RETENTION_DAYS: i64 = 90;
const PURGE_BATCH: i64 = 2000;
const PURGE_MAX_BATCHES: usize = 50;
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const BUDGET: Duration = Duration::from_secs(55);

/// Xoá theo lô (không `DELETE` một phát hàng triệu dòng). `cond` là điều kiện cố định trong mã, tham số `$1` là mốc cắt.
async fn purge_where(conn: &mut PgConnection, sql: &'static str, cutoff: DateTime<Utc>) -> Result<u64, sqlx::Error> {
    let mut total = 0;
    for _ in 0..PURGE_MAX_BATCHES {
        let n = sqlx::query(sql)
            .bind(cutoff)
            .bind(PURGE_BATCH)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        total += n;
        if i64::try_from(n).unwrap_or(i64::MAX) < PURGE_BATCH {
            break;
        }
    }
    Ok(total)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxPurged {
    /// Đã dispatch quá 30 ngày.
    pub dispatched: u64,
    /// Chưa dispatch quá 90 ngày.
    pub stale: u64,
}

pub async fn purge_outbox(conn: &mut PgConnection, now: DateTime<Utc>) -> Result<OutboxPurged, sqlx::Error> {
    let dispatched = purge_where(
        conn,
        "DELETE FROM integration_events WHERE id IN (SELECT id FROM integration_events \
         WHERE dispatched_at IS NOT NULL AND dispatched_at < $1 ORDER BY id LIMIT $2)",
        now - Span::days(OUTBOX_DISPATCHED_RETENTION_DAYS),
    )
    .await?;
    let stale = purge_where(
        conn,
        "DELETE FROM integration_events WHERE id IN (SELECT id FROM integration_events \
         WHERE dispatched_at IS NULL AND created_at < $1 ORDER BY id LIMIT $2)",
        now - Span::days(OUTBOX_UNDISPATCHED_RETENTION_DAYS),
    )
    .await?;
    Ok(OutboxPurged { dispatched, stale })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OauthPurged {
    pub codes: u64,
    pub tokens: u64,
    pub clients: u64,
}

/// Mã hết hạn quá 1 ngày; token có refresh hết hạn quá 7 ngày hoặc thu hồi quá 30 ngày; client DCR chưa từng dùng quá
/// 7 ngày; client CIMD không dùng quá 60 ngày.
pub async fn purge_oauth(conn: &mut PgConnection, now: DateTime<Utc>) -> Result<OauthPurged, sqlx::Error> {
    let ago = |d: i64| now - Span::days(d);
    let codes = sqlx::query("DELETE FROM oauth_authorization_codes WHERE expires_at < $1")
        .bind(ago(1))
        .execute(&mut *conn)
        .await?
        .rows_affected();
    let tokens = sqlx::query("DELETE FROM oauth_tokens WHERE refresh_expires_at < $1 OR revoked_at < $2")
        .bind(ago(7))
        .bind(ago(30))
        .execute(&mut *conn)
        .await?
        .rows_affected();
    let clients = sqlx::query(
        "DELETE FROM oauth_clients WHERE (kind = 'dcr' AND last_used_at IS NULL AND created_at < $1) \
         OR (kind = 'cimd' AND (last_used_at < $2 OR (last_used_at IS NULL AND created_at < $2)))",
    )
    .bind(ago(7))
    .bind(ago(60))
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(OauthPurged { codes, tokens, clients })
}

/// Job dọn outbox. `enabled` = `status::any_enabled`; tắt ⇒ `None` (không đăng ký, như Node không tạo timer).
pub fn outbox_purge_job(db: &Db, enabled: bool) -> Result<Option<JobSpec>, SchedulerError> {
    if !enabled {
        return Ok(None);
    }
    let db = db.clone();
    JobSpec::new(JOB_OUTBOX_PURGE, INTERVAL, BUDGET, move |company: CompanyRef| {
        let db = db.clone();
        async move {
            let mut conn = db
                .tenant(company)
                .await
                .map_err(|e| e.to_string())?
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            let r = purge_outbox(&mut conn, Utc::now()).await.map_err(|e| e.to_string())?;
            if r.dispatched + r.stale > 0 {
                tracing::info!(
                    "Outbox purge: {} đã dispatch >30 ngày, {} chưa dispatch >90 ngày",
                    r.dispatched,
                    r.stale
                );
            }
            Ok(())
        }
    })
    .map(Some)
}

/// Job dọn OAuth. `enabled` = `status::oauth_enabled`.
pub fn oauth_purge_job(db: &Db, enabled: bool) -> Result<Option<JobSpec>, SchedulerError> {
    if !enabled {
        return Ok(None);
    }
    let db = db.clone();
    JobSpec::new(JOB_OAUTH_PURGE, INTERVAL, BUDGET, move |company: CompanyRef| {
        let db = db.clone();
        async move {
            let mut conn = db
                .tenant(company)
                .await
                .map_err(|e| e.to_string())?
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            let r = purge_oauth(&mut conn, Utc::now()).await.map_err(|e| e.to_string())?;
            if r.codes + r.tokens + r.clients > 0 {
                tracing::info!("OAuth purge: {} mã, {} token, {} client", r.codes, r.tokens, r.clients);
            }
            Ok(())
        }
    })
    .map(Some)
}
