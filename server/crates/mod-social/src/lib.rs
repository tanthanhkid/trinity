//! Đăng bài đa kênh, phần tài khoản (M53a), chuyển từ `services/crm/src/social` (`social-accounts.service`,
//! `social.config`, `social-oauth-state`, `providers/facebook.provider` phần kết nối).
//!
//! - [`config`]: mạng hỗ trợ (chỉ `facebook`), mạng đã gỡ, `redirect_uri`.
//! - [`dto`]: body `connect-url` kiểm như class-validator.
//! - [`state`]: `state` OAuth ký HMAC (gắn người bấm và mạng).
//! - [`provider`]: provider Facebook Page: quyền xin, URL đăng nhập, đổi `code` lấy Page (qua `mod_facebook::graph::GraphClient`,
//!   nên dùng chung URL gốc đổi được và quan sát lỗi cho ChannelGuard).
//! - [`accounts`]: danh sách, bật lại, gỡ, URL kết nối, callback, giải mã token cho job đăng (M54b).
//! - [`routes`]: bảng route K14 (6 route tài khoản; bài, nháp, media, mẫu chữ thuộc M53b trở đi).
//!
//! Token Fanpage mã hoá AES-256-GCM bằng `INTEGRATIONS_SECRET_KEY` (`trinity_integrations::webhooks::secret`), đúng như bản Node.
//! "Làm mới token": token Page lấy từ user token dài hạn không hết hạn nên provider Facebook không có bước làm mới
//! (`refresh` không có ở bản Node); chỉ có [`accounts::save_refreshed`] và [`accounts::mark_reauth`] cho job đăng.

pub mod accounts;
pub mod config;
pub mod dto;
pub mod provider;
pub mod routes;
pub mod state;
