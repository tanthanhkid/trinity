//! Kiểm và so khớp `redirect_uri` (`redirect-uri.ts`, OAuth 2.1 §2.3.1, RFC 8252).

use url::Url;

use crate::error::{OAuthError, R};
use crate::util::{is_js_space, js_len};

const MAX_LEN: usize = 2048;

pub fn is_loopback_host(host: &str) -> bool {
    matches!(host.to_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

fn bad(msg: &str) -> OAuthError {
    OAuthError::new("invalid_redirect_uri", msg)
}

/// Kiểm lúc ĐĂNG KÝ hoặc khai trong CIMD: https, hoặc http CHỈ cho loopback. Cấm fragment, userinfo, ký tự điều khiển,
/// khoảng trắng, `\`, scheme lạ (`javascript:`, `data:`, `app://`: chặn code injection).
pub fn parse_redirect_uri(raw: &str) -> R<Url> {
    let bad_chars = |c: char| c <= '\u{1f}' || c == '\u{7f}' || c == '\\' || is_js_space(c);
    if raw.is_empty() || js_len(raw) > MAX_LEN || raw.chars().any(bad_chars) {
        return Err(bad("redirect_uri không hợp lệ"));
    }
    let u = Url::parse(raw).map_err(|_| bad("redirect_uri không hợp lệ"))?;
    let loopback = u.host_str().is_some_and(is_loopback_host);
    if !(u.scheme() == "https" || (u.scheme() == "http" && loopback)) {
        return Err(bad("redirect_uri phải là https (http chỉ cho localhost)"));
    }
    if u.fragment().is_some_and(|f| !f.is_empty()) || raw.contains('#') {
        return Err(bad("redirect_uri không được có fragment"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(bad("redirect_uri không được chứa tài khoản"));
    }
    if u.host_str().is_none_or(str::is_empty) {
        return Err(bad("redirect_uri thiếu tên miền"));
    }
    Ok(u)
}

fn search(u: &Url) -> &str {
    u.query().unwrap_or("")
}

/// Khớp CHÍNH XÁC chuỗi đã đăng ký. Ngoại lệ duy nhất (RFC 8252 §7.3, Claude Code): URI đăng ký là loopback `http`
/// KHÔNG khai cổng ⇒ nhận mọi cổng, còn scheme/host/path/query phải y hệt.
pub fn redirect_uri_matches(registered: &str, requested: &str) -> bool {
    if registered == requested {
        return true;
    }
    let (Ok(reg), Ok(req)) = (Url::parse(registered), Url::parse(requested)) else {
        return false;
    };
    if reg.scheme() != "http" || !reg.host_str().is_some_and(is_loopback_host) || reg.port().is_some() {
        return false;
    }
    req.scheme() == "http"
        && req.host_str().map(str::to_lowercase) == reg.host_str().map(str::to_lowercase)
        && req.path() == reg.path()
        && search(&req) == search(&reg)
        && req.fragment().is_none_or(str::is_empty)
        && req.username().is_empty()
        && req.password().is_none()
}

pub fn is_loopback_uri(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|u| u.scheme() == "http" && u.host_str().is_some_and(is_loopback_host))
}

/// `new URL(uri).host`: tên máy kèm cổng không mặc định; hiển thị trên màn đồng ý (MCP spec: PHẢI hiện hostname).
pub fn redirect_host(uri: &str) -> String {
    let Ok(u) = Url::parse(uri) else { return String::new() };
    match (u.host_str(), u.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_owned(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dang_ky_tu_choi_uri_nguy_hiem() {
        for bad in [
            "javascript:alert(1)",
            "http://evil.example.com/cb",
            "https://client.example.com/cb#frag",
            "https://client.example.com/cb#",
            "https://user:pw@client.example.com/cb",
            "data:text/html,x",
            "chatgpt://cb",
            "https://x.example.com/a b",
            "https://x.example.com/a\\b",
            "https://x.example.com/a\u{feff}b",
            "",
        ] {
            assert!(parse_redirect_uri(bad).is_err(), "{bad}");
        }
        for ok in [
            "https://client.example.com/cb",
            "http://localhost/callback",
            "http://127.0.0.1:3118/cb",
            "http://[::1]/cb",
        ] {
            assert!(parse_redirect_uri(ok).is_ok(), "{ok}");
        }
        assert!(parse_redirect_uri(&format!("https://a.example.com/{}", "x".repeat(2100))).is_err());
    }

    #[test]
    fn loopback_khong_cong_nhan_moi_cong() {
        assert!(redirect_uri_matches(
            "http://localhost/callback",
            "http://localhost:3118/callback"
        ));
        assert!(redirect_uri_matches(
            "http://localhost/callback",
            "http://LOCALHOST:9/callback"
        ));
        assert!(!redirect_uri_matches(
            "http://localhost/callback",
            "http://localhost:3118/other"
        ));
        assert!(!redirect_uri_matches(
            "http://localhost/callback",
            "https://localhost:3118/callback"
        ));
        assert!(!redirect_uri_matches(
            "http://localhost/callback",
            "http://localhost:3118/callback?a=1"
        ));
        // Đăng ký có cổng ⇒ khớp chuỗi nguyên văn.
        assert!(!redirect_uri_matches(
            "http://localhost:1/callback",
            "http://localhost:2/callback"
        ));
        assert!(redirect_uri_matches(
            "https://client.example.com/cb",
            "https://client.example.com/cb"
        ));
        assert!(!redirect_uri_matches(
            "https://client.example.com/cb",
            "https://client.example.com/cb/../x"
        ));
        assert!(!redirect_uri_matches(
            "https://client.example.com/cb",
            "https://client.example.com/cb?a=1"
        ));
    }

    #[test]
    fn host_hien_thi() {
        assert_eq!(redirect_host("https://client.example.com/cb"), "client.example.com");
        assert_eq!(redirect_host("http://localhost:3118/cb"), "localhost:3118");
        assert_eq!(redirect_host("not a url"), "");
    }
}
