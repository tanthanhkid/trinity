//! Log JSON, Sentry, sự kiện sản phẩm, che dữ liệu riêng tư.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1, 4.12.

pub mod log;
mod redact;

pub use redact::{SECRET_QUERY_KEYS, redact_url};
