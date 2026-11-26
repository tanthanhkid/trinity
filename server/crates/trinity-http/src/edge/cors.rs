//! CORS theo `CORS_ORIGIN`, trùng `isOriginAllowed`/`corsOrigin` của `apps/monolith/src/bootstrap-app.ts` và hành vi
//! `app.enableCors({ origin: fn, credentials: true })` (gói `cors` của Express).
//!
//! - `CORS_ORIGIN`: nhiều giá trị phân tách bằng dấu phẩy; mỗi mục là một origin đầy đủ hoặc `*.example.com` (mọi
//!   subdomain một cấp, nhãn `[a-z0-9-]+`; scheme ở mục wildcard được bỏ qua, cả http và https đều khớp).
//! - `localhost` bất kỳ cổng chỉ được phép ngoài production.
//! - Request không có `Origin` (cùng origin, curl) luôn qua và không thêm header CORS.
//! - `Access-Control-Allow-Credentials: true`; preflight (`OPTIONS`) trả 204, phản chiếu `Access-Control-Request-Headers`.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

pub const DEFAULT_CORS_ORIGIN: &str = "http://localhost:3000";
const ALLOW_METHODS: &str = "GET,HEAD,PUT,PATCH,POST,DELETE";

/// `^https?://localhost(:\d+)?$` (phân biệt hoa thường như bản TS).
fn is_localhost_origin(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    let Some(rest) = rest.strip_prefix("localhost") else {
        return false;
    };
    rest.is_empty()
        || rest
            .strip_prefix(':')
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}

fn strip_scheme_ci(s: &str) -> Option<&str> {
    for p in ["https://", "http://"] {
        if s.len() >= p.len() && s.is_char_boundary(p.len()) && s[..p.len()].eq_ignore_ascii_case(p) {
            return Some(&s[p.len()..]);
        }
    }
    None
}

/// `*.example.com` hoặc `https://*.example.com` khớp `origin` có dạng `<nhãn>.example.com` (nhãn `[a-z0-9-]+`).
fn wildcard_matches(entry: &str, origin: &str) -> bool {
    let rest = strip_scheme_ci(entry).unwrap_or(entry);
    let Some(host) = rest.strip_prefix("*.") else {
        return false;
    };
    if host.is_empty() {
        return false;
    }
    let Some(o) = strip_scheme_ci(origin) else { return false };
    let Some((label, tail)) = o.split_once('.') else {
        return false;
    };
    !label.is_empty()
        && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && tail.eq_ignore_ascii_case(host)
}

/// `configured` là giá trị `CORS_ORIGIN`; `production` là `NODE_ENV=production`.
pub fn is_origin_allowed(origin: &str, configured: &str, production: bool) -> bool {
    if !production && is_localhost_origin(origin) {
        return true;
    }
    configured
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|entry| entry == origin || wildcard_matches(entry, origin))
}

/// Cấu hình CORS của tiến trình.
#[derive(Debug, Clone)]
pub struct CorsConfig {
    pub configured: String,
    pub production: bool,
}

impl CorsConfig {
    /// `CORS_ORIGIN` rỗng hoặc thiếu ⇒ `http://localhost:3000`.
    pub fn new(cors_origin: &str, production: bool) -> Self {
        let configured = if cors_origin.is_empty() {
            DEFAULT_CORS_ORIGIN
        } else {
            cors_origin
        };
        Self {
            configured: configured.to_owned(),
            production,
        }
    }

    fn allows(&self, origin: &str) -> bool {
        is_origin_allowed(origin, &self.configured, self.production)
    }
}

fn add_vary(h: &mut HeaderMap, v: &'static str) {
    h.append(header::VARY, HeaderValue::from_static(v));
}

/// Lớp middleware CORS: `axum::middleware::from_fn_with_state(Arc::new(cfg), cors_layer)`.
/// Không dùng cho route do Node xử lý (K17: proxy giữ nguyên CORS của Node để chỉ có một `Access-Control-Allow-Origin`).
pub async fn cors_layer(State(cfg): State<Arc<CorsConfig>>, req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let allowed = origin
        .as_deref()
        .filter(|o| cfg.allows(o))
        .and_then(|o| HeaderValue::from_str(o).ok());
    let preflight = req.method() == Method::OPTIONS;
    let req_headers = req.headers().get(header::ACCESS_CONTROL_REQUEST_HEADERS).cloned();

    let mut resp = if preflight {
        Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(axum::body::Body::empty())
            .unwrap_or_default()
    } else {
        next.run(req).await
    };
    let h = resp.headers_mut();
    add_vary(h, "Origin");
    if let Some(o) = allowed {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        h.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        if preflight {
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static(ALLOW_METHODS),
            );
            if let Some(rh) = req_headers {
                h.insert(HeaderName::from_static("access-control-allow-headers"), rh);
                add_vary(h, "Access-Control-Request-Headers");
            }
        }
    }
    if preflight {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_localhost_moi_cong() {
        assert!(is_origin_allowed(
            "http://localhost:5173",
            "https://crm.example.com",
            false
        ));
        assert!(is_origin_allowed("https://localhost", "https://crm.example.com", false));
        assert!(!is_origin_allowed(
            "http://localhost:abc",
            "https://crm.example.com",
            false
        ));
        assert!(!is_origin_allowed(
            "http://localhost.evil.com",
            "https://crm.example.com",
            false
        ));
    }

    #[test]
    fn production_chan_localhost_tru_khi_ghi_ro() {
        assert!(!is_origin_allowed(
            "http://localhost:5173",
            "https://crm.example.com",
            true
        ));
        assert!(is_origin_allowed(
            "http://localhost:3000",
            "http://localhost:3000",
            true
        ));
    }

    #[test]
    fn origin_cau_hinh_va_wildcard_subdomain() {
        let prod = |o, c| is_origin_allowed(o, c, true);
        assert!(prod("https://crm.example.com", "https://crm.example.com"));
        assert!(prod("https://a.example.com", "*.example.com"));
        assert!(prod("http://a-1.example.com", "*.example.com"));
        assert!(prod("https://A.Example.com", "https://*.example.com"));
        assert!(!prod("https://evil.com", "*.example.com"));
        assert!(
            !prod("https://example.com", "*.example.com"),
            "gốc không phải subdomain"
        );
        assert!(!prod("https://a.b.example.com", "*.example.com"), "chỉ một cấp");
        assert!(!prod("https://a.example.com.evil.com", "*.example.com"));
        assert!(!prod("https://aexample.com", "*.example.com"));
        assert!(prod(
            "https://x.example.org",
            "https://crm.example.com, *.example.org ,"
        ));
    }
}
