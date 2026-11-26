//! Scheduler theo công ty có budget và nhận lượt qua bảng (K20, PLAN 4.9).
//!
//! - Mỗi job khai tên, chu kỳ và budget ([`JobSpec`]). Một lượt ([`Scheduler::tick`]) duyệt công ty đang hoạt động
//!   bắt đầu sau công ty cuối đã tới ở lượt trước (con trỏ theo job, theo id như `runForEachCompany`), dừng bắt đầu
//!   công ty mới khi hết `budget * 0.6` (chừa phần cho công ty đang chạy dở), công ty lỗi không chặn công ty khác.
//! - **Nhận lượt** cho cặp (job, công ty) trong một giao dịch ngắn: `pg_try_advisory_xact_lock` rồi ghi `locked_until`
//!   vào `platform.job_runs`; lượt khác thấy `locked_until` chưa qua thì bỏ qua. Khoá nhả ngay khi commit và kết nối
//!   về pool trước khi job chạy: không có khoá mức phiên, không giữ kết nối suốt lượt (job gọi mạng không chiếm pool).
//!   Task bị huỷ giữa chừng thì `locked_until` hết hạn rồi lượt sau chạy lại.
//! - Chủ của job đọc từ tệp sở hữu ([`Ownership::job`]), nạp lại bằng [`Scheduler::set_ownership`] (SIGHUP) hoặc
//!   [`Scheduler::reload_ownership`] (tệp hỏng thì giữ bảng đang dùng).
//! - `platform.job_runs` tồn tại cả ở chế độ một công ty ([`ensure_job_tables`]); chế độ một công ty chỉ có công ty 1.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use sqlx::AssertSqlSafe;
use tokio::time::{Instant, MissedTickBehavior};
use trinity_db::platform::{PLATFORM_LOCK, Platform};
use trinity_db::{CompanyRef, Db, DbError};
use trinity_kernel::ownership::{Owner, Ownership};

/// Độ dài tối đa của tên job và `node_id` (cột `varchar(100)`; `locked_by` thêm hậu tố nhận lượt).
pub const MAX_NAME_LEN: usize = 100;
/// Trần budget của một job.
pub const MAX_BUDGET: Duration = Duration::from_secs(600);
/// Thời gian tối thiểu cho một công ty đã bắt đầu, kể cả khi tick gần hết budget.
pub const MIN_COMPANY_TIME: Duration = Duration::from_secs(1);
/// Biên an toàn cộng vào thời hạn thuê: lease luôn dài hơn thời gian job được phép chạy.
pub const LEASE_MARGIN: Duration = Duration::from_secs(5);
/// Chờ các tick đang chạy khi tắt trước khi huỷ hẳn.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

/// Phần budget dùng để bắt đầu công ty mới; phần còn lại chừa cho công ty đang chạy khi hết giờ.
pub const BUDGET_START_FRACTION: f64 = 0.6;

const JOB_RUNS_DDL: &[&str] = &[
    "CREATE SCHEMA IF NOT EXISTS platform",
    "CREATE TABLE IF NOT EXISTS platform.job_runs (
       job varchar(100) NOT NULL,
       company_id int NOT NULL,
       locked_until timestamptz NOT NULL,
       locked_by varchar(200),
       last_started_at timestamptz,
       last_finished_at timestamptz,
       last_error text,
       PRIMARY KEY (job, company_id)
     )",
    // Hàng đợi việc một lần (K21, `queue.rs`).
    "CREATE TABLE IF NOT EXISTS platform.jobs (
       id bigserial PRIMARY KEY,
       company_id int NOT NULL,
       kind varchar(100) NOT NULL,
       payload jsonb NOT NULL DEFAULT '{}',
       status varchar(10) NOT NULL DEFAULT 'queued',
       run_at timestamptz NOT NULL DEFAULT now(),
       attempts int NOT NULL DEFAULT 0,
       max_attempts int NOT NULL DEFAULT 5,
       locked_at timestamptz,
       locked_until timestamptz,
       locked_by varchar(200),
       last_error text,
       dedupe_key varchar(200) UNIQUE,
       created_at timestamptz NOT NULL DEFAULT now()
     )",
    "CREATE INDEX IF NOT EXISTS jobs_due_idx ON platform.jobs (run_at, id) WHERE status <> 'failed'",
];

/// Tạo `platform.job_runs` (idempotent, cả ở chế độ một công ty). Nhiều tiến trình boot cùng lúc xếp hàng trên
/// [`PLATFORM_LOCK`], cùng khoá với `Platform::ensure`.
pub async fn ensure_job_tables(db: &Db) -> Result<(), DbError> {
    let mut tx = db.platform().begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PLATFORM_LOCK)
        .execute(&mut *tx)
        .await?;
    for stmt in JOB_RUNS_DDL {
        sqlx::raw_sql(AssertSqlSafe((*stmt).to_owned()))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Lỗi của scheduler (lỗi của job nằm trong [`CompanyOutcome`], không phải ở đây).
#[derive(Debug, thiserror::Error)]
pub enum SchedulerError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("không có job \"{0}\"")]
    UnknownJob(String),
    #[error("khai báo job không hợp lệ: {0}")]
    InvalidSpec(String),
}

pub type JobFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
/// Hàm chạy job cho một công ty. Không được giữ kết nối pool khi chờ mạng (tự lấy rồi trả ở mỗi truy vấn).
pub type JobFn = Arc<dyn Fn(CompanyRef) -> JobFuture + Send + Sync>;

/// Khai báo một job.
#[derive(Clone)]
pub struct JobSpec {
    /// Tên trong tệp sở hữu và trong `job_runs` (≤ 100 ký tự).
    pub name: String,
    pub interval: Duration,
    /// Trần thời gian của cả lượt; cũng là thời hạn thuê (`locked_until`) và trần của MỖI công ty.
    pub budget: Duration,
    pub run: JobFn,
}

impl JobSpec {
    /// Từ chối chu kỳ 0, budget 0 hoặc quá [`MAX_BUDGET`], tên rỗng hoặc dài hơn [`MAX_NAME_LEN`].
    pub fn new<F, Fut>(name: &str, interval: Duration, budget: Duration, run: F) -> Result<Self, SchedulerError>
    where
        F: Fn(CompanyRef) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            return Err(SchedulerError::InvalidSpec(format!(
                "tên job phải dài 1..={MAX_NAME_LEN} byte"
            )));
        }
        if interval.is_zero() {
            return Err(SchedulerError::InvalidSpec("chu kỳ phải lớn hơn 0".to_owned()));
        }
        if budget.is_zero() || budget > MAX_BUDGET {
            return Err(SchedulerError::InvalidSpec(format!(
                "budget phải trong (0, {MAX_BUDGET:?}]"
            )));
        }
        Ok(Self {
            name: name.to_owned(),
            interval,
            budget,
            run: Arc::new(move |c| Box::pin(run(c))),
        })
    }
}

/// Kết cục của một công ty trong một lượt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickStatus {
    /// Job chạy xong.
    Ran,
    /// Bên khác đang giữ lượt (`locked_until` chưa qua).
    Busy,
    /// Job trả lỗi hoặc quá budget.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyOutcome {
    pub company: i32,
    pub status: TickStatus,
}

/// Báo cáo một lượt của một job.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TickReport {
    /// Tệp sở hữu giao job cho Node: không làm gì.
    pub not_owner: bool,
    pub outcomes: Vec<CompanyOutcome>,
    /// Hết budget trước khi duyệt hết công ty (lượt sau tiếp tục).
    pub budget_exhausted: bool,
}

impl TickReport {
    pub fn failed(&self) -> impl Iterator<Item = &CompanyOutcome> {
        self.outcomes
            .iter()
            .filter(|o| matches!(o.status, TickStatus::Failed(_)))
    }

    pub fn ran(&self) -> Vec<i32> {
        self.outcomes
            .iter()
            .filter(|o| o.status == TickStatus::Ran)
            .map(|o| o.company)
            .collect()
    }
}

/// Scheduler. Clone rẻ; mọi bản chia sẻ con trỏ và bảng sở hữu.
#[derive(Clone)]
pub struct Scheduler {
    db: Db,
    platform: Platform,
    /// Định danh tiến trình ghi vào `locked_by`.
    node_id: Arc<str>,
    /// Số thứ tự nhận lượt: mỗi lần nhận một `locked_by` riêng (`<node>#<n>`), nhả lượt phải khớp đúng token này.
    claims: Arc<AtomicU64>,
    tables: Arc<tokio::sync::OnceCell<()>>,
    jobs: Arc<RwLock<Vec<JobSpec>>>,
    ownership: Arc<RwLock<Arc<Ownership>>>,
    cursors: Arc<Mutex<HashMap<String, i32>>>,
}

impl std::fmt::Debug for Scheduler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Scheduler")
            .field("node_id", &self.node_id)
            .finish_non_exhaustive()
    }
}

impl Scheduler {
    /// `node_id` ≤ [`MAX_NAME_LEN`] byte (cắt nếu dài hơn).
    pub fn new(db: &Db, platform: &Platform, ownership: Ownership, node_id: &str) -> Self {
        let node_id: String = node_id
            .chars()
            .scan(0, |n, c| {
                *n += c.len_utf8();
                (*n <= MAX_NAME_LEN).then_some(c)
            })
            .collect();
        Self {
            db: db.clone(),
            platform: platform.clone(),
            node_id: node_id.as_str().into(),
            claims: Arc::new(AtomicU64::new(0)),
            tables: Arc::new(tokio::sync::OnceCell::new()),
            jobs: Arc::new(RwLock::new(Vec::new())),
            ownership: Arc::new(RwLock::new(Arc::new(ownership))),
            cursors: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Đăng ký (ghi đè theo tên).
    pub fn register(&self, spec: JobSpec) {
        let mut jobs = self.jobs.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        jobs.retain(|j| j.name != spec.name);
        jobs.push(spec);
    }

    /// Thay bảng sở hữu (gọi khi nhận `SIGHUP`).
    pub fn set_ownership(&self, ownership: Ownership) {
        *self
            .ownership
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(ownership);
    }

    /// Đọc lại tệp sở hữu; tệp hỏng thì giữ bảng đang dùng, ghi lỗi và trả lỗi.
    pub fn reload_ownership(&self, path: &Path) -> Result<(), trinity_kernel::ownership::OwnershipError> {
        match Ownership::load(path) {
            Ok(own) => {
                self.set_ownership(own);
                Ok(())
            }
            Err(e) => {
                tracing::error!("tệp sở hữu hỏng, giữ bảng đang dùng: {e}");
                Err(e)
            }
        }
    }

    fn owns(&self, job: &str) -> bool {
        self.ownership
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .job(job)
            == Owner::Rust
    }

    fn spec(&self, name: &str) -> Option<JobSpec> {
        self.jobs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|j| j.name == name)
            .cloned()
    }

    /// Con trỏ hiện tại của job (id công ty cuối đã tới).
    pub fn cursor(&self, job: &str) -> Option<i32> {
        self.cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(job)
            .copied()
    }

    fn set_cursor(&self, job: &str, id: i32) {
        self.cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(job.to_owned(), id);
    }

    /// Chạy MỘT lượt của job. Công ty lỗi không chặn công ty khác; lỗi của job ghi ở [`TickReport`], không phải `Err`.
    pub async fn tick(&self, job: &str) -> Result<TickReport, SchedulerError> {
        let spec = self
            .spec(job)
            .ok_or_else(|| SchedulerError::UnknownJob(job.to_owned()))?;
        let mut report = TickReport::default();
        self.tables.get_or_try_init(|| ensure_job_tables(&self.db)).await?;
        if !self.owns(job) {
            report.not_owner = true;
            return Ok(report);
        }
        let companies = self.platform.list_active_companies().await?;
        if companies.is_empty() {
            return Ok(report);
        }
        // Tiếp tục sau công ty cuối đã tới (theo id: công ty thêm/khoá giữa chừng không làm lệch).
        let start = match self.cursor(job) {
            None => 0,
            Some(last) => companies.iter().position(|c| c.id() > last).unwrap_or(0),
        };
        // Budget theo cả tick như bản Node: hết `start_by` thì không bắt đầu công ty mới; công ty đang chạy được tới
        // `end` (có sàn MIN_COMPANY_TIME).
        let begun = Instant::now();
        let start_by = begun + spec.budget.mul_f64(BUDGET_START_FRACTION);
        let end = begun + spec.budget;
        for i in 0..companies.len() {
            if i > 0 && Instant::now() >= start_by {
                report.budget_exhausted = true;
                break;
            }
            let company = companies[(start + i) % companies.len()];
            // Ghi trước khi chạy: lượt bị cắt giữa chừng thì lượt sau bắt đầu sau công ty này.
            self.set_cursor(job, company.id());
            let status = self.run_company(&spec, company, end).await;
            if let TickStatus::Failed(msg) = &status {
                tracing::error!("[job {job}] công ty {}: {msg}", company.id());
            }
            report.outcomes.push(CompanyOutcome {
                company: company.id(),
                status,
            });
        }
        Ok(report)
    }

    async fn run_company(&self, spec: &JobSpec, company: CompanyRef, end: Instant) -> TickStatus {
        let limit = end.saturating_duration_since(Instant::now()).max(MIN_COMPANY_TIME);
        // Thời hạn thuê luôn dài hơn thời gian job được chạy.
        let token = match self.claim(&spec.name, company.id(), limit + LEASE_MARGIN).await {
            Ok(Some(t)) => t,
            Ok(None) => return TickStatus::Busy,
            Err(e) => return TickStatus::Failed(format!("nhận lượt lỗi: {e}")),
        };
        // Job chạy trong task riêng, ngoài mọi giao dịch và kết nối: panic thành lỗi của công ty đó, quá giờ thì bị
        // huỷ (lượt sau chạy lại). `AbortOnDrop` huỷ cả khi tick bị huỷ.
        let mut task = AbortOnDrop(tokio::spawn((spec.run)(company)));
        let error = match tokio::time::timeout(limit, &mut task.0).await {
            Ok(Ok(Ok(()))) => None,
            Ok(Ok(Err(e))) => Some(e),
            Ok(Err(join)) => Some(format!("job dừng bất thường: {join}")),
            Err(_) => {
                task.0.abort();
                Some(format!("quá thời gian {} ms", limit.as_millis()))
            }
        };
        if let Err(e) = self.release(&spec.name, company.id(), &token, error.as_deref()).await {
            tracing::warn!("[job {}] nhả lượt công ty {} lỗi: {e}", spec.name, company.id());
        }
        match error {
            None => TickStatus::Ran,
            Some(e) => TickStatus::Failed(e),
        }
    }

    /// Nhận lượt: một giao dịch ngắn, khoá mức giao dịch rồi ghi `locked_until`. Trả token (`locked_by`) riêng của
    /// lần nhận này, `None` = bên khác đang giữ.
    async fn claim(&self, job: &str, company: i32, lease: Duration) -> Result<Option<String>, SchedulerError> {
        let token = format!("{}#{}", self.node_id, self.claims.fetch_add(1, Ordering::Relaxed));
        let mut tx = self.db.platform().begin().await?;
        let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1), $2)")
            .bind(format!("job_runs:{job}"))
            .bind(company)
            .fetch_one(&mut *tx)
            .await?;
        if !got {
            tx.rollback().await?;
            return Ok(None);
        }
        let claimed = sqlx::query(
            "INSERT INTO platform.job_runs (job, company_id, locked_until, locked_by, last_started_at)
             VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4, now())
             ON CONFLICT (job, company_id) DO UPDATE
               SET locked_until = EXCLUDED.locked_until, locked_by = EXCLUDED.locked_by,
                   last_started_at = now(), last_error = NULL
               WHERE platform.job_runs.locked_until <= now()",
        )
        .bind(job)
        .bind(company)
        .bind(i64::try_from(lease.as_millis()).unwrap_or(i64::MAX))
        .bind(&token)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
        tx.commit().await?;
        Ok(claimed.then_some(token))
    }

    /// Nhả lượt (chỉ khi còn là của mình) và ghi kết quả.
    async fn release(&self, job: &str, company: i32, token: &str, error: Option<&str>) -> Result<(), SchedulerError> {
        let mut conn = self.db.platform().acquire().await?;
        sqlx::query(
            "UPDATE platform.job_runs SET locked_until = now(), last_finished_at = now(), last_error = $4
              WHERE job = $1 AND company_id = $2 AND locked_by = $3",
        )
        .bind(job)
        .bind(company)
        .bind(token)
        .bind(error.map(|e| e.chars().take(1000).collect::<String>()))
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    /// Chạy mọi job đã đăng ký theo chu kỳ cho tới khi `shutdown` đổi sang `true`. Mỗi job một task; lượt trước
    /// chưa xong thì bỏ nhịp. Khi tắt: không bắt đầu lượt mới, chờ lượt đang chạy tối đa [`SHUTDOWN_GRACE`] rồi huỷ
    /// và nhả lượt còn giữ của tiến trình này.
    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), SchedulerError> {
        self.tables.get_or_try_init(|| ensure_job_tables(&self.db)).await?;
        let specs: Vec<JobSpec> = self
            .jobs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut tasks = tokio::task::JoinSet::new();
        for spec in specs {
            let (this, stop) = (self.clone(), shutdown.clone());
            tasks.spawn(async move {
                let mut every = tokio::time::interval(spec.interval);
                every.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    if *stop.borrow() {
                        break;
                    }
                    every.tick().await;
                    if *stop.borrow() {
                        break;
                    }
                    if let Err(e) = this.tick(&spec.name).await {
                        tracing::error!("[job {}] lượt lỗi: {e}", spec.name);
                    }
                }
            });
        }
        while !*shutdown.borrow() {
            if shutdown.changed().await.is_err() {
                break;
            }
        }
        let drained = tokio::time::timeout(SHUTDOWN_GRACE, async { while tasks.join_next().await.is_some() {} }).await;
        if drained.is_err() {
            tasks.shutdown().await;
        }
        // Nhả mọi lượt còn giữ của tiến trình này (chỉ khi huỷ giữa chừng; lượt xong đã tự nhả).
        sqlx::query(
            "UPDATE platform.job_runs SET locked_until = now() WHERE locked_by LIKE $1 AND locked_until > now()",
        )
        .bind(format!(
            "{}#%",
            self.node_id
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        ))
        .execute(self.db.raw_pool())
        .await?;
        Ok(())
    }
}

/// Huỷ task khi bị drop (tick bị huỷ thì job không chạy mồ côi).
struct AbortOnDrop(tokio::task::JoinHandle<Result<(), String>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
