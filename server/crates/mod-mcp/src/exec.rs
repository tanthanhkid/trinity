//! Thực thi một lời gọi tool (`McpServerService.execute`): giới hạn 60 lời gọi/phút/người → scope `crm.write` → quyền của tool → chạy →
//! ánh xạ lỗi sang `isError` với câu song ngữ, cắt kết quả 40.000 đơn vị UTF-16, ghi nhật ký mỗi lời gọi (`integration_audit_logs`,
//! kênh `mcp`, `args` đã che SĐT).
//!
//! Tool cụ thể (M40–M42, `mod-mcp` các nhóm) đăng ký [`ToolSpec`] vào [`ToolRegistry`]; `tools/list` vẫn lấy từ hợp đồng đóng băng,
//! nên tool trong hợp đồng chưa đăng ký chạy được báo "chưa chuyển" thay vì biến mất khỏi danh sách.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use trinity_db::{CompanyRef, Db};
use trinity_integrations::audit::{self, AuditEntry, AuditStatus, Channel};
use trinity_rbac::can;

use crate::ai_output::{sanitize_for_ai, slice16};
use crate::auth::Principal;
use crate::limits::{MCP_CALLS_PER_MINUTE, McpLimits};
use crate::protocol::{BoxFuture, CallResult, ToolHost};

/// Trần độ dài văn bản trả về (đơn vị UTF-16 như `.slice()` của JS).
pub const MAX_TEXT: usize = 40_000;

/// Lỗi của tool; mỗi biến ứng với một nhánh của `failure()` bản TS.
#[derive(Debug)]
pub enum ToolError {
    /// `ToolUserError`: đối số/điều kiện người dùng sai, câu thông báo trả nguyên.
    User(String),
    /// `NotFoundException`: không có hoặc ngoài phạm vi quyền.
    NotFound,
    /// `ForbiddenToolError`/`ForbiddenException`: câu thông báo trả nguyên.
    Forbidden(String),
    /// `HttpException` khác (<500 ⇒ "Yêu cầu không hợp lệ: …"; 403 ⇒ từ chối chung; ≥500 ⇒ lỗi hệ thống).
    Http { status: u16, message: String },
    /// `Error` thường: nếu câu bắt đầu bằng `query`/`id`/`contact_id` hoặc chứa `SĐT`/`Không hỗ trợ` thì là lỗi đối số.
    Plain(String),
    /// Lỗi hệ thống (log, trả câu chung).
    Internal(String),
}

pub struct ToolOutput {
    /// Văn bản trả cho model; vắng thì dùng JSON của `structured`.
    pub text: Option<String>,
    pub structured: Value,
}

pub struct ToolCtx<'a> {
    pub principal: &'a Principal,
    pub base_url: &'a str,
}

pub trait ToolRunner: Send + Sync {
    fn run<'a>(&'a self, args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;
}

/// Đăng ký một tool: `scope` (`crm.write` cho tool ghi) và `permissions` (mọi quyền đều phải có).
pub struct ToolSpec {
    pub name: &'static str,
    pub scope: Option<&'static str>,
    pub permissions: &'static [&'static str],
    pub runner: Arc<dyn ToolRunner>,
}

#[derive(Default)]
pub struct ToolRegistry {
    map: HashMap<&'static str, ToolSpec>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, spec: ToolSpec) {
        self.map.insert(spec.name, spec);
    }

    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.map.get(name)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Nơi ghi nhật ký (trừu tượng để test không cần DB). Không bao giờ làm hỏng luồng chính.
pub trait AuditSink: Send + Sync {
    fn log<'a>(&'a self, company: CompanyRef, entry: AuditEntry) -> BoxFuture<'a, ()>;
}

/// Ghi vào `integration_audit_logs` của công ty.
pub struct DbAudit {
    pub db: Db,
}

impl AuditSink for DbAudit {
    fn log<'a>(&'a self, company: CompanyRef, entry: AuditEntry) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let Ok(t) = self.db.tenant(company).await else { return };
            let Ok(mut c) = t.acquire().await else { return };
            audit::log(&mut c, &entry).await;
        })
    }
}

/// Đối tượng bị tác động ghi vào nhật ký: `id` (kiểu cũ/bản ghi) hoặc `action_id` (`get_action_status`).
pub fn audit_target(args: &Value) -> (Option<String>, Option<String>) {
    let id = args.get("id");
    let action_id = args.get("action_id");
    if let Some(Value::String(s)) = id {
        return (Some(s.split(':').next().unwrap_or("").to_owned()), Some(s.clone()));
    }
    if let Some(Value::Number(n)) = action_id {
        return (Some("ai_action_draft".to_owned()), Some(n.to_string()));
    }
    if let Some(Value::Number(n)) = id {
        return (None, Some(n.to_string()));
    }
    (None, None)
}

/// Lỗi `Error` thường mang nội dung đối số: `/^(query|id|contact_id)\b|SĐT|Không hỗ trợ/`.
fn is_plain_argument_error(m: &str) -> bool {
    let starts = ["query", "id", "contact_id"].iter().any(|w| {
        m.strip_prefix(w)
            .is_some_and(|rest| !rest.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_'))
    });
    starts || m.contains("SĐT") || m.contains("Không hỗ trợ")
}

pub struct Executor {
    pub registry: ToolRegistry,
    pub limits: Arc<McpLimits>,
    pub audit: Arc<dyn AuditSink>,
    /// URL gốc công khai (cho tool dựng link).
    pub base_url: String,
}

impl Executor {
    /// Gắn người gọi để dùng như [`ToolHost`].
    pub fn bind<'a>(&'a self, principal: &'a Principal) -> BoundExecutor<'a> {
        BoundExecutor { exec: self, principal }
    }

    async fn run_tool(&self, name: &str, args: &Value, p: &Principal) -> CallResult {
        let started = std::time::Instant::now();
        let target = audit_target(args);
        let log = |status: AuditStatus, error: Option<String>| {
            let mut e = AuditEntry::new(Channel::Mcp, name, status);
            e.client_id = Some(p.client_id.clone());
            e.user_id = Some(p.user_id);
            e.duration_ms = Some(i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX));
            e.resource = target.0.clone();
            e.resource_id = target.1.clone();
            e.error = error;
            // Che SĐT / bỏ khoá nhạy cảm trước khi ghi nhật ký (không ghi SĐT thô).
            e.metadata = Some(json!({ "args": sanitize_for_ai(args, "", 0) }));
            self.audit.log(p.company, e)
        };

        let limit = self.limits.call(p.company.id(), p.user_id);
        if !limit.allowed {
            log(AuditStatus::Denied, Some("rate_limited".into())).await;
            return CallResult::error(format!(
                "Quá giới hạn {MCP_CALLS_PER_MINUTE} lời gọi/phút. Thử lại sau {} giây. / Rate limit exceeded.",
                limit.retry_after_sec
            ));
        }
        let Some(spec) = self.registry.get(name) else {
            log(AuditStatus::Error, Some("not_implemented".into())).await;
            return CallResult::error(
                "Công cụ này chưa sẵn sàng trên máy chủ này. / This tool is not available on this server yet.",
            );
        };
        if let Some(scope) = spec.scope
            && !p.scopes.iter().any(|s| s == scope)
        {
            log(AuditStatus::Denied, Some(format!("insufficient_scope:{scope}"))).await;
            return CallResult::error(format!(
                "insufficient_scope: kết nối này chưa được cấp quyền ghi ({scope}). Người dùng cần kết nối lại và bật \"Cho phép AI thay đổi dữ liệu\" ở màn đồng ý (Cài đặt > Kết nối & AI > Kết nối AI). / This connection lacks the {scope} scope."
            ));
        }
        if let Some(missing) = spec.permissions.iter().find(|perm| !can(&p.grants, perm, None)) {
            log(AuditStatus::Denied, Some(format!("missing_permission:{missing}"))).await;
            return CallResult::error(format!(
                "Bạn không có quyền thực hiện thao tác này (cần quyền {missing}). / Permission denied: {missing} required."
            ));
        }
        let ctx = ToolCtx {
            principal: p,
            base_url: &self.base_url,
        };
        match spec.runner.run(args, &ctx).await {
            Ok(out) => {
                log(AuditStatus::Ok, None).await;
                let text = out
                    .text
                    .unwrap_or_else(|| trinity_kernel::json::js_json(&out.structured));
                CallResult {
                    text: slice16(&text, MAX_TEXT),
                    structured: Some(out.structured),
                    is_error: false,
                }
            }
            Err(err) => self.failure(err, log).await,
        }
    }

    async fn failure<'a, F>(&self, err: ToolError, log: F) -> CallResult
    where
        F: Fn(AuditStatus, Option<String>) -> BoxFuture<'a, ()>,
    {
        match err {
            ToolError::User(m) => {
                log(AuditStatus::Error, Some("invalid_arguments".into())).await;
                CallResult::error(m)
            }
            ToolError::NotFound => {
                log(AuditStatus::Denied, Some("not_found_or_out_of_scope".into())).await;
                CallResult::error(
                    "Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn. / Not found or outside your permission scope.",
                )
            }
            ToolError::Forbidden(m) => {
                log(AuditStatus::Denied, Some("forbidden".into())).await;
                CallResult::error(m)
            }
            ToolError::Http { status: 403, .. } => {
                log(AuditStatus::Denied, Some("forbidden".into())).await;
                CallResult::error("Bạn không có quyền thực hiện thao tác này. / Permission denied.")
            }
            ToolError::Http { status, message } if status < 500 => {
                log(AuditStatus::Error, Some(format!("http_{status}"))).await;
                CallResult::error(format!("Yêu cầu không hợp lệ: {message}"))
            }
            ToolError::Plain(m) if is_plain_argument_error(&m) => {
                log(AuditStatus::Error, Some("invalid_arguments".into())).await;
                CallResult::error(m)
            }
            ToolError::Http { message: m, .. } | ToolError::Plain(m) | ToolError::Internal(m) => {
                tracing::error!("MCP tool lỗi: {m}");
                log(AuditStatus::Error, Some("internal_error".into())).await;
                CallResult::error("Lỗi hệ thống khi thực hiện yêu cầu. Vui lòng thử lại sau. / Internal error.")
            }
        }
    }
}

pub struct BoundExecutor<'a> {
    exec: &'a Executor,
    principal: &'a Principal,
}

impl ToolHost for BoundExecutor<'_> {
    fn call<'a>(&'a self, name: &'a str, args: Value) -> BoxFuture<'a, CallResult> {
        Box::pin(async move { self.exec.run_tool(name, &args, self.principal).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn muc_tieu_nhat_ky() {
        assert_eq!(
            audit_target(&json!({ "id": "contact:12" })),
            (Some("contact".into()), Some("contact:12".into()))
        );
        assert_eq!(
            audit_target(&json!({ "action_id": 7 })),
            (Some("ai_action_draft".into()), Some("7".into()))
        );
        assert_eq!(audit_target(&json!({ "id": 5 })), (None, Some("5".into())));
        assert_eq!(audit_target(&json!({})), (None, None));
    }

    #[test]
    fn loi_thuong_nhan_dien_loi_doi_so() {
        for m in [
            "query phải từ 2 ký tự",
            "id không hợp lệ",
            "contact_id sai",
            "Không hỗ trợ kiểu này",
            "Có SĐT trong chuỗi",
        ] {
            assert!(is_plain_argument_error(m), "{m}");
        }
        for m in ["identity lỗi", "query_x", "lỗi lạ"] {
            assert!(!is_plain_argument_error(m), "{m}");
        }
    }
}
