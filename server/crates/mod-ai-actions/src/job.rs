//! Job hết hạn đề xuất AI (`ai-action-expiry.service.ts`): 10 phút một lượt, lượt đầu sau 8 phút; chỉ đăng ký khi OAuth/MCP bật.

use std::time::Duration;

use trinity_db::{CompanyRef, Db};
use trinity_jobs::{JobSpec, SchedulerError};

pub const JOB_AI_ACTION_EXPIRY: &str = "integrations.ai-action-expiry";
const INTERVAL: Duration = Duration::from_secs(10 * 60);
const FIRST_DELAY: Duration = Duration::from_secs(8 * 60);
const BUDGET: Duration = Duration::from_secs(55);

/// `enabled` = `status::oauth_enabled`; tắt ⇒ `None` (không timer nào, như Node).
pub fn expiry_job(db: &Db, enabled: bool) -> Result<Option<JobSpec>, SchedulerError> {
    if !enabled {
        return Ok(None);
    }
    let db = db.clone();
    JobSpec::new(JOB_AI_ACTION_EXPIRY, INTERVAL, BUDGET, move |company: CompanyRef| {
        let db = db.clone();
        async move {
            let mut c = db
                .tenant(company)
                .await
                .map_err(|e| e.to_string())?
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            let r = crate::service::expire_overdue(&mut c, chrono::Utc::now())
                .await
                .map_err(|e| e.to_string())?;
            if r.expired + r.stale + r.purged > 0 {
                tracing::info!(
                    "Đề xuất AI: {} hết hạn, {} kết quả không rõ, {} đã dọn",
                    r.expired,
                    r.stale,
                    r.purged
                );
            }
            Ok(())
        }
    })
    .map(|j| Some(j.with_first_delay(FIRST_DELAY)))
}
