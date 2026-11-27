//! Luật điều hướng của `apps/web/src/proxy.ts` (và `redirects` của `next.config.ts`), viết lại thành hàm thuần để
//! kiểm bằng bảng ca. Không đụng I/O: nhận các thông tin của request, trả quyết định.

/// Thông tin request mà luật cần.
#[derive(Debug, Clone, Copy)]
pub struct NavRequest<'a> {
    /// Giá trị header `Host` (có thể kèm cổng).
    pub host: &'a str,
    /// Đường dẫn, không kèm query.
    pub path: &'a str,
    /// Query thô (không có `?`).
    pub query: Option<&'a str>,
    /// Cookie `access_token` có giá trị (khác rỗng).
    pub has_access_token: bool,
    /// Cookie `has_session` có giá trị (khác rỗng).
    pub has_session: bool,
}

/// Quyết định cho một request trang.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Nav {
    /// Phục vụ đường dẫn gốc. `no_store`: thêm `Cache-Control: no-store, must-revalidate` + `Pragma: no-cache`.
    Pass { no_store: bool },
    /// Chuyển hướng 307 tới `location`.
    Redirect { location: String },
    /// Tên miền phụ cửa hàng: phục vụ trang `/s/<slug>` (URL trình duyệt giữ nguyên), kèm `no-store`.
    Store { slug: String },
}

/// Trang công khai (khớp tiền tố, như `PUBLIC_PATHS` của `proxy.ts`).
const PUBLIC_PREFIXES: [&str; 5] = ["/login", "/register", "/invite/", "/.well-known", "/s/"];
/// Trang công khai khớp nguyên đường dẫn.
const PUBLIC_EXACT: [&str; 2] = ["/privacy", "/terms"];
/// Đoạn đầu mà `config.matcher` của `proxy.ts` loại ra: `/((?!api|_next/static|_next/image|favicon.ico|uploads|logo|brand).*)`.
/// Tiền tố thuần, không có ranh giới đoạn (đúng như regex): `/apiary` cũng bị loại.
const MATCHER_SKIP: [&str; 7] = [
    "api",
    "_next/static",
    "_next/image",
    "favicon.ico",
    "uploads",
    "logo",
    "brand",
];

/// Đường dẫn bị `matcher` loại: `proxy()` không chạy (không chuyển hướng, không `no-store`).
pub fn matcher_skips(path: &str) -> bool {
    let rest = path.strip_prefix('/').unwrap_or(path);
    MATCHER_SKIP.iter().any(|p| rest.starts_with(p))
}

/// `/assistant` và `/assistant/*` ⇒ `/settings?tab=integrations` (`redirects` của `next.config.ts`, `permanent: false`).
pub fn assistant_redirect(path: &str) -> Option<&'static str> {
    (path == "/assistant" || path.starts_with("/assistant/")).then_some("/settings?tab=integrations")
}

/// Slug tên miền phụ: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` (3 đến 40 ký tự).
fn valid_slug(s: &str) -> bool {
    let b = s.as_bytes();
    if !(3..=40).contains(&b.len()) {
        return false;
    }
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    alnum(b[0]) && alnum(b[b.len() - 1]) && b.iter().all(|&c| alnum(c) || c == b'-')
}

/// `{slug}.{STORE_DOMAIN}` ⇒ `slug`. `store_domain` đã `trim` + chữ thường; rỗng/`None` = tắt.
fn store_slug(store_domain: Option<&str>, host: &str) -> Option<String> {
    let domain = store_domain.map(str::trim).filter(|d| !d.is_empty())?.to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    // `.replace(/:\d+$/, '')`
    let host = match host.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|c| c.is_ascii_digit()) => h,
        _ => host.as_str(),
    };
    let slug = host.strip_suffix(format!(".{domain}").as_str())?;
    valid_slug(slug).then(|| slug.to_owned())
}

/// `encodeURIComponent` của JavaScript.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `loginPathWithNext` (`lib/oauth-authorize.ts`): chỉ `/oauth/authorize` (+ query) được đưa vào `next`.
fn login_path_with_next(path_and_search: &str) -> String {
    let ok = path_and_search.len() <= 8192
        && !path_and_search.contains(['\\', '\n', '\r'])
        && path_and_search
            .strip_prefix("/oauth/authorize")
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('?'));
    if ok {
        format!("/login?next={}", encode_uri_component(path_and_search))
    } else {
        "/login".to_owned()
    }
}

/// Quyết định cho một trang. Gọi cho request GET/HEAD vào trang (không phải API). `store_domain` là `STORE_DOMAIN`.
pub fn decide(req: &NavRequest<'_>, store_domain: Option<&str>) -> Nav {
    let path = req.path;
    if matcher_skips(path) {
        return Nav::Pass { no_store: false };
    }
    if let Some(slug) = store_slug(store_domain, req.host) {
        // API + tài nguyên tĩnh đi thẳng; mọi trang khác của tên miền phụ là trang cửa hàng.
        if path.starts_with("/api/") || path.starts_with("/_next/") {
            return Nav::Pass { no_store: false };
        }
        return Nav::Store { slug };
    }
    if PUBLIC_PREFIXES.iter().any(|p| path.starts_with(p)) || PUBLIC_EXACT.contains(&path) {
        return Nav::Pass { no_store: true };
    }
    if path == "/" {
        let signed_in = req.has_access_token || req.has_session;
        let to = if signed_in { "/dashboard" } else { "/login" };
        return Nav::Redirect {
            location: to.to_owned(),
        };
    }
    if req.has_access_token || req.has_session {
        return Nav::Pass { no_store: true };
    }
    let target = if path == "/oauth/authorize" {
        let search = req.query.filter(|q| !q.is_empty()).map(|q| format!("?{q}")).unwrap_or_default();
        login_path_with_next(&format!("{path}{search}"))
    } else {
        "/login".to_owned()
    };
    Nav::Redirect { location: target }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOMAIN: Option<&str> = Some("shop.example.com");

    fn req<'a>(host: &'a str, path: &'a str, token: bool, session: bool) -> NavRequest<'a> {
        NavRequest {
            host,
            path,
            query: None,
            has_access_token: token,
            has_session: session,
        }
    }

    fn redirect(to: &str) -> Nav {
        Nav::Redirect { location: to.to_owned() }
    }

    /// Bảng 18 ca, đối chiếu từng dòng với `proxy.ts`.
    #[test]
    fn bang_18_ca_khop_proxy_ts() {
        let app = "app.example.com";
        let pass = Nav::Pass { no_store: true };
        let skip = Nav::Pass { no_store: false };
        let cases: Vec<(&str, NavRequest<'_>, Nav)> = vec![
            ("1 gốc, có access_token", req(app, "/", true, false), redirect("/dashboard")),
            ("2 gốc, chỉ has_session", req(app, "/", false, true), redirect("/dashboard")),
            ("3 gốc, chưa đăng nhập", req(app, "/", false, false), redirect("/login")),
            ("4 /login công khai", req(app, "/login", false, false), pass.clone()),
            ("5 /register công khai", req(app, "/register", false, false), pass.clone()),
            ("6 /invite/<token> công khai", req(app, "/invite/abc", false, false), pass.clone()),
            ("7 /.well-known công khai", req(app, "/.well-known/x", false, false), pass.clone()),
            ("8 /s/<slug> công khai", req(app, "/s/cua-hang", false, false), pass.clone()),
            ("9 /privacy khớp nguyên đường dẫn", req(app, "/privacy", false, false), pass.clone()),
            ("10 /terms khớp nguyên đường dẫn", req(app, "/terms", false, false), pass.clone()),
            ("11 /privacy/x không công khai", req(app, "/privacy/x", false, false), redirect("/login")),
            ("12 trang riêng, có access_token", req(app, "/contacts", true, false), pass.clone()),
            ("13 trang riêng, chỉ has_session", req(app, "/contacts", false, true), pass.clone()),
            ("14 trang riêng, chưa đăng nhập", req(app, "/contacts", false, false), redirect("/login")),
            ("15 /_next/static bị matcher loại", req(app, "/_next/static/a.js", false, false), skip.clone()),
            ("16 /uploads bị matcher loại", req(app, "/uploads/a.png", false, false), skip.clone()),
            (
                "17 tên miền phụ cửa hàng",
                req("abc-shop.shop.example.com", "/", false, false),
                Nav::Store { slug: "abc-shop".to_owned() },
            ),
            (
                "18 tên miền phụ: /_next/ đi thẳng",
                req("abc-shop.shop.example.com", "/_next/data/x.json", false, false),
                skip.clone(),
            ),
        ];
        assert_eq!(cases.len(), 18);
        for (name, r, want) in cases {
            assert_eq!(decide(&r, DOMAIN), want, "{name}");
        }
    }

    #[test]
    fn oauth_authorize_chua_dang_nhap_quay_lai_sau_dang_nhap() {
        let mut r = req("app.example.com", "/oauth/authorize", false, false);
        r.query = Some("client_id=a&state=b c");
        assert_eq!(
            decide(&r, None),
            redirect("/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Da%26state%3Db%20c")
        );
        r.query = None;
        assert_eq!(decide(&r, None), redirect("/login?next=%2Foauth%2Fauthorize"));
        // Đã đăng nhập thì cho qua.
        let r = req("app.example.com", "/oauth/authorize", true, false);
        assert_eq!(decide(&r, None), Nav::Pass { no_store: true });
        // Đường dẫn khác không đưa vào `next`.
        assert_eq!(login_path_with_next("/oauth/authorizeX"), "/login");
        assert_eq!(login_path_with_next("/oauth/authorize?a=\\b"), "/login");
    }

    #[test]
    fn matcher_la_tien_to_thuan_nhu_regex() {
        for p in ["/api/v1/x", "/apiary", "/favicon.ico", "/logo.svg", "/brand/a.png", "/_next/image", "/uploads"] {
            assert!(matcher_skips(p), "{p}");
        }
        for p in ["/", "/login", "/_next/other", "/dashboard"] {
            assert!(!matcher_skips(p), "{p}");
        }
    }

    #[test]
    fn ten_mien_phu_cua_hang() {
        let d = DOMAIN;
        assert_eq!(store_slug(d, "ab1.shop.example.com:8443").as_deref(), Some("ab1"));
        assert_eq!(store_slug(d, "AB1.Shop.Example.COM").as_deref(), Some("ab1"));
        // Quá ngắn, bắt đầu hoặc kết thúc bằng `-`, ký tự lạ, nhiều cấp, đúng tên miền gốc.
        for host in [
            "ab.shop.example.com",
            "-ab1.shop.example.com",
            "ab1-.shop.example.com",
            "a_b1.shop.example.com",
            "x.y.shop.example.com",
            "shop.example.com",
            "ab1.other.com",
        ] {
            assert_eq!(store_slug(d, host), None, "{host}");
        }
        assert_eq!(store_slug(None, "ab1.shop.example.com"), None);
        assert_eq!(store_slug(Some("  "), "ab1.shop.example.com"), None);
        assert!(valid_slug(&"a".repeat(40)));
        assert!(!valid_slug(&"a".repeat(41)));
        // Tên miền phụ + /api/ đi thẳng; không bị chuyển hướng đăng nhập.
        let r = req("ab1.shop.example.com", "/api/v1/store", false, false);
        assert_eq!(decide(&r, d), Nav::Pass { no_store: false });
    }

    #[test]
    fn assistant_chuyen_ve_cai_dat() {
        for p in ["/assistant", "/assistant/a/b"] {
            assert_eq!(assistant_redirect(p), Some("/settings?tab=integrations"));
        }
        assert_eq!(assistant_redirect("/assistants"), None);
    }
}
