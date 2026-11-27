//! Log JSON, Sentry, sự kiện sản phẩm, che dữ liệu riêng tư.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1, 4.12.

pub mod log;
mod monitoring;
mod product_events;
mod redact;
mod scrub;

pub use monitoring::{
    ErrorContext, MonitoringConfig, client_options, init_sentry, report_frontend_warning, report_server_error,
    resolve_release,
};
pub use product_events::{ProductEvent, ProductEvents, PropValue, sanitize_props};
pub use redact::{SECRET_QUERY_KEYS, redact_url};
pub use scrub::{scrub_event, scrub_sentry_event, scrub_text, scrub_url};
