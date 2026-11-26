//! Scheduler theo công ty, advisory lock, hàng đợi SKIP LOCKED (PLAN 4.9).
//!
//! K20: [`scheduler`] — job theo chu kỳ, mỗi lượt duyệt công ty đang hoạt động với con trỏ tiếp tục và budget như
//! `runForEachCompany`; nhận lượt từng cặp (job, công ty) qua `platform.job_runs`.
//! K21: [`queue`] — hàng đợi việc một lần `platform.jobs` (nhận bằng `FOR UPDATE SKIP LOCKED`, thử lại, khoá trùng).

pub mod queue;
pub mod scheduler;

pub use queue::{Job, NewJob, Queue, QueueError, Worker, WorkerConfig};
pub use scheduler::{
    CompanyOutcome, JobFn, JobFuture, JobSpec, Scheduler, SchedulerError, TickReport, TickStatus, ensure_job_tables,
};
