//! Phụ thuộc dùng chung của module: dựng một lần ở `serve` rồi chia sẻ qua `Arc`.

use std::sync::Arc;

use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::edge::client_ip::ClientIpResolver;
use trinity_http::outbound::safe_get::SafeGetOptions;
use trinity_http::rate_limit::FixedWindowLimiter;
use trinity_integrations::audit::{self, AuditEntry, AuditStatus, Channel};
use trinity_rbac::PermissionService;

use crate::config::OauthConfig;
use crate::error::{OAuthError, R};

/// Giới hạn trong RAM (một tiến trình). DCR: 10 đăng ký/giờ/IP. Token/revoke: 60 yêu cầu/phút/IP. Màn đồng ý: 30 lần/phút/người dùng.
/// Trần chung theo IP peer khi IP khách KHÔNG tin được: cao hơn nhiều giới hạn từng client, chỉ chống dội hàng loạt.
pub struct Limiters {
    pub register: Arc<FixedWindowLimiter>,
    pub token: Arc<FixedWindowLimiter>,
    pub consent: Arc<FixedWindowLimiter>,
    pub untrusted_peer: Arc<FixedWindowLimiter>,
}

impl Limiters {
    pub fn new() -> Self {
        Self {
            register: FixedWindowLimiter::new(10, 60 * 60 * 1000),
            token: FixedWindowLimiter::new(60, 60 * 1000),
            consent: FixedWindowLimiter::new(30, 60 * 1000),
            untrusted_peer: FixedWindowLimiter::new(600, 60 * 1000),
        }
    }
}

impl Default for Limiters {
    fn default() -> Self {
        Self::new()
    }
}

pub struct OauthCtx {
    pub db: Db,
    pub platform: Platform,
    pub perms: PermissionService,
    pub config: OauthConfig,
    pub ip: Arc<ClientIpResolver>,
    /// Client tải CIMD (SSRF theo `config.policy`). `None` ⇒ không tải được CIMD (client DCR vẫn dùng bình thường).
    pub safe_get: Option<SafeGetOptions>,
    pub limits: Limiters,
}

impl OauthCtx {
    pub async fn conn(&self, company: CompanyRef) -> R<TenantConn> {
        let t = self
            .db
            .tenant(company)
            .await
            .map_err(|e| OAuthError::internal("tenant", e))?;
        t.acquire().await.map_err(|e| OAuthError::internal("acquire", e))
    }

    pub fn random(&self, bytes: usize) -> R<String> {
        crate::crypto::random_token(bytes).map_err(|e| OAuthError::internal("ngẫu nhiên", e))
    }

    /// URL gốc; chưa cấu hình ⇒ 503 (route đã chặn bằng cờ `enabled` nên hiếm khi tới đây).
    pub fn base(&self) -> R<&str> {
        self.config
            .base
            .as_deref()
            .ok_or_else(|| OAuthError::with_status("server_error", "Chưa cấu hình INTEGRATIONS_PUBLIC_BASE_URL", 503))
    }

    /// Công ty mà bí mật (mã, token) tự nhận thuộc về, nếu còn hoạt động (`enterTokenCompany`): công ty lạ hoặc bị treo
    /// ⇒ `None`. Bản một công ty chỉ có công ty 1.
    pub async fn token_company(&self, raw: &str) -> Option<CompanyRef> {
        let id = crate::company_id_of_token(raw);
        if !self.platform.multi_tenant() {
            return (id == 1).then_some(CompanyRef::DEFAULT);
        }
        self.platform.active_company(id).await.ok().flatten()
    }

    /// Nhật ký tích hợp kênh `mcp`; không bao giờ làm hỏng luồng chính.
    pub async fn audit(&self, company: CompanyRef, mut e: AuditEntry) {
        e.channel = Channel::Mcp;
        if let Ok(mut c) = self.conn(company).await {
            audit::log(&mut c, &e).await;
        }
    }

    pub fn entry(
        action: &str,
        status: AuditStatus,
        client_id: &str,
        user_id: Option<i32>,
        metadata: serde_json::Value,
    ) -> AuditEntry {
        let mut e = AuditEntry::new(Channel::Mcp, action, status);
        e.client_id = Some(client_id.to_owned());
        e.user_id = user_id;
        e.metadata = Some(metadata);
        e
    }
}
