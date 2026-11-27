//! Điểm vào HTTP của MCP (`mcp.controller.ts`), độc lập khung web: nhận [`HttpIn`] trả [`HttpOut`]. Thứ tự kiểm: cờ → `Origin`
//! (danh sách cho phép, chống DNS rebinding) → xác thực → 240 request/phút/người → thân là MỘT thông điệp JSON-RPC (không batch) →
//! vận chuyển ([`crate::protocol`]). `GET`/`DELETE` ⇒ 405 (không phiên, không luồng SSE).

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Value, json};
use trinity_http::edge::client_ip::ClientIp;
use trinity_integrations::audit::{AuditEntry, AuditStatus, Channel};

use crate::auth::{AuthError, AuthFailure, Identity, ascii_header};
use crate::exec::{AuditSink, Executor};
use crate::frozen::Frozen;
use crate::limits::McpLimits;
use crate::protocol::{self, Req, transport_error};

/// Scope xin trong `WWW-Authenticate`: CẢ `crm.write` (Claude chỉ xin đúng scope ghi ở đây; người dùng vẫn bỏ được ở màn đồng ý).
pub const CHALLENGE_SCOPES: &str = "crm.read crm.write";

#[derive(Debug, Clone)]
pub struct HttpIn {
    /// `GET`, `POST`, `DELETE`… (chữ hoa).
    pub method: String,
    pub origin: Option<String>,
    pub authorization: Option<String>,
    pub accept: Option<String>,
    pub content_type: Option<String>,
    pub protocol_version: Option<String>,
    pub body: Vec<u8>,
    pub client: ClientIp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpOut {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    /// Rỗng (202) hoặc JSON.
    pub body: Vec<u8>,
}

impl HttpOut {
    fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type", "application/json; charset=utf-8".to_owned())],
            body: body.as_bytes().to_vec(),
        }
    }

    fn with(mut self, k: &'static str, v: impl Into<String>) -> Self {
        self.headers.push((k, v.into()));
        self
    }
}

/// Cấu hình đọc một lần lúc dựng.
#[derive(Debug, Clone)]
pub struct McpConfig {
    /// `INTEGRATIONS_MCP_ENABLED` + URL gốc hợp lệ: thiếu một thì mọi route MCP 404.
    pub enabled: bool,
    /// URL gốc công khai (không bao giờ suy từ header `Host`).
    pub base: Option<String>,
    /// Origin trình duyệt được phép.
    pub allowed_origins: BTreeSet<String>,
}

impl McpConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let base = trinity_integrations::status::public_base_url(&get);
        let enabled = trinity_integrations::status::oauth_enabled(&get);
        Self {
            enabled,
            allowed_origins: allowed_origins(&get, base.as_deref()),
            base,
        }
    }

    pub fn from_process_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }
}

/// Origin trình duyệt được phép (`allowedOrigins`): URL gốc, ChatGPT, Claude, cộng `INTEGRATIONS_MCP_ALLOWED_ORIGINS`. Client máy
/// chủ (ChatGPT/Claude) không gửi `Origin`.
pub fn allowed_origins(get: &impl Fn(&str) -> Option<String>, base: Option<&str>) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = base.into_iter().map(str::to_owned).collect();
    set.extend(["https://chatgpt.com", "https://chat.openai.com", "https://claude.ai"].map(str::to_owned));
    for o in get("INTEGRATIONS_MCP_ALLOWED_ORIGINS").unwrap_or_default().split(',') {
        let o = o.trim().trim_end_matches('/');
        if !o.is_empty() {
            set.insert(o.to_owned());
        }
    }
    set
}

pub struct McpEndpoint {
    pub config: McpConfig,
    pub frozen: Arc<Frozen>,
    pub identity: Arc<dyn Identity>,
    pub limits: Arc<McpLimits>,
    pub exec: Executor,
    pub audit: Arc<dyn AuditSink>,
}

fn not_found() -> HttpOut {
    HttpOut::json(404, "{\"statusCode\":404,\"message\":\"Not Found\"}")
}

impl McpEndpoint {
    pub async fn handle(&self, req: HttpIn) -> HttpOut {
        match req.method.as_str() {
            "POST" => self.post(req).await,
            _ => {
                let out = if self.config.enabled {
                    let e = transport_error(405, -32000, "Method not allowed");
                    HttpOut::json(405, e.body.as_deref().unwrap_or(""))
                } else {
                    not_found()
                };
                out.with("allow", "POST")
            }
        }
    }

    /// 401/403 theo RFC 6750 + RFC 9728: `resource_metadata` để client tự khám phá AS.
    fn challenge(&self, err: &AuthError) -> HttpOut {
        let base = self.config.base.as_deref().unwrap_or("");
        let mut parts: Vec<String> = Vec::new();
        if err.kind != AuthFailure::Missing {
            parts.push(format!("error=\"{}\"", err.kind.as_str()));
            parts.push(format!("error_description=\"{}\"", ascii_header(&err.description)));
        }
        parts.push(format!("resource_metadata=\"{base}/api/v1/oauth/protected-resource\""));
        parts.push(format!("scope=\"{CHALLENGE_SCOPES}\""));
        let status = if err.kind == AuthFailure::InsufficientScope {
            403
        } else {
            401
        };
        let error = if err.kind == AuthFailure::Missing {
            "unauthorized"
        } else {
            err.kind.as_str()
        };
        let body = json!({ "error": error, "error_description": err.description });
        HttpOut::json(status, &body.to_string())
            .with("www-authenticate", format!("Bearer {}", parts.join(", ")))
            .with("cache-control", "no-store")
    }

    async fn post(&self, req: HttpIn) -> HttpOut {
        if !self.config.enabled {
            return not_found();
        }
        if let Some(o) = &req.origin
            && !self.config.allowed_origins.contains(o.trim_end_matches('/'))
        {
            let e = transport_error(403, -32000, "Origin không được phép");
            return HttpOut::json(403, e.body.as_deref().unwrap_or(""));
        }
        let principal = match self.identity.authenticate(req.authorization.as_deref()).await {
            Ok(p) => p,
            Err(err) => {
                if !self
                    .limits
                    .auth_failure(&req.client, req.authorization.as_deref())
                    .allowed
                {
                    return HttpOut::json(
                        429,
                        "{\"error\":\"rate_limited\",\"error_description\":\"Quá nhiều yêu cầu xác thực sai\"}",
                    )
                    .with("retry-after", "60");
                }
                if let Some(w) = &err.who {
                    let mut e = AuditEntry::new(Channel::Mcp, "auth", AuditStatus::Denied);
                    e.client_id = Some(w.client_id.clone());
                    e.user_id = Some(w.user_id);
                    e.error = Some(err.kind.as_str().to_owned());
                    self.audit.log(w.company, e).await;
                }
                return self.challenge(&err);
            }
        };
        let hit = self.limits.request(principal.company.id(), principal.user_id);
        if !hit.allowed {
            let e = transport_error(429, -32000, "Quá giới hạn yêu cầu");
            return HttpOut::json(429, e.body.as_deref().unwrap_or(""))
                .with("retry-after", hit.retry_after_sec.to_string());
        }
        // Thân phải là MỘT thông điệp JSON-RPC (đối tượng): mảng (batch), rỗng, `null`, chuỗi… ⇒ 400. JSON hỏng để vận chuyển báo.
        let shape_bad = match serde_json::from_slice::<Value>(&req.body) {
            Ok(v) => !v.is_object(),
            Err(_) => req.body.iter().all(u8::is_ascii_whitespace),
        };
        if shape_bad {
            let e = transport_error(400, -32600, "Body phải là 1 thông điệp JSON-RPC (không hỗ trợ batch)");
            return HttpOut::json(400, e.body.as_deref().unwrap_or(""));
        }
        let host = self.exec.bind(&principal);
        let reply = protocol::handle(
            &self.frozen,
            &host,
            &Req {
                accept: req.accept.as_deref(),
                content_type: req.content_type.as_deref(),
                protocol_version: req.protocol_version.as_deref(),
                body: &req.body,
            },
        )
        .await;
        match reply.body {
            Some(b) => HttpOut {
                status: reply.status,
                headers: vec![("content-type", "application/json".to_owned())],
                body: b.into_bytes(),
            },
            None => HttpOut {
                status: reply.status,
                headers: Vec::new(),
                body: Vec::new(),
            },
        }
    }
}
