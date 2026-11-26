//! Worker gửi: nhận việc (`FOR UPDATE SKIP LOCKED`), gửi, ghi kết quả; mỗi lượt nhận tăng `attempts` NGAY (chặn thử lại vô
//! hạn). Port của `webhook-delivery-worker.service.ts`. Hàng đợi dùng bảng `webhook_deliveries` như bản Node (cùng một hàng
//! đợi với Node trong giai đoạn lai); K21 (`platform.jobs`) không thay được vì bản Node đọc bảng này.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::{PgConnection, Row};
use trinity_db::TenantDb;
use trinity_db::outbox::{NewNotification, create_notification};

use super::actors::ActorProvider;
use super::payload::{ActorScopes, evaluate_event};
use super::retry::{AUTO_DISABLE_AFTER_FAILURES, MAX_ATTEMPTS, next_retry_delay_sec};
use super::sender::{PostResult, SendItem, SendTarget, Sender};

pub const CLAIM_BATCH: i64 = 20;
/// Chừa đủ cho một lượt gửi (hạn 10 giây) cộng ghi kết quả.
pub const SEND_MARGIN: Duration = Duration::from_secs(11);
const CONCURRENCY: usize = 5;
/// Hợp đồng thuê: việc đã nhận mà chưa ghi kết quả (crash) sẽ được nhận lại sau chừng này.
pub const LEASE_SECONDS: f64 = 120.0;

#[derive(Debug, Clone)]
pub struct Claimed {
    pub id: String,
    pub endpoint_id: i32,
    pub event_type: String,
    pub payload: Value,
    pub attempts: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Db(#[from] trinity_db::DbError),
    #[error("cấp quyền chủ thể lỗi: {0}")]
    Actor(String),
}

/// `UPDATE … RETURNING` một câu: hai tiến trình không bao giờ nhận cùng một dòng (SKIP LOCKED và dịch `next_attempt_at` ra sau
/// = lease). Chỉ nhận việc của endpoint đang bật.
pub async fn claim(conn: &mut PgConnection, limit: i64) -> Result<Vec<Claimed>, sqlx::Error> {
    let rows = sqlx::query(
        "UPDATE webhook_deliveries d \
            SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => $1) \
          WHERE d.id IN ( \
            SELECT d2.id FROM webhook_deliveries d2 \
              JOIN webhook_endpoints e ON e.id = d2.endpoint_id AND e.is_active = true \
             WHERE d2.status IN ('pending', 'failed') AND d2.next_attempt_at <= now() AND d2.attempts < $2 \
             ORDER BY d2.next_attempt_at ASC LIMIT $3 FOR UPDATE OF d2 SKIP LOCKED) \
        RETURNING d.id::text AS id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.created_at",
    )
    .bind(LEASE_SECONDS)
    .bind(MAX_ATTEMPTS)
    .bind(limit)
    .fetch_all(conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(Claimed {
                id: r.try_get("id")?,
                endpoint_id: r.try_get("endpoint_id")?,
                event_type: r.try_get("event_type")?,
                payload: r.try_get("payload")?,
                attempts: r.try_get("attempts")?,
                created_at: r.try_get("created_at")?,
            })
        })
        .collect()
}

/// Việc đã hết lượt (`attempts >= MAX`) mà vẫn pending/failed ⇒ lượt cuối bị gián đoạn và lease đã hết: chuyển `dead` thay vì
/// nhận lại. Trần số lần gửi là TUYỆT ĐỐI kể cả khi bước ghi kết quả không bao giờ chạy tới.
pub async fn sweep_exhausted(conn: &mut PgConnection) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "UPDATE webhook_deliveries SET status = 'dead', last_error = 'attempts_exhausted' \
         WHERE status IN ('pending', 'failed') AND attempts >= $1 AND next_attempt_at <= now()",
    )
    .bind(MAX_ATTEMPTS)
    .execute(conn)
    .await?
    .rows_affected())
}

enum Outcome<'a> {
    Dead(&'a str),
    Result(PostResult),
}

struct EndpointRef {
    id: i32,
    created_by: i32,
    name: String,
}

pub struct Worker<'a> {
    /// Quá mốc này thì không nhận thêm việc (chừa thời gian cho một lượt gửi dở) và trả lại việc chưa kịp xử lý.
    pub deadline: Instant,
    pub tenant: &'a TenantDb,
    pub sender: &'a Sender,
    pub actors: &'a dyn ActorProvider,
}

impl Worker<'_> {
    /// Gửi một lô với tối đa 5 làn song song. Lỗi xử lý một dòng chỉ ghi log (lease sẽ nhận lại; `attempts` đã tăng nên có trần).
    pub async fn process_batch(&self, rows: Vec<Claimed>) {
        let queue = Mutex::new(VecDeque::from(rows));
        let cache: Mutex<HashMap<i32, Option<ActorScopes>>> = Mutex::new(HashMap::new());
        let lanes = (0..CONCURRENCY.min(queue.lock().map_or(0, |q| q.len()))).map(|_| async {
            while Instant::now() + SEND_MARGIN < self.deadline {
                let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                let Some(row) = next else { break };
                if let Err(e) = self.process_one(&row, &cache).await {
                    tracing::error!("Webhook delivery {}: lỗi xử lý ({e})", row.id);
                }
            }
        });
        futures_util::future::join_all(lanes).await;
        // Việc đã nhận mà chưa kịp gửi (hết giờ): trả lại để lượt sau nhận ngay, không bắt chờ hết lease và không tốn một lần gửi.
        let left: Vec<Claimed> = queue.into_inner().map(Vec::from).unwrap_or_default();
        if !left.is_empty()
            && let Err(e) = self.release(&left).await
        {
            tracing::error!("Webhook: không trả lại được {} việc chưa gửi ({e})", left.len());
        }
    }

    async fn release(&self, rows: &[Claimed]) -> Result<(), WorkerError> {
        let mut conn = self.tenant.acquire().await?;
        for r in rows {
            sqlx::query(
                "UPDATE webhook_deliveries SET attempts = attempts - 1, next_attempt_at = now() \
                 WHERE id = $1::uuid AND attempts = $2 AND status IN ('pending', 'failed')",
            )
            .bind(&r.id)
            .bind(r.attempts)
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }

    async fn scopes(
        &self,
        cache: &Mutex<HashMap<i32, Option<ActorScopes>>>,
        user: i32,
    ) -> Result<Option<ActorScopes>, String> {
        if let Some(v) = cache.lock().ok().and_then(|c| c.get(&user).cloned()) {
            return Ok(v);
        }
        let v = self.actors.scopes_for(self.tenant, user).await?;
        if let Ok(mut c) = cache.lock() {
            c.insert(user, v.clone());
        }
        Ok(v)
    }

    async fn process_one(&self, row: &Claimed, cache: &Mutex<HashMap<i32, Option<ActorScopes>>>) -> Result<(), String> {
        let e = |x: WorkerError| x.to_string();
        let mut conn = self.tenant.acquire().await.map_err(|x| x.to_string())?;
        let ep =
            sqlx::query("SELECT id, name, url, secret_enc, created_by, is_active FROM webhook_endpoints WHERE id = $1")
                .bind(row.endpoint_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|x| x.to_string())?;
        let Some(ep) = ep.filter(|r| r.get::<bool, _>("is_active")) else {
            return self
                .settle(&mut conn, row, Outcome::Dead("endpoint_inactive"), None)
                .await
                .map_err(e);
        };
        let epr = EndpointRef {
            id: ep.get("id"),
            created_by: ep.get("created_by"),
            name: ep.get("name"),
        };
        drop(conn);
        let Some(scopes) = self.scopes(cache, epr.created_by).await? else {
            self.deactivate(epr.id, "creator_unauthorized", epr.created_by, &epr.name)
                .await
                .map_err(|x| x.to_string())?;
            let mut conn = self.tenant.acquire().await.map_err(|x| x.to_string())?;
            return self
                .settle(&mut conn, row, Outcome::Dead("creator_unauthorized"), None)
                .await
                .map_err(e);
        };
        let mut conn = self.tenant.acquire().await.map_err(|x| x.to_string())?;
        if crate::webhooks::endpoints::event_catalog()
            .iter()
            .all(|c| c["type"] != row.event_type.as_str())
        {
            return self
                .settle(&mut conn, row, Outcome::Dead("unknown_event"), None)
                .await
                .map_err(e);
        }
        // Che và lọc LẠI theo quyền HIỆN TẠI (có thể đã đổi từ lúc tạo delivery).
        let Some(data) = evaluate_event(&row.event_type, &row.payload, &scopes) else {
            return self
                .settle(&mut conn, row, Outcome::Dead("no_longer_visible"), None)
                .await
                .map_err(e);
        };
        let target = SendTarget {
            endpoint_id: epr.id,
            url: ep.get("url"),
            secret_enc: ep.get("secret_enc"),
            created_by: epr.created_by,
        };
        let item = SendItem {
            delivery_id: row.id.clone(),
            event_type: row.event_type.clone(),
            data,
            created_at: row.created_at,
            attempt: row.attempts,
        };
        // Thả kết nối trước khi chờ HTTP (tối đa 10 giây); lấy kết nối mới để ghi nhật ký và kết quả.
        drop(conn);
        let res = self.sender.send(&target, &item).await;
        let mut conn = self.tenant.acquire().await.map_err(|x| x.to_string())?;
        self.sender.record(&mut conn, &target, &item, &res).await;
        self.settle(&mut conn, row, Outcome::Result(res), Some(&epr))
            .await
            .map_err(e)
    }

    /// Ghi kết quả CHỈ khi lượt nhận còn hiệu lực (`attempts` khớp, còn pending/failed): chống ghi đè muộn.
    async fn settle(
        &self,
        conn: &mut PgConnection,
        row: &Claimed,
        outcome: Outcome<'_>,
        ep: Option<&EndpointRef>,
    ) -> Result<(), WorkerError> {
        let res = match outcome {
            Outcome::Dead(reason) => {
                sqlx::query("UPDATE webhook_deliveries SET status = 'dead', last_error = $3 WHERE id = $1::uuid AND attempts = $2 AND status IN ('pending', 'failed')")
                    .bind(&row.id)
                    .bind(row.attempts)
                    .bind(reason)
                    .execute(conn)
                    .await?;
                return Ok(());
            }
            Outcome::Result(r) => r,
        };
        if res.ok {
            let done = sqlx::query(
                "UPDATE webhook_deliveries SET status = 'success', delivered_at = now(), last_status_code = $3, last_error = NULL \
                 WHERE id = $1::uuid AND attempts = $2 AND status IN ('pending', 'failed')",
            )
            .bind(&row.id)
            .bind(row.attempts)
            .bind(res.status_code)
            .execute(&mut *conn)
            .await?
            .rows_affected();
            if done > 0
                && let Some(ep) = ep
            {
                sqlx::query("UPDATE webhook_endpoints SET last_success_at = now(), consecutive_failures = 0, updated_at = now() WHERE id = $1")
                        .bind(ep.id)
                        .execute(conn)
                        .await?;
            }
            return Ok(());
        }
        let delay = next_retry_delay_sec(row.attempts);
        let failed = sqlx::query(
            "UPDATE webhook_deliveries SET status = $3, last_status_code = $4, last_error = $5, \
               next_attempt_at = CASE WHEN $6::float8 IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => $6::float8) END \
             WHERE id = $1::uuid AND attempts = $2 AND status IN ('pending', 'failed')",
        )
        .bind(&row.id)
        .bind(row.attempts)
        .bind(if delay.is_none() { "dead" } else { "failed" })
        .bind(res.status_code)
        .bind(res.error.as_deref())
        .bind(delay.map(|d| d as f64))
        .execute(&mut *conn)
        .await?
        .rows_affected();
        // Lỗi cấu hình khoá (`secret_*`) không phải lỗi của endpoint ⇒ không tính vào bộ đếm tự tắt.
        if failed > 0
            && !res.error.as_deref().is_some_and(|e| e.starts_with("secret_"))
            && let Some(ep) = ep
        {
            let n: i32 = sqlx::query_scalar(
                    "UPDATE webhook_endpoints SET last_failure_at = now(), consecutive_failures = consecutive_failures + 1, updated_at = now() \
                     WHERE id = $1 RETURNING consecutive_failures",
                )
                .bind(ep.id)
                .fetch_one(&mut *conn)
                .await?;
            if n >= AUTO_DISABLE_AFTER_FAILURES {
                self.deactivate(ep.id, "consecutive_failures", ep.created_by, &ep.name)
                    .await?;
            }
        }
        Ok(())
    }

    /// Tắt endpoint (idempotent: chỉ lần chuyển true sang false mới thông báo) và đưa việc chờ về `dead`. Việc TẮT được commit
    /// TRƯỚC; thông báo ở giao dịch riêng sau đó, lỗi thông báo chỉ ghi log và không làm mất việc tắt.
    pub async fn deactivate(
        &self,
        endpoint_id: i32,
        reason: &str,
        creator: i32,
        name: &str,
    ) -> Result<(), WorkerError> {
        let mut tx = self.tenant.begin().await?;
        let n = sqlx::query("UPDATE webhook_endpoints SET is_active = false, disabled_reason = $2, updated_at = now() WHERE id = $1 AND is_active = true")
            .bind(endpoint_id)
            .bind(reason)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if n == 0 {
            return Ok(());
        }
        sqlx::query("UPDATE webhook_deliveries SET status = 'dead', last_error = 'endpoint_disabled' WHERE endpoint_id = $1 AND status IN ('pending', 'failed')")
            .bind(endpoint_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::warn!("Webhook endpoint={endpoint_id} tự tắt ({reason})");
        let why = if reason == "consecutive_failures" {
            format!("lỗi liên tiếp {AUTO_DISABLE_AFTER_FAILURES} lần")
        } else {
            "người tạo không còn quyền quản lý webhook".to_owned()
        };
        let note = NewNotification {
            recipient_id: creator,
            event_type: "webhook_endpoint_disabled".into(),
            title: "Webhook tự động tắt".into(),
            body: format!("Endpoint \"{name}\" đã bị tắt: {why}. Kiểm tra rồi bật lại ở Cài đặt > Kết nối & AI."),
            action_url: Some("/connections?muc=webhook-out".into()),
        };
        if let Err(e) = self.notify(note).await {
            tracing::warn!("Không gửi được thông báo tắt webhook endpoint={endpoint_id}: {e}");
        }
        Ok(())
    }

    async fn notify(&self, note: NewNotification) -> Result<(), String> {
        let mut tx = self.tenant.begin().await.map_err(|e| e.to_string())?;
        create_notification(&mut tx, &[note]).await.map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
}
