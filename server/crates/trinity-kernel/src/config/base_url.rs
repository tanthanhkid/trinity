//! Địa chỉ gốc của Graph API và Zalo đọc từ env — bản Rust của `apiBaseUrl()`
//! (`services/crm/src/common/helpers/api-base-url.ts`, G15), giữ nguyên luật và câu báo lỗi.
//!
//! Khác bản Node một chỗ: bản Node kiểm lúc gọi API (giá trị sai làm lời gọi đó lỗi), bản Rust kiểm một lần lúc khởi
//! động và không khởi động khi giá trị sai.

use url::{Host, Url};

use super::{EnvMap, get};

/// Địa chỉ gốc đã kiểm, không có `/` cuối.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalApis {
    /// Graph API (`FACEBOOK_GRAPH_BASE_URL`, mặc định `https://graph.facebook.com`).
    pub graph: String,
    /// Graph API cho tải video: mặc định `https://graph-video.facebook.com`; đặt `FACEBOOK_GRAPH_BASE_URL` thì dùng
    /// chung địa chỉ đó.
    pub graph_video: String,
    /// `ZALO_OAUTH_BASE_URL`, mặc định `https://oauth.zaloapp.com`.
    pub zalo_oauth: String,
    /// `ZALO_OPENAPI_BASE_URL`, mặc định `https://openapi.zalo.me`.
    pub zalo_openapi: String,
    /// `ZALO_ZNS_BASE_URL`, mặc định `https://business.openapi.zalo.me`.
    pub zalo_zns: String,
}

const GRAPH: &str = "https://graph.facebook.com";
const GRAPH_VIDEO: &str = "https://graph-video.facebook.com";
const ZALO_OAUTH: &str = "https://oauth.zaloapp.com";
const ZALO_OPENAPI: &str = "https://openapi.zalo.me";
const ZALO_ZNS: &str = "https://business.openapi.zalo.me";

impl Default for ExternalApis {
    fn default() -> Self {
        Self {
            graph: GRAPH.to_owned(),
            graph_video: GRAPH_VIDEO.to_owned(),
            zalo_oauth: ZALO_OAUTH.to_owned(),
            zalo_openapi: ZALO_OPENAPI.to_owned(),
            zalo_zns: ZALO_ZNS.to_owned(),
        }
    }
}

impl ExternalApis {
    /// Đọc 4 biến; trả mọi lỗi cùng lúc.
    pub fn from_env(env: &EnvMap) -> Result<Self, Vec<String>> {
        let mut errs = Vec::new();
        let mut one = |name: &str, fallback: &str| {
            api_base_url(name, fallback, env).unwrap_or_else(|e| {
                errs.push(e);
                fallback.to_owned()
            })
        };
        let graph_set = get(env, "FACEBOOK_GRAPH_BASE_URL").is_some();
        let graph = one("FACEBOOK_GRAPH_BASE_URL", GRAPH);
        let out = Self {
            graph_video: if graph_set {
                graph.clone()
            } else {
                GRAPH_VIDEO.to_owned()
            },
            graph,
            zalo_oauth: one("ZALO_OAUTH_BASE_URL", ZALO_OAUTH),
            zalo_openapi: one("ZALO_OPENAPI_BASE_URL", ZALO_OPENAPI),
            zalo_zns: one("ZALO_ZNS_BASE_URL", ZALO_ZNS),
        };
        if errs.is_empty() { Ok(out) } else { Err(errs) }
    }
}

/// Không đặt (hoặc rỗng) ⇒ `fallback`. `http://` chỉ nhận host loopback, bất kể `NODE_ENV`; không nhận query hay `#`;
/// bỏ `/` cuối.
pub fn api_base_url(name: &str, fallback: &str, env: &EnvMap) -> Result<String, String> {
    let Some(raw) = get(env, name) else {
        return Ok(fallback.to_owned());
    };
    let url = Url::parse(raw).map_err(|_| format!("{name} không phải URL hợp lệ"))?;
    match url.scheme() {
        "http" => {
            if !url.host().is_some_and(|h| is_loopback(&h)) {
                return Err(format!(
                    "{name}: http:// chỉ dùng cho máy chủ cục bộ (localhost, 127.0.0.1, ::1) — dùng https://"
                ));
            }
        }
        "https" => {}
        _ => return Err(format!("{name} chỉ nhận https:// (http:// cho máy chủ cục bộ)")),
    }
    // `new URL('https://x/?')` của Node cho `search` rỗng; chỉ query/fragment có nội dung mới bị từ chối.
    if url.query().is_some_and(|q| !q.is_empty()) || url.fragment().is_some_and(|f| !f.is_empty()) {
        return Err(format!("{name} không được có query hay #"));
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

fn is_loopback(h: &Host<&str>) -> bool {
    match h {
        Host::Domain(d) => is_loopback_host(d),
        Host::Ipv4(ip) => ip.octets()[0] == 127,
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// `localhost`, `127.x.x.x`, `::1` (có hoặc không ngoặc vuông), không phân biệt hoa thường.
pub fn is_loopback_host(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h == "::1" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts[1..]
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}
