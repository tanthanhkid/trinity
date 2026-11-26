//! Job `briefings.run-due` (mỗi 60 giây, budget 40 giây) đăng ký với scheduler K20. MẶC ĐỊNH TẮT: chỉ đăng ký khi env
//! `BRIEFING_CRON_ENABLED=true` và không ở chế độ API điều khiển test; ngoài ra còn công tắc `enabled` trong cấu hình bản tin
//! và cờ `ai_briefing` (kiểm trong [`crate::run_due`]).

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use trinity_db::Db;
use trinity_jobs::{JobSpec, Scheduler, SchedulerError};

use crate::service::{Ports, run_due};

pub const JOB_NAME: &str = "briefings.run-due";
pub const INTERVAL: Duration = Duration::from_secs(60);
pub const BUDGET: Duration = Duration::from_secs(40);

/// `testHooksEnabled`: `TRINITY_TEST_HOOKS=1` và `NODE_ENV` là `test` hoặc `development`.
pub fn test_hooks_enabled(get: impl Fn(&str) -> Option<String>) -> bool {
    get("TRINITY_TEST_HOOKS").is_some_and(|v| v.trim() == "1")
        && matches!(get("NODE_ENV").as_deref(), Some("test" | "development"))
}

/// Job có được bật theo env không.
pub fn job_enabled(get: impl Fn(&str) -> Option<String>) -> bool {
    !test_hooks_enabled(&get) && get("BRIEFING_CRON_ENABLED").is_some_and(|v| v.trim() == "true")
}

/// Khai báo job (không đăng ký).
pub fn job_spec<P: Ports>(db: Db, ports: Arc<P>) -> Result<JobSpec, SchedulerError> {
    JobSpec::new(JOB_NAME, INTERVAL, BUDGET, move |company| {
        let db = db.clone();
        let ports = Arc::clone(&ports);
        async move {
            let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
            run_due(&tenant, ports.as_ref(), Utc::now())
                .await
                .map(drop)
                .map_err(|e| format!("{e:?}"))
        }
    })
}

/// Đăng ký job khi env bật; trả `true` nếu đã đăng ký.
pub fn register_if_enabled<P: Ports>(
    scheduler: &Scheduler,
    db: &Db,
    ports: Arc<P>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<bool, SchedulerError> {
    if !job_enabled(get) {
        return Ok(false);
    }
    scheduler.register(job_spec(db.clone(), ports)?);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn chi_chay_khi_bat_co() {
        assert!(!job_enabled(env(&[])));
        assert!(!job_enabled(env(&[("BRIEFING_CRON_ENABLED", "1")])));
        assert!(!job_enabled(env(&[("BRIEFING_CRON_ENABLED", "false")])));
        assert!(job_enabled(env(&[("BRIEFING_CRON_ENABLED", "true")])));
        assert!(job_enabled(env(&[("BRIEFING_CRON_ENABLED", " true ")])));
    }

    #[test]
    fn api_dieu_khien_test_tat_lich() {
        let on = [
            ("BRIEFING_CRON_ENABLED", "true"),
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "test"),
        ];
        assert!(!job_enabled(env(&on)));
        // production hoặc chưa đặt NODE_ENV: cờ test không có hiệu lực, lịch vẫn chạy.
        let prod = [
            ("BRIEFING_CRON_ENABLED", "true"),
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "production"),
        ];
        assert!(job_enabled(env(&prod)));
        assert!(job_enabled(env(&[
            ("BRIEFING_CRON_ENABLED", "true"),
            ("TRINITY_TEST_HOOKS", "1")
        ])));
    }

    #[test]
    fn khai_bao_job_dung_ten_va_chu_ky() {
        assert_eq!(JOB_NAME, "briefings.run-due");
        assert_eq!((INTERVAL.as_secs(), BUDGET.as_secs()), (60, 40));
    }
}
