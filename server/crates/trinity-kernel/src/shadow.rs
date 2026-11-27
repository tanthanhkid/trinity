//! Ngữ cảnh "shadow" (K28, docs/rust/PLAN.md mục 4.14): handler đang chạy để SO SÁNH với Node, không phải để phục vụ khách.
//! Ba hàng rào dựa vào cờ này (đặt bằng [`scope`] quanh handler, đọc bằng [`active`]):
//! 1. `trinity-db` đặt phiên chỉ đọc (`default_transaction_read_only = on`) mỗi lần lấy kết nối;
//! 2. mọi chỗ gọi mạng ra ngoài gọi [`forbid_outbound`] và bị từ chối;
//! 3. cache đếm/dashboard bỏ qua (không đọc, không ghi) khi [`active`].
//!
//! Vi phạm (gọi mạng, ghi DB bị Postgres từ chối) được [`record_violation`] ghi vào trạng thái của lần chạy để bộ shadow
//! đánh dấu route "không shadow được" và không thử lại. Cờ gắn vào TASK: `tokio::spawn` bên trong handler không thừa kế
//! (handler của route `safe_for_shadow` không được tự spawn việc ghi; điều này được rà khi bật `safe_for_shadow`).

use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

/// Trạng thái của một lần chạy shadow.
#[derive(Debug, Default)]
pub struct ShadowRun {
    violation: Mutex<Option<String>>,
}

impl ShadowRun {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Vi phạm đầu tiên (lý do ngắn, không chứa dữ liệu khách).
    pub fn violation(&self) -> Option<String> {
        self.violation.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

tokio::task_local! {
    static RUN: Arc<ShadowRun>;
}

/// Chạy `fut` trong ngữ cảnh shadow.
pub async fn scope<F: Future>(run: Arc<ShadowRun>, fut: F) -> F::Output {
    RUN.scope(run, fut).await
}

/// Đang chạy shadow?
pub fn active() -> bool {
    RUN.try_with(|_| ()).is_ok()
}

/// Ghi vi phạm (chỉ có tác dụng trong shadow; lần đầu giữ lại).
pub fn record_violation(reason: &str) {
    let _ = RUN.try_with(|r| {
        let mut v = r.violation.lock().unwrap_or_else(PoisonError::into_inner);
        if v.is_none() {
            *v = Some(reason.to_owned());
        }
    });
}

/// Lỗi trả cho chỗ gọi mạng khi đang shadow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundDenied(pub String);

impl fmt::Display for OutboundDenied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "gọi mạng bị từ chối khi shadow: {}", self.0)
    }
}

impl std::error::Error for OutboundDenied {}

/// Gọi TRƯỚC mọi request ra mạng ngoài (HTTP, S3…). Đang shadow ⇒ ghi vi phạm và từ chối; ngoài shadow luôn `Ok`.
pub fn forbid_outbound(what: &str) -> Result<(), OutboundDenied> {
    if active() {
        record_violation(&format!("mạng: {what}"));
        return Err(OutboundDenied(what.to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ngoai_shadow_khong_chan_gi() {
        assert!(!active());
        assert!(forbid_outbound("x").is_ok());
        record_violation("bo-qua"); // không panic, không tác dụng
    }

    #[tokio::test]
    async fn trong_shadow_chan_mang_va_ghi_vi_pham_dau_tien() {
        let run = ShadowRun::new();
        scope(run.clone(), async {
            assert!(active());
            assert_eq!(forbid_outbound("safe_get"), Err(OutboundDenied("safe_get".into())));
            record_violation("lan hai");
        })
        .await;
        assert_eq!(run.violation().as_deref(), Some("mạng: safe_get"));
        assert!(!active());
    }

    #[tokio::test]
    async fn spawn_khong_thua_ke() {
        let run = ShadowRun::new();
        let inner = scope(run, async { tokio::spawn(async { active() }).await.unwrap() }).await;
        assert!(!inner);
    }
}
