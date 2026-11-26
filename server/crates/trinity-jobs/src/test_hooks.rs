//! K34: công tắc "không chạy tự động" cho API điều khiển test (chỉ biên dịch khi bật cờ `test-hooks`).
//!
//! Cùng luật C18 bên Node: `TRINITY_TEST_HOOKS=1` **và** `NODE_ENV` là `test` hoặc `development` (chưa đặt hoặc `production` thì
//! không). Bật ⇒ [`crate::Scheduler::run`] và [`crate::Worker::run`] trả về ngay, không nhận lượt hay việc nào; job chỉ chạy khi
//! được gọi trực tiếp.

/// API điều khiển test có bật không (đọc từ hàm tra biến môi trường `get`).
pub fn enabled(get: impl Fn(&str) -> Option<String>) -> bool {
    let flag = get("TRINITY_TEST_HOOKS").is_some_and(|v| v.trim() == "1");
    let env = get("NODE_ENV");
    flag && matches!(env.as_deref().map(str::trim), Some("test" | "development"))
}

/// Như [`enabled`] với biến môi trường của tiến trình.
pub fn enabled_from_env() -> bool {
    enabled(|k| std::env::var(k).ok())
}

#[cfg(test)]
mod tests {
    use super::enabled;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn chi_bat_khi_co_ca_hai_dieu_kien() {
        assert!(enabled(env(&[("TRINITY_TEST_HOOKS", "1"), ("NODE_ENV", "test")])));
        assert!(enabled(env(&[
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "development")
        ])));
        assert!(!enabled(env(&[("TRINITY_TEST_HOOKS", "1")])));
        assert!(!enabled(env(&[
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "production")
        ])));
        assert!(!enabled(env(&[("TRINITY_TEST_HOOKS", "1"), ("NODE_ENV", "staging")])));
        assert!(!enabled(env(&[("NODE_ENV", "test")])));
        assert!(!enabled(env(&[("TRINITY_TEST_HOOKS", "true"), ("NODE_ENV", "test")])));
    }

    /// Bật cờ rồi chờ 3 chu kỳ: scheduler và worker không tự chạy gì (không chạm DB: guard đứng trước mọi truy vấn).
    #[tokio::test]
    async fn bat_co_cho_3_chu_ky_khong_job_nao_tu_chay() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        use crate::{JobSpec, Queue, Scheduler, Worker, WorkerConfig};
        use trinity_db::platform::Platform;
        use trinity_db::{Db, DbConfig};

        let db = Db::connect_lazy(&DbConfig::new("postgresql://u@127.0.0.1:1/none")).unwrap();
        let platform = Platform::new(&db, None);
        let runs = Arc::new(AtomicUsize::new(0));
        let r2 = runs.clone();
        let sched = Scheduler::new(&db, &platform, trinity_kernel::ownership::Ownership::default(), "t")
            .with_automatic_runs_disabled(true);
        sched.register(
            JobSpec::new("j", Duration::from_millis(50), Duration::from_secs(1), move |_| {
                let r2 = r2.clone();
                async move {
                    r2.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            })
            .unwrap()
            .with_first_delay(Duration::ZERO),
        );
        let worker = Worker::new(&Queue::new(&db, "t"), WorkerConfig::default()).with_automatic_runs_disabled(true);
        let (_tx, rx) = tokio::sync::watch::channel(false);
        // Cả hai trả về ngay (không chờ tắt máy); chờ thêm 3 chu kỳ rồi kiểm không có lượt nào.
        sched.run(rx.clone()).await.unwrap();
        worker.run(rx).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }
}
