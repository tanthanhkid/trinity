# Mẫu tệp sở hữu cho các đợt bật a–e

Chỉ là **mẫu**; không có tệp nào ở đây đang được dùng. Tệp chạy thật là `deploy/hybrid/ownership.json` (mặc định mọi thứ thuộc Node). Định dạng, luật khớp (tiền tố dài nhất + phương thức) và cách đổi sở hữu:
`server/crates/trinity-kernel/src/ownership.rs`, PLAN mục 4.14, `docs/runbooks/cutover.md`; từng đợt: `docs/runbooks/cutover-cac-dot.md`.

JSON thuần không có chỗ ghi chú nên việc chờ nằm ở bảng dưới. Mỗi tệp **tích luỹ** (gồm cả các đợt trước). Số route là số dòng khớp `rust` trong `server/contracts/routes.json` (đếm theo phương thức + đường dẫn) khi nạp tệp đó.

| Đợt | Tệp | Tiền tố giao cho `rust` (thêm so với đợt trước) | Job | Số route `rust` |
|---|---|---|---|---|
| a | `ownership-dot-a.json` | `/health`, `/ready`, `/live`, `/telemetry`, `/site-config`, `/settings`; giữ `node`: `/settings/channel-guard` | — | 18 |

**Việc chờ trước khi bật** (issue còn mở lúc viết mẫu):

- đợt a: không

Route không có dòng nào (`/notif-ws`, `/uploads`, `/.well-known`, `/docs`, 11 route đã gỡ của `RetiredRoutesController`) thuộc Node. `migrate` luôn `node`, `web` luôn `rust` (như `deploy/hybrid/ownership.json` mặc định).
Nạp thử một mẫu: `TRINITY_OWNERSHIP_FILE=$PWD/deploy/hybrid/mau/ownership-dot-a.json trinity check-config`.
