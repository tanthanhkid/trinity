//! API công khai bằng khoá API (M36): chuyển từ `services/crm/src/public-api/*`. 5 endpoint dưới `/api/v1/public`, xác thực
//! bằng header `X-API-Key` (không JWT):
//!
//! | Endpoint | Phạm vi khoá | Việc |
//! |---|---|---|
//! | `POST /public/contacts` (201) | `contacts:create` | tạo khách, gán cho chủ khoá, cảnh báo SĐT trùng |
//! | `GET /public/contacts/sources` | `contacts:create` | nguồn khách đang bật |
//! | `POST /public/deals` (201) | `deals:create` | tạo thương vụ dưới danh nghĩa chủ khoá, gắn/tạo khách theo SĐT |
//! | `POST /public/tasks` (201) | `tasks:create` | tạo thẻ Kanban giao cho chủ khoá |
//! | `GET /public/tasks/columns` | `tasks:create` | bảng và cột Kanban chủ khoá được thấy |
//!
//! - [`guards`]: `ApiKeyGuard` (dùng `mod_apikeys::api_keys::validate`, rồi kiểm chủ khoá còn hoạt động như guard của CRM) và
//!   `PublicApiRateLimiterGuard` (100 yêu cầu/phút/khoá, khoá theo công ty). Hai guard đăng ký theo tên vào
//!   `AccessDeps::guards` ([`guards::named_guards`]).
//! - [`service`]: logic. Thao tác ghi chạy DƯỚI DANH NGHĨA chủ khoá, với đúng quyền và phạm vi dữ liệu của họ; chủ khoá hiện là
//!   Quản trị thì bị chặn.
//! - [`routes`]: bảng route (nạp vào `trinity-bin` để so với `routes.json`) và router axum.
//!
//! Khác bản TS có chủ đích: việc tạo thương vụ ([`service::create_deal`]) nằm ở đây vì module deal (M08) chưa chuyển; khi M08
//! xong, hàm này gọi lại service của M08. Việc dọn bản ghi mẫu sau khách thật đầu tiên (`SampleRecordsService.purgeIfReal`) chưa
//! có bản Rust nên chưa chạy ở đây.

#![allow(clippy::result_large_err)]

pub mod guards;
pub mod routes;
pub mod service;

use std::sync::Arc;

use trinity_db::Db;
use trinity_db::platform::Platform;
use trinity_http::edge::client_ip::ClientIpResolver;
use trinity_http::rate_limit::FixedWindowLimiter;
use trinity_rbac::{PermissionService, ScopeService};

pub use guards::named_guards;
pub use routes::{api_router, specs};

/// Phụ thuộc dùng chung, dựng một lần ở `serve`.
pub struct PublicCtx {
    pub db: Db,
    pub platform: Platform,
    pub perms: PermissionService,
    pub scopes: ScopeService,
    pub ip: Arc<ClientIpResolver>,
    /// 100 yêu cầu mỗi phút mỗi khoá (RAM, một tiến trình): dựng bằng [`PublicCtx::new_limiter`].
    pub limiter: Arc<FixedWindowLimiter>,
}

impl PublicCtx {
    pub fn new_limiter() -> Arc<FixedWindowLimiter> {
        FixedWindowLimiter::new(100, 60 * 1000)
    }
}
