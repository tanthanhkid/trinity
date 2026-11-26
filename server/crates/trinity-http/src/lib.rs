//! Router, middleware, validation, giới hạn tốc độ, web tĩnh, strangler proxy, shadow, TLS.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1. Hiện có:
//! - [`outbound`]: lớp chống SSRF dùng chung cho mọi lời gọi HTTP ra tới địa chỉ do người dùng nhập (webhook ra, tải
//!   CIMD của OAuth, tải media) (K35).
//! - [`validate`]: kiểm dữ liệu vào theo chế độ strict và lenient (K15).

pub mod outbound;
pub mod validate;
