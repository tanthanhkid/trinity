//! Ba giới hạn tốc độ của MCP (`mcp-rate-limiter.ts`, cửa sổ cố định 1 phút trong RAM của tiến trình, không chia sẻ với Node: I3):
//! 240 request/phút/người, 60 lời gọi tool/phút/người (theo NGƯỜI, không theo IP: ChatGPT/Claude gọi từ dải IP chung), 30 lần xác
//! thực sai/phút theo IP.

use std::sync::Arc;

use sha2::{Digest, Sha256};

use trinity_http::edge::client_ip::ClientIp;
use trinity_http::rate_limit::{FixedWindowLimiter, Hit, now_ms};

pub const MCP_CALLS_PER_MINUTE: u32 = 60;
pub const MCP_REQUESTS_PER_MINUTE: u32 = 240;
pub const MCP_AUTH_FAIL_PER_MINUTE: u32 = 30;
/// Ghi thẳng (chế độ mặc định): trần theo NGƯỜI DÙNG và theo ỨNG DỤNG AI mỗi phút; tạo đề xuất chờ duyệt: theo người dùng.
pub const WRITES_PER_MINUTE: u32 = 30;
pub const WRITES_PER_CLIENT_PER_MINUTE: u32 = 20;
pub const DRAFTS_PER_MINUTE: u32 = 10;
/// Trần chung theo IP peer khi IP khách KHÔNG tin được (mọi khách chung một peer).
const UNTRUSTED_PEER_PER_MINUTE: u32 = 600;

/// Kết quả một lần đếm: `retry_after_sec` luôn ≥ 1 khi bị chặn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limit {
    pub allowed: bool,
    pub retry_after_sec: u64,
}

impl From<Hit> for Limit {
    fn from(h: Hit) -> Self {
        Self {
            allowed: h.allowed,
            retry_after_sec: h.retry_after_sec.max(1),
        }
    }
}

pub struct McpLimits {
    requests: Arc<FixedWindowLimiter>,
    calls: Arc<FixedWindowLimiter>,
    auth_fail: Arc<FixedWindowLimiter>,
    writes: Arc<FixedWindowLimiter>,
    client_writes: Arc<FixedWindowLimiter>,
    drafts: Arc<FixedWindowLimiter>,
    untrusted_peer: Arc<FixedWindowLimiter>,
}

impl Default for McpLimits {
    fn default() -> Self {
        Self::new()
    }
}

impl McpLimits {
    pub fn new() -> Self {
        Self::with_untrusted_peer(FixedWindowLimiter::new(UNTRUSTED_PEER_PER_MINUTE, 60_000))
    }

    /// Dùng CHUNG trần theo IP peer của OAuth (`OauthCtx.limits.untrusted_peer`): dội OAuth rồi MCP từ cùng một peer không tin
    /// được thì dùng chung một xô, không có hai xô để lách.
    pub fn with_untrusted_peer(untrusted_peer: Arc<FixedWindowLimiter>) -> Self {
        Self {
            requests: FixedWindowLimiter::new(MCP_REQUESTS_PER_MINUTE, 60_000),
            calls: FixedWindowLimiter::new(MCP_CALLS_PER_MINUTE, 60_000),
            auth_fail: FixedWindowLimiter::new(MCP_AUTH_FAIL_PER_MINUTE, 60_000),
            writes: FixedWindowLimiter::new(WRITES_PER_MINUTE, 60_000),
            client_writes: FixedWindowLimiter::new(WRITES_PER_CLIENT_PER_MINUTE, 60_000),
            drafts: FixedWindowLimiter::new(DRAFTS_PER_MINUTE, 60_000),
            untrusted_peer,
        }
    }

    /// Mã người dùng lặp giữa các công ty: khoá có kèm công ty.
    pub fn request(&self, company_id: i32, user_id: i32) -> Limit {
        self.requests
            .hit_company(company_id, &format!("req:{user_id}"), now_ms())
            .into()
    }

    pub fn call(&self, company_id: i32, user_id: i32) -> Limit {
        self.calls
            .hit_company(company_id, &format!("call:{user_id}"), now_ms())
            .into()
    }

    /// Ghi thẳng theo người dùng (`WRITES_PER_MINUTE`).
    pub fn write(&self, company_id: i32, user_id: i32) -> Limit {
        self.writes
            .hit_company(company_id, &format!("write:{user_id}"), now_ms())
            .into()
    }

    /// Ghi thẳng theo ỨNG DỤNG AI (client OAuth) của người dùng (`WRITES_PER_CLIENT_PER_MINUTE`).
    pub fn write_app(&self, company_id: i32, user_id: i32, client_id: &str) -> Limit {
        self.client_writes
            .hit_company(company_id, &format!("write_app:{client_id}:{user_id}"), now_ms())
            .into()
    }

    /// Tạo đề xuất chờ duyệt theo người dùng (`DRAFTS_PER_MINUTE`).
    pub fn draft(&self, company_id: i32, user_id: i32) -> Limit {
        self.drafts
            .hit_company(company_id, &format!("draft:{user_id}"), now_ms())
            .into()
    }

    /// Chỉ chặn brute-force token rác theo IP. IP không tin được ⇒ kiểm CẢ trần chung theo peer VÀ khoá riêng của client
    /// (`own`, vd header `Authorization`): đổi `own` không lách được trần peer, một client không làm nghẽn client khác.
    pub fn auth_failure(&self, ip: &ClientIp, own: Option<&str>) -> Limit {
        let now = now_ms();
        if let Some(addr) = ip.ip {
            return self.auth_fail.hit(&format!("mcp-auth:{addr}"), now).into();
        }
        let peer = self.untrusted_peer.hit(&format!("mcp-auth:{}", ip.rate_key), now);
        if !peer.allowed {
            return peer.into();
        }
        let units: Vec<u16> = own.unwrap_or("").trim().encode_utf16().take(200).collect();
        let own = String::from_utf16_lossy(&units);
        // Băm sha256[..24] như `hit_by_client` của OAuth: khoá không chứa token thô và có độ dài cố định.
        let short: String = Sha256::digest(own.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            .chars()
            .take(24)
            .collect();
        self.auth_fail
            .hit(&format!("mcp-auth:u:{}:{short}", ip.rate_key), now)
            .into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinity_http::edge::client_ip::Source;

    fn untrusted(peer: &str) -> ClientIp {
        ClientIp {
            ip: None,
            rate_key: peer.into(),
            untrusted_reason: Some("thử".into()),
            source: Source::Edge,
        }
    }

    #[test]
    fn tran_peer_dung_chung_voi_ben_ngoai_va_khoa_bam() {
        let shared = FixedWindowLimiter::new(3, 60_000);
        let l = McpLimits::with_untrusted_peer(shared.clone());
        let ip = untrusted("peer-1");
        // Mỗi token khác nhau có xô riêng, nhưng cùng chung trần peer (3 lần).
        assert!(l.auth_failure(&ip, Some("Bearer a")).allowed);
        assert!(l.auth_failure(&ip, Some("Bearer b")).allowed);
        assert!(l.auth_failure(&ip, Some("Bearer c")).allowed);
        assert!(!l.auth_failure(&ip, Some("Bearer d")).allowed);
        // Bên ngoài (OAuth) dùng cùng limiter: peer khác thì không ảnh hưởng, cùng peer thì đã chạm trần.
        assert!(!shared.hit("mcp-auth:peer-1", now_ms()).allowed);
        assert!(l.auth_failure(&untrusted("peer-2"), Some("Bearer a")).allowed);
    }
}
