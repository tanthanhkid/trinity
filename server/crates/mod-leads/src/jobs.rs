//! Hai job đăng ký với scheduler K20, MẶC ĐỊNH TẮT như bản TS: chỉ đăng ký khi env bật và không ở chế độ API điều khiển test.
//!
//! - `lead-scoring.run`: mỗi 10 phút, env `LEAD_SCORING_ENABLED=true`;
//! - `stale-work.digest`: mỗi 15 phút, env `STALE_REMINDERS_ENABLED=true` (gửi tối đa một lần mỗi ngày, xem [`crate::stale`]).
//!
//! Budget mỗi lượt 55 giây (như `roundBudgetMs` của `tenantTimerTick`).

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db};
use trinity_jobs::{JobSpec, Scheduler, SchedulerError};

use crate::{Features, lead, stale};

pub const LEAD_JOB: &str = "lead-scoring.run";
pub const STALE_JOB: &str = "stale-work.digest";
pub const LEAD_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const STALE_INTERVAL: Duration = Duration::from_secs(15 * 60);
pub const BUDGET: Duration = Duration::from_secs(55);
const LEAD_FIRST_DELAY: Duration = Duration::from_secs(3 * 60);
const STALE_FIRST_DELAY: Duration = Duration::from_secs(4 * 60);

/// `testHooksEnabled`: `TRINITY_TEST_HOOKS=1` và `NODE_ENV` là `test` hoặc `development`.
fn test_hooks_enabled(get: &impl Fn(&str) -> Option<String>) -> bool {
    get("TRINITY_TEST_HOOKS").is_some_and(|v| v.trim() == "1")
        && matches!(get("NODE_ENV").as_deref(), Some("test" | "development"))
}

fn flag(get: &impl Fn(&str) -> Option<String>, name: &str) -> bool {
    !test_hooks_enabled(get) && get(name).is_some_and(|v| v == "true")
}

/// `leadScoringJobEnabled()` (cũng là `job_enabled` của `GET /lead-scoring/rules`).
pub fn lead_enabled(get: impl Fn(&str) -> Option<String>) -> bool {
    get("LEAD_SCORING_ENABLED").is_some_and(|v| v == "true")
}

/// `staleJobEnabled()` (cũng là `job_enabled` của `GET /stale-work/config`).
pub fn stale_enabled(get: impl Fn(&str) -> Option<String>) -> bool {
    get("STALE_REMINDERS_ENABLED").is_some_and(|v| v == "true")
}

/// Bản dùng chung một `Features` cho mọi công ty (test, hoặc cổng không phụ thuộc công ty).
struct Shared<F>(Arc<F>);

impl<F: Features> Features for Shared<F> {
    async fn enabled(&self, conn: &mut PgConnection, key: &str) -> bool {
        self.0.enabled(conn, key).await
    }
}

pub fn lead_spec<F: Features + 'static>(db: Db, features: Arc<F>) -> Result<JobSpec, SchedulerError> {
    lead_spec_with(db, move |_| Shared(Arc::clone(&features)))
}

/// Như [`lead_spec`] nhưng dựng `Features` theo từng công ty (gói của công ty quyết định cờ `lead_scoring`).
pub fn lead_spec_with<F, M>(db: Db, make: M) -> Result<JobSpec, SchedulerError>
where
    F: Features + 'static,
    M: Fn(CompanyRef) -> F + Send + Sync + 'static,
{
    let make = Arc::new(make);
    Ok(JobSpec::new(LEAD_JOB, LEAD_INTERVAL, BUDGET, move |company| {
        let db = db.clone();
        let features = make(company);
        async move {
            let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
            let mut conn = tenant.acquire().await.map_err(|e| e.to_string())?;
            lead::run_once(&mut conn, &features, Utc::now())
                .await
                .map(drop)
                .map_err(|e| format!("{e:?}"))
        }
    })?
    .with_first_delay(LEAD_FIRST_DELAY))
}

pub fn stale_spec<F: Features + 'static>(db: Db, features: Arc<F>) -> Result<JobSpec, SchedulerError> {
    stale_spec_with(db, move |_| Shared(Arc::clone(&features)))
}

/// Như [`stale_spec`] nhưng dựng `Features` theo từng công ty.
pub fn stale_spec_with<F, M>(db: Db, make: M) -> Result<JobSpec, SchedulerError>
where
    F: Features + 'static,
    M: Fn(CompanyRef) -> F + Send + Sync + 'static,
{
    let make = Arc::new(make);
    Ok(JobSpec::new(STALE_JOB, STALE_INTERVAL, BUDGET, move |company| {
        let db = db.clone();
        let features = make(company);
        async move {
            let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
            stale::run_once(&tenant, &features, Utc::now(), false)
                .await
                .map(drop)
                .map_err(|e| format!("{e:?}"))
        }
    })?
    .with_first_delay(STALE_FIRST_DELAY))
}

/// Đăng ký các job được env bật; trả tên job đã đăng ký.
pub fn register_if_enabled<F: Features + 'static>(
    scheduler: &Scheduler,
    db: &Db,
    features: Arc<F>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<Vec<&'static str>, SchedulerError> {
    register_if_enabled_with(scheduler, db, move |_| Shared(Arc::clone(&features)), get)
}

/// Như [`register_if_enabled`] nhưng `Features` dựng theo từng công ty (`make` gọi mỗi lượt job).
pub fn register_if_enabled_with<F, M>(
    scheduler: &Scheduler,
    db: &Db,
    make: M,
    get: impl Fn(&str) -> Option<String>,
) -> Result<Vec<&'static str>, SchedulerError>
where
    F: Features + 'static,
    M: Fn(CompanyRef) -> F + Clone + Send + Sync + 'static,
{
    let mut names = Vec::new();
    if flag(&get, "LEAD_SCORING_ENABLED") {
        scheduler.register(lead_spec_with(db.clone(), make.clone())?);
        names.push(LEAD_JOB);
    }
    if flag(&get, "STALE_REMINDERS_ENABLED") {
        scheduler.register(stale_spec_with(db.clone(), make)?);
        names.push(STALE_JOB);
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn chi_bat_khi_dat_dung_true() {
        assert!(!lead_enabled(env(&[])));
        assert!(!lead_enabled(env(&[("LEAD_SCORING_ENABLED", "1")])));
        assert!(lead_enabled(env(&[("LEAD_SCORING_ENABLED", "true")])));
        assert!(!stale_enabled(env(&[("STALE_REMINDERS_ENABLED", " true")])));
        assert!(stale_enabled(env(&[("STALE_REMINDERS_ENABLED", "true")])));
    }

    #[test]
    fn api_dieu_khien_test_tat_lich() {
        let on = [
            ("LEAD_SCORING_ENABLED", "true"),
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "test"),
        ];
        assert!(!flag(&env(&on), "LEAD_SCORING_ENABLED"));
        let prod = [
            ("LEAD_SCORING_ENABLED", "true"),
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "production"),
        ];
        assert!(flag(&env(&prod), "LEAD_SCORING_ENABLED"));
    }

    #[test]
    fn ten_va_chu_ky() {
        assert_eq!((LEAD_JOB, LEAD_INTERVAL.as_secs()), ("lead-scoring.run", 600));
        assert_eq!((STALE_JOB, STALE_INTERVAL.as_secs()), ("stale-work.digest", 900));
    }
}
