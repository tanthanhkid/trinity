# Mẫu tệp sở hữu cho các đợt bật a–e

Chỉ là **mẫu**; không có tệp nào ở đây đang được dùng. Tệp chạy thật là `deploy/hybrid/ownership.json` (mặc định mọi thứ thuộc Node). Định dạng, luật khớp (tiền tố dài nhất + phương thức) và cách đổi sở hữu:
`server/crates/trinity-kernel/src/ownership.rs`, PLAN mục 4.14, `docs/runbooks/cutover.md`; từng đợt: `docs/runbooks/cutover-cac-dot.md`.

JSON thuần không có chỗ ghi chú nên việc chờ nằm ở bảng dưới. Mỗi tệp **tích luỹ** (gồm cả các đợt trước). Số route là số dòng khớp `rust` trong `server/contracts/routes.json` (đếm theo phương thức + đường dẫn) khi nạp tệp đó.

| Đợt | Tệp | Tiền tố giao cho `rust` (thêm so với đợt trước) | Job | Số route `rust` |
|---|---|---|---|---|
| a | `ownership-dot-a.json` | `/health`, `/ready`, `/live`, `/telemetry`, `/site-config`, `/settings`; giữ `node`: `/settings/channel-guard` | — | 18 |
| b | `ownership-dot-b.json` | `/auth`, `/users`, `/roles`, `/rbac`, `/api-keys`, `/public/auth`; giữ `node`: `/auth/settings/login-wifi-check-targets` | — | 69 |
| c | `ownership-dot-c.json` | `/contacts`, `/deals`, `/interactions`, `/kanban`, `/custom-objects`, `/refs`, `/reports`, `/setup` | — | 190 |
| d | `ownership-dot-d.json` | `/employees`, `/management`, `/projects`, `/products`, `/product-categories`, `/product-attribute-defs`, `/pos`, `/store`, `/notifications`, `/newsfeed`, `/briefings`, `/templates`, `/events`, `/stale-work`, `/lead-scoring`, `/kpi`, `/tax-config`, `/insurance-settings`, `/payslips`, `/salary-components`, `/salary-rules`, `/auth/settings/login-wifi-check-targets` | `briefings.run-due`, `lead-scoring.run`, `stale-work.digest`, `notification.scheduled` | 417 |
| e | `ownership-dot-e.json` | `/integrations`, `/hooks`, `/mcp`, `/oauth`, `/public`, `/facebook`, `/zalo-oa`, `/social`, `/settings/channel-guard` | `integrations.webhook-dispatch`, `integrations.ai-action-expiry`, `integrations.outbox-purge`, `integrations.oauth-purge`, `facebook.flows`, `facebook.broadcasts`, `social.publish`, `social.metrics` | 560 |

**Việc chờ trước khi bật** (issue còn mở lúc viết mẫu):

- đợt a: không
- đợt b: không
- đợt c: không (G12b đã có)
- đợt d: #203 (M14a), #204 (M14b), #222 (M31); job chưa đăng ký ở `serve`
- đợt e: #234 (M43), #235 (M44a, mới có một phần), #237 (M44c), #243 (M49), #244 (M50), #245 (M51), #249 (M54a), #250 (M54b), #251 (M55a), #252 (M55b); đợt d

Route không có dòng nào (`/notif-ws`, `/uploads`, `/.well-known`, `/docs`, 11 route đã gỡ của `RetiredRoutesController`) thuộc Node. `migrate` luôn `node`, `web` luôn `rust` (như `deploy/hybrid/ownership.json` mặc định).
Nạp thử một mẫu: `TRINITY_OWNERSHIP_FILE=$PWD/deploy/hybrid/mau/ownership-dot-e.json trinity check-config`.
