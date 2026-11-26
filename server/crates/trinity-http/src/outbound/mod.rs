//! HTTP ra tới địa chỉ do người dùng (hoặc AI) đưa vào: chống SSRF và GET an toàn.
//!
//! Chuyển từ `services/crm/src/integrations/webhooks/ssrf-guard.ts` ([`ssrf`]) và
//! `services/crm/src/integrations/common/safe-http-get.ts` ([`safe_get`]); spec TS chuyển thành test trong
//! `tests/ssrf.rs` và `tests/safe_get.rs`.

pub mod safe_get;
pub mod ssrf;
