//! Hoạt động AI và duyệt đề xuất (M38, docs/rust/PLAN.md mục 4.8), chuyển từ `services/crm/src/integrations/mcp/actions/
//! {ai-actions.controller,ai-actions.service,ai-action-view,ai-action-expiry.service}.ts`. 7 route `/api/v1/integrations/ai-actions`
//! (2 route `/integrations/ai-connections` của cùng cụm đã ở `mod-oauth`):
//!
//! | Route | Quyền |
//! |---|---|
//! | `GET /ai-actions` (`?status=`, `?cursor=`, `?limit=`), `GET /ai-actions/:id`, `GET /ai-actions/pending-count` | đăng nhập, CHỈ đề xuất của chính mình |
//! | `GET /ai-actions/settings` | đăng nhập |
//! | `PATCH /ai-actions/settings` | `integrations.ai_admin` |
//! | `POST /ai-actions/:id/approve`, `POST /ai-actions/:id/reject` | đăng nhập, CHỈ đề xuất của chính mình |
//!
//! Chỉ nhận JWT phiên web: token OAuth của AI là chuỗi opaque nên không qua được guard, AI KHÔNG có đường tự duyệt.
//!
//! - [`service`]: logic (nhận nguyên tử `pending → approved` trước khi chạy, thực thi tối đa một lần, quyền kiểm lại lúc duyệt,
//!   `failed` kèm lý do đã che SĐT, trạng thái hiệu lực không phụ thuộc job).
//! - [`ActionExecutor`]: cổng chạy tool ghi. Danh sách tool, quyền, thực thi và lưu phiên bản cấu trúc là việc của khung thao
//!   ghi M42/M43; ở đây là một trait để nối vào, mặc định ([`NoTools`]) chưa có tool nào (duyệt đề xuất lạ ⇒ 400).
//! - [`job`]: job `integrations.ai-action-expiry` (10 phút một lượt): hết hạn, kết quả không rõ, dọn.
//! - [`routes`]: bảng route và router axum.

#![allow(clippy::result_large_err)]

pub mod job;
pub mod routes;
pub mod service;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use trinity_db::Db;
use trinity_kernel::error::AppError;
use trinity_rbac::Grants;

pub use job::{JOB_AI_ACTION_EXPIRY, expiry_job};
pub use routes::{api_router, specs};

/// Khoá `settings`: `true` ⇒ AI chỉ tạo đề xuất chờ duyệt; vắng hoặc khác ⇒ ghi thẳng.
pub const REQUIRE_APPROVAL_KEY: &str = "ai_require_approval";

/// Người duyệt, đủ cho kiểm quyền lúc thực thi.
#[derive(Debug, Clone)]
pub struct ActionUser {
    pub user_id: i32,
    pub email: String,
    pub is_admin: bool,
    pub grants: Grants,
    pub company: trinity_db::CompanyRef,
}

/// Thông tin một loại đề xuất (`ActionToolDef` của bản Node, phần không phải thực thi).
#[derive(Debug, Clone)]
pub struct ToolInfo {
    pub label: String,
    /// Quyền người duyệt phải còn giữ lúc duyệt.
    pub permissions: Vec<String>,
    /// Đổi cấu trúc ⇒ lưu phiên bản cấu trúc trước khi chạy.
    pub structure: bool,
}

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Cổng chạy tool ghi của AI (M42/M43 cài đặt).
pub trait ActionExecutor: Send + Sync {
    /// `None` ⇒ loại đề xuất không còn được hỗ trợ.
    fn info(&self, tool: &str) -> Option<ToolInfo>;
    /// Lưu phiên bản cấu trúc TRƯỚC khi đổi (không lưu được thì không đổi).
    fn save_version<'a>(
        &'a self,
        draft_id: i32,
        tool: &'a str,
        summary: &'a str,
        user: &'a ActionUser,
    ) -> BoxFut<'a, Result<(), AppError>>;
    /// Chạy qua đúng service nghiệp vụ với quyền của người duyệt. Lỗi `HttpError` < 500 trả nguyên cho client.
    fn execute<'a>(
        &'a self,
        tool: &'a str,
        params: &'a Value,
        user: &'a ActionUser,
        draft_id: i32,
    ) -> BoxFut<'a, Result<Value, AppError>>;
}

/// Chưa có tool ghi nào (trước M42).
pub struct NoTools;

impl ActionExecutor for NoTools {
    fn info(&self, _tool: &str) -> Option<ToolInfo> {
        None
    }
    fn save_version<'a>(
        &'a self,
        _d: i32,
        _t: &'a str,
        _s: &'a str,
        _u: &'a ActionUser,
    ) -> BoxFut<'a, Result<(), AppError>> {
        Box::pin(async { Ok(()) })
    }
    fn execute<'a>(
        &'a self,
        _t: &'a str,
        _p: &'a Value,
        _u: &'a ActionUser,
        _d: i32,
    ) -> BoxFut<'a, Result<Value, AppError>> {
        Box::pin(async { Err(AppError::internal("không có tool ghi nào được đăng ký")) })
    }
}

/// Phụ thuộc dùng chung, dựng một lần ở `serve`.
pub struct AiActionsCtx {
    pub db: Db,
    /// `INTEGRATIONS_MCP_ENABLED` + `INTEGRATIONS_PUBLIC_BASE_URL` (`trinity_integrations::status::oauth_enabled`); tắt ⇒ mọi route 404.
    pub enabled: bool,
    pub executor: Arc<dyn ActionExecutor>,
    /// Hạn một lần thực thi; mặc định [`service::DEFAULT_EXEC_TIMEOUT`] (4 phút, ngắn hơn ngưỡng 5 phút của job "kết quả không rõ").
    pub exec_timeout: std::time::Duration,
}
