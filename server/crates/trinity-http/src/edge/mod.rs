//! Biên của máy chủ: CORS, giới hạn body, raw body, multipart, IP thật của khách và header bảo mật chung (K16, docs/rust/PLAN.md mục 4.13).

// `HttpError` (kiểu lỗi K05) và `Response` lớn hơn ngưỡng của clippy; lỗi chỉ xảy ra ở đường từ chối request nên không boxing.
#![allow(clippy::result_large_err)]

pub mod body;
pub mod client_ip;
pub mod cors;
pub mod net;
pub mod security_headers;
