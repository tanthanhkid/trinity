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
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use sqlx::AssertSqlSafe;
use tokio::time::{Instant, MissedTickBehavior};
use trinity_db::platform::{PLATFORM_LOCK, Platform};
use trinity_db::{CompanyRef, Db, DbError};
use trinity_kernel::ownership::{Owner, Ownership};

/// Phần budget dùng để bắt đầu công ty mới; phần còn lại chừa cho công ty đang chạy khi hết giờ.
pub const BUDGET_START_FRACTION: f64 = 0.6;

const JOB_RUNS_DDL: &[&str] = &[
    "CREATE SCHEMA IF NOT EXISTS platform",
    "CREATE TABLE IF NOT EXISTS platform.job_runs (
       job varchar(100) NOT NULL,
       company_id int NOT NULL,
       locked_until timestamptz NOT NULL,
       locked_by varchar(100),
       last_started_at timestamptz,
       last_finished_at timestamptz,
       last_error text,
       PRIMARY KEY (job, company_id)
     )",
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
    pub fn new<F, Fut>(name: &str, interval: Duration, budget: Duration, run: F) -> Self
    where
        F: Fn(CompanyRef) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        Self {
            name: name.to_owned(),
            interval,
            budget,
            run: Arc::new(move |c| Box::pin(run(c))),
        }
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
    pub fn new(db: &Db, platform: &Platform, ownership: Ownership, node_id: &str) -> Self {
        Self {
            db: db.clone(),
            platform: platform.clone(),
            node_id: node_id.into(),
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
        let deadline = Instant::now() + spec.budget.mul_f64(BUDGET_START_FRACTION);
        for i in 0..companies.len() {
            if i > 0 && Instant::now() >= deadline {
                report.budget_exhausted = true;
                break;
            }
            let company = companies[(start + i) % companies.len()];
            // Ghi trước khi chạy: lượt bị cắt giữa chừng thì lượt sau bắt đầu sau công ty này.
            self.set_cursor(job, company.id());
            let status = self.run_company(&spec, company).await;
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

    async fn run_company(&self, spec: &JobSpec, company: CompanyRef) -> TickStatus {
        match self.claim(&spec.name, company.id(), spec.budget).await {
            Ok(true) => {}
            Ok(false) => return TickStatus::Busy,
            Err(e) => return TickStatus::Failed(format!("nhận lượt lỗi: {e}")),
        }
        // Job chạy ngoài mọi giao dịch và kết nối; quá budget thì bị huỷ (lượt sau chạy lại).
        let res = tokio::time::timeout(spec.budget, (spec.run)(company)).await;
        let error = match res {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(_) => Some(format!("quá budget {} ms", spec.budget.as_millis())),
        };
        if let Err(e) = self.release(&spec.name, company.id(), error.as_deref()).await {
            tracing::warn!("[job {}] nhả lượt công ty {} lỗi: {e}", spec.name, company.id());
        }
        match error {
            None => TickStatus::Ran,
            Some(e) => TickStatus::Failed(e),
        }
    }

    /// Nhận lượt: một giao dịch ngắn, khoá mức giao dịch rồi ghi `locked_until`. `true` = nhận được.
    async fn claim(&self, job: &str, company: i32, lease: Duration) -> Result<bool, SchedulerError> {
        let mut tx = self.db.platform().begin().await?;
        let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1), $2)")
            .bind(format!("job_runs:{job}"))
            .bind(company)
            .fetch_one(&mut *tx)
            .await?;
        if !got {
            tx.rollback().await?;
            return Ok(false);
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
        .bind(&*self.node_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
        tx.commit().await?;
        Ok(claimed)
    }

    /// Nhả lượt (chỉ khi còn là của mình) và ghi kết quả.
    async fn release(&self, job: &str, company: i32, error: Option<&str>) -> Result<(), SchedulerError> {
        let mut conn = self.db.platform().acquire().await?;
        sqlx::query(
            "UPDATE platform.job_runs SET locked_until = now(), last_finished_at = now(), last_error = $4
              WHERE job = $1 AND company_id = $2 AND locked_by = $3",
        )
        .bind(job)
        .bind(company)
        .bind(&*self.node_id)
        .bind(error.map(|e| e.chars().take(1000).collect::<String>()))
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    /// Chạy mọi job đã đăng ký theo chu kỳ cho tới khi `shutdown` đổi sang `true`. Mỗi job một task; lượt trước
    /// chưa xong thì bỏ nhịp (không chạy chồng trong cùng tiến trình).
    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), SchedulerError> {
        ensure_job_tables(&self.db).await?;
        let specs: Vec<JobSpec> = self
            .jobs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut tasks = tokio::task::JoinSet::new();
        for spec in specs {
            let (this, mut stop) = (self.clone(), shutdown.clone());
            tasks.spawn(async move {
                let mut every = tokio::time::interval(spec.interval);
                every.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = every.tick() => {
                            if let Err(e) = this.tick(&spec.name).await {
                                tracing::error!("[job {}] lượt lỗi: {e}", spec.name);
                            }
                        }
                        _ = stop.changed() => break,
                    }
                }
            });
        }
        while !*shutdown.borrow() {
            if shutdown.changed().await.is_err() {
                break;
            }
        }
        tasks.shutdown().await;
        Ok(())
    }
}
