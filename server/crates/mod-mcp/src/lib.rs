//! Lõi máy chủ MCP (M39, docs/rust/PLAN.md mục 4.8), chuyển từ `services/crm/src/integrations/mcp/{mcp.controller,mcp-server.service,
//! mcp-auth.service,mcp-rate-limiter,ai-output}.ts`. 3 route `/api/v1/mcp`.
//!
//! - [`frozen`]: hợp đồng đóng băng (`server/contracts/mcp/`): `tools/list` và `instructions` phục vụ nguyên văn, kiểm đối số bằng
//!   chính schema đó.
//! - [`protocol`]: JSON-RPC không phiên trả JSON (`initialize`, `ping`, `tools/list`, `tools/call`; 406/415/400, thương lượng
//!   `protocolVersion`, `Mcp-Protocol-Version`).
//! - [`auth`], [`limits`], [`endpoint`]: token OAuth (M37), `Origin`, 240 request/phút/người, 30 lần xác thực sai/phút/IP,
//!   `WWW-Authenticate`.
//! - [`exec`]: chạy tool (60 lời gọi/phút/người, scope, quyền, nhật ký, ánh xạ lỗi song ngữ, cắt 40.000 UTF-16); các nhóm tool
//!   (M40–M42) đăng ký [`exec::ToolSpec`].
//! - [`ai_output`]: che SĐT / bỏ khoá nhạy cảm trong mọi dữ liệu trả cho AI và trong nhật ký.
//! - [`routes`]: bảng route và router axum.
//!
//! Luật sản phẩm giữ nguyên (và là việc của các nhóm tool): không có tool xoá; hành động công khai cần `confirmed_by_user`.

#![recursion_limit = "256"]
// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]
#![allow(clippy::type_complexity)]

pub mod actions;
pub mod ai_output;
pub mod args;
pub mod auth;
pub mod deps;
pub mod endpoint;
pub mod exec;
pub mod frozen;
pub mod limits;
pub mod protocol;
pub mod routes;
pub mod tools;

pub use endpoint::{HttpIn, HttpOut, McpConfig, McpEndpoint};
pub use exec::{ToolCtx, ToolError, ToolOutput, ToolRegistry, ToolRunner, ToolSpec};
pub use routes::{McpState, api_router, specs};
pub use tools::{
    AuthInvitations, FanpageDeps, FanpagePorts, InboxDeps, InvitationsPort, Kick, PostsDeps, SocialDeps, fanpage_deps,
    register_fanpage, register_group1, register_group2, register_group3, register_inbox_invitations, register_social,
    register_structure,
};
