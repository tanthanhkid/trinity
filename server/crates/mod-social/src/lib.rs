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
//! - [`recur`], [`recurrences`], [`dto_recur`], [`csv`], [`import`], [`ports`], [`adapters`] (M55b): bài lặp (daily/weekly/monthly, giờ Việt Nam,
//!   tạo bài hẹn giờ theo từng lượt, chống trùng bằng khoá `recur:<id>:<ISO>`) và nhập CSV/danh sách dòng (xem trước + `plan_hash`,
//!   409 khi dữ liệu đổi, từng dòng độc lập). Bài đăng đi qua cổng [`ports::PostsPort`] do M54a cài khi gộp.
//! - [`publish`], [`multipart`]: đăng bài lên Page (chữ, ảnh, video tải theo phiên qua luồng) và lấy số liệu bài (M54b).
//! - [`jobs`]: job `social.publish` (đăng, thử lại, dọn việc kẹt) và `social.metrics` (số liệu, bài bị xoá trên mạng) (M54b).
//! - [`router`]: router axum cho `SocialController` và `SocialPublicController` (mount ở `trinity-bin`).
//! - [`routes`]: bảng route K14 (tài khoản, media, bài đăng M54a, 12 route M55a, 8 route M55b).
//!
//! Token Fanpage mã hoá AES-256-GCM bằng `INTEGRATIONS_SECRET_KEY` (`trinity_integrations::webhooks::secret`), đúng như bản Node.
//! "Làm mới token": token Page lấy từ user token dài hạn không hết hạn nên provider Facebook không có bước làm mới
//! (`refresh` không có ở bản Node); chỉ có [`accounts::save_refreshed`] và [`accounts::mark_reauth`] cho job đăng.
// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod accounts;
pub mod adapters;
pub mod chunked;
pub mod config;
pub mod csv;
pub mod drafts;
pub mod dto;
pub mod dto_recur;
pub mod first_comment;
pub mod import;
pub mod jobs;
pub mod limits;
pub mod media;
pub mod media_link;
pub mod multipart;
pub mod ports;
pub mod posts;
pub mod provider;
pub mod publish;
pub mod queue;
pub mod recur;
pub mod recurrences;
pub mod router;
pub mod routes;
pub mod snippets;
pub mod state;
pub mod utm;
