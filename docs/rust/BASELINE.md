# Baseline bản Node (R003)

Đo bằng `tests/load/baseline.sh` (một lệnh; xem đầu file), tải do `tests/load/run.mjs` tạo: `GET /health`, `GET /contacts?limit=20` (có đăng nhập), `POST /auth/login`; 15 giây mỗi kịch bản, 10 và 50 kết nối đồng thời; chạy trực tiếp vào Node rồi qua Next (rewrite sang Node). Script đặt bí mật ngẫu nhiên riêng cho mỗi lần chạy, chạy `NODE_ENV=production`, Redis cổng 6390, Node 4210, Next 3210, DB riêng đã seed (5 khách demo).

## Giới hạn của lần đo này (đọc trước khi dùng số)

- **Máy đo: Mac arm64 16 GB, không phải máy 2 GB.** Tiêu chí "máy 2 GB" chưa đạt bằng số đo thật; kịch bản chạy nguyên trên Linux 2 GB (e2-small) bằng cùng một lệnh, và ở đó ghi thêm PSS và swap. Số RAM dưới đây là RSS tiến trình (macOS không có PSS).
- Máy đo vừa chạy việc khác và bộ tạo tải cùng máy tranh CPU với server: **độ trễ dao động rất lớn giữa các lần chạy** (lần chạy thử trước đó cho `contacts` 50 kết nối p95 22 ms trực tiếp, lần chính thức 125 ms). Dùng số này làm bậc độ lớn; số dùng để so Rust phải đo lại trên cùng máy, cùng điều kiện, lặp ≥3 lần lấy trung vị.
- Chưa có Rust proxy nên "cấu hình lai" ở đây là **Node + Next** (Next đứng trước, rewrite sang Node); phần Rust đo ở X05 bằng cùng script (thêm một hàng).
- Một công ty (`MULTI_TENANT=false`), 5 khách: `contacts` nhẹ hơn dữ liệu thật.

## Số đo (lần chạy 26/11/2026, `mac-arm64-16gb`)

RAM (RSS, MB):

| Thành phần | Rỗi (5 giây sau khi lên) | Đỉnh khi tải |
|---|---|---|
| Node monolith | 335 | 684 |
| Next server (standalone) | 105 | 436 (qua Next) |
| Redis | 6 | 6 |
| Cộng (Node + Next + Redis) | ~446 | ~1.125 |

Postgres: 1 kết nối lúc rỗi, **5 đỉnh** (một công ty). Khởi động Node tới khi `/health` 200: ~2,0 giây.

Độ trễ và thông lượng (ms):

| Kịch bản | Kết nối | Trực tiếp Node: rps / p50 / p95 | Qua Next: rps / p50 / p95 |
|---|---|---|---|
| `GET /health` | 10 | 9.499 / 0,7 / 3,0 | 1.266 / 4,0 / 28,3 |
| `GET /health` | 50 | 10.529 / 3,3 / 13,7 | 439 / 49,1 / 382,7 |
| `GET /contacts?limit=20` | 10 | 1.393 / 4,9 / 19,4 | 343 / 12,3 / 108,2 |
| `GET /contacts?limit=20` | 50 | 1.180 / 26,9 / 125,2 | 777 / 27,0 / 224,0 |
| `POST /auth/login` | 2 | 13,5 / 127,7 / 301,7 | 17,7 / 108,1 / 142,5 |

CPU trung bình (% của 1 lõi): trực tiếp: Node 145%; qua Next: Node 71%, Next 39%.

Nhận xét: đường qua Next làm `GET /contacts` 10 kết nối chậm hơn khoảng 2,5 lần ở p50 và rps giảm mạnh ở cả hai mức — tức proxy Rust đứng trước phải rẻ hơn Next rõ rệt, nếu không giai đoạn lai chậm hơn hiện tại. Đăng nhập (~110–130 ms) do băm mật khẩu, không phụ thuộc đường vào.

## Ngưỡng lui trong giai đoạn lai (đề xuất, chốt khi đo trên máy 2 GB)

Cộng dồn đỉnh Node + Next + Redis đã ~1,1 GB trước khi tính Postgres và hệ điều hành: **cấu hình lai không vừa máy 2 GB nếu không hạ**. Đề xuất: đặt `TENANT_MAX_CLIENTS` và `TENANT_CONNECTION_LIMIT` thấp, `--max-old-space-size` cho Node (ví dụ 384) và cho Next; lui về bản Node thuần khi một trong hai điều kiện kéo dài > 5 phút: swap dùng > 256 MB, hoặc `MemAvailable` < 200 MB. Kiểm trên Linux 2 GB bằng `baseline.sh` (dòng "Swap dùng") trước khi chốt các số này.

## Chạy lại

```bash
pnpm install --frozen-lockfile && pnpm db:generate
pnpm --filter "./packages/*" build && pnpm --filter @trinity/monolith build
NEXT_PUBLIC_API_URL=/api/v1 pnpm --filter web build
# DB riêng đã migrate + seed (SEED_DEMO_DATA=true)
DATABASE_URL=postgresql://u:p@localhost:5432/trinity_baseline EMAIL=... PASSWORD=... tests/load/baseline.sh <nhãn>
```
