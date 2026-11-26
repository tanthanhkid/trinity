# Test hợp đồng HTTP hộp đen

Chỉ dùng `fetch` tới một địa chỉ gốc; không import mã backend. Chạy được trên bản Node hôm nay và trên binary Rust sau này
(PLAN mục 6.2, issue C06a).

## Chạy

```bash
# Postgres 16 local (brew) là đủ; bộ chạy tự dựng/xoá các DB `trinity_contract_*`
pnpm --filter @trinity/contract-tests test                        # Node, mọi hồ sơ có thư mục cases/<hồ sơ>
pnpm --filter @trinity/contract-tests test -- --profile default   # một hồ sơ
pnpm --filter @trinity/contract-tests test:unit                   # chỉ bộ chuẩn hoá
```

Bộ chạy (`run.ts`): dựng DB mẫu (migrate + seed admin), rồi với mỗi hồ sơ tạo DB từ mẫu, khởi động máy chủ **một lần** với env của
hồ sơ, chạy `cases/<hồ sơ>/*.test.ts`, tắt máy chủ. Máy chủ chạy với `TZ=UTC`, cổng 4310 (`CONTRACT_PORT`), env sạch (không đọc `.env`).
Từ chối bắt đầu trong khung 16:50-17:10 UTC (quanh nửa đêm Việt Nam, "hôm nay" đổi giữa lượt).

## So Node với Rust trong cùng lượt

```bash
pnpm --filter @trinity/contract-tests test -- --mode record --out /tmp/c06a-node          # Node, ghi kết quả đã chuẩn hoá
SERVER_CMD=/đường/dẫn/trinity SERVER_CMD_PRODUCTION=/đường/dẫn/trinity-release \
  pnpm --filter @trinity/contract-tests test -- --target cmd --mode compare --baseline /tmp/c06a-node
```

`golden(tên, vai, snap(res))` ghi (record) hoặc so (compare) `<out>/<hồ sơ>/<tên>.<vai>.json`. Golden commit ở
`server/contracts/golden/` chỉ để xem diff khi review (`UPDATE_GOLDEN=1 ... test`); chuẩn so là kết quả Node của cùng lượt chạy.
Hồ sơ `production` phía Rust chạy trên binary **phát hành** (không có `test-hooks`).

## Thêm một ca

1. Tạo `cases/<hồ sơ>/NN-ten.test.ts`; `afterAll(closeDb)`.
2. Seed bằng SQL ở `lib/db.ts` (`seedUser`, `seedContact`, `grant`, `setSetting`, hoặc `q(...)`). Mốc thời gian luôn **tương đối**:
   `now() - interval '…'` (`seedContact({ daysAgo })`). Không hằng ngày cứng.
3. Gọi qua `api.get/post/...` (`lib/http.ts`); mỗi lời gọi nên truyền `ip: freshIp()` để không dính giới hạn tốc độ theo IP.
   Cần chạy job hoặc xoá cache: `control.runJob(...)`, `control.flushCache()` (API điều khiển test, không có ở hồ sơ `production`).
   Sửa quyền trong DB rồi gọi lại thì phải `flushCache()`.
4. Route đọc dữ liệu khách mà hình dạng đổi theo quyền (cột `shape_permissions` của `routes.json`): ghi golden cho 3 vai `admin`,
   `leader`, `sale` (xem `07-contacts-three-roles.test.ts`).
5. Golden: `golden('ten-ca', vai, snap(res))`. Trường động đã được chuẩn hoá (`lib/normalize.ts`): id → `<id:n>`, thời điểm gần
   bây giờ → `<now>`, xa hơn → `<time:-3d>`, ngày → `<vn-day:-1>`, token → `<token>`, uuid, email `@contract.test`. Nhãn mới thì thêm vào
   `Normalizer` và `unit/normalize.test.ts`.
6. Tên vai trò/giá trị nằm trong response phải ổn định giữa các lần chạy; chạy 3 lần và `diff -r` các thư mục `--out` phải trống.

## Thêm một hồ sơ cấu hình

1. Tạo `profiles/<tên>.env` chỉ gồm biến **khác** `default.env` (một biến trống `X=` nghĩa là đặt rỗng).
2. Tạo `cases/<tên>/` với các ca cần hồ sơ đó. Ca nào đổi `process.env` giữa ca ở e2e cũ thì chuyển thành ca của một hồ sơ.
3. Hồ sơ hiện có: `default`, `integrations-off`, `no-secret-key`, `bad-secret-key`, `no-public-base-url`, `private-targets`,
   `restricted-origins`, `production`. Bộ chạy mặc định chỉ chạy hồ sơ nào có thư mục `cases/<tên>/`; hiện có `default` và `production`,
   các hồ sơ còn lại chờ ca ở C12a–C13b.

## Ca bị chuyển loại / chưa chuyển
Khung này chưa chuyển ca e2e nào (việc của C07–C13); 10 ca mẫu ở `cases/` chứng minh từng khả năng: job (`04`), xoá cache (`05`), `now`
(`04`), hồ sơ `production` (`cases/production`), response theo ngày (`06`), ba vai (`07`), công ty thứ hai (`03`), validation strict/lenient (`02`),
ca sinh từ `routes.json` (`08`), đăng nhập (`02`), health (`01`).
