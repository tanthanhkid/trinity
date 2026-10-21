# Kiểm thử "premium" bằng Chrome headless

Các script ở đây mở một Chrome headless riêng, dùng hồ sơ tạm và xoá hồ sơ khi đóng. Mọi lệnh gọi `/api/v1/*` bị chặn bằng CDP `Fetch` rồi trả dữ liệu giả từ `fixtures.mjs`. Script **không gọi máy chủ thật** và không dùng phiên đăng nhập thật. Kết quả được ghi vào `docs/TRANG-THAI.md`.

Trong CI, job **Web build and UI checks** (`.github/workflows/ci.yml`) chạy các script này trên bản `next build` standalone, cho mọi PR đụng `apps/web/`. Script nào báo lỗi thì job đỏ. Ngoại lệ đã biết nằm trong `ALLOW` của `ui-audit.mjs`, kèm lý do và hạn sửa.

## Chạy

1. Mở web ở chế độ dev, ví dụ cổng 3917: `cd apps/web && node node_modules/next/dist/bin/next dev -p 3917`.
2. Chạy script trong thư mục `apps/web`:
   - `node e2e/premium/contrast.mjs` đo tương phản chữ/nền từ token màu (không cần trình duyệt).
   - `node e2e/premium/ui-audit.mjs [đường-dẫn…]` rà nền tảng UI cho 5 màn chính:
     - tràn ngang ở 360px;
     - vùng chạm ≥ 44px;
     - focus bàn phím thấy được;
     - giảm chuyển động.
   - `node e2e/premium/break-it.mjs [tình-huống…]` "cố tình phá":
     - mất mạng giữa luồng;
     - API 500/401;
     - danh sách trống;
     - token kênh hết hạn;
     - đăng bài lỗi;
     - hoàn tác xoá.

     Mã thoát 1 nếu có tình huống lệch.
   - `node e2e/premium/probe.mjs /đường-dẫn` liệt kê các API một trang gọi, dùng khi thêm dữ liệu giả.

Biến môi trường:

- `BASE_URL`: địa chỉ web, mặc định `http://localhost:3917`.
- `CHROME_CHANNEL`: mặc định `chrome`, tức dùng Chrome đã cài sẵn trên máy, không tải trình duyệt.

Trên Git Bash (Windows), đặt `MSYS_NO_PATHCONV=1` để đường dẫn `/dashboard` không bị đổi thành đường dẫn ổ đĩa.

## Tệp

| Tệp | Việc |
|---|---|
| `harness.mjs` | Mở Chrome hồ sơ tạm, gắn phiên giả, chặn API bằng CDP Fetch, giả mất mạng |
| `fixtures.mjs` | Dữ liệu giả của một công ty mẫu. `handle(req, scenario)` cho phép ghi đè từng tình huống (lỗi 500/401, danh sách trống, token kênh hết hạn…) |
| `contrast.mjs` | Bảng tương phản WCAG cho các cặp màu màn A–C dùng, cả sáng lẫn tối |
| `ui-audit.mjs` | Đo tràn ngang, vùng chạm, focus, chuyển động |
| `break-it.mjs` | 9 tình huống "cố tình phá", in bảng kết quả |
| `probe.mjs` | Dò API của một trang |
