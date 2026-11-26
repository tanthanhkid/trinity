//! Cờ máy chủ của các kênh tích hợp (`GET /integrations/status`). Đọc từ một hàm tra env để test được.

use serde_json::{Value, json};
use url::Url;

fn on(v: Option<String>) -> bool {
    v.is_some_and(|v| matches!(v.trim().to_lowercase().as_str(), "true" | "1"))
}

pub fn webhooks_enabled(env: &impl Fn(&str) -> Option<String>) -> bool {
    on(env("INTEGRATIONS_WEBHOOKS_ENABLED"))
}

pub fn mcp_enabled(env: &impl Fn(&str) -> Option<String>) -> bool {
    on(env("INTEGRATIONS_MCP_ENABLED"))
}

/// Có ít nhất một kênh bật: điều kiện mở route nhật ký và chạy job dọn outbox.
pub fn any_enabled(env: &impl Fn(&str) -> Option<String>) -> bool {
    webhooks_enabled(env) || mcp_enabled(env)
}

/// `INTEGRATIONS_SECRET_KEY` hợp lệ: base64 (chuẩn hoặc url-safe, đệm `=` tuỳ chọn) giải ra đúng 32 byte.
pub fn secret_key_configured(env: &impl Fn(&str) -> Option<String>) -> bool {
    let Some(raw) = env("INTEGRATIONS_SECRET_KEY") else {
        return false;
    };
    let raw = raw.trim();
    if raw.is_empty()
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'-' | b'='))
    {
        return false;
    }
    // Node `Buffer.from(raw, 'base64')` bỏ ký tự thừa và nhận cả hai bảng chữ; độ dài giải mã = floor(n*6/8) trên phần
    // trước dấu `=`. Chỉ nhận `=` ở cuối.
    let body = raw.trim_end_matches('=');
    if body.contains('=') {
        return false;
    }
    body.len() * 6 / 8 == 32
}

/// URL gốc công khai (`INTEGRATIONS_PUBLIC_BASE_URL`): https, hoặc http tới loopback khi `NODE_ENV` là test/development;
/// không userinfo, path, query, fragment. KHÔNG suy từ header `Host`.
pub fn public_base_url(env: &impl Fn(&str) -> Option<String>) -> Option<String> {
    let raw = env("INTEGRATIONS_PUBLIC_BASE_URL")?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let u = Url::parse(raw).ok()?;
    let loopback = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let dev = matches!(env("NODE_ENV").as_deref(), Some("test" | "development"));
    if u.scheme() != "https" && !(dev && u.scheme() == "http" && loopback) {
        return None;
    }
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !matches!(u.path(), "/" | "")
    {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

pub fn mcp_resource_url(base: &str) -> String {
    format!("{base}/api/v1/mcp")
}

/// Cờ MCP + URL gốc: thiếu một trong hai thì OAuth/MCP trả 404.
pub fn oauth_enabled(env: &impl Fn(&str) -> Option<String>) -> bool {
    mcp_enabled(env) && public_base_url(env).is_some()
}

/// Thân của `GET /integrations/status`.
pub fn status(env: &impl Fn(&str) -> Option<String>) -> Value {
    let base = public_base_url(env);
    json!({
        "webhooks_enabled": webhooks_enabled(env),
        "mcp_enabled": mcp_enabled(env),
        "secret_key_configured": secret_key_configured(env),
        "mcp_base_url_configured": base.is_some(),
        "mcp_url": if oauth_enabled(env) { base.as_deref().map(mcp_resource_url) } else { None },
    })
}
