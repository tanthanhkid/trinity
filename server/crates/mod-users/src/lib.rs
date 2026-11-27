//! Module quản lý người dùng (M03, docs/rust/PLAN.md mục 4.7): 10 endpoint `/api/v1/users`, 2 endpoint ghim menu
//! `/api/v1/users/me/pinned-menu` và `PUT /api/v1/users/:id/roles`. Chuyển từ `services/auth/src/users/*` và
//! `setUserRoles` của `roles.service.ts`.
//!
//! - [`service`]: logic + DB (hàm nhận [`Ctx`] và [`Actor`]).
//! - [`guards`]: chống leo thang, Quản trị cuối cùng, hạn mức người dùng, lời mời, giai đoạn làm việc.
//! - [`pinned`]: ghim menu.
//! - [`routes`]: bảng route ([`routes::specs`], nạp vào `trinity-bin` để so với `routes.json`) và router axum.

pub mod guards;
pub mod members;
pub mod pinned;
pub mod routes;
pub mod service;

pub use guards::Actor;
pub use routes::{api_router, specs};
pub use service::Ctx;
