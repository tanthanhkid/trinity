# Runbook — Bật từng đợt a–e (mẫu tệp sở hữu và kiểm sau khi bật)

Issue X02a–X02e (#256–#260; PLAN mục 6.5, 4.14). Bổ sung cho `docs/runbooks/cutover.md`: file đó nói **cách** đổi sở hữu (sao lưu, ghi tệp nguyên tử, `SIGHUP`, lui, sửa dữ liệu
có chọn lọc); file này nói **bật cái gì** ở mỗi đợt, kiểm gì, lui ra sao và dấu hiệu lỗi riêng của đợt.

Các tệp mẫu nằm ở `deploy/hybrid/mau/ownership-dot-{a,b,c,d,e}.json`. **Chỉ là mẫu, không có đợt nào đang bật**: tệp chạy thật vẫn là `deploy/hybrid/ownership.json`
(mặc định mọi thứ thuộc Node). Bảng route theo module và việc còn chờ: `deploy/hybrid/mau/README.md`.

Quy ước chung của mẫu:

- **Tích luỹ**: tệp đợt N gồm toàn bộ dòng của các đợt trước cộng dòng của đợt N, vì chỉ có một tệp sở hữu. Bật đợt N = thay tệp chạy bằng mẫu N (sau khi bỏ chỗ khác biệt cục bộ có chủ ý).
- Tiền tố rộng (`/api/v1/users`, `/api/v1/management`, ...) giao cả nhóm; dòng `node` dài hơn chặn lại phần chưa tới đợt (luật tiền tố dài nhất, `trinity-kernel` ownership). Hai chỗ dùng cách này: `settings/channel-guard` (node tới đợt e) và `auth/settings/login-wifi-check-targets` (node tới đợt d).
- `migrate` luôn `"node"` trong mẫu: Rust chỉ **ghi** `_prisma_migrations` cho công ty mới từ đợt b (K07), còn migrate nền lúc boot đổi chủ ở X06, không thuộc các đợt này. `web` luôn `"rust"` như tệp mặc định hiện tại (W02b: Rust phục vụ web tĩnh); thay tệp bằng mẫu không làm đổi chủ của trang web.
- Route không có dòng nào (`/notif-ws`, `/uploads`, `/.well-known`, `/docs`, 11 route đã gỡ của `RetiredRoutesController`) thuộc Node và Rust chuyển tiếp như cũ.
- Kiểm trước mọi lần bật (ngoài danh sách mục 1 của `cutover.md`):

```
diff deploy/hybrid/ownership.json deploy/hybrid/mau/ownership-dot-<đợt trước>.json   # chỉ được khác chỗ có lý do; đợt a: so với tệp mặc định
TRINITY_OWNERSHIP_FILE=$PWD/deploy/hybrid/mau/ownership-dot-<đợt>.json trinity check-config
trinity check-routes                # độ phủ route 100% theo routes.json cho module trong đợt
trinity shadow-report --file "$SHADOW_REPORT_FILE"   # mã thoát 0 = mọi route safe_for_shadow đạt min_samples
```

Cách bật, lui, sao lưu: `cutover.md` mục 2, 4.1, 4.2 (một lần ghi tệp, `mv` nguyên tử, `SIGHUP`; dưới 2 phút; không khởi động lại tiến trình nào). Ở các đoạn dưới, `$BASE` là địa chỉ
biên của bản đang chạy (cổng Rust), `$TOKEN` là access token của người dùng thử ở công ty thử.

## Đợt a (X02a, #256) — health, telemetry, cấu hình trang, cài đặt, tuỳ chọn

Module: M06 (`mod-settings`) và K27 (`mod-system`). Mẫu: `deploy/hybrid/mau/ownership-dot-a.json` (health, ready, live, telemetry, site-config chỉ `GET`; cả `/api/v1/settings`
trừ `settings/channel-guard`). Điều kiện đã có trên `main`: K28 (shadow nối vào `serve`), K31, X01, X11, D01. Không còn việc chờ.

**Bật**

1. Làm bước chuẩn bị chung ở đầu file, rồi sao lưu theo `cutover.md` mục 2 (đợt đầu: lưu thêm `ownership.before.json` = tệp mặc định).
2. `cp deploy/hybrid/mau/ownership-dot-a.json deploy/hybrid/ownership.json.new`, kiểm `check-config`, `mv -f` thành `ownership.json`, `kill -HUP` (`cutover.md` 4.1).
3. Chạy `trinity check-invariants --state /var/lib/trinity/invariants.json`; đặt lịch mỗi giờ trong 72 giờ đầu (`docs/rust/invariants.md`).

**Kiểm sau khi bật** (làm trong 10 phút đầu)

```
curl -fsS $BASE/api/v1/health ; curl -fsS $BASE/api/v1/ready ; curl -fsS $BASE/api/v1/live
curl -fsS $BASE/api/v1/telemetry/config
curl -fsS $BASE/api/v1/site-config            # chỉ có ở Rust: 404 nghĩa là dòng site-config chưa được nạp
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/settings/options
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/settings/org-features
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/settings/usage
```

- `PATCH /api/v1/settings/departments` và `PUT /api/v1/settings/org-features` ở công ty thử: đổi rồi đọc lại bằng chính API và bằng SQL (`settings`, `setting_options`); công ty khác không đổi.
- `/api/v1/settings/channel-guard` vẫn do Node trả (đợt e mới đổi): gọi thử, mã và hình dạng giống trước khi bật.
- Log của Rust không có dòng lỗi nạp tệp sở hữu; Node bỏ qua các route trên (không còn log request của chúng).
- 5xx của `/api/v1/*` không tăng so với 24 giờ trước đợt.

**Lui**: theo `cutover.md` 4.2 bằng `ownership.before.json` (hoặc ghi lại `{"routes":[],"jobs":{},"migrate":"node"}`), `SIGHUP`, rồi smoke trên Node. Không có job nào đổi chủ ở đợt này nên không cần kiểm mục 5.

**Dấu hiệu lỗi**

| Dấu hiệu | Nguyên nhân hay gặp | Việc làm |
|---|---|---|
| `/api/v1/site-config` 404 | tệp chạy không có dòng site-config, hoặc tiến trình chưa nạp lại | `diff` với mẫu, gửi lại `SIGHUP` |
| `/api/v1/settings/channel-guard` đổi hình dạng trả lời | dòng `node` của `settings/channel-guard` bị mất khi sửa tệp | thêm lại dòng, `SIGHUP` |
| `settings/options` thiếu mục so với Node | lệch dữ liệu mặc định theo gói ngành | lui, so `setting_options` theo `cutover.md` mục 6 |
| 401 hàng loạt ở route cài đặt | `JWT_SECRET` hoặc `INTERNAL_SERVICE_SECRET` lệch giữa Rust và Node | sửa env, khởi động lại theo `hybrid.md`, không lui nếu chỉ do env |
| Shadow báo khác biệt mới sau khi bật | route `cached` đổi hình dạng | lui nếu ảnh hưởng người dùng, ghi vào X12a |

## Đợt b (X02b, #257) — đăng nhập, người dùng, vai trò, API key, đăng nhập công khai

Module: M01–M05 (`mod-auth`, `mod-users`, `mod-rbac-admin`, `mod-apikeys`). Mẫu: `ownership-dot-b.json` = đợt a cộng `/api/v1/auth` (trừ `auth/settings/login-wifi-check-targets`, thuộc đợt d),
`/users`, `/roles`, `/rbac`, `/api-keys`, `/public/auth`. **Bật cả cụm trong một lần ghi** (dùng chung trạng thái phiên). Điều kiện: đợt a đã qua 72 giờ đầu, bộ kiểm X11 xanh,
test hai chiều của migrator (K07) đạt trên bản sao schema thật. Không còn việc chờ về mã.

**Bật**

1. Đợt a xanh; ghi lại mốc `check-invariants`; chọn giờ ít người đăng nhập.
2. Thêm ngay trước khi bật: đếm phiên để so sau đó:
   `psql "$DATABASE_URL" -Atc "select count(*) from active_sessions; select count(*) from revoked_sessions; select count(*) from token_blacklist"` (lặp cho schema công ty thử).
3. Ghi `ownership-dot-b.json` thành tệp chạy và `SIGHUP` (`cutover.md` 4.1).

**Kiểm sau khi bật**

```
curl -fsS -X POST $BASE/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"<thử>","password":"<thử>"}'
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/auth/me
curl -fsS -X POST $BASE/api/v1/auth/refresh --cookie "<cookie refresh của người thử>"
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/users?page=1
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/roles
```

- **Không ai bị đăng xuất**: một phiên mở sẵn từ **trước** khi bật (đăng nhập bằng Node) vẫn gọi được `auth/me` và làm mới được; số `active_sessions` không giảm bất thường; token ký ở Node xác minh được ở Rust và ngược lại.
- Đăng ký **một công ty thử** bằng Rust (`POST /api/v1/auth/register`), rồi `prisma migrate status` trên schema công ty mới phải báo đã cập nhật và `trinity migrate --status` không còn mục chờ.
- Đổi mật khẩu rồi đăng nhập bằng mật khẩu mới ở cả hai bên (hash giữ định dạng cũ); lời mời: tạo, xem trước, nhận.
- Tạo API key ở công ty thử và dùng nó gọi `/api/v1/public/*` (route đó còn thuộc Node tới đợt e): key do Rust tạo Node phải chấp nhận.
- Giới hạn tốc độ đăng nhập nằm ở RAM từng bên (I3): thử sai mật khẩu liên tiếp không khoá nhầm người dùng khác.

**Lui**: `cutover.md` 4.2. Phiên và token đã cấp bởi Rust vẫn hợp lệ ở Node (cùng khoá ký, cùng định dạng); công ty đã đăng ký bằng Rust giữ nguyên, không xoá.

**Dấu hiệu lỗi**

| Dấu hiệu | Nguyên nhân hay gặp | Việc làm |
|---|---|---|
| Người dùng bị đăng xuất hàng loạt, `auth/refresh` 401 | lệch khoá ký hoặc định dạng cookie/refresh giữa hai bên | lui ngay, so `JWT_SECRET` và các khoá ký phiên giữa Rust và Node |
| Mọi request 400 "chữ ký nội bộ" | `INTERNAL_SERVICE_SECRET` lệch (D01) | sửa env cả ba tiến trình |
| `prisma migrate status` của công ty mới báo chưa cập nhật | migrator Rust ghi thiếu `_prisma_migrations` | lui đăng ký công ty (đưa `auth` về Node), mở X12b |
| `users`, `user_roles` thiếu dòng so với trước | ghi sai ở M03/M04 | lui, đối chiếu dump theo `cutover.md` mục 6 (bảng nhóm b ở 6.1) |
| Lời mời hay API key không dùng được ở bên kia | hash/định dạng token khác | lui, mở X12b |
| `check-invariants` đỏ ở `updated_at` lùi hoặc mã trùng | đường ghi người dùng | dừng bật đợt c |

## Đợt c (X02c, #258) — khách hàng, deal, kanban, bảng tuỳ biến, báo cáo, wizard dựng hệ thống

Module: M07, M08, M15–M21 (`mod-contacts`, `mod-deals`, `mod-kanban`, `mod-custom`, `mod-reports`, `mod-setup`). Mẫu: `ownership-dot-c.json` = đợt b cộng `/api/v1/contacts`, `/deals`,
`/interactions`, `/kanban`, `/custom-objects`, `/refs`, `/reports`, `/setup`. Điều kiện: đợt b qua 72 giờ đầu, X11 xanh, G12b (Node nhả việc nền theo tệp sở hữu) đã có. Không còn việc chờ về mã.

**Bật**: như đợt b, thay mẫu bằng `ownership-dot-c.json`. Trước khi ghi tệp, ghi số dòng các bảng chính để so sau:
`select (select count(*) from contacts), (select count(*) from deals), (select count(*) from kanban_cards), (select count(*) from custom_records)`.

**Kiểm sau khi bật**

```
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/contacts?page=1"
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/deals
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/kanban/boards
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/custom-objects
curl -fsS -H "Authorization: Bearer $TOKEN" $BASE/api/v1/reports/dashboard-overview
```

- Ghi: tạo khách, deal, thẻ kanban, bản ghi bảng tuỳ biến ở công ty thử; sửa, xoá mềm; đọc lại bằng chính API và SQL; nhập xuất bảng tuỳ biến một lần.
- **Chuông thông báo tới client khi việc tạo ở Rust mà socket còn ở Node**: mở hai trình duyệt (người A, người B), A tạo thẻ kanban giao cho B (và gán một khách cho B); chuông của B hiện trong vài giây qua `/notif-ws`,
  và có dòng mới trong `notification_logs`. Nếu có dòng mà không có chuông: kiểm đường `NOTIFY`/`trinity_sync` (K33) và route `POST /api/v1/events/notify-ws-emit` (còn ở Node tới đợt d).
- Báo cáo: so `reports/dashboard-overview` và `reports/custom/...` giữa Rust và Node cho cùng khoảng ngày; số liệu bằng nhau (cache `cached: true` chỉ so hình dạng).
- `setup/wizard`, `setup/build`: chỉ chạy thử ở công ty thử, không chạy ở công ty thật.
- Lọc `LIKE` có ký tự `%` `_` `\` trong từ khoá tìm khách trả đúng (không khớp tràn).

**Lui**: `cutover.md` 4.2. Khách, deal, thẻ ghi bằng Rust nằm cùng bảng nên Node đọc được ngay; không xoá gì.

**Dấu hiệu lỗi**

| Dấu hiệu | Nguyên nhân hay gặp | Việc làm |
|---|---|---|
| Không có chuông khi tạo việc ở Rust | thông báo ghi nhưng không đẩy tới socket Node | lui `kanban` và `contacts` về Node, mở X12c; kiểm `NOTIFY` |
| Danh sách khách ít hơn Node | bộ lọc `0` = không lọc, `page` lớn, escape LIKE | lui, đối chiếu `contacts` theo 6.1 |
| Số báo cáo lệch | múi giờ (`TZ` tiến trình khác UTC) hoặc cache | so `TZ` của hai bên, đợt d còn phụ thuộc điều này |
| 5xx ở `custom-objects` | công thức/bộ phân tích (M57), `json!` lớn | xem log, lui nếu lặp |
| `kanban_card_*` mồ côi | xoá thẻ không dọn bảng phụ | đối chiếu dump, sửa chọn lọc |

