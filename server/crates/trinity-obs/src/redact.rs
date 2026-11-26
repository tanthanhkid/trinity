//! Che bí mật trong URL trước khi ghi log — bản Rust của `redactUrl()` (`packages/logger/src/redact-url.ts`), cùng
//! luật và cùng ca test:
//!
//! - token webhook vào nằm trong đường dẫn: `/hooks/in/<token>` ⇒ `/hooks/in/[redacted]`;
//! - mã OAuth và token trong query: `?code=…`, `&state=…`, `&token=…` (và các khoá ở [`SECRET_QUERY_KEYS`], không
//!   phân biệt hoa thường) ⇒ `…=[redacted]`.
//!
//! Chuỗi không khớp trả y nguyên. Không dùng regex: hai luật trên quét tuyến tính.

use std::borrow::Cow;

const REDACTED: &str = "[redacted]";
const HOOK_SEGMENT: &str = "/hooks/in/";

/// Khoá query bị che, giống bản Node.
pub const SECRET_QUERY_KEYS: &[&str] = &[
    "code",
    "state",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "secret",
    "password",
    "api_key",
    "apikey",
    "key",
    "signature",
    "verify_token",
    "hub.verify_token",
    "oauth_token",
    "oauth_token_secret",
];

/// `\s` của JavaScript (gần đúng: khoảng trắng Unicode và U+FEFF).
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Che token webhook trong đường dẫn và bí mật trong query.
pub fn redact_url(url: &str) -> Cow<'_, str> {
    let step1 = redact_hook_paths(url);
    match redact_query(&step1) {
        Cow::Borrowed(_) => step1,
        Cow::Owned(s) => Cow::Owned(s),
    }
}

/// `/(\/hooks\/in\/)[^/?#\s]+/g` ⇒ `$1[redacted]`.
fn redact_hook_paths(url: &str) -> Cow<'_, str> {
    if !url.contains(HOOK_SEGMENT) {
        return Cow::Borrowed(url);
    }
    let mut out = String::with_capacity(url.len());
    let mut rest = url;
    while let Some(i) = rest.find(HOOK_SEGMENT) {
        let after = i + HOOK_SEGMENT.len();
        out.push_str(&rest[..after]);
        let tail = &rest[after..];
        let end = tail
            .find(|c: char| c == '/' || c == '?' || c == '#' || is_js_space(c))
            .unwrap_or(tail.len());
        if end > 0 {
            out.push_str(REDACTED);
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// `/([?&](?:khoá…)=)[^&#\s]*/gi` ⇒ `$1[redacted]`.
fn redact_query(url: &str) -> Cow<'_, str> {
    let mut out: Option<String> = None;
    let mut copied = 0; // byte đầu tiên của `url` chưa chép sang `out`
    let mut i = 0;
    let bytes = url.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'?' || bytes[i] == b'&' {
            let after = &url[i + 1..];
            if let Some(key) = SECRET_QUERY_KEYS.iter().find(|k| starts_with_key(after, k)) {
                let value_start = i + 1 + key.len() + 1;
                let value = &url[value_start..];
                let value_end = value_start
                    + value
                        .find(|c: char| c == '&' || c == '#' || is_js_space(c))
                        .unwrap_or(value.len());
                let o = out.get_or_insert_with(|| String::with_capacity(url.len()));
                o.push_str(&url[copied..value_start]);
                o.push_str(REDACTED);
                copied = value_end;
                i = value_end;
                continue;
            }
        }
        i += 1;
    }
    match out {
        None => Cow::Borrowed(url),
        Some(mut o) => {
            o.push_str(&url[copied..]);
            Cow::Owned(o)
        }
    }
}

/// `s` bắt đầu bằng `key=` (so khoá không phân biệt hoa thường ASCII).
fn starts_with_key(s: &str, key: &str) -> bool {
    s.len() > key.len()
        && s.as_bytes()[key.len()] == b'='
        && s.as_bytes()[..key.len()].eq_ignore_ascii_case(key.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::redact_url;

    fn r(s: &str) -> String {
        redact_url(s).into_owned()
    }

    // Cùng ca với packages/logger/src/redact-url.spec.ts.
    #[test]
    fn che_token_webhook_vao_giu_phan_con_lai() {
        assert_eq!(
            r("/api/v1/hooks/in/whk_AbC-123_xyz?x=1"),
            "/api/v1/hooks/in/[redacted]?x=1"
        );
        assert_eq!(r("/api/v1/hooks/in/whk_abc"), "/api/v1/hooks/in/[redacted]");
        assert_eq!(
            r("POST https://x.vn/api/v1/hooks/in/whk_secret failed"),
            "POST https://x.vn/api/v1/hooks/in/[redacted] failed"
        );
    }

    #[test]
    fn che_code_state_token_trong_query_giu_tham_so_khac() {
        assert_eq!(
            r("/api/v1/integrations/oauth/callback?code=abc123&state=xyz&page=2"),
            "/api/v1/integrations/oauth/callback?code=[redacted]&state=[redacted]&page=2"
        );
        assert_eq!(
            r("/x?a=1&access_token=T0K&client_secret=S"),
            "/x?a=1&access_token=[redacted]&client_secret=[redacted]"
        );
        assert_eq!(r("/x?CODE=abc#frag"), "/x?CODE=[redacted]#frag");
        assert_eq!(
            r("/wh?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=1"),
            "/wh?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=1"
        );
        assert_eq!(
            r("/x?verify_token=VT&oauth_token=OT&page=2"),
            "/x?verify_token=[redacted]&oauth_token=[redacted]&page=2"
        );
        assert_eq!(r("/x?postcode=7000"), "/x?postcode=7000");
        assert_eq!(r("/x?token=T&Token=U"), "/x?token=[redacted]&Token=[redacted]");
    }

    #[test]
    fn duong_dan_khac_khong_doi() {
        assert_eq!(r("/api/v1/contacts?page=1"), "/api/v1/contacts?page=1");
        assert_eq!(r("/api/v1/hooks/out"), "/api/v1/hooks/out");
        assert_eq!(r(""), "");
        assert!(matches!(
            redact_url("/api/v1/contacts?page=1"),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    #[test]
    fn ca_bien() {
        // Đoạn token rỗng: regex cần ít nhất một ký tự nên giữ nguyên.
        assert_eq!(r("/api/v1/hooks/in/"), "/api/v1/hooks/in/");
        assert_eq!(r("/api/v1/hooks/in/?code="), "/api/v1/hooks/in/?code=[redacted]");
        assert_eq!(
            r("/a/hooks/in/t1 /b/hooks/in/t2"),
            "/a/hooks/in/[redacted] /b/hooks/in/[redacted]"
        );
        assert_eq!(r("/x?code"), "/x?code");
        assert_eq!(r("/x?keyboard=1&key=2"), "/x?keyboard=1&key=[redacted]");
        assert_eq!(r("/x?state=ẩn&a=b"), "/x?state=[redacted]&a=b");
    }
}
