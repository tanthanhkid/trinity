//! Auth tương thích bản Node (K11, docs/rust/PLAN.md mục 4.6): JWT HS256 cùng `JWT_SECRET`, mật khẩu bcrypt, blacklist
//! token và phiên đang hoạt động (RAM + bảng bền + `NOTIFY trinity_sync`), guard theo đúng thứ tự kiểm của
//! `packages/rbac-nest/src/jwt-auth.guard.ts`.
//!
//! API key, `x-service-secret` và tiền tố token công ty (`cN.`) thuộc các issue sau.

pub mod guard;
pub mod jwt;
pub mod password;
pub mod security;
pub mod sync;

pub use guard::{AuthError, AuthUser, Authenticator};
pub use security::Security;
