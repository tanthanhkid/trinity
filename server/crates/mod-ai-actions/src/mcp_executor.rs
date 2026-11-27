//! Bộ chạy tool ghi thật của MCP (M42) cho cổng [`ActionExecutor`]: nhãn/quyền/thực thi lấy từ `mod_mcp::actions` (cùng danh sách
//! thao tác mà tool ghi dùng khi tạo đề xuất), chạy với NGƯỜI DUYỆT thật (quyền hiện tại, không gỡ `*.phone_full`).
//! Chưa có thao tác đổi cấu trúc (M43), nên không lưu phiên bản cấu trúc.

use std::sync::Arc;

use mod_mcp::auth::Principal;
use mod_mcp::deps::ToolDeps;
use serde_json::Value;
use trinity_kernel::error::AppError;

use crate::{ActionExecutor, ActionUser, BoxFut, ToolInfo};

pub struct McpExecutor {
    pub deps: Arc<ToolDeps>,
}

impl ActionExecutor for McpExecutor {
    fn info(&self, tool: &str) -> Option<ToolInfo> {
        mod_mcp::actions::info(tool).map(|(label, permissions)| ToolInfo {
            label: label.to_owned(),
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            structure: false,
        })
    }

    fn save_version<'a>(
        &'a self,
        _draft_id: i32,
        _tool: &'a str,
        _summary: &'a str,
        _user: &'a ActionUser,
    ) -> BoxFut<'a, Result<(), AppError>> {
        Box::pin(async { Ok(()) })
    }

    fn execute<'a>(
        &'a self,
        tool: &'a str,
        params: &'a Value,
        user: &'a ActionUser,
        draft_id: i32,
    ) -> BoxFut<'a, Result<Value, AppError>> {
        Box::pin(async move {
            let principal = Principal {
                company: user.company,
                user_id: user.user_id,
                email: user.email.clone(),
                client_id: String::new(),
                scopes: Vec::new(),
                token_id: 0,
                grants: user.grants.clone(),
            };
            mod_mcp::actions::run_approved(tool, params, &principal, &self.deps, draft_id).await
        })
    }
}
