//! Cấu hình Zalo OA chính thức, toàn bộ qua env, KHÔNG có giá trị mặc định cho secret (`zalo-oa.config.ts`). Env đọc MỖI LẦN
//! gọi (nguồn là closure) để test đổi được giữa các ca; `ZALO_*_BASE_URL` trỏ tới máy chủ giả khi test.
//! Tài liệu: <https://developers.zalo.me/docs/official-account> (OAuth v4 của OA, Webhook, API v3.0, ZNS).

use std::sync::Arc;

/// Nguồn env dùng chung (`process.env` ở production, bảng giả ở test).
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub fn process_env() -> Env {
    Arc::new(|k| std::env::var(k).ok())
}

pub const DEFAULT_OAUTH_BASE_URL: &str = "https://oauth.zaloapp.com";
pub const DEFAULT_OPENAPI_BASE_URL: &str = "https://openapi.zalo.me";
pub const DEFAULT_ZNS_BASE_URL: &str = "https://business.openapi.zalo.me";

/// Tin tư vấn chỉ gửi được trong 48 giờ kể từ tin gần nhất của khách.
pub const CONSULT_WINDOW_MS: i64 = 48 * 60 * 60 * 1000;
/// Làm mới token khi còn dưới ngần này so với hạn.
pub const REFRESH_SKEW_MS: i64 = 10 * 60 * 1000;
pub const OAUTH_STATE_TTL_MS: i64 = 10 * 60 * 1000;
/// Refresh token Zalo sống khoảng 3 tháng.
pub const REFRESH_TOKEN_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZaloEndpoint {
    /// Trang quản trị OA cấp quyền cho ứng dụng (OAuth v4, PKCE).
    Permission,
    /// Đổi code ⇒ token và làm mới token (header `secret_key` = khoá bí mật của ứng dụng).
    Token,
    /// OA API v3.0 (gửi tin tư vấn, lấy hồ sơ người dùng).
    Api,
    /// ZNS: gửi tin thông báo theo mẫu đã duyệt.
    Zns,
}

fn is_loopback_host(h: &str) -> bool {
    let h = h.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h == "::1" {
        return true;
    }
    let p: Vec<&str> = h.split('.').collect();
    p.len() == 4
        && p[0] == "127"
        && p.iter()
            .all(|x| !x.is_empty() && x.len() <= 3 && x.bytes().all(|b| b.is_ascii_digit()))
}

/// Địa chỉ gốc API bên ngoài đọc từ env (`apiBaseUrl`): không đặt ⇒ `fallback`; `http://` chỉ cho host loopback; không có
/// query hay `#`; bỏ `/` cuối. (Cùng luật `mod_facebook::config::api_base_url`; gom về `trinity-kernel` khi cả hai đã vào main.)
pub fn api_base_url(name: &str, fallback: &str, env: &Env) -> Result<String, String> {
    let raw = env(name).unwrap_or_default().trim().to_owned();
    if raw.is_empty() {
        return Ok(fallback.to_owned());
    }
    let url = url::Url::parse(&raw).map_err(|_| format!("{name} không phải URL hợp lệ"))?;
    match url.scheme() {
        "http" if !url.host_str().is_some_and(is_loopback_host) => {
            return Err(format!(
                "{name}: http:// chỉ dùng cho máy chủ cục bộ (localhost, 127.0.0.1, ::1) — dùng https://"
            ));
        }
        "http" | "https" => {}
        _ => return Err(format!("{name} chỉ nhận https:// (http:// cho máy chủ cục bộ)")),
    }
    if raw.contains('?') || raw.contains('#') {
        return Err(format!("{name} không được có query hay #"));
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// URL Zalo theo địa chỉ gốc `ZALO_OAUTH_BASE_URL` (permission, token), `ZALO_OPENAPI_BASE_URL` (api), `ZALO_ZNS_BASE_URL`
/// (zns). Chỉ kiểm biến của đúng điểm cuối được gọi.
pub fn zalo_url(endpoint: ZaloEndpoint, env: &Env) -> Result<String, String> {
    Ok(match endpoint {
        ZaloEndpoint::Permission => format!(
            "{}/v4/oa/permission",
            api_base_url("ZALO_OAUTH_BASE_URL", DEFAULT_OAUTH_BASE_URL, env)?
        ),
        ZaloEndpoint::Token => format!(
            "{}/v4/oa/access_token",
            api_base_url("ZALO_OAUTH_BASE_URL", DEFAULT_OAUTH_BASE_URL, env)?
        ),
        ZaloEndpoint::Api => format!(
            "{}/v3.0/oa",
            api_base_url("ZALO_OPENAPI_BASE_URL", DEFAULT_OPENAPI_BASE_URL, env)?
        ),
        ZaloEndpoint::Zns => format!(
            "{}/message/template",
            api_base_url("ZALO_ZNS_BASE_URL", DEFAULT_ZNS_BASE_URL, env)?
        ),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZaloOaConfig {
    pub app_id: Option<String>,
    pub app_secret: Option<String>,
    /// "Khoá bí mật OA" dùng ký webhook (`ZALO_WEBHOOK_SECRET`).
    pub webhook_secret: Option<String>,
    /// URL callback khai trên Zalo.
    pub redirect_uri: Option<String>,
    /// Nơi đưa trình duyệt về sau khi cấp quyền.
    pub post_connect_url: String,
    /// `development` = ZNS chế độ thử (chỉ tới số quản trị đã khai, không tốn quota).
    pub zns_mode: Option<&'static str>,
}

fn clean(env: &Env, k: &str) -> Option<String> {
    env(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

pub fn zalo_oa_config(env: &Env) -> ZaloOaConfig {
    ZaloOaConfig {
        app_id: clean(env, "ZALO_OA_APP_ID"),
        app_secret: clean(env, "ZALO_OA_APP_SECRET"),
        webhook_secret: clean(env, "ZALO_WEBHOOK_SECRET"),
        redirect_uri: clean(env, "ZALO_OA_REDIRECT_URI"),
        post_connect_url: clean(env, "ZALO_OA_POST_CONNECT_URL").unwrap_or_else(|| "/settings".to_owned()),
        zns_mode: (clean(env, "ZALO_ZNS_MODE").as_deref() == Some("development")).then_some("development"),
    }
}

/// Đủ biến để chạy luồng OAuth và gọi API. Webhook cần thêm `webhook_secret`.
pub fn is_zalo_oa_configured(c: &ZaloOaConfig) -> bool {
    c.app_id.is_some() && c.app_secret.is_some() && c.redirect_uri.is_some()
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

/// `0912…` / `+84912…` / `84912…` ⇒ `84912…` (định dạng Zalo/ZNS yêu cầu); không giống SĐT VN ⇒ `None`.
pub fn to_zalo_phone(raw: &str) -> Option<String> {
    let d: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\r' | '.' | '-' | '(' | ')'))
        .collect();
    let d = d.strip_prefix('+').unwrap_or(&d);
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    if digits(d, 10) && d.starts_with('0') {
        return Some(format!("84{}", &d[1..]));
    }
    if digits(d, 11) && d.starts_with("84") {
        return Some(d.to_owned());
    }
    None
}

/// `84912…` ⇒ `0912…` (định dạng lưu trong khách).
pub fn to_local_phone(zalo: &str) -> String {
    match zalo.strip_prefix("84") {
        Some(rest) => format!("0{rest}"),
        None => zalo.to_owned(),
    }
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
    fn sdt_zalo_va_noi_dia() {
        for (raw, want) in [
            ("0912345678", Some("84912345678")),
            ("+84 912-345.678", Some("84912345678")),
            ("(0912) 345 678", Some("84912345678")),
            ("84912345678", Some("84912345678")),
            ("912345678", None),
            ("091234567", None),
            ("0912345678x", None),
            ("1912345678", None),
            ("", None),
        ] {
            assert_eq!(to_zalo_phone(raw).as_deref(), want, "{raw}");
        }
        assert_eq!(to_local_phone("84912345678"), "0912345678");
        assert_eq!(to_local_phone("0912"), "0912");
    }

    #[test]
    fn url_zalo_theo_diem_cuoi() {
        let real = env(&[]);
        assert_eq!(
            zalo_url(ZaloEndpoint::Token, &real).unwrap(),
            "https://oauth.zaloapp.com/v4/oa/access_token"
        );
        assert_eq!(
            zalo_url(ZaloEndpoint::Permission, &real).unwrap(),
            "https://oauth.zaloapp.com/v4/oa/permission"
        );
        assert_eq!(
            zalo_url(ZaloEndpoint::Api, &real).unwrap(),
            "https://openapi.zalo.me/v3.0/oa"
        );
        assert_eq!(
            zalo_url(ZaloEndpoint::Zns, &real).unwrap(),
            "https://business.openapi.zalo.me/message/template"
        );
        let mock = env(&[
            ("ZALO_OAUTH_BASE_URL", "http://127.0.0.1:9/"),
            ("ZALO_ZNS_BASE_URL", "http://localhost:9"),
        ]);
        assert_eq!(
            zalo_url(ZaloEndpoint::Token, &mock).unwrap(),
            "http://127.0.0.1:9/v4/oa/access_token"
        );
        assert_eq!(
            zalo_url(ZaloEndpoint::Zns, &mock).unwrap(),
            "http://localhost:9/message/template"
        );
        // Chỉ kiểm biến của đúng điểm cuối: ZALO_ZNS_BASE_URL sai không làm hỏng điểm cuối token.
        let bad_zns = env(&[("ZALO_ZNS_BASE_URL", "http://graph.example")]);
        assert!(zalo_url(ZaloEndpoint::Token, &bad_zns).is_ok());
        assert!(zalo_url(ZaloEndpoint::Zns, &bad_zns).is_err());
        assert!(zalo_url(ZaloEndpoint::Api, &env(&[("ZALO_OPENAPI_BASE_URL", "https://x/?a=1")])).is_err());
    }

    #[test]
    fn cau_hinh() {
        let c = zalo_oa_config(&env(&[
            ("ZALO_OA_APP_ID", " 1 "),
            ("ZALO_OA_APP_SECRET", "s"),
            ("ZALO_OA_REDIRECT_URI", "https://x/cb"),
            ("ZALO_ZNS_MODE", "development"),
        ]));
        assert!(is_zalo_oa_configured(&c) && c.webhook_secret.is_none() && c.zns_mode == Some("development"));
        assert_eq!(
            (c.app_id.as_deref(), c.post_connect_url.as_str()),
            (Some("1"), "/settings")
        );
        assert!(!is_zalo_oa_configured(&zalo_oa_config(&env(&[(
            "ZALO_OA_APP_ID",
            "1"
        )]))));
        assert!(
            zalo_oa_config(&env(&[("ZALO_ZNS_MODE", "production")]))
                .zns_mode
                .is_none()
        );
    }
}
