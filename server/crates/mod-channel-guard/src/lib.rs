//! Module chống lạm dụng kênh (M45, docs/rust/PLAN.md mục 4.7): hạn mức kênh gửi ra ngoài theo gói, khoá kênh của chủ nền
//! tảng, tự tạm dừng gửi tự động theo tỉ lệ lỗi Graph API, và hai đường `settings/channel-guard`. Chuyển từ
//! `services/crm/src/channel-guard/*`.
//!
//! - [`guard`]: [`ChannelGuard`] (đếm nguyên tử, khoá, tạm dừng, sự kiện, trạng thái).
//! - [`window`]: phần thuần (ngưỡng `CHANNEL_GUARD_*`, cửa sổ lỗi Graph, khung giờ/ngày Việt Nam).
//! - [`graph`]: phân loại kết quả lời gọi Graph.
//! - [`error`]: [`ChannelBlocked`] (403 khoá, 429 tạm dừng/hết hạn mức).
//! - [`routes`]: bảng route ([`routes::specs`], nạp vào `trinity-bin` để so với `routes.json`) và router axum.
//!
//! Module gửi ra ngoài (M46 Facebook, M52 Zalo, M54b đăng bài…) gọi [`ChannelGuard::prepare_reserve`] trước giao dịch rồi
//! [`ChannelGuard::reserve_in`] trong giao dịch; mỗi lời gọi Graph báo [`ChannelGuard::record_graph`]. Tiến trình `serve`
//! chuyển mọi `SyncEvent` của `trinity_db::sync::listen` vào [`ChannelGuard::on_sync_event`] để cửa sổ lỗi nhận cả kết quả
//! do tiến trình khác phát qua `NOTIFY graph`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod error;
pub mod graph;
pub mod guard;
pub mod routes;
pub mod window;

pub use error::{BlockCode, ChannelBlocked, GuardError, PendingEvent};
pub use graph::{GRAPH_POLICY_CODE, GraphOutcome};
pub use guard::{
    AutoPause, BlockReason, ChannelAlerts, ChannelGuard, ChannelGuardStatus, OutboundMode, OutboundScope, QuotaKind,
    ReserveContext,
};
pub use routes::{api_router, specs};
pub use window::{GraphGuardConfig, GraphVerdict, GraphWindowEvent, day_bucket, evaluate_graph_window, hour_bucket};
