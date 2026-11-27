//! GET an toàn tới URL do người dùng đưa (`safe-http-get.ts`): dùng chung bộ chặn SSRF ([`super::ssrf`]: chỉ https,
//! cổng 443/8443, mọi IP phân giải phải công cộng, bộ phân giải của client tự kiểm chống DNS rebinding), KHÔNG theo
//! chuyển hướng, có hạn thời gian và trần kích thước thân. Lỗi chỉ trả mã chung, không lộ nội dung hay IP nội bộ.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use reqwest::header::{ACCEPT, ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_TYPE, HeaderMap, USER_AGENT};

use super::ssrf::{HostResolver, SsrfPolicy, SystemResolver, assert_safe_url, safe_client};

/// Hạn thời gian mặc định khi tải CIMD.
pub const SAFE_GET_TIMEOUT: Duration = Duration::from_secs(5);
/// Trần thân mặc định khi tải CIMD.
pub const SAFE_GET_MAX_BYTES: usize = 64 * 1024;
/// Hạn thời gian mặc định khi tải media.
pub const SAFE_GET_MEDIA_TIMEOUT: Duration = Duration::from_secs(30);

/// Mã lỗi chung, giống chuỗi lỗi của `SafeGetError` bản TS: `blocked_target`, `redirect_not_followed`, `http_<mã>`,
/// `not_json`, `not_media`, `too_large`, `invalid_json`, `timeout`, `network_error`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SafeGetError(pub String);

impl SafeGetError {
    fn new(code: &str) -> Self {
        Self(code.to_owned())
    }
}

/// Tuỳ chọn cho một lần GET, kèm client `reqwest` dựng sẵn cho cặp (chính sách, bộ phân giải): tạo một lần rồi dùng lại
/// (giữ kết nối), không dựng client mỗi lần gọi.
#[derive(Clone)]
pub struct SafeGetOptions {
    policy: SsrfPolicy,
    resolver: Arc<dyn HostResolver>,
    client: reqwest::Client,
    /// Hạn thời gian cho cả lượt: phân giải DNS bước kiểm, kết nối, đọc thân.
    pub timeout: Duration,
    /// Trần thân (byte).
    pub max_bytes: usize,
}

/// Hạn kết nối của client dùng chung; hạn của cả lượt là `SafeGetOptions::timeout`.
const CONNECT_TIMEOUT: Duration = SAFE_GET_MEDIA_TIMEOUT;

/// Client của chính sách lấy từ env tiến trình + DNS hệ thống, dựng một lần cho cả tiến trình.
static DEFAULT_CLIENT: LazyLock<Option<(SsrfPolicy, reqwest::Client)>> = LazyLock::new(|| {
    let policy = SsrfPolicy::from_process_env();
    safe_client(policy, Arc::new(SystemResolver), CONNECT_TIMEOUT)
        .ok()
        .map(|c| (policy, c))
});

impl SafeGetOptions {
    /// Tuỳ chọn với chính sách và bộ phân giải riêng (dựng client mới; giữ lại để dùng nhiều lần).
    pub fn new(
        policy: SsrfPolicy,
        resolver: Arc<dyn HostResolver>,
        timeout: Duration,
        max_bytes: usize,
    ) -> reqwest::Result<Self> {
        let client = safe_client(policy, Arc::clone(&resolver), CONNECT_TIMEOUT)?;
        Ok(Self {
            policy,
            resolver,
            client,
            timeout,
            max_bytes,
        })
    }

    fn process_default(timeout: Duration, max_bytes: usize) -> reqwest::Result<Self> {
        match DEFAULT_CLIENT.as_ref() {
            Some((policy, client)) => Ok(Self {
                policy: *policy,
                resolver: Arc::new(SystemResolver),
                client: client.clone(),
                timeout,
                max_bytes,
            }),
            None => Self::new(
                SsrfPolicy::from_process_env(),
                Arc::new(SystemResolver),
                timeout,
                max_bytes,
            ),
        }
    }

    /// Mặc định của tải CIMD: chính sách từ env của tiến trình, DNS hệ thống, 5 giây, 64 KiB.
    pub fn json_defaults() -> reqwest::Result<Self> {
        Self::process_default(SAFE_GET_TIMEOUT, SAFE_GET_MAX_BYTES)
    }

    /// Mặc định của tải media: chính sách từ env của tiến trình, DNS hệ thống, 30 giây, trần do người gọi đặt.
    pub fn media_defaults(max_bytes: usize) -> reqwest::Result<Self> {
        Self::process_default(SAFE_GET_MEDIA_TIMEOUT, max_bytes)
    }

    /// Chính sách đích.
    pub fn policy(&self) -> SsrfPolicy {
        self.policy
    }
}

/// Kết quả tải JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct SafeGetJson {
    /// Mã HTTP (luôn 200).
    pub status: u16,
    /// `max-age` (giây) trong `Cache-Control`; `Some(0)` khi `no-store`/`no-cache` hoặc thiếu header; `None` khi có
    /// header mà không có `max-age`.
    pub max_age_sec: Option<u64>,
    /// Thân JSON.
    pub json: serde_json::Value,
}

/// Kết quả tải media.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeGetMedia {
    /// `Content-Type` không tham số, chữ thường.
    pub content_type: String,
    /// Thân.
    pub body: Vec<u8>,
}

struct RawGet {
    status: u16,
    headers: HeaderMap,
    body: Vec<u8>,
}

/// `Cache-Control` → số giây (`parseMaxAge`).
pub fn parse_max_age(cache_control: Option<&str>) -> Option<u64> {
    let s = match cache_control {
        None | Some("") => return Some(0),
        Some(s) => s,
    };
    let lower = s.to_ascii_lowercase();
    if lower.contains("no-store") || lower.contains("no-cache") {
        return Some(0);
    }
    // `/max-age=(\d{1,9})/i`: lần xuất hiện đầu tiên có ít nhất một chữ số, lấy tối đa 9 chữ số.
    lower.match_indices("max-age=").find_map(|(i, m)| {
        let digits: String = lower[i + m.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .take(9)
            .collect();
        digits.parse().ok()
    })
}

/// `^application\/([a-z0-9.+-]+\+)?json\b` không phân biệt hoa thường.
fn is_json_type(ctype: &str) -> bool {
    let c = ctype.to_ascii_lowercase();
    let Some(rest) = c.strip_prefix("application/") else {
        return false;
    };
    // Thử mọi vị trí "json" hợp lệ: ngay đầu, hoặc sau "<đuôi>+" gồm [a-z0-9.+-].
    let ok_at = |i: usize| {
        let prefix = &rest[..i];
        let prefix_ok = i == 0
            || (prefix.ends_with('+')
                && prefix.len() > 1
                && prefix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-')));
        let after = rest[i + 4..].bytes().next();
        prefix_ok && !after.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
    };
    rest.match_indices("json").any(|(i, _)| ok_at(i))
}

/// `^(image|video)\/[a-z0-9.+-]+` không phân biệt hoa thường.
fn is_media_type(ctype: &str) -> bool {
    let c = ctype.to_ascii_lowercase();
    let rest = c.strip_prefix("image/").or_else(|| c.strip_prefix("video/"));
    rest.and_then(|r| r.bytes().next())
        .is_some_and(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

async fn safe_get_raw(
    raw_url: &str,
    o: &SafeGetOptions,
    accept: &str,
    user_agent: &str,
    accept_type: fn(&str) -> Option<&'static str>,
) -> Result<RawGet, SafeGetError> {
    // K28: đang shadow thì KHÔNG ra mạng (ghi vi phạm, không thử lại).
    if trinity_kernel::shadow::forbid_outbound("safe_get").is_err() {
        return Err(SafeGetError::new("shadow_denied"));
    }
    // Một hạn thời gian cho cả lượt, kể cả bước phân giải DNS để kiểm (DNS treo không giữ lời gọi quá hạn).
    let work = async {
        let target = assert_safe_url(raw_url, o.policy, o.resolver.as_ref())
            .await
            .map_err(|_| SafeGetError::new("blocked_target"))?;
        let mut res = o
            .client
            .get(target.url.clone())
            .header(ACCEPT, accept)
            .header(USER_AGENT, user_agent)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| SafeGetError::new("network_error"))?;
        let status = res.status().as_u16();
        if status != 200 {
            return Err(SafeGetError(if (300..400).contains(&status) {
                "redirect_not_followed".to_owned()
            } else {
                format!("http_{status}")
            }));
        }
        let ctype = first_latin1(res.headers(), CONTENT_TYPE);
        if let Some(code) = accept_type(&ctype) {
            return Err(SafeGetError::new(code));
        }
        if res.content_length().is_some_and(|n| n > o.max_bytes as u64) {
            return Err(SafeGetError::new("too_large"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| SafeGetError::new("network_error"))? {
            if body.len() + chunk.len() > o.max_bytes {
                return Err(SafeGetError::new("too_large"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(RawGet {
            status,
            headers: res.headers().clone(),
            body,
        })
    };
    tokio::time::timeout(o.timeout, work)
        .await
        .map_err(|_| SafeGetError::new("timeout"))?
}

/// Giá trị đầu tiên của header như Node đọc (`latin1`: mỗi byte một ký tự); Node bỏ các dòng `Content-Type` trùng.
fn first_latin1(headers: &HeaderMap, name: reqwest::header::HeaderName) -> String {
    headers
        .get(name)
        .map(|v| v.as_bytes().iter().map(|&b| char::from(b)).collect())
        .unwrap_or_default()
}

/// Giá trị header như Node đọc (`latin1`: mỗi byte một ký tự), các dòng trùng tên nối bằng `, `.
fn header_latin1(headers: &HeaderMap, name: reqwest::header::HeaderName) -> String {
    headers
        .get_all(name)
        .iter()
        .map(|v| v.as_bytes().iter().map(|&b| char::from(b)).collect::<String>())
        .collect::<Vec<_>>()
        .join(", ")
}

/// GET JSON an toàn cho việc tải Client ID Metadata Document (CIMD) (`safeGetJson`): mặc định 5 giây, thân ≤ 64 KiB,
/// phải là JSON.
pub async fn safe_get_json(raw_url: &str, o: &SafeGetOptions) -> Result<SafeGetJson, SafeGetError> {
    let r = safe_get_raw(raw_url, o, "application/json", "Trinity-CRM-OAuth/1", |c| {
        if is_json_type(c) { None } else { Some("not_json") }
    })
    .await?;
    // Như `Buffer.toString('utf8')`: byte UTF-8 hỏng thành U+FFFD rồi mới đọc JSON.
    let text = String::from_utf8_lossy(&r.body);
    let json = serde_json::from_str(&text).map_err(|_| SafeGetError::new("invalid_json"))?;
    let cache = header_latin1(&r.headers, CACHE_CONTROL);
    Ok(SafeGetJson {
        status: r.status,
        max_age_sec: parse_max_age(Some(&cache)),
        json,
    })
}

/// Tải ảnh/video từ URL công khai (AI đưa link tệp nó vừa tạo) (`safeGetMedia`): chỉ `image/*` hoặc `video/*`, trần do
/// người gọi đặt trong `o.max_bytes`.
pub async fn safe_get_media(raw_url: &str, o: &SafeGetOptions) -> Result<SafeGetMedia, SafeGetError> {
    let r = safe_get_raw(raw_url, o, "image/*,video/*", "Trinity-CRM-Media/1", |c| {
        if is_media_type(c) { None } else { Some("not_media") }
    })
    .await?;
    let ctype = first_latin1(&r.headers, CONTENT_TYPE);
    let content_type = ctype.split(';').next().unwrap_or("").trim().to_lowercase();
    Ok(SafeGetMedia {
        content_type,
        body: r.body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_age() {
        assert_eq!(parse_max_age(Some("public, max-age=120")), Some(120));
        assert_eq!(parse_max_age(Some("no-store")), Some(0));
        assert_eq!(parse_max_age(Some("No-Cache, max-age=60")), Some(0));
        assert_eq!(parse_max_age(None), Some(0));
        assert_eq!(parse_max_age(Some("public")), None);
        assert_eq!(parse_max_age(Some("max-age=1234567890123")), Some(123_456_789));
    }

    #[test]
    fn loai_noi_dung() {
        for ok in [
            "application/json",
            "application/json; charset=utf-8",
            "APPLICATION/JSON",
            "application/ld+json",
            "application/vnd.api+json",
        ] {
            assert!(is_json_type(ok), "{ok}");
        }
        for bad in [
            "text/html",
            "application/jsonx",
            "application/+json",
            "text/json",
            "",
            "application/x-json",
        ] {
            assert!(!is_json_type(bad), "{bad}");
        }
        assert!(is_media_type("image/png"));
        assert!(is_media_type("VIDEO/mp4; codecs=x"));
        assert!(!is_media_type("image/"));
        assert!(!is_media_type("text/plain"));
    }
}
