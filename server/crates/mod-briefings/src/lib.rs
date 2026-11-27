//! Bản tin sáng chiều (M23): 6 endpoint và job `briefings.run-due`.
//!
//! Chuyển từ `services/crm/src/briefings`. Mỗi hàm ở [`service`] ứng với một endpoint, nhận [`trinity_db::TenantDb`] của
//! công ty; bảng route và router axum ở [`routes`]. Phần RBAC (người nhận, phạm vi `reports.overview`, cờ `ai_briefing`)
//! đi qua trait [`Ports`], cài thật ở [`ports::RbacPorts`] (chạy trên kết nối bên gọi đưa vào); thông báo trong app đi qua cổng K36
//! (`trinity_db::outbox`); job đăng ký với scheduler K20 ([`job`]), chỉ chạy khi bật `BRIEFING_CRON_ENABLED=true`.
//!
//! | Endpoint | Hàm |
//! |---|---|
//! | `GET /briefings/config` | [`get_config`] |
//! | `PATCH /briefings/config` | [`update_config`] |
//! | `POST /briefings/run-now` | [`run_now`] |
//! | `GET /briefings/preview` | [`preview`] |
//! | `GET /briefings` | [`list`] |
//! | `GET /briefings/:id` | [`one`] |
//!
//! Tool MCP `get_briefing_data` và `save_briefing`: phần dữ liệu và ghi nằm ở [`agent`] (`mod-mcp` chỉ là lớp gọi).

pub mod agent;
pub mod aggregate;
pub mod config;
pub mod job;
pub mod ports;
pub mod routes;
pub mod service;
pub mod text;
pub mod time;
pub mod types;

pub use service::{
    Available, Briefing, BriefingSummary, ConfigResponse, Error, Ports, Preview, Result, RunDue, RunResult, get_config,
    list, now_slot, one, preview, roster_with_permission, run_due, run_now, run_slot, update_config,
};
