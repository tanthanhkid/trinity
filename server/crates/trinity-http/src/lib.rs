//! Router, middleware, validation, giới hạn tốc độ, web tĩnh, strangler proxy, shadow, TLS.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1. Hiện có:
//! - [`outbound`]: lớp chống SSRF dùng chung cho mọi lời gọi HTTP ra tới địa chỉ do người dùng nhập (webhook ra, tải
//!   CIMD của OAuth, tải media) (K35).
//! - [`validate`]: kiểm dữ liệu vào theo chế độ strict và lenient (K15).
//! - [`rate_limit`]: giới hạn tốc độ cửa sổ cố định theo khoá/công ty, trong RAM (K25).
//! - [`serve`]: HTTP hoặc TLS từ tệp chứng chỉ (Cloudflare Origin Certificate), tắt máy êm khi nhận SIGTERM (K19).
//! - [`router`]: router bắt buộc khai quyền (`Access`) cho mọi route và kiểm bảng route với `contracts/routes.json` (K14).
//! - [`strangler`]: proxy chuyển tiếp phần thuộc Node (stream, WebSocket, timeout), tệp sở hữu route nạp lại bằng SIGHUP (K17).
//! - [`web`]: phục vụ bản xuất tĩnh của web (`WEB_DIR`) và luật điều hướng của `proxy.ts` (K18).
//! - [`edge`]: CORS, giới hạn body, raw body, multipart và IP thật của khách theo `TRUSTED_PROXY` (K16).

pub mod edge;
pub mod outbound;
pub mod rate_limit;
pub mod router;
pub mod serve;
pub mod strangler;
pub mod validate;
pub mod web;
