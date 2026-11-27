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

