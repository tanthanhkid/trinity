# ROUTE-GAP — route Node chưa có ở Rust (đối chiếu 27/11, lần 2, base main 8a35d877)

Phương pháp (không build, chỉ đọc mã): lấy 583 route của `server/contracts/routes.json`, đối chiếu từng cặp
(method, path đã chuẩn hoá `:param`) với `RouteSpec::new(...)`/`.route(...)` trong `server/crates/*/src` (kể cả hằng `BASE`,
closure `r(...)`/`s(...)`), rồi kiểm module khai route có `api_router`/`mount` tương ứng trong `trinity-bin/src/serve.rs`.
Là phép đếm tĩnh: dòng nào còn nghi thì để `cargo xtask check-routes --require-all` (lượt build PC) chốt.

## Kết quả

- 583 route trong hợp đồng; **582 đã khai và mount**. Thiếu **0** route cần viết.
- 1 route cố ý không port: `POST /api/v1/social/media/upload-token` (SocialController) — đã gỡ cùng Vercel Blob (G11).
  Còn nằm trong `routes.json` nhưng đã đánh dấu bỏ ở `RUST_REMOVED_ROUTES`.
- Chốt bằng máy (27/11, sau sửa): `cargo xtask check-routes --require-all` **đã khai 570/570 route, 0 lỗi**. Nhóm `rbac-admin` đã vào
  `declared_routes` (bỏ `PUT /users/:id/roles` vì mod-users đã khai); `POST /social/media/upload-token` nằm trong
  `RUST_REMOVED_ROUTES` (`trinity-http/src/router/check.rs`): không tính vào tổng, không báo thiếu, Rust khai lại thì lỗi.
- Số 155/571 thiếu của lần 1 đã hết: #504–#541 phủ social, facebook, webhooks/tích hợp, HR, retired, newsfeed, notify,
  briefings, payroll, chấm công…
- Route Rust không có trong hợp đồng (cố ý): `/api/v1/exports*` (mod-exports) và nhóm `rbac-admin` khai riêng.
- Ghi chú cũ trong `serve.rs` ("CHƯA mount: mod-deals, mod-newsfeed") đã lỗi thời: cả hai đã mount.

## Tool MCP (`contracts/mcp/tools.json`, 110 tool) chưa có handler Rust — 14 tool

| Nhóm | Tool |
|---|---|
| Báo cáo | `get_report` (chờ báo cáo tuỳ chỉnh `CustomReportsService`) |
| Briefing (M41) | `get_briefing_data`, `save_briefing` |
| Chấm điểm lead | `list_leads_to_score`, `set_lead_intent` |
| AI / tương tác | `list_ai_activity`, `list_interactions` |
| Kênh / ChannelGuard | `get_connected_channels`, `get_channel_limits`, `get_client_ip_status` |
| Cài đặt | `set_features`, `save_crm_option`, `get_store_settings`, `update_store_settings` |

## Job/cron Node chưa chạy trong Rust

Đã đăng ký trong `serve.rs`: `facebook.broadcasts`, `facebook.flows`, `social.publish`, `social.metrics`,
`briefings.run-due` (khi `BRIEFING_CRON_ENABLED`).

Đã có hàm dựng job nhưng **chưa gọi `scheduler.register`** trong `serve.rs` (chỉ việc nối):

| Job Node | Hàm Rust có sẵn |
|---|---|
| `lead-scoring.job.ts`, `stale-work.job.ts` | `mod_leads::jobs::register_if_enabled` |
| `notifications.scheduler.ts` (2 phút) | `mod_notify::jobs::scheduled_job` (cần `Deliverer`) |
| `ai-action-expiry.service.ts` (10 phút) | `mod_ai_actions::expiry_job` |
| `integration-outbox-purge.service.ts`, `oauth-purge.service.ts` (6 giờ) | `trinity_integrations::{outbox_purge_job, oauth_purge_job}` |
| `webhook-dispatcher.service.ts` (10 giây + dọn 6 giờ) | `trinity_integrations::webhooks::dispatcher::webhook_tick_job` (cần `Dispatcher`) |

Chưa có job Rust tương ứng: không còn job Node nào ngoài danh sách trên (`tenant-timer.ts` chỉ là helper).
