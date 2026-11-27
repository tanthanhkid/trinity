//! Máy chủ OAuth 2.1 cho kết nối AI (M37, docs/rust/PLAN.md mục 4.8): chuyển từ `services/crm/src/integrations/oauth/*`.
//!
//! - [`config`]: scope, thời hạn, URL gốc (không bao giờ suy từ header `Host`), cờ bật.
//! - [`metadata`]: RFC 8414 / 9728.
//! - [`clients`]: DCR (RFC 7591), CIMD (tải qua lớp chống SSRF), xác thực client; sổ client chung nằm ở công ty 1.
//! - [`authorize`], [`consent`]: kiểm yêu cầu uỷ quyền, PKCE S256, token consent HMAC.
//! - [`tokens`]: đổi mã, xoay refresh (cửa sổ đồng thời 10 giây, dùng lại ngoài cửa sổ ⇒ thu hồi cả chuỗi), thu hồi,
//!   [`OauthCtx::verify_access_token`] cho MCP (M39).
//! - [`connections`]: danh sách / thu hồi kết nối AI cho màn "Kết nối AI".
//! - [`routes`]: 8 route (bảng [`routes::specs`], nạp vào `trinity-bin` để so với `routes.json`) và router axum.
//!
//! Job dọn định kỳ nằm ở `trinity_integrations::purge::oauth_purge_job` (K35).

pub mod authorize;
pub mod clients;
pub mod config;
pub mod connections;
pub mod consent;
pub mod crypto;
pub mod ctx;
pub mod error;
pub mod metadata;
pub mod redirect;
pub mod routes;
pub mod tokens;
mod util;

pub use config::OauthConfig;
pub use ctx::{Limiters, OauthCtx};
pub use routes::{api_router, specs};
pub use tokens::VerifiedAccessToken;

/// Tiền tố công ty của bí mật (mã, token): công ty 1 không có (định dạng cũ vẫn dùng được).
pub fn company_token_prefix(company_id: i32) -> String {
    if company_id == 1 {
        String::new()
    } else {
        format!("c{company_id}.")
    }
}

/// Công ty mà một bí mật tự nhận thuộc về: `^c([1-9][0-9]{0,9})\.(.+)$` (dotall); không tiền tố = công ty 1.
pub fn company_id_of_token(raw: &str) -> i64 {
    let Some(rest) = raw.strip_prefix('c') else { return 1 };
    let Some((digits, secret)) = rest.split_once('.') else {
        return 1;
    };
    let ok = !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0')
        && !secret.is_empty();
    if ok { digits.parse().unwrap_or(1) } else { 1 }
}

#[cfg(test)]
mod tests;
