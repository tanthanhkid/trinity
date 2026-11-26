//! Hàng đợi Postgres cho việc một lần (K21, PLAN 4.9): `platform.jobs`.
//!
//! - **Nhận việc nguyên tử** bằng một câu `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`: không giữ
//!   kết nối hay giao dịch trong lúc job chạy, hai worker không bao giờ nhận cùng một việc.
//! - **Thời hạn thuê** (`locked_until`): worker chết giữa chừng thì việc được nhận lại sau khi hết hạn. Số lần thử
//!   (`attempts`) tăng lúc nhận, nên việc làm chết worker cũng bị tính; quá `max_attempts` thì chuyển `failed`.
//! - **Thử lại có backoff** (5 giây × 2^(lần-1), trần 1 giờ); quá số lần thì giữ ở trạng thái `failed` kèm `last_error`
//!   để xem, [`Queue::requeue_failed`] đặt lại.
//! - **Khoá trùng** `dedupe_key` (unique): [`Queue::enqueue`] trả `None` khi đã có việc cùng khoá. Việc xong thì xoá
//!   dòng (khoá được dùng lại).
//! - Hoàn thành/báo lỗi chỉ có hiệu lực với đúng lần nhận (`locked_by` + `attempts`): worker chậm bị nhận lại không
//!   ghi đè kết quả của lần sau.
//!
//! Bảng tạo bởi [`crate::ensure_job_tables`] (cả ở chế độ một công ty).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use trinity_db::{Db, DbError};

use crate::scheduler::{MAX_NAME_LEN, ensure_job_tables};

/// Backoff cơ sở và trần.
pub const BACKOFF_BASE: Duration = Duration::from_secs(5);
pub const BACKOFF_MAX: Duration = Duration::from_secs(3600);
/// Số lần thử mặc định.
pub const DEFAULT_MAX_ATTEMPTS: i32 = 5;

#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("việc không hợp lệ: {0}")]
    Invalid(String),
}

/// Việc mới.
#[derive(Debug, Clone)]
pub struct NewJob {
    pub company_id: i32,
    pub kind: String,
    pub payload: Value,
    /// `None` = chạy ngay.
    pub run_in: Option<Duration>,
    pub max_attempts: i32,
    pub dedupe_key: Option<String>,
}

impl NewJob {
    pub fn new(company_id: i32, kind: &str, payload: Value) -> Self {
        Self {
            company_id,
            kind: kind.to_owned(),
            payload,
            run_in: None,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            dedupe_key: None,
        }
    }

    #[must_use]
    pub fn dedupe(mut self, key: &str) -> Self {
        self.dedupe_key = Some(key.to_owned());
        self
    }

    #[must_use]
    pub fn run_in(mut self, d: Duration) -> Self {
        self.run_in = Some(d);
        self
    }

    #[must_use]
    pub fn max_attempts(mut self, n: i32) -> Self {
        self.max_attempts = n;
        self
    }
}

/// Việc đã nhận.
#[derive(Debug, Clone)]
pub struct Job {
    pub id: i64,
    pub company_id: i32,
    pub kind: String,
    pub payload: Value,
    /// Lần thử hiện tại (từ 1).
    pub attempts: i32,
    pub max_attempts: i32,
    token: String,
}

/// Một việc `failed` để xem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedJob {
    pub id: i64,
    pub company_id: i32,
    pub kind: String,
    pub attempts: i32,
    pub last_error: Option<String>,
}

/// Hàng đợi. Clone rẻ.
#[derive(Clone)]
pub struct Queue {
    db: Db,
    node_id: Arc<str>,
    claims: Arc<AtomicU64>,
    tables: Arc<tokio::sync::OnceCell<()>>,
}

impl std::fmt::Debug for Queue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Queue")
            .field("node_id", &self.node_id)
            .finish_non_exhaustive()
    }
}

/// Backoff trước lần thử sau, khi lần vừa rồi là `attempts` (≥ 1).
pub fn backoff(attempts: i32) -> Duration {
    let exp = u32::try_from(attempts.saturating_sub(1).clamp(0, 20)).unwrap_or(20);
    BACKOFF_BASE.saturating_mul(1u32 << exp).min(BACKOFF_MAX)
}

fn millis(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
}

impl Queue {
    pub fn new(db: &Db, node_id: &str) -> Self {
        let node_id: String = node_id
            .chars()
            .scan(0, |n, c| {
                *n += c.len_utf8();
                (*n <= MAX_NAME_LEN).then_some(c)
            })
            .collect();
        Self {
            db: db.clone(),
            node_id: node_id.as_str().into(),
            claims: Arc::new(AtomicU64::new(0)),
            tables: Arc::new(tokio::sync::OnceCell::new()),
        }
    }

    async fn ready(&self) -> Result<(), QueueError> {
        self.tables.get_or_try_init(|| ensure_job_tables(&self.db)).await?;
        Ok(())
    }

    /// Thêm việc. `Ok(None)` khi `dedupe_key` đã có việc đang chờ.
    pub async fn enqueue(&self, job: NewJob) -> Result<Option<i64>, QueueError> {
        if job.kind.is_empty() || job.kind.len() > MAX_NAME_LEN {
            return Err(QueueError::Invalid(format!("kind phải dài 1..={MAX_NAME_LEN} byte")));
        }
        if job.max_attempts < 1 {
            return Err(QueueError::Invalid("max_attempts phải ≥ 1".to_owned()));
        }
        if job.dedupe_key.as_ref().is_some_and(|k| k.is_empty() || k.len() > 200) {
            return Err(QueueError::Invalid("dedupe_key phải dài 1..=200 byte".to_owned()));
        }
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        let id: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO platform.jobs (company_id, kind, payload, run_at, max_attempts, dedupe_key)
             VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond', $5, $6)
             ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
        )
        .bind(job.company_id)
        .bind(&job.kind)
        .bind(&job.payload)
        .bind(job.run_in.map_or(0, millis))
        .bind(job.max_attempts)
        .bind(&job.dedupe_key)
        .fetch_optional(&mut *conn)
        .await?;
        Ok(id.map(|(i,)| i))
    }

    /// Nhận một việc đến hạn, thuê `lease`. `None` = không có việc.
    pub async fn claim(&self, lease: Duration) -> Result<Option<Job>, QueueError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        // Việc đã hết hạn thuê mà hết lần thử (worker chết giữ nó mỗi lần): giữ lại ở `failed`.
        sqlx::query(
            "UPDATE platform.jobs SET status = 'failed', locked_by = NULL, locked_until = NULL,
                    last_error = COALESCE(last_error, 'worker dừng giữa chừng, hết số lần thử')
              WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts",
        )
        .execute(&mut *conn)
        .await?;
        let token = format!("{}#{}", self.node_id, self.claims.fetch_add(1, Ordering::Relaxed));
        let row: Option<(i64, i32, String, Value, i32, i32)> = sqlx::query_as(
            "UPDATE platform.jobs SET status = 'running', attempts = attempts + 1, locked_at = now(),
                    locked_until = now() + $1 * interval '1 millisecond', locked_by = $2
              WHERE id = (
                SELECT id FROM platform.jobs
                 WHERE run_at <= now()
                   AND (status = 'queued' OR (status = 'running' AND locked_until < now()))
                 ORDER BY run_at, id
                 FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id, company_id, kind, payload, attempts, max_attempts",
        )
        .bind(millis(lease))
        .bind(&token)
        .fetch_optional(&mut *conn)
        .await?;
        Ok(row.map(|(id, company_id, kind, payload, attempts, max_attempts)| Job {
            id,
            company_id,
            kind,
            payload,
            attempts,
            max_attempts,
            token,
        }))
    }

    /// Xong: xoá dòng. `false` = lần nhận này không còn hiệu lực (đã bị nhận lại).
    pub async fn complete(&self, job: &Job) -> Result<bool, QueueError> {
        let mut conn = self.db.platform().acquire().await?;
        let n = sqlx::query("DELETE FROM platform.jobs WHERE id = $1 AND locked_by = $2 AND attempts = $3")
            .bind(job.id)
            .bind(&job.token)
            .bind(job.attempts)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        Ok(n > 0)
    }

    /// Lỗi: hết lần thử thì `failed` (giữ lại), còn thì xếp lại sau [`backoff`]. `false` = lần nhận không còn hiệu lực.
    pub async fn fail(&self, job: &Job, error: &str) -> Result<bool, QueueError> {
        let mut conn = self.db.platform().acquire().await?;
        let error: String = error.chars().take(2000).collect();
        let n = sqlx::query(
            "UPDATE platform.jobs
                SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
                    run_at = CASE WHEN attempts >= max_attempts THEN run_at
                                  ELSE now() + $4 * interval '1 millisecond' END,
                    locked_by = NULL, locked_until = NULL, last_error = $5
              WHERE id = $1 AND locked_by = $2 AND attempts = $3",
        )
        .bind(job.id)
        .bind(&job.token)
        .bind(job.attempts)
        .bind(millis(backoff(job.attempts)))
        .bind(error)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        Ok(n > 0)
    }

    /// Việc `failed` (mới nhất trước).
    pub async fn list_failed(&self, limit: i64) -> Result<Vec<FailedJob>, QueueError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        let rows: Vec<(i64, i32, String, i32, Option<String>)> = sqlx::query_as(
            "SELECT id, company_id, kind, attempts, last_error FROM platform.jobs
              WHERE status = 'failed' ORDER BY id DESC LIMIT $1",
        )
        .bind(limit.clamp(1, 1000))
        .fetch_all(&mut *conn)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, company_id, kind, attempts, last_error)| FailedJob {
                id,
                company_id,
                kind,
                attempts,
                last_error,
            })
            .collect())
    }

    /// Đặt lại việc `failed` để chạy lại ngay (số lần thử về 0). `false` = không có việc đó ở trạng thái `failed`.
    pub async fn requeue_failed(&self, id: i64) -> Result<bool, QueueError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        let n = sqlx::query(
            "UPDATE platform.jobs SET status = 'queued', attempts = 0, run_at = now() WHERE id = $1 AND status = 'failed'",
        )
        .bind(id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        Ok(n > 0)
    }
}

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type Handler = Arc<dyn Fn(Job) -> HandlerFuture + Send + Sync>;

/// Cấu hình worker.
#[derive(Debug, Clone, Copy)]
pub struct WorkerConfig {
    /// Số việc chạy cùng lúc trong tiến trình.
    pub concurrency: usize,
    /// Thời hạn thuê, cũng là trần thời gian một việc.
    pub lease: Duration,
    /// Nghỉ khi hàng đợi trống.
    pub poll: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            concurrency: 4,
            lease: Duration::from_secs(300),
            poll: Duration::from_millis(500),
        }
    }
}

/// Worker: bộ xử lý theo `kind`, chạy `concurrency` vòng nhận việc.
#[derive(Clone)]
pub struct Worker {
    queue: Queue,
    cfg: WorkerConfig,
    handlers: HashMap<String, Handler>,
}

impl Worker {
    pub fn new(queue: &Queue, cfg: WorkerConfig) -> Self {
        Self {
            queue: queue.clone(),
            cfg,
            handlers: HashMap::new(),
        }
    }

    pub fn handle<F, Fut>(&mut self, kind: &str, f: F)
    where
        F: Fn(Job) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        self.handlers.insert(kind.to_owned(), Arc::new(move |j| Box::pin(f(j))));
    }

    /// Nhận và chạy MỘT việc nếu có. `true` = đã xử lý một việc.
    pub async fn run_once(&self) -> Result<bool, QueueError> {
        let Some(job) = self.queue.claim(self.cfg.lease).await? else {
            return Ok(false);
        };
        let Some(handler) = self.handlers.get(&job.kind).cloned() else {
            // Không có bộ xử lý: không thử lại vô ích, giữ lại để xem.
            let msg = format!("không có bộ xử lý cho kind \"{}\"", job.kind);
            sqlx_fail_now(&self.queue, &job, &msg).await?;
            return Ok(true);
        };
        // Task riêng: panic thành lỗi của việc; quá hạn thuê thì bị huỷ.
        let mut task = tokio::spawn(handler(job.clone()));
        let res = match tokio::time::timeout(self.cfg.lease, &mut task).await {
            Ok(Ok(r)) => r,
            Ok(Err(join)) => Err(format!("việc dừng bất thường: {join}")),
            Err(_) => {
                task.abort();
                Err(format!("quá thời hạn thuê {} ms", self.cfg.lease.as_millis()))
            }
        };
        match res {
            Ok(()) => {
                self.queue.complete(&job).await?;
            }
            Err(e) => {
                self.queue.fail(&job, &e).await?;
            }
        }
        Ok(true)
    }

    /// Chạy `concurrency` vòng cho tới khi `shutdown` đổi sang `true`; chờ việc đang chạy xong (tối đa một hạn thuê).
    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), QueueError> {
        self.queue.ready().await?;
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..self.cfg.concurrency.max(1) {
            let (this, stop) = (self.clone(), shutdown.clone());
            tasks.spawn(async move {
                while !*stop.borrow() {
                    match this.run_once().await {
                        Ok(true) => {}
                        Ok(false) => tokio::time::sleep(this.cfg.poll).await,
                        Err(e) => {
                            tracing::error!("hàng đợi: {e}");
                            tokio::time::sleep(this.cfg.poll).await;
                        }
                    }
                }
            });
        }
        while !*shutdown.borrow() {
            if shutdown.changed().await.is_err() {
                break;
            }
        }
        let drained = tokio::time::timeout(self.cfg.lease, async { while tasks.join_next().await.is_some() {} }).await;
        if drained.is_err() {
            tasks.shutdown().await;
        }
        Ok(())
    }
}

/// Đặt `failed` ngay (không backoff) cho việc không có bộ xử lý.
async fn sqlx_fail_now(queue: &Queue, job: &Job, msg: &str) -> Result<(), QueueError> {
    let mut conn = queue.db.platform().acquire().await?;
    sqlx::query(
        "UPDATE platform.jobs SET status = 'failed', locked_by = NULL, locked_until = NULL, last_error = $4
          WHERE id = $1 AND locked_by = $2 AND attempts = $3",
    )
    .bind(job.id)
    .bind(&job.token)
    .bind(job.attempts)
    .bind(msg)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
