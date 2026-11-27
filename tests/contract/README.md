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

## Ca e2e đã chuyển (C12a: webhook ra, `webhooks-out.e2e-spec.ts`, 34 ca)
Bảng ánh xạ chỗ đổi env / gọi hàm nội bộ → hồ sơ / API điều khiển. 45 test chạy (34 `it` + `it.each` 11 đích SSRF; ca production nằm sẵn ở `cases/production`).

| Ca gốc | Đổi gì ở e2e gốc | Chuyển sang |
|---|---|---|
| 403 mọi route; DTO sai/404/400; danh mục sự kiện; `it.each` SSRF ×11; sửa URL sang nội bộ | `enable()` bật cờ + khoá | `default` (`30-webhooks-out-config`). Danh mục: spec gốc đòi 15 sự kiện, danh mục hiện có nhiều hơn; ca so với `server/contracts/events.json`. Ca sửa URL: endpoint nội bộ seed bằng SQL (đường tạo không cho) |
| cờ tắt → 404 | xoá `INTEGRATIONS_*` | `integrations-off` |
| cờ TẮT: tick không làm gì | xoá cờ giữa ca rồi `dispatcher.tick()` | `integrations-off` (seed endpoint + outbox bằng SQL, `control.runJob('webhook-dispatch')` trả `skipped`) |
| thiếu / sai `INTEGRATIONS_SECRET_KEY` (1 ca, 2 nửa) | đặt env giữa ca | tách theo hồ sơ: `no-secret-key` và `bad-secret-key` |
| production giả lập vẫn chặn 127.0.0.1 | đặt `NODE_ENV=production` giữa ca | đã có ở `cases/production/01-production.test.ts` (C06a, binary/hồ sơ production thật) |
| 2 ca CRUD + secret | `ALLOW_PRIVATE_TARGETS` | `private-targets` (`01`) |
| 8 ca gửi thật; 4 ca thử lại; 5 ca chủ thể; 8 ca nhận việc + biên | `enable()` + `ALLOW_PRIVATE_TARGETS`, `dispatcher.tick()`, 62 lời gọi Prisma | `private-targets` (`02` đến `05`); `tick()` = `control.runJob('webhook-dispatch')`; Prisma → SQL; `publishIntegrationEvent` → `INSERT integration_events` |
| `RbacCache.invalidateUsers` | gọi hàm trong tiến trình | `control.flushCache()` |
| ca đổi khoá: secret cũ không giải mã được | đổi env giữa ca | seed bản mã của khoá khác bằng SQL (`encryptWithForeignKey`) |

Ca bị chuyển loại phần gọi hàm: `dispatcher.dispatchEvents()` đứng riêng (không gửi) nay seed delivery chờ bằng SQL (`pendingDelivery`) rồi kiểm phần còn lại; `worker.claim()` hai lần đồng thời, ghi kết quả muộn của lượt nhận cũ (`processBatch(first)`) và
`sweepExhausted()` đứng riêng không còn gọi được từ ngoài: phần "không nhận trùng / lease / trần 7 lần / quét dead" kiểm qua `tick`, phần ghi muộn và claim song song thật kiểm ở test Rust `webhooks_pg.rs`.

## Ca bị chuyển loại / chưa chuyển
Đã chuyển (C11, hồ sơ `default`, 34 ca): `cases/default/20-commerce` (5, từ `commerce.e2e-spec`), `21-pos-dashboard` (6), `22-payroll-notification` (21), `23-notification-reaper` (2, `reapStuckProcessing(NOW)` → `control.runJob('notification.reap-stuck', { now })`, `createLog` → `POST /notifications/send` hẹn giờ + đọc log bằng SQL). Các ca e2e còn lại chuyển ở C07a và C08–C13. 10 ca mẫu ở `cases/` chứng minh từng khả năng: job (`04`), xoá cache (`05`), `now`
(`04`), hồ sơ `production` (`cases/production`), response theo ngày (`06`), ba vai (`07`), công ty thứ hai (`03`), validation strict/lenient (`02`),
ca sinh từ `routes.json` (`08`), đăng nhập (`02`), health (`01`).

## Ca e2e đã chuyển
- C08 (28 ca, hồ sơ `default`): `10-contacts-rbac` (12, từ `contacts.e2e-spec.ts`), `11-deals-rbac` (8, `deals.e2e-spec.ts`), `12-deals-won-date` (1; thay
  `BriefingAggregatorService.collect(…, NOW)` trong tiến trình bằng `control.runJob('briefings.collect', { owner, slot, now })`),
  `13-settings-options` (3), `14-org-features` (4; ca "mặc định bật hết" seed `setup_status=da_dung` vì DB mới ở trạng thái chưa dựng quy trình).
  Ca đọc dữ liệu khách ghi golden 3 vai qua `lib/roles.ts`. Ghi chú đổi so với e2e gốc: `deals` ca "scope own" khẳng định thêm
  KHÔNG thấy deal người khác; ca khoá lạ của `org-features` ghi golden thay vì giả định harness whitelist (máy chủ thật trả 400).

## Độ phủ route theo cụm (C14a)

`call()` ghi mỗi lời gọi vào `<out>/coverage/<hồ sơ>/<pid>.jsonl`; `lib/coverage.ts` ghép với `server/contracts/routes.json` rồi tính, cho từng route của một cụm,
bốn loại ca: **thành công**, **từ chối** (401 không token; route `can` cần cả 403 thiếu quyền), **đầu vào sai** (400: thân sai hoặc id không phải số), **không tồn tại** (404 với `:id`).
Cụm (theo tên controller) và miễn trừ có lý do khai ở `coverage-clusters.json`. File `99-coverage-<cụm>.test.ts` chạy cuối hồ sơ `default` và đỏ nếu còn route thiếu loại ca; báo cáo ghi ở `<out>/coverage/default/<cụm>.report.json`.
Phải chạy cả hồ sơ (không chạy lẻ file `99-`). Cụm `auth-settings`: 63 route; ca sinh từ metadata ở `60-auth-settings-generated.test.ts`, ca thành công và golden 3 vai (`users.phone_full`) ở `61-auth-settings-flows.test.ts`.
Khi so hai lượt bằng `diff -r`, thêm `-x coverage` (tên file đo độ phủ theo pid).
