//! API key, đăng nhập công khai và team (M05): 8 endpoint của `services/auth` (`api-keys`, `public-api`, `teams`).
//!
//! | Endpoint | Quyền | Hàm |
//! |---|---|---|
//! | `GET /api-keys` | `settings.integrations` | [`api_keys::find_all`] |
//! | `GET /api-keys/:id` | `settings.integrations` | [`api_keys::find_by_id`] |
//! | `POST /api-keys` (201) | `settings.integrations` | [`api_keys::create`] |
//! | `POST /api-keys/:id/rotate` | `settings.integrations` | [`api_keys::rotate`] |
//! | `DELETE /api-keys/:id` | `settings.integrations` | [`api_keys::revoke`] |
//! | `POST /public/auth/login` | công khai + `ApiKeyGuard` (`auth:login`) | [`api_keys::validate`] rồi `mod_auth::AuthService::login_third_party` |
//! | `GET /auth/teams` | đăng nhập | [`teams::find_all`] |
//! | `POST /auth/teams` (201) | `org.manage` | [`teams::create`] |
//!
//! Lớp logic nhận `&mut PgConnection` đã gắn công ty (như `mod-commerce`); [`routes::routes`] khai 8 route với `Access` và
//! so với `contracts/routes.json` (K14). Handler (extractor K15 → hàm ở đây → JSON) do tầng serve nối vào.
// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod api_keys;
pub mod company_token;
pub mod guards;
pub mod routes;
pub mod teams;

use std::sync::Arc;

use mod_auth::{AuthService, PermGrants};
use trinity_db::Db;
use trinity_db::platform::Platform;
use trinity_http::edge::client_ip::ClientIpResolver;
use trinity_rbac::PermissionService;

pub use guards::named_guards;
pub use routes::api_router;

/// Phụ thuộc dùng chung của router M05, dựng một lần ở `serve`.
pub struct ApiKeysCtx {
    pub db: Db,
    pub platform: Platform,
    pub perms: PermissionService,
    /// Cùng bản `AuthService` với router `/auth/*` (chung bộ giới hạn tốc độ đăng nhập).
    pub auth: Arc<AuthService<PermGrants>>,
    pub ip: Arc<ClientIpResolver>,
}
