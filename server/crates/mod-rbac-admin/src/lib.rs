//! Quản trị vai trò và nhật ký quyền (M04): 10 endpoint của `services/auth/src/rbac-admin`.
//!
//! | Endpoint | Quyền | Hàm |
//! |---|---|---|
//! | `GET /roles` | `roles.manage` hoặc `users.manage` hoặc `kanban.boards` | [`roles::list`] |
//! | `GET /roles/:id` | `roles.manage` | [`roles::get`] |
//! | `POST /roles` (201) | `roles.manage` | [`roles::create`] |
//! | `POST /roles/:id/clone` (201) | `roles.manage` | [`roles::clone`] |
//! | `PATCH /roles/:id` | `roles.manage` | [`roles::update`] |
//! | `PUT /roles/:id/grants` | `roles.manage` | [`roles::set_grants`] |
//! | `DELETE /roles/:id` | `roles.manage` | [`roles::remove`] |
//! | `GET /roles/:id/members` | `roles.manage` | [`roles::members`] |
//! | `PUT /users/:id/roles` | `users.manage` | [`roles::set_user_roles`] |
//! | `GET /rbac/audit` | `roles.manage` | [`audit::list`] |
//!
//! Hàm nhận `&mut PgConnection` đã gắn công ty (như `mod-commerce`) và [`Ctx`] (công ty, `PermissionService`,
//! `ScopeService`, `RbacCache`) rồi trả JSON đúng hình của bản Node. Mọi thay đổi ghi `rbac_audit_log` TRONG CÙNG giao
//! dịch, và xoá cache quyền của người bị ảnh hưởng SAU khi commit (xem `RbacCache::invalidate_users`). Chống tự nâng quyền
//! ở [`guardrails`]: một luật so theo quyền (không theo tên vai trò): người gọi không cấp/sửa/gán được thứ không phải tập
//! con quyền của chính mình. `PermissionService`/`ScopeService` tự lấy kết nối từ pool, nên `Db` cần pool từ 2 kết nối.
//!
//! [`api_router`] nối 9 route vào axum (`PUT /users/:id/roles` do `mod-users` mount).
//!
//! [`routes::routes`] khai 10 route với `Access` và so với `contracts/routes.json` (K14); handler (extractor K15 → hàm ở đây
//! → JSON) do tầng serve nối vào bảng này.
//!
//! JSON `grants` sắp theo khoá (bản Node theo thứ tự chèn): cùng nội dung, khác thứ tự khoá.
// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod api;
pub mod audit;
pub mod guardrails;
pub mod roles;
pub mod routes;
mod validate;

use std::sync::Arc;

use trinity_db::CompanyRef;
use trinity_rbac::{Grants, PermissionService, RbacCache, ScopeService};

pub use api::{RbacState, api_router};
pub use validate::{
    AuditQuery, CreateRole, UpdateRole, validate_audit_query, validate_create_role, validate_set_grants,
    validate_set_user_roles, validate_update_role,
};

/// Người gọi, do guard xác thực (K11) điền: quyền đã gộp của người đó (`AuthUser.grants`).
#[derive(Debug, Clone)]
pub struct Actor {
    pub user_id: i32,
    pub is_admin: bool,
    pub grants: Grants,
}

/// Dịch vụ dùng chung của mọi hàm trong crate.
#[derive(Clone)]
pub struct Ctx {
    pub company: CompanyRef,
    pub permissions: PermissionService,
    pub scope: ScopeService,
    pub cache: Arc<RbacCache>,
}
