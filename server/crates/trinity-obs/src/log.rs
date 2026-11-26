//! Log JSON ra stdout qua `tracing` (PLAN 4.12): mỗi sự kiện một dòng JSON; dòng log request có mã tương quan, phương
//! thức, đường dẫn đã che token ([`crate::redact_url`]), mã trạng thái, thời lượng, id người dùng đã băm.
//!
//! Tên trường giữ như log của bản Node (`correlation_id`, `method`, `url`, `status_code`, `duration_ms`, `user_id`,
//! xem `packages/logger/src/elk-exception.filter.ts`, `logging.interceptor.ts`) để ai đang lọc log theo tên trường
//! không phải đổi.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

use crate::redact_url;

/// Header mang mã tương quan (cùng tên bản Node).
pub const CORRELATION_HEADER: &str = "x-correlation-id";

/// Bật log JSON ra stdout cho cả tiến trình. Mức log theo `RUST_LOG` (mặc định `info`). Gọi một lần lúc khởi động;
/// lần sau trả lỗi.
pub fn init_json() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::subscriber::set_global_default(json_subscriber(std::io::stdout))?;
    Ok(())
}

/// Subscriber JSON ghi ra `writer` (test dùng bộ đệm).
pub fn json_subscriber<W>(writer: W) -> impl tracing::Subscriber + Send + Sync
where
    W: for<'a> MakeWriter<'a> + Send + Sync + 'static,
{
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_target(true)
        .with_env_filter(filter)
        .with_writer(writer)
        .finish()
}

/// Mã tương quan của một request: giữ giá trị header `x-correlation-id` do client hoặc proxy gửi nếu gọn và an toàn
/// (≤ 128 ký tự `[A-Za-z0-9._:-]`), không thì sinh mã mới. Bản Node ghi `N/A` khi thiếu header; bản Rust luôn có mã
/// để nối các dòng log của cùng request.
pub fn correlation_id(header: Option<&str>) -> String {
    if let Some(h) = header.map(str::trim)
        && !h.is_empty()
        && h.len() <= 128
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        return h.to_owned();
    }
    new_correlation_id()
}

/// Mã mới: thời điểm (µs) + bộ đếm trong tiến trình, dạng hex. Chỉ để nối log, không phải bí mật.
pub fn new_correlation_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{micros:x}-{seq:x}")
}

/// Băm id người dùng trước khi ghi log: HMAC-SHA256 với khoá `MONITORING_HASH_SECRET` (không có thì `JWT_SECRET`),
/// 24 ký tự hex đầu — cùng cách `hashUserId()` của bản Node (`packages/logger/src/product-events.ts`), nên cùng một
/// người cho cùng một chuỗi ở log, Sentry và PostHog.
#[derive(Clone)]
pub struct UserIdHasher {
    key: Vec<u8>,
}

impl std::fmt::Debug for UserIdHasher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UserIdHasher(..)")
    }
}

impl UserIdHasher {
    pub fn new(secret: &str) -> Self {
        Self {
            key: secret.as_bytes().to_vec(),
        }
    }

    pub fn hash(&self, user_id: &str) -> String {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key).expect("HMAC nhận khoá mọi độ dài");
        mac.update(user_id.as_bytes());
        let digest = mac.finalize().into_bytes();
        let mut out = String::with_capacity(24);
        for b in digest.iter().take(12) {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }
}

/// Dữ liệu một dòng log request.
#[derive(Debug, Clone)]
pub struct RequestLog<'a> {
    pub correlation_id: &'a str,
    pub method: &'a str,
    /// Đường dẫn kèm query như nhận được; được che trước khi ghi.
    pub url: &'a str,
    pub status: u16,
    pub duration: Duration,
    /// Id người dùng đã băm ([`UserIdHasher`]); `None` = chưa đăng nhập.
    pub user_hash: Option<&'a str>,
}

/// Ghi một dòng log request: 5xx mức `error`, 4xx mức `warn`, còn lại `info`. URL luôn đi qua [`redact_url`].
pub fn log_request(r: &RequestLog<'_>) {
    let url = redact_url(r.url);
    let url: &str = &url;
    let duration_ms = u64::try_from(r.duration.as_millis()).unwrap_or(u64::MAX);
    let user_id = r.user_hash.unwrap_or("anonymous");
    macro_rules! emit {
        ($lvl:ident, $msg:literal) => {
            tracing::$lvl!(
                target: "trinity::http",
                correlation_id = r.correlation_id,
                method = r.method,
                url,
                status_code = r.status,
                duration_ms,
                user_id,
                $msg
            )
        };
    }
    match r.status {
        500.. => emit!(error, "request"),
        400..=499 => emit!(warn, "request"),
        _ => emit!(info, "request"),
    }
}

#[cfg(test)]
mod tests;
