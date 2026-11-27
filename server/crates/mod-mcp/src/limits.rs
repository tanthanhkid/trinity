//! Ba giới hạn tốc độ của MCP (`mcp-rate-limiter.ts`, cửa sổ cố định 1 phút trong RAM của tiến trình, không chia sẻ với Node: I3):
//! 240 request/phút/người, 60 lời gọi tool/phút/người (theo NGƯỜI, không theo IP: ChatGPT/Claude gọi từ dải IP chung), 30 lần xác
//! thực sai/phút theo IP.

use std::sync::Arc;

use trinity_http::edge::client_ip::ClientIp;
use trinity_http::rate_limit::{FixedWindowLimiter, Hit, now_ms};

pub const MCP_CALLS_PER_MINUTE: u32 = 60;
pub const MCP_REQUESTS_PER_MINUTE: u32 = 240;
pub const MCP_AUTH_FAIL_PER_MINUTE: u32 = 30;
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
    untrusted_peer: Arc<FixedWindowLimiter>,
}

impl Default for McpLimits {
    fn default() -> Self {
        Self::new()
    }
}

impl McpLimits {
    pub fn new() -> Self {
        Self {
            requests: FixedWindowLimiter::new(MCP_REQUESTS_PER_MINUTE, 60_000),
            calls: FixedWindowLimiter::new(MCP_CALLS_PER_MINUTE, 60_000),
            auth_fail: FixedWindowLimiter::new(MCP_AUTH_FAIL_PER_MINUTE, 60_000),
            untrusted_peer: FixedWindowLimiter::new(UNTRUSTED_PEER_PER_MINUTE, 60_000),
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
        self.auth_fail
            .hit(&format!("mcp-auth:{}:{own}", ip.rate_key), now)
            .into()
    }
}
