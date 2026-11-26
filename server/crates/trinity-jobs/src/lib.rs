//! Scheduler theo công ty, advisory lock, hàng đợi SKIP LOCKED (PLAN 4.9).
//!
//! K20: [`scheduler`] — job theo chu kỳ, mỗi lượt duyệt công ty đang hoạt động với con trỏ tiếp tục và budget như
//! `runForEachCompany`; nhận lượt từng cặp (job, công ty) qua `platform.job_runs`. Hàng đợi `platform.jobs` (K21) thêm sau.

pub mod scheduler;

pub use scheduler::{
    CompanyOutcome, JobFn, JobFuture, JobSpec, Scheduler, SchedulerError, TickReport, TickStatus, ensure_job_tables,
};
