//! Job `notification.scheduled`: mỗi 2 phút, cho từng công ty, chạy [`crate::notifications::process_scheduled`] (gồm reaper).
//! Sở hữu job (Node hay Rust chạy) do tệp sở hữu quyết định ở `trinity-jobs` (K20), nên hai bên không chạy trùng.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use trinity_db::{CompanyRef, Db};
use trinity_jobs::{JobSpec, SchedulerError};

use crate::delivery::Deliverer;
use crate::notifications::process_scheduled;

/// Tên job trong tệp sở hữu.
pub const JOB_SCHEDULED: &str = "notification.scheduled";
/// Chu kỳ (`@Cron('0 */2 * * * *')` của bản TS).
pub const INTERVAL: Duration = Duration::from_secs(120);
/// Trần thời gian của cả lượt.
pub const BUDGET: Duration = Duration::from_secs(30);

/// Khai báo job để `Scheduler::register`.
pub fn scheduled_job(db: &Db, deliverer: Arc<Deliverer>) -> Result<JobSpec, SchedulerError> {
    let db = db.clone();
    JobSpec::new(JOB_SCHEDULED, INTERVAL, BUDGET, move |company: CompanyRef| {
        let (db, deliverer) = (db.clone(), Arc::clone(&deliverer));
        async move {
            let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
            let n = process_scheduled(&tenant, &deliverer, Utc::now())
                .await
                .map_err(|e| format!("{e:?}"))?;
            if n > 0 {
                tracing::info!("Processed {n} scheduled notifications");
            }
            Ok(())
        }
    })
}
