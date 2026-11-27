# Nâng cấp từ bản Node

Hướng dẫn cho người đã cài Trinity bằng `docker-compose.yml` (hai image `trinity-api`, `trinity-web`, Node + Next) và sẽ
chuyển sang bản một tiến trình viết bằng Rust.

**Trạng thái.** Bản phát hành công khai hiện vẫn là bản Node; compose mặc định chưa đổi. Image `trinity` duy nhất, compose
mới và lệnh `install.sh` mới nằm ở issue [#264](https://github.com/tanthanhkid/trinity/issues/264) (X06, đang làm). Các mục
dưới đây ghi **thiết kế đã chốt cho bản đó** ([rust/PLAN.md](rust/PLAN.md) mục 4.13 và 8, [rust/ISSUES.md](rust/ISSUES.md)); tên tệp
và giá trị cụ thể sẽ được đối chiếu lại khi X06 vào `main`. Kịch bản thử nâng cấp tự động:
[#276](https://github.com/tanthanhkid/trinity/issues/276) (đang làm). Ai chạy cấu hình lai từ `main` thì đọc
[runbooks/hybrid.md](runbooks/hybrid.md).

## Tóm tắt thay đổi

| Hạng mục | Bản Node | Bản Rust (từ X06) |
|---|---|---|
| Image | `trinity-api`, `trinity-web` | `trinity` (một image, không có shell hay Node) |
| Service trong compose | `postgres`, `migrate`, `api`, `web` | `trinity`, `postgres` (migration chạy trong chính binary) |
| Bỏ hẳn | Redis (đã bỏ từ bản Node cuối), Prisma lúc chạy, Next server | `migrate`, `api`, `web` |
| Cổng chính | web `3000`, api `4000` | `3000` cho mọi thứ, gồm `/api/v1` và `/notif-ws` |
| Cổng tương thích | | `COMPAT_API_PORT` (mặc định `4000`), chỉ để proxy cũ chưa kịp sửa; xem dưới |
| Biến `PORT` | `PORT=4000` trong `.env.example` | bị bỏ qua, in một dòng cảnh báo |
| Người dùng trong container | `node` (uid 1000) | uid 1000, nên volume cũ vẫn ghi được |
| Volume | `pgdata`, `storage` (`/var/lib/trinity/storage`), `uploads` (`/app/uploads`) | giữ nguyên tên và đường dẫn |
| Healthcheck | `node -e fetch(...)` | `trinity healthcheck` (gọi `GET /api/v1/health` trên loopback) |
| Cơ sở dữ liệu | PostgreSQL 16, schema Prisma | không đổi; migration Rust và Prisma dùng chung bảng `_prisma_migrations`, checksum khớp |

Dữ liệu, tài khoản, phiên đăng nhập, tệp tải lên và khóa `INTEGRATIONS_SECRET_KEY` giữ nguyên; không có bước chuyển dữ liệu.

## Hành động bắt buộc

1. **Sao lưu** volume `pgdata` (hoặc `pg_dump` cơ sở dữ liệu `trinity`) và hai volume `storage`, `uploads` ([deployment.md](deployment.md), mục Backups).
2. **Giữ nguyên `.env`.** Bí mật (`JWT_SECRET`, `SERVICE_SECRET` hoặc `INTERNAL_SERVICE_SECRET`, `INTEGRATIONS_SECRET_KEY`) phải
   là giá trị cũ, nếu không phiên đăng nhập và bí mật webhook đã lưu sẽ không đọc được. Ở production binary từ chối khởi
   động khi còn giá trị `change-me-*` hoặc bí mật ngắn hơn 32 ký tự; chạy `trinity check-config` để biết trước.
3. **Đặt `TRUSTED_PROXY`** theo bảng ở [deployment.md](deployment.md#client-ip-trusted_proxy). Từ nay tiến trình Rust là tiến
   trình biên (trước đây là `web`), nên giá trị áp lên kết nối TCP tới nó. Quên bước này thì kiểm tra IP đăng nhập và chấm
   công không chạy theo IP thật, và quản trị viên thấy biểu ngữ cảnh báo.
4. **Sửa reverse proxy**: gỡ luật `/notif-ws/*` trỏ cổng 4000, trỏ mọi thứ về cổng chính
   ([deployment.md](deployment.md#reverse-proxy-for-the-rust-server-one-port)). Chưa kịp sửa thì chuông realtime vẫn chạy nhờ cổng
   tương thích, nhưng cổng đó sẽ bị gỡ (xem dưới).
5. **Bỏ đặt `PORT`** trong `.env` nếu có; không bắt buộc, chỉ để hết cảnh báo. Biến của phần đã gỡ (`REDIS_URL`, `BACKEND_URL`,
   `MONOLITH_INTERNAL_URL`, `AUTH_SERVICE_URL`, cấu hình Vercel Blob và kết nối đã gỡ, …) cũng bị bỏ qua kèm một dòng cảnh báo mỗi biến.
6. Nếu đứng sau proxy Cloudflare: đặt `SOCIAL_MAX_VIDEO_MB=95` ([giới hạn 100 MB / 100 giây](deployment.md#behind-the-cloudflare-proxy-100-mb-and-100-seconds)).

## Các bước

```bash
git pull                       # lấy compose mới, .env.example mới
docker compose pull            # hoặc: docker compose build
docker compose up -d           # service cũ migrate/api/web bị bỏ: thêm --remove-orphans
docker compose logs -f trinity # chờ health 200
```

Rồi kiểm: đăng nhập bằng tài khoản cũ, mở một tệp đã tải lên, tải một tệp mới lên (không báo lỗi quyền ghi), mở chuông
thông báo ở hai tab và xác nhận thông báo mới tới trong vài giây.

## Cổng tương thích 4000

Bản Node bắt reverse proxy trỏ `/notif-ws` thẳng vào cổng 4000; Next không chuyển tiếp WebSocket. Sau khi gỡ Node, nếu
không có gì nghe ở đó thì chuông realtime mất mà không có lỗi nào. Vì vậy binary nghe thêm `COMPAT_API_PORT`; trong
container là `0.0.0.0:4000`, compose công bố `127.0.0.1:${API_PORT:-4000}` (biến `API_PORT` vẫn là biến phía host như
trước). Với `TRUSTED_PROXY=cloudflare-tunnel` cổng này chỉ nghe loopback hoặc tắt. Cổng này **giữ tới hết bản phát hành lớn
kế tiếp** sau bản đầu tiên phát hành bản Rust; số bản cụ thể sẽ ghi vào `CHANGELOG.md` khi X06 phát hành. Hai cổng không
được trùng nhau (binary báo lỗi rõ và dừng).

## Lui về bản Node

Giữ `.env` và hai volume dữ liệu. Chạy lại compose của bản trước (`git checkout <thẻ cũ>`, `docker compose up -d --build`).
Migration chỉ thêm và Prisma đọc được cùng bảng `_prisma_migrations`, nên lui không cần khôi phục cơ sở dữ liệu, trừ khi
bản mới có migration mà bạn đã chạy; lúc đó khôi phục từ bản sao lưu ở bước 1. Kế hoạch giữ đường lui ít nhất 14 ngày sau
bản phát hành.

## Chưa có trong bản đầu

- Web tĩnh do Rust phục vụ ([#185](https://github.com/tanthanhkid/trinity/issues/185)): cho tới lúc đó giao diện vẫn là Next, do cấu hình lai chuyển tiếp.
- Tải video theo phần và xuất tệp dài chạy nền khi đứng sau proxy Cloudflare ([#277](https://github.com/tanthanhkid/trinity/issues/277), [#278](https://github.com/tanthanhkid/trinity/issues/278)).
- Số đo RAM và CPU trên máy 2 GB và 1 GB ([#263](https://github.com/tanthanhkid/trinity/issues/263)); cấu hình Postgres cho máy nhỏ trong
  [deployment.md](deployment.md#postgresql-on-small-machines) là điểm khởi đầu, chưa phải số đã đo.
