# Test hợp đồng HTTP hộp đen

Chỉ dùng `fetch` tới một địa chỉ gốc; không import mã backend. Chạy được trên bản Node hôm nay và trên binary Rust sau này
(PLAN mục 6.2, issue C06a).

## Chạy

```bash
# Postgres 16 local (brew) là đủ; bộ chạy tự dựng/xoá các DB `trinity_contract_*`
pnpm --filter @trinity/contract-tests contract                    # Node, mọi hồ sơ có thư mục cases/<hồ sơ>
pnpm --filter @trinity/contract-tests contract -- --profile default   # một hồ sơ
pnpm --filter @trinity/contract-tests test                       # chỉ test đơn vị bộ chuẩn hoá (không cần Postgres)
```

Bộ chạy (`run.ts`): dựng DB mẫu (migrate + seed admin), rồi với mỗi hồ sơ tạo DB từ mẫu, khởi động máy chủ **một lần** với env của
hồ sơ, chạy `cases/<hồ sơ>/*.test.ts`, tắt máy chủ. Luôn build monolith trước (`--no-build` để bỏ qua). Máy chủ chạy với `TZ=UTC`, cổng 4310 (`CONTRACT_PORT`), env sạch (không đọc `.env`).
Nhiều lượt chạy cùng máy: đặt `CONTRACT_PORT` và `CONTRACT_DB_PREFIX` riêng (mặc định `trinity_contract`, cổng 4310) để không giẫm DB và cổng của nhau.
Từ chối bắt đầu trong khung 16:50-17:10 UTC (quanh nửa đêm Việt Nam, "hôm nay" đổi giữa lượt).

## So Node với Rust trong cùng lượt

```bash
pnpm --filter @trinity/contract-tests contract -- --mode record --out /tmp/c06a-node          # Node, ghi kết quả đã chuẩn hoá
SERVER_CMD='["/đường/dẫn/trinity"]' SERVER_CMD_PRODUCTION='["/đường/dẫn/trinity-release"]' \  # mảng JSON: lệnh + đối số
  pnpm --filter @trinity/contract-tests contract -- --target cmd --mode compare --baseline /tmp/c06a-node
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

## Ca đã chuyển từ e2e cũ
- C07b (32 ca): `cases/default/40-roles-admin` (20, từ `roles-admin.e2e-spec`), `41-session-lifecycle` (6), `42-route-audit` (2), `43-smoke` (4).
  Dàn dựng viết lại bằng SQL: `seedAdmin` (vai trò hệ thống), `lockOtherAdmins` (ca "Quản trị cuối cùng": khoá các Quản trị còn lại rồi mở
  lại, vì mọi ca chung một DB nên không `TRUNCATE user_roles` như bản cũ). Tên vai trò mang hậu tố riêng của lượt chạy.
  `42-route-audit`: boot-check Nest (`auditRoutes`) không chạy được từ ngoài, nên ca kiểm kết quả của nó trên `server/contracts/routes.json`
  (mọi route có khai báo quyền; route xuất file có `*.export`); `43-smoke` lấy số quyền/scope từ `server/contracts/rbac.json` thay vì hằng cứng
  (e2e cũ ghi 62 quyền, hợp đồng hiện có 61). Bốn file này không có `RbacCache.invalidateUsers` trực tiếp (sửa vai trò qua API đã tự vô hiệu cache);
  6 chỗ gọi `invalidateUsers` của e2e cũ nằm ở ca MCP/OAuth/webhook (C10 trở đi).
- Hai bộ chạy song song trên cùng máy dùng chung tên DB `trinity_contract_*` và cổng 4310 sẽ giẫm nhau; đặt `CONTRACT_PORT` riêng và (nếu cần) đổi tên DB mẫu.

## Ca e2e đã chuyển (C09)
- C09 (22 ca, hồ sơ `default`): `20-custom-objects` (14, từ `custom-objects.e2e-spec.ts`) và `21-custom-object-templates` (8, từ `custom-objects-templates.e2e-spec.ts`).
  Mỗi ca bắt đầu bằng `resetCustom()` (TRUNCATE `custom_records/fields/objects`, `integration_events`) vì e2e gốc dọn ở `afterEach` và nhiều ca dùng cùng khoá
  thực thể (`hoc_sinh`) và đếm bảng. Các ca đếm bằng `prisma.*.count()` đổi thành SQL. Ca SĐT và danh sách mẫu ghi golden 3 vai (`lib/roles.ts`).

## Máy chủ giả Graph và Zalo (C06b)

Bộ chạy mở một máy chủ giả (`mock/channels.ts`, cổng 4311 hoặc `CONTRACT_MOCK_PORT`) và trỏ máy chủ Trinity tới nó bằng
`FACEBOOK_GRAPH_BASE_URL`, `ZALO_OAUTH_BASE_URL`, `ZALO_OPENAPI_BASE_URL`, `ZALO_ZNS_BASE_URL`. Mặc định trả thành công; ca test đặt
kịch bản lỗi và đọc lời gọi qua `lib/channels.ts`:

- `mock.reset()` (đầu mỗi ca), `mock.rules({ match: 'POST me/messages', status, json, times? })`, `graphFail(match, code, subcode?)` (mã Graph
  368/551/17/32/4/613/190), `mock.calls()` (đã ghi: phương thức, đường dẫn, dịch vụ, có/không header xác thực, thân; không ghi token),
  `mock.unexpected()` (đường chưa có kịch bản: máy chủ giả trả 501, ca và bộ chạy đều coi là lỗi).
- Seed kênh bằng SQL: `seedFacebookPage`, `seedFacebookConversation`, `seedZaloConnection`, `seedZaloThread`; bản mã token do `encryptSecret`
  (cùng định dạng `secret-crypto.ts`, khoá của hồ sơ).
- **Chặn mạng:** với `--target node`, máy chủ chạy với `--require mock/block-network.cjs` (từ chối kết nối TCP và tra DNS ngoài loopback,
  ghi vào `CONTRACT_NET_VIOLATIONS`); có vi phạm thì hồ sơ đỏ. Bản Rust cần chặn tương đương ở mức hệ điều hành.
- Máy chủ giả chạy trong tiến trình bộ chạy nên mọi lệnh con của bộ chạy phải bất đồng bộ (`spawnSync` làm nó đứng).

## Ca bị chuyển loại / chưa chuyển
Các ca e2e còn lại chuyển ở C07a và C08–C13; 10 ca mẫu ở `cases/` chứng minh từng khả năng: job (`04`), xoá cache (`05`), `now`
(`04`), hồ sơ `production` (`cases/production`), response theo ngày (`06`), ba vai (`07`), công ty thứ hai (`03`), validation strict/lenient (`02`),
ca sinh từ `routes.json` (`08`), đăng nhập (`02`), health (`01`).
