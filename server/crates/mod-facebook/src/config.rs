//! Cấu hình Facebook qua env, chuyển từ `facebook.config.ts` và `common/helpers/api-base-url.ts`. Mọi hàm nhận nguồn env là
//! closure (đọc MỖI LẦN gọi, như bản Node, để test đổi được giữa các ca; `FACEBOOK_GRAPH_BASE_URL` trỏ tới máy chủ giả).
//!
//! Meta docs: Graph API versions <https://developers.facebook.com/docs/graph-api/changelog/versions>; Webhooks Messenger
//! <https://developers.facebook.com/docs/messenger-platform/webhooks>.

use std::sync::Arc;

use trinity_integrations::status::public_base_url;

/// Nguồn env dùng chung (`process.env` ở production, bảng giả ở test).
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Env của tiến trình.
pub fn process_env() -> Env {
    Arc::new(|k| std::env::var(k).ok())
}

pub const DEFAULT_GRAPH_VERSION: &str = "v25.0";
pub const DEFAULT_GRAPH_BASE_URL: &str = "https://graph.facebook.com";
/// Tải video theo phiên đi qua host riêng của Graph.
pub const DEFAULT_GRAPH_VIDEO_BASE_URL: &str = "https://graph-video.facebook.com";

/// Quyền xin khi đăng nhập Facebook: đúng bộ của use case Messenger trên app Meta. Lead Ads cần thêm `leads_retrieval` +
/// `pages_manage_ads`: chỉ thêm khi app có use case đó, xin quyền app chưa có thì Facebook báo "Invalid Scopes".
pub const FACEBOOK_SCOPES: [&str; 4] = [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_read_engagement",
];

/// Quyền thêm khi bật tự xử lý bình luận (`FACEBOOK_COMMENT_AUTOMATION`).
pub const COMMENT_SCOPES: [&str; 2] = ["pages_read_user_content", "pages_manage_engagement"];

/// Quyền của phần đăng bài (Đăng đa kênh), xin chung một lần nối (`FACEBOOK_SOCIAL_SCOPES`).
pub const FACEBOOK_SOCIAL_SCOPES: [&str; 3] = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

/// Trường webhook đăng ký cho mỗi Page. `leadgen` cần quyền `leads_retrieval`: đăng ký kèm khi app chưa có quyền đó thì
/// Facebook từ chối CẢ lệnh, Page không nhận được tin nhắn nào.
pub const SUBSCRIBED_FIELDS: [&str; 3] = ["messages", "messaging_postbacks", "messaging_referrals"];

/// Trường thêm khi bật bình luận.
pub const COMMENT_FIELDS: [&str; 1] = ["feed"];

/// `FACEBOOK_COMMENT_AUTOMATION` = `1`/`true`/`yes` (không phân biệt hoa/thường).
pub fn comment_automation_enabled(env: &Env) -> bool {
    let v = env("FACEBOOK_COMMENT_AUTOMATION")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    matches!(v.as_str(), "1" | "true" | "yes")
}

/// Quyền xin khi đăng nhập (thêm quyền bình luận khi đã bật).
pub fn facebook_scopes(env: &Env) -> Vec<String> {
    let mut v: Vec<String> = FACEBOOK_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    if comment_automation_enabled(env) {
        v.extend(COMMENT_SCOPES.iter().map(|s| (*s).to_owned()));
    }
    v
}

/// Một lần nối xin cả quyền nhận tin/bình luận lẫn quyền đăng bài (cùng một app Meta), bỏ trùng, giữ thứ tự xuất hiện.
pub fn connect_scopes(env: &Env) -> Vec<String> {
    let mut v = facebook_scopes(env);
    for s in FACEBOOK_SOCIAL_SCOPES {
        if !v.iter().any(|x| x == s) {
            v.push(s.to_owned());
        }
    }
    v
}

/// Trường webhook đăng ký cho Page (thêm `feed` khi đã bật bình luận).
pub fn subscribed_fields(env: &Env) -> Vec<String> {
    let mut v: Vec<String> = SUBSCRIBED_FIELDS.iter().map(|s| (*s).to_owned()).collect();
    if comment_automation_enabled(env) {
        v.extend(COMMENT_FIELDS.iter().map(|s| (*s).to_owned()));
    }
    v
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacebookConfig {
    pub app_id: String,
    pub app_secret: String,
    pub verify_token: String,
    pub graph_version: String,
    /// URL gốc công khai (`INTEGRATIONS_PUBLIC_BASE_URL`) để dựng `redirect_uri`; `None` nếu chưa đặt hoặc không hợp lệ.
    pub base_url: Option<String>,
}

pub fn load_facebook_config(env: &Env) -> FacebookConfig {
    let get = |k: &str| env(k).unwrap_or_default().trim().to_owned();
    let version = get("FACEBOOK_GRAPH_VERSION");
    FacebookConfig {
        app_id: get("FACEBOOK_APP_ID"),
        app_secret: get("FACEBOOK_APP_SECRET"),
        verify_token: get("FACEBOOK_WEBHOOK_VERIFY_TOKEN"),
        graph_version: if version.is_empty() {
            DEFAULT_GRAPH_VERSION.to_owned()
        } else {
            version
        },
        base_url: public_base_url(&|k: &str| env(k)),
    }
}

/// Đủ để chạy đăng nhập Facebook (app id/secret + URL gốc). Webhook cần thêm verify token.
pub fn is_facebook_configured(c: &FacebookConfig) -> bool {
    !c.app_id.is_empty() && !c.app_secret.is_empty() && c.base_url.is_some()
}

/// `redirect_uri` của OAuth; gọi khi `base_url` đã có.
pub fn oauth_redirect_uri(c: &FacebookConfig) -> String {
    format!(
        "{}/api/v1/facebook/oauth/callback",
        c.base_url.as_deref().unwrap_or_default()
    )
}

fn is_loopback_host(h: &str) -> bool {
    let h = h.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h == "::1" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Địa chỉ gốc của API bên ngoài đọc từ env (`apiBaseUrl`): không đặt ⇒ `fallback`; `http://` chỉ nhận cho host loopback
/// (không phụ thuộc môi trường, để không bao giờ gửi token qua mạng không mã hoá); không có query hay `#`; bỏ `/` cuối.
pub fn api_base_url(name: &str, fallback: &str, env: &Env) -> Result<String, String> {
    let raw = env(name).unwrap_or_default().trim().to_owned();
    if raw.is_empty() {
        return Ok(fallback.to_owned());
    }
    let url = url::Url::parse(&raw).map_err(|_| format!("{name} không phải URL hợp lệ"))?;
    match url.scheme() {
        "http" => {
            if !url.host_str().is_some_and(is_loopback_host) {
                return Err(format!(
                    "{name}: http:// chỉ dùng cho máy chủ cục bộ (localhost, 127.0.0.1, ::1) — dùng https://"
                ));
            }
        }
        "https" => {}
        _ => return Err(format!("{name} chỉ nhận https:// (http:// cho máy chủ cục bộ)")),
    }
    if raw.contains('?') || raw.contains('#') {
        return Err(format!("{name} không được có query hay #"));
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// Đường dẫn Graph (id, cạnh) không được thoát khỏi `/{version}/` hay chèn query: id lấy từ webhook/request nên chặn `..`,
/// `.`, `?`, `#`, `\` và khoảng trắng.
pub fn is_safe_graph_path(path: &str) -> bool {
    !path.chars().any(|c| matches!(c, '?' | '#' | '\\') || c.is_whitespace())
        && !path.split('/').any(|s| s == ".." || s == ".")
}

/// `encodeURIComponent` của JS: giữ `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, mã hoá phần còn lại theo UTF-8.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `URLSearchParams.toString()`: `application/x-www-form-urlencoded` (khoảng trắng thành `+`), giữ thứ tự chèn.
pub fn form_encode(query: &[(String, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(query)
        .finish()
}

/// Dựng URL Graph API (`graphUrl`): chỗ DUY NHẤT dựng URL cho client, đăng đa kênh và bình luận đầu tiên. Lỗi ⇒ chuỗi
/// tiếng Việt (cấu hình địa chỉ gốc sai hoặc đường dẫn lạ); chưa gửi gì tới Facebook.
pub fn graph_url(
    version: &str,
    path: &str,
    query: &[(String, String)],
    video: bool,
    env: &Env,
) -> Result<String, String> {
    if !is_safe_graph_path(path) {
        return Err("Đường dẫn Graph API không hợp lệ".to_owned());
    }
    let fallback = if video {
        DEFAULT_GRAPH_VIDEO_BASE_URL
    } else {
        DEFAULT_GRAPH_BASE_URL
    };
    let base = api_base_url("FACEBOOK_GRAPH_BASE_URL", fallback, env)?;
    let segs: Vec<String> = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .map(encode_uri_component)
        .collect();
    let q = form_encode(query);
    Ok(format!(
        "{base}/{}/{}{}",
        encode_uri_component(version),
        segs.join("/"),
        if q.is_empty() { String::new() } else { format!("?{q}") }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        let m: std::collections::HashMap<String, String> =
            pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Arc::new(move |k| m.get(k).cloned())
    }

    #[test]
    fn dia_chi_goc_graph() {
        let e = env(&[]);
        assert_eq!(
            api_base_url("X", "https://graph.facebook.com", &e).unwrap(),
            "https://graph.facebook.com"
        );
        for (v, ok) in [
            ("https://a.example/", Some("https://a.example")),
            ("http://127.0.0.1:9000///", Some("http://127.0.0.1:9000")),
            ("http://localhost:1", Some("http://localhost:1")),
            ("http://[::1]:80", Some("http://[::1]:80")),
            ("http://graph.example", None),
            ("http://127.0.0.1.evil.com", None),
            ("ftp://x", None),
            ("https://a.example/?x=1", None),
            ("https://a.example/#f", None),
            ("khong-phai-url", None),
        ] {
            let got = api_base_url("X", "f", &env(&[("X", v)]));
            assert_eq!(got.ok().as_deref(), ok, "{v}");
        }
    }

    #[test]
    fn duong_dan_an_toan_va_url() {
        for bad in ["a/../b", "./a", "a?x=1", "a#b", "a\\b", "a b"] {
            assert!(!is_safe_graph_path(bad), "{bad}");
        }
        assert!(
            is_safe_graph_path("me/accounts")
                && is_safe_graph_path("123_456/subscribed_apps")
                && is_safe_graph_path("a..b")
        );
        let e = env(&[("FACEBOOK_GRAPH_BASE_URL", "http://127.0.0.1:9/")]);
        let q = vec![
            ("fields".to_owned(), "id,name,picture{url}".to_owned()),
            ("q".to_owned(), "a b".to_owned()),
        ];
        assert_eq!(
            graph_url("v25.0", "/me/accounts", &q, false, &e).unwrap(),
            "http://127.0.0.1:9/v25.0/me/accounts?fields=id%2Cname%2Cpicture%7Burl%7D&q=a+b"
        );
        assert!(graph_url("v25.0", "a/../b", &[], false, &e).is_err());
        assert_eq!(encode_uri_component("a b/é"), "a%20b%2F%C3%A9");
        assert_eq!(
            graph_url("v25.0", "x", &[], true, &env(&[])).unwrap(),
            "https://graph-video.facebook.com/v25.0/x"
        );
    }

    #[test]
    fn quyen_va_truong_webhook() {
        let off = env(&[]);
        let on = env(&[("FACEBOOK_COMMENT_AUTOMATION", " YES ")]);
        assert!(!comment_automation_enabled(&off) && comment_automation_enabled(&on));
        assert_eq!(
            subscribed_fields(&off),
            ["messages", "messaging_postbacks", "messaging_referrals"]
        );
        assert_eq!(subscribed_fields(&on).last().map(String::as_str), Some("feed"));
        // Bỏ trùng `pages_show_list` và `pages_read_engagement`; quyền đăng bài thêm cuối.
        let s = connect_scopes(&off);
        assert_eq!(
            s,
            [
                "pages_show_list",
                "pages_messaging",
                "pages_manage_metadata",
                "pages_read_engagement",
                "pages_manage_posts"
            ]
        );
        assert_eq!(connect_scopes(&on).len(), 7);
        let c = load_facebook_config(&env(&[
            ("FACEBOOK_APP_ID", " 1 "),
            ("FACEBOOK_APP_SECRET", "s"),
            ("INTEGRATIONS_PUBLIC_BASE_URL", "https://crm.example"),
        ]));
        assert!(is_facebook_configured(&c) && c.graph_version == DEFAULT_GRAPH_VERSION);
        assert_eq!(
            oauth_redirect_uri(&c),
            "https://crm.example/api/v1/facebook/oauth/callback"
        );
        assert!(!is_facebook_configured(&load_facebook_config(&off)));
    }
}
