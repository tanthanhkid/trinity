//! Đăng bài đa kênh, phần tài khoản (M53a), chuyển từ `services/crm/src/social` (`social-accounts.service`,
//! `social.config`, `social-oauth-state`, `providers/facebook.provider` phần kết nối).
//!
//! - [`config`]: mạng hỗ trợ (chỉ `facebook`), mạng đã gỡ, `redirect_uri`.
//! - [`dto`]: body `connect-url` kiểm như class-validator.
//! - [`state`]: `state` OAuth ký HMAC (gắn người bấm và mạng).
//! - [`provider`]: provider Facebook Page: quyền xin, URL đăng nhập, đổi `code` lấy Page (qua `mod_facebook::graph::GraphClient`,
//!   nên dùng chung URL gốc đổi được và quan sát lỗi cho ChannelGuard).
//! - [`accounts`]: danh sách, bật lại, gỡ, URL kết nối, callback, giải mã token cho job đăng (M54b).
//! - [`media`], [`media_link`]: thư viện media (M53b): tải multipart theo luồng, nhập từ link (chống SSRF K35), trần video theo
//!   `SOCIAL_MAX_VIDEO_MB`, link công khai có chữ ký.
//! - [`chunked`]: tải video theo phần (X15a) để qua proxy Cloudflare giới hạn 100 MB.
//! - [`drafts`], [`queue`], [`snippets`] (M55a): bài nháp, khung giờ hàng đợi hằng tuần (giờ Việt Nam), bộ hashtag và chữ ký.
//!   `POST /social/drafts/:id/publish` chờ dịch vụ tạo bài của M54a.
//! - [`routes`]: bảng route K14 (tài khoản, media, bài đăng M54a, 12 route M55a; bài lặp và CSV thuộc M55b).
//!
//! Token Fanpage mã hoá AES-256-GCM bằng `INTEGRATIONS_SECRET_KEY` (`trinity_integrations::webhooks::secret`), đúng như bản Node.
//! "Làm mới token": token Page lấy từ user token dài hạn không hết hạn nên provider Facebook không có bước làm mới
//! (`refresh` không có ở bản Node); chỉ có [`accounts::save_refreshed`] và [`accounts::mark_reauth`] cho job đăng.
// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod accounts;
pub mod chunked;
pub mod config;
pub mod drafts;
pub mod dto;
pub mod first_comment;
pub mod media;
pub mod media_link;
pub mod posts;
pub mod provider;
pub mod queue;
pub mod routes;
pub mod snippets;
pub mod state;
pub mod utm;
