//! Facebook (M46): Graph client, đăng nhập OAuth và kết nối Fanpage, chuyển từ `services/crm/src/facebook`
//! (`graph-client`, `facebook.config`, `facebook-oauth-state`, `facebook-pages.service`).
//!
//! - [`config`]: cấu hình env, URL Graph (`FACEBOOK_GRAPH_BASE_URL` trỏ tới máy chủ giả khi test), quyền xin, trường webhook.
//! - [`graph`]: [`graph::GraphClient`] (mọi lời gọi Graph) và [`graph::GraphApiError`] với phân loại mã lỗi (190 token, 10 và
//!   200–299 quyền, 4/17/32/613 và HTTP 429 giới hạn tần suất, subcode 2018278/1545041 ngoài cửa sổ). Mỗi lời gọi báo
//!   [`mod_channel_guard::GraphOutcome`] cho `observer` (nối `ChannelGuard::record_graph`) để cửa sổ lỗi M45 phân loại.
//! - [`state`]: `state` OAuth ký HMAC gắn với người bấm và công ty.
//! - [`pages`]: danh sách Page, token mã hoá (`INTEGRATIONS_SECRET_KEY`), kiểm hạn, ngắt kết nối, phần đăng bài của Page.
//! - [`routes`]: bảng route K14 (7 route; webhook và tin nhắn thuộc M47a/M47b/M48).
//!
//! - [`webhook`] (M47a): `GET/POST /facebook/webhook`: xác minh, chữ ký `X-Hub-Signature-256`, định tuyến theo Page/công ty,
//!   chuyển tiếp nguyên byte, cổng tính năng; xử lý từng loại sự kiện đi qua [`webhook::EntryProcessor`] (M47b tin nhắn và Lead Ads,
//!   M49 bình luận).
//!
//! - [`ingest`], [`messenger`], [`leads`] (M47b): [`ingest::FacebookIngest`] cài `EntryProcessor`: tin Messenger vào (hội thoại, khách, outbox
//!   `messenger.message_*`, chuông) và Lead Ads (`leadgen` ⇒ Graph ⇒ khách, khử trùng theo `leadgen_id`).
//!
//! Chưa có ở đây (việc của M48/M49): bình luận, link mở chat, kịch bản nhắn tin, luật tự động. Sau `check_token`
//! thành công tầng route còn gọi làm mới tên khách thiếu (`refreshMissingNames`, M48).

pub mod config;
pub mod graph;
pub mod ingest;
pub mod leads;
pub mod messenger;
pub mod pages;
pub mod routes;
pub mod state;
pub mod webhook;
