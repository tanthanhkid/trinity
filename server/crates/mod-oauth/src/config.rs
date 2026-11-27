//! Hằng số, scope và cấu hình đọc từ env (`oauth-config.ts`). URL gốc KHÔNG BAO GIỜ suy từ header `Host`: issuer/`resource`
//! mà suy từ header client gửi được thì metadata bị đầu độc (mix-up).

use trinity_http::outbound::ssrf::SsrfPolicy;
use trinity_integrations::status;
use url::Url;

/// Scope MCP. `crm.write` cho AI GHI dữ liệu ngay, trong đúng quyền của người dùng.
pub const OAUTH_SCOPES: [&str; 2] = ["crm.read", "crm.write"];
/// Giá trị quảng bá ở AS metadata. `offline_access` chỉ để client xin refresh token; ta luôn cấp refresh, không lưu scope này.
pub const ADVERTISED_SCOPES: [&str; 3] = ["crm.read", "crm.write", "offline_access"];
pub const DEFAULT_SCOPES: [&str; 1] = ["crm.read"];

pub const CODE_TTL_MS: i64 = 60_000;
pub const ACCESS_TTL_SEC: i64 = 60 * 60;
pub const REFRESH_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const CONSENT_TTL_SEC: i64 = 10 * 60;

/// Nhãn tiếng Việt cho màn đồng ý.
pub struct ScopeLabel {
    pub label: &'static str,
    pub description: &'static str,
    pub available: bool,
    pub optional: bool,
}

pub fn scope_label(scope: &str) -> Option<ScopeLabel> {
    match scope {
        "crm.read" => Some(ScopeLabel {
            label: "Đọc dữ liệu CRM",
            description: "Xem khách hàng, deal, lịch sử chăm sóc, công việc và báo cáo tổng quan trong ĐÚNG phạm vi quyền của bạn. Số điện thoại luôn bị che.",
            available: true,
            optional: false,
        }),
        "crm.write" => Some(ScopeLabel {
            label: "Cho phép AI thay đổi dữ liệu (trong phạm vi quyền của bạn)",
            description: "Cho phép ứng dụng GHI dữ liệu trực tiếp: tạo khách hàng, thêm ghi chú, đổi giai đoạn, tạo công việc, chuyển người phụ trách, tạo/sửa bản ghi của bảng tuỳ biến, nhập dữ liệu hàng loạt. Thay đổi có hiệu lực NGAY, theo đúng quyền và phạm vi dữ liệu của bạn — AI không làm được gì bạn không làm được. Mọi thao tác được ghi lại ở mục Hoạt động AI. Bỏ chọn quyền này nếu chỉ muốn AI đọc dữ liệu.",
            available: true,
            optional: true,
        }),
        _ => None,
    }
}

/// Cấu hình đọc một lần lúc dựng module.
#[derive(Debug, Clone)]
pub struct OauthConfig {
    /// Cờ MCP + URL gốc: thiếu một trong hai thì mọi route OAuth trả 404.
    pub enabled: bool,
    /// URL gốc công khai đã kiểm (`INTEGRATIONS_PUBLIC_BASE_URL`).
    pub base: Option<String>,
    /// `JWT_SECRET` (không cắt khoảng trắng, như TS): khoá dẫn xuất ký token consent.
    pub jwt_secret: Option<String>,
    /// `INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS`: rỗng = mọi tên miền.
    pub cimd_hosts: Vec<String>,
    /// Chính sách SSRF (`INTEGRATIONS_ALLOW_PRIVATE_TARGETS` chỉ có tác dụng khi `NODE_ENV` là test/development).
    pub policy: SsrfPolicy,
}

impl OauthConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let cimd_hosts = get("INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        Self {
            enabled: status::oauth_enabled(&get),
            base: status::public_base_url(&get),
            jwt_secret: get("JWT_SECRET").filter(|s| !s.is_empty()),
            cimd_hosts,
            policy: SsrfPolicy::from_env(&get),
        }
    }

    pub fn from_process_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }
}

pub fn issuer_url(base: &str) -> String {
    format!("{base}/api/v1/oauth")
}
pub fn mcp_resource_url(base: &str) -> String {
    status::mcp_resource_url(base)
}
pub fn authorization_endpoint(base: &str) -> String {
    format!("{base}/oauth/authorize")
}

/// So khớp `resource` (RFC 8707) với URL MCP chuẩn tắc: bỏ `/` cuối; scheme và host không phân biệt hoa/thường.
pub fn is_canonical_resource(candidate: &str, base: &str) -> bool {
    let Ok(u) = Url::parse(candidate) else { return false };
    // JS: `u.hash`/`u.search` rỗng khi chỉ có `#`/`?` trơ, nên chỉ phần không rỗng mới bị từ chối.
    if u.fragment().is_some_and(|f| !f.is_empty())
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some_and(|q| !q.is_empty())
    {
        return false;
    }
    let norm = format!("{}{}", u.origin().ascii_serialization(), u.path().trim_end_matches('/'));
    norm == mcp_resource_url(base)
}
