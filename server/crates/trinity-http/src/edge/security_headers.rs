//! Header bảo mật chung cho mọi phản hồi của máy chủ (X10).
//!
//! Khớp middleware bảo mật của các service Node cũ (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
//! `Strict-Transport-Security: max-age=31536000; includeSubDomains`), thêm `Content-Security-Policy: frame-ancestors`
//! và `Referrer-Policy`. `X-XSS-Protection` bị bỏ vì trình duyệt hiện đại không còn dùng.
//!
//! - Header đã có sẵn trong phản hồi (do module hoặc Node đặt) được giữ nguyên, lớp này chỉ thêm khi thiếu.
//! - HSTS chỉ gửi khi kết nối là https: listener tự chạy TLS, hoặc `X-Forwarded-Proto: https` khi đặt
//!   `TRUST_FORWARDED_PROTO=true` (chỉ bật khi đứng sau proxy tin cậy).
//!
//! Biến môi trường:
//! - `HSTS_MAX_AGE`: giây; mặc định 31536000 ở production, tắt ngoài production; `0` hoặc không phải số ⇒ tắt.
//! - `HSTS_INCLUDE_SUBDOMAINS`: mặc định `true`.
//! - `TRUST_FORWARDED_PROTO`: đúng `true` mới tin `X-Forwarded-Proto`.
//! - `FRAME_ANCESTORS`: nguồn được phép nhúng khung, mặc định `'none'`; khác `'none'` thì không gửi `X-Frame-Options`.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

const DEFAULT_HSTS_MAX_AGE: u64 = 31_536_000;
const DEFAULT_FRAME_ANCESTORS: &str = "'none'";

/// Cấu hình lớp header bảo mật.
#[derive(Debug, Clone)]
pub struct SecurityHeadersConfig {
    /// `None` ⇒ không gửi HSTS.
    pub hsts_max_age: Option<u64>,
    pub hsts_include_subdomains: bool,
    /// Listener của tiến trình tự chạy TLS.
    pub listener_https: bool,
    /// Tin `X-Forwarded-Proto` (đứng sau proxy tin cậy).
    pub trust_forwarded_proto: bool,
    /// Giá trị sau `frame-ancestors`.
    pub frame_ancestors: String,
}

impl SecurityHeadersConfig {
    /// Đọc từ biến môi trường qua `lookup`; `production` là `NODE_ENV=production`.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>, production: bool, listener_https: bool) -> Self {
        let hsts_max_age = match lookup("HSTS_MAX_AGE")
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            Some(v) => v.parse::<u64>().ok().filter(|n| *n > 0),
            None => production.then_some(DEFAULT_HSTS_MAX_AGE),
        };
        let flag = |key: &str, default: bool| {
            lookup(key).map_or(default, |v| match v.trim().to_ascii_lowercase().as_str() {
                "true" => true,
                "false" => false,
                _ => default,
            })
        };
        let frame_ancestors = lookup("FRAME_ANCESTORS")
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty() && HeaderValue::from_str(v).is_ok() && !v.contains(';'))
            .unwrap_or_else(|| DEFAULT_FRAME_ANCESTORS.to_owned());
        Self {
            hsts_max_age,
            hsts_include_subdomains: flag("HSTS_INCLUDE_SUBDOMAINS", true),
            listener_https,
            trust_forwarded_proto: flag("TRUST_FORWARDED_PROTO", false),
            frame_ancestors,
        }
    }

    fn is_https(&self, req_headers: &HeaderMap) -> bool {
        self.listener_https
            || (self.trust_forwarded_proto
                && req_headers
                    .get("x-forwarded-proto")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split(',').next())
                    .is_some_and(|p| p.trim().eq_ignore_ascii_case("https")))
    }
}

fn add_if_absent(h: &mut HeaderMap, name: HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        h.entry(name).or_insert(v);
    }
}

/// Lớp middleware: `axum::middleware::from_fn_with_state(Arc::new(cfg), security_headers_layer)`.
pub async fn security_headers_layer(
    State(cfg): State<Arc<SecurityHeadersConfig>>,
    req: Request,
    next: Next,
) -> Response {
    let https = cfg.is_https(req.headers());
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    add_if_absent(h, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    add_if_absent(h, header::REFERRER_POLICY, "strict-origin-when-cross-origin");
    add_if_absent(
        h,
        header::CONTENT_SECURITY_POLICY,
        &format!("frame-ancestors {}", cfg.frame_ancestors),
    );
    if cfg.frame_ancestors == DEFAULT_FRAME_ANCESTORS {
        add_if_absent(h, header::X_FRAME_OPTIONS, "DENY");
    }
    if https && let Some(max_age) = cfg.hsts_max_age {
        let value = if cfg.hsts_include_subdomains {
            format!("max-age={max_age}; includeSubDomains")
        } else {
            format!("max-age={max_age}")
        };
        add_if_absent(h, header::STRICT_TRANSPORT_SECURITY, &value);
    }
    resp
}
