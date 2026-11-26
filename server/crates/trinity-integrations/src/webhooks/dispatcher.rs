//! Dispatcher: outbox → delivery cho từng endpoint đăng ký, rồi gửi (port `webhook-dispatcher.service.ts`). Mỗi tick (10 giây):
//! (1) outbox → delivery; (2) quét việc hết lượt; (3) nhận và gửi tối đa 20 việc đến hạn; (4) dọn (6 giờ một lần mỗi công ty).
//! Nhiều tiến trình chạy trùng vẫn đúng: delivery có UNIQUE (endpoint_id, event_id), việc gửi nhận bằng SKIP LOCKED.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgConnection, Row};
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_jobs::{JobSpec, SchedulerError};

use super::actors::ActorProvider;
use super::payload::{ActorScopes, evaluate_event};
use super::sender::Sender;
use super::worker::{CLAIM_BATCH, SEND_MARGIN, Worker, WorkerError, claim, sweep_exhausted};

/// Tên trong tệp sở hữu (`KNOWN_JOBS`).
pub const JOB_WEBHOOK_DISPATCH: &str = "integrations.webhook-dispatch";
/// Budget 30 giây theo PLAN 1.9.
pub const BUDGET: Duration = Duration::from_secs(30);
pub const TICK: Duration = Duration::from_secs(10);
const EVENT_BATCH: i64 = 200;
const MAX_EVENT_LOOPS: usize = 5;
/// Sự kiện outbox cũ hơn mức này (vd cờ tắt rồi bật lại) không đẩy nữa: tránh dội sự kiện lỗi thời.
pub const EVENT_MAX_AGE: chrono::Duration = chrono::Duration::days(7);
const DELIVERY_RETENTION_DAYS: i64 = 30;
/// Receipt idempotency của webhook vào: đủ dài cho mọi cơ chế gửi lại hợp lý của bên gửi.
const RECEIPT_RETENTION_DAYS: i64 = 180;
const HOUSEKEEPING_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

pub struct Dispatcher {
    pub sender: Sender,
    pub actors: Box<dyn ActorProvider>,
    last_housekeeping: Mutex<HashMap<i32, Instant>>,
}

struct Pending {
    id: i64,
    event_type: String,
    payload: Value,
    created_at: DateTime<Utc>,
}

impl Dispatcher {
    pub fn new(sender: Sender, actors: Box<dyn ActorProvider>) -> Self {
        Self {
            sender,
            actors,
            last_housekeeping: Mutex::new(HashMap::new()),
        }
    }

    /// Một lượt cho một công ty. `enabled` = cờ `INTEGRATIONS_WEBHOOKS_ENABLED`. Khoá mã hoá thiếu ⇒ tạm dừng (ghi log).
    pub async fn tick(&self, tenant: &TenantDb, enabled: bool) -> Result<(), WorkerError> {
        self.tick_until(tenant, enabled, Instant::now() + BUDGET).await
    }

    /// Như [`Self::tick`] với hạn rõ ràng: gần hết giờ thì không nhận thêm việc.
    pub async fn tick_until(&self, tenant: &TenantDb, enabled: bool, deadline: Instant) -> Result<(), WorkerError> {
        if !enabled {
            return Ok(());
        }
        if let Err(e) = self.sender.key() {
            tracing::error!("Webhook worker tạm dừng: {e}");
            return Ok(());
        }
        self.dispatch_events(tenant).await?;
        let mut conn = tenant.acquire().await?;
        sweep_exhausted(&mut conn).await?;
        // Gần hết giờ thì không nhận thêm việc (mỗi lượt gửi có thể mất tới 10 giây).
        let rows = if Instant::now() + SEND_MARGIN < deadline {
            claim(&mut conn, CLAIM_BATCH).await?
        } else {
            Vec::new()
        };
        drop(conn);
        if !rows.is_empty() {
            Worker {
                deadline,
                tenant,
                sender: &self.sender,
                actors: self.actors.as_ref(),
            }
            .process_batch(rows)
            .await;
        }
        self.housekeeping(tenant).await?;
        Ok(())
    }

    /// Outbox → delivery. Lọc `dispatched_at IS NULL`, KHÔNG dùng mốc id (id cấp lúc INSERT, không theo thứ tự COMMIT).
    pub async fn dispatch_events(&self, tenant: &TenantDb) -> Result<usize, WorkerError> {
        let mut total = 0;
        for _ in 0..MAX_EVENT_LOOPS {
            let mut conn = tenant.acquire().await?;
            let rows = sqlx::query(
                "SELECT id, event_type, payload, created_at FROM integration_events WHERE dispatched_at IS NULL ORDER BY id ASC LIMIT $1",
            )
            .bind(EVENT_BATCH)
            .fetch_all(&mut *conn)
            .await?;
            if rows.is_empty() {
                break;
            }
            let pending: Vec<Pending> = rows
                .iter()
                .map(|r| {
                    Ok(Pending {
                        id: r.try_get("id")?,
                        event_type: r.try_get("event_type")?,
                        payload: r.try_get("payload")?,
                        created_at: r.try_get("created_at")?,
                    })
                })
                .collect::<Result<_, sqlx::Error>>()?;
            let n = pending.len();
            let endpoints = sqlx::query(
                "SELECT id, name, events, created_by, created_at FROM webhook_endpoints WHERE is_active = true ORDER BY id",
            )
            .fetch_all(&mut *conn)
            .await?;
            drop(conn);
            total += self.build_deliveries(tenant, &pending, &endpoints).await?;
            let mut conn = tenant.acquire().await?;
            let ids: Vec<i64> = pending.iter().map(|p| p.id).collect();
            sqlx::query(
                "UPDATE integration_events SET dispatched_at = now() WHERE id = ANY($1) AND dispatched_at IS NULL",
            )
            .bind(&ids)
            .execute(&mut *conn)
            .await?;
            if i64::try_from(n).unwrap_or(i64::MAX) < EVENT_BATCH {
                break;
            }
        }
        Ok(total)
    }

    async fn build_deliveries(
        &self,
        tenant: &TenantDb,
        pending: &[Pending],
        endpoints: &[sqlx::postgres::PgRow],
    ) -> Result<usize, WorkerError> {
        let mut scopes: HashMap<i32, Option<ActorScopes>> = HashMap::new();
        let mut rows: Vec<(i32, i64, String, Value)> = Vec::new();
        let oldest = Utc::now() - EVENT_MAX_AGE;
        for ep in endpoints {
            let (id, created_by): (i32, i32) = (ep.try_get("id")?, ep.try_get("created_by")?);
            let (name, events, ep_created): (String, Vec<String>, DateTime<Utc>) =
                (ep.try_get("name")?, ep.try_get("events")?, ep.try_get("created_at")?);
            let mine: Vec<&Pending> = pending
                .iter()
                .filter(|e| events.contains(&e.event_type) && e.created_at >= ep_created && e.created_at >= oldest)
                .collect();
            if mine.is_empty() {
                continue;
            }
            if let std::collections::hash_map::Entry::Vacant(e) = scopes.entry(created_by) {
                let s = self
                    .actors
                    .scopes_for(tenant, created_by)
                    .await
                    .map_err(WorkerError::Actor)?;
                e.insert(s);
            }
            let Some(s) = scopes.get(&created_by).and_then(Option::as_ref) else {
                Worker {
                    deadline: Instant::now() + BUDGET,
                    tenant,
                    sender: &self.sender,
                    actors: self.actors.as_ref(),
                }
                .deactivate(id, "creator_unauthorized", created_by, &name)
                .await?;
                continue;
            };
            for ev in mine {
                if let Some(data) = evaluate_event(&ev.event_type, &ev.payload, s) {
                    rows.push((id, ev.id, ev.event_type.clone(), data));
                }
            }
        }
        if rows.is_empty() {
            return Ok(0);
        }
        let mut conn = tenant.acquire().await?;
        let mut inserted = 0;
        for (ep, ev, ty, data) in &rows {
            inserted += sqlx::query(
                "INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload) VALUES ($1, $2, $3, $4::text::jsonb) \
                 ON CONFLICT (endpoint_id, event_id) DO NOTHING",
            )
            .bind(ep)
            .bind(ev)
            .bind(ty)
            .bind(trinity_kernel::json::js_json(data))
            .execute(&mut *conn)
            .await?
            .rows_affected();
        }
        Ok(usize::try_from(inserted).unwrap_or(usize::MAX))
    }

    /// Dọn delivery xong hoặc chết quá 30 ngày và receipt webhook vào quá 180 ngày (theo lô).
    async fn housekeeping(&self, tenant: &TenantDb) -> Result<(), WorkerError> {
        let company = tenant.company().id();
        {
            let mut m = self
                .last_housekeeping
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if m.get(&company).is_some_and(|t| t.elapsed() < HOUSEKEEPING_EVERY) {
                return Ok(());
            }
            m.insert(company, Instant::now());
        }
        let mut conn = tenant.acquire().await?;
        housekeeping_once(&mut conn, Utc::now()).await?;
        Ok(())
    }
}

/// Phần dọn của một lượt (tách ra để test không phải chờ 6 giờ).
pub async fn housekeeping_once(conn: &mut PgConnection, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM webhook_inbound_receipts WHERE created_at < $1")
        .bind(now - chrono::Duration::days(RECEIPT_RETENTION_DAYS))
        .execute(&mut *conn)
        .await?;
    let before = now - chrono::Duration::days(DELIVERY_RETENTION_DAYS);
    for _ in 0..20 {
        let n = sqlx::query(
            "DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries \
             WHERE status IN ('success', 'dead') AND created_at < $1 ORDER BY created_at ASC LIMIT 1000)",
        )
        .bind(before)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        if n < 1000 {
            break;
        }
    }
    Ok(())
}

/// Job 10 giây một lượt, theo từng công ty. `enabled` = `status::webhooks_enabled`; tắt ⇒ `None` (không đăng ký).
pub fn webhook_tick_job(
    db: &Db,
    dispatcher: std::sync::Arc<Dispatcher>,
    enabled: bool,
) -> Result<Option<JobSpec>, SchedulerError> {
    if !enabled {
        return Ok(None);
    }
    let db = db.clone();
    JobSpec::new(JOB_WEBHOOK_DISPATCH, TICK, BUDGET, move |company: CompanyRef| {
        let (db, d) = (db.clone(), std::sync::Arc::clone(&dispatcher));
        async move {
            let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
            d.tick(&tenant, true).await.map_err(|e| e.to_string())
        }
    })
    .map(Some)
}
