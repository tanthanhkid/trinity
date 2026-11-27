# Runbook — Quét GET trên bản sao dữ liệu thật (X13)

> **Lưu trữ (X06, 27/11/2026).** Quét này so response của Node với Rust trên cùng bản sao dữ liệu; từ X06 không còn bản Node trong cây nên không còn gì để so cùng lượt. Tài liệu giữ cho lịch sử và cho đường lui 14 ngày (checkout tag trước X06). Chuẩn so hiện hành là golden ghi lần cuối ở X03 (`tests/contract`).

Dùng khi route `safe_for_shadow` chưa đủ `min_samples` sau 48 giờ shadow (`docs/runbooks/cutover.md`, mục 1). Khôi phục bản dump vào một máy
quét riêng, chạy Node và Rust cùng trỏ vào bản sao đó, gọi mọi route GET `safe_for_shadow` với id lấy từ chính bản sao, so hai response
**như shadow K28** (`server/crates/trinity-http/src/strangler/shadow.rs`, hàm `compare`; bản TS `tests/contract/sweep/compare.ts`, so chặt,
không `shape_only`). Route `cached: true` được so chặt ở đây vì cả hai bên chạy với cache tắt.

## 0. Ràng buộc (không thoả thì không quét)

- Máy quét do chủ dự án quản lý, **ổ đĩa mã hoá** (BitLocker/LUKS), không chia sẻ, không có đường ra sản xuất; không cài lại dịch vụ nào trỏ về bản thật.
- Dùng `JWT_SECRET` **riêng** của máy quét (sinh mới cho mỗi lần quét). **Không bao giờ** dùng `JWT_SECRET`, `INTEGRATIONS_SECRET_KEY` hay
  bất kỳ bí mật nào của bản thật. Token do script tự ký bằng bí mật riêng này; người dùng lấy từ bản sao nhưng mật khẩu không cần.
- Bản sao chứa dữ liệu khách thật: không sao chép ra ngoài máy quét, không dán vào issue/chat. **Báo cáo không có giá trị dữ liệu** (chỉ route,
  số đếm, đường dẫn + loại khác biệt) nên là thứ duy nhất được đưa ra khỏi máy.
- Hai backend phải tắt tích hợp ra ngoài (không đặt token Facebook/Zalo/Google, `INTEGRATIONS_*` trống) để route đọc không gọi mạng.
- Xoá bản sao ngay sau khi quét (mục 6).

## 1. Chuẩn bị máy quét

```
export SCAN_DIR=/srv/x13-scan            # nằm trên ổ mã hoá
umask 077; mkdir -p $SCAN_DIR && cd $SCAN_DIR
export SWEEP_JWT_SECRET="$(openssl rand -hex 32)"   # bí mật riêng, chỉ ở biến môi trường của phiên shell này; không ghi ra tệp
```

Không ghi `SWEEP_JWT_SECRET` vào `.env`, lịch sử shell (`set +o history` trước khi nhập tay) hay log. Đóng shell là mất bí mật.

## 2. Khôi phục bản dump vào Postgres riêng

```
docker run -d --name x13-pg -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" -p 127.0.0.1:55432:5432 postgres:16   # chỉ loopback
createdb -h 127.0.0.1 -p 55432 -U postgres trinity
pg_restore -h 127.0.0.1 -p 55432 -U postgres -d trinity --no-owner <đường-dẫn-bản-dump>
```

Phiên bản Postgres và tên DB lấy theo bản thật. Kiểm: `trinity migrate --status` (Rust) và `prisma migrate status` (Node) đều trỏ vào
bản sao và báo đã cập nhật. Với công ty khác công ty 1 (MULTI_TENANT) đặt thêm `SWEEP_SCHEMA=c_<id>` và `SWEEP_COMPANY_ID=<id>`.

## 3. Chạy Node và Rust cùng trỏ vào bản sao

Cả hai: cùng `DATABASE_URL` của bản sao, cùng `JWT_SECRET=$SWEEP_JWT_SECRET`, **`TRINITY_DISABLE_READ_CACHE=1`**, `TZ=UTC`, không có
`REDIS_URL`, không có khoá tích hợp. Node cổng 3000, Rust cổng 3100 (`trinity serve`), chỉ bind loopback. Không bật shadow (`SHADOW_SAMPLE_RATE=0`)
và để mọi route thuộc đúng một bên phục vụ trực tiếp (không chạy qua strangler): script gọi thẳng từng backend. Tắt job nền của cả hai
bên (không để hai bên cùng ghi vào bản sao khi quét): Rust `trinity serve` không bật job; Node chạy ở chế độ chỉ web nếu có, nếu không thì
chấp nhận việc job Node ghi nhẹ vào bản sao và ghi chú vào kết quả.

Kiểm cờ cache đã tắt: gọi hai lần liên tiếp `GET /api/v1/contacts?limit=1` sau khi sửa một dòng bằng SQL trên bản sao; cả hai lần phải thấy dòng mới.

## 4. Chạy quét

```
cd tests/contract           # đã `pnpm install` ở máy có mạng trước khi chuyển sang máy quét (không tải gì trên máy quét)
export SWEEP_NODE_URL=http://127.0.0.1:3000 SWEEP_RUST_URL=http://127.0.0.1:3100
export SWEEP_DATABASE_URL=postgres://postgres:<mật-khẩu-tạm>@127.0.0.1:55432/trinity
export SWEEP_USER_IDS=<id quản trị>,<id trưởng nhóm>,<id nhân viên>   # tuỳ chọn: mỗi người một vai, vì `shape_permissions` đổi hình dạng response
pnpm sweep
```

Script (`tests/contract/sweep/run.ts`): chỉ chọn `method = GET` và `safe_for_shadow = true` trong `server/contracts/routes.json`; kết nối DB ở chế độ
chỉ đọc; thay tham số đường dẫn bằng id lấy từ bảng tương ứng (`tests/contract/sweep/param-map.ts`, mỗi quy tắc là SQL cố định); mỗi route
gọi tối thiểu `min_samples` lần (ít id hơn thì lặp xoay vòng id và người dùng; `distinct_requests` trong báo cáo cho biết số yêu cầu khác nhau);
ký token HS256 ngắn hạn bằng `SWEEP_JWT_SECRET`. Mã thoát 0 chỉ khi mọi route đủ mẫu, không khác biệt, không lỗi mạng; 1 nếu không; 2 nếu cấu hình sai.

Route có tham số mà `param-map.ts` chưa có quy tắc nằm trong `no_sampler` của báo cáo và bị tính thiếu mẫu: bổ sung quy tắc (và test ở
`tests/contract/unit/sweep.test.ts`) rồi chạy lại, không đoán id. Hiện `GET /social/media-link/:token/:name` (token ký sẵn) thuộc loại này.
Route cần query bắt buộc chưa được hỗ trợ (script không gửi query): ghi vào kết quả nếu gặp.

## 5. Đọc báo cáo

`tests/contract/.out/sweep-report.json` (đổi bằng `SWEEP_OUT`). Mỗi route: `samples`, `reached_min_samples`, `equal`, `different`,
`status_mismatch`, `errors`, `no_sampler`, `diffs[] = {entry: "$.a.b[].c|value", count}`. Loại khác biệt: `type`, `value`, `array_length`,
`missing_in_rust`, `missing_in_node`, `content_type`, `body`. Đường dẫn có khoá không phải định danh thuần (tên khách dùng làm khoá,
email, số) bị thay bằng `<key>`; script từ chối ghi báo cáo nếu bước kiểm cuối thấy chuỗi lạ. Đính báo cáo vào issue của đợt (X02a–X02e); tiêu chí:
`summary.below_min_samples` rỗng và `summary.with_differences` rỗng, hoặc khác biệt có lý do trong danh sách cho phép.

## 6. Xoá bản sao (bắt buộc, kể cả khi quét lỗi)

```
pkill -f "trinity serve"; pkill -f "node .*monolith"            # dừng hai backend
docker rm -f -v x13-pg                                          # xoá container và volume dữ liệu
shred -u <đường-dẫn-bản-dump> 2>/dev/null || rm -f <đường-dẫn-bản-dump>
unset SWEEP_JWT_SECRET SWEEP_DATABASE_URL SWEEP_USER_IDS
rm -rf $SCAN_DIR/*                                              # chỉ để lại báo cáo đã duyệt nếu cần, copy ra trước
```

Ghi vào issue: thời điểm xoá, người xoá. Thư mục dữ liệu Postgres nằm ngoài Docker thì xoá bằng `shred`/`cryptsetup luksErase` theo chính sách máy quét.
Lần quét sau sinh `SWEEP_JWT_SECRET` mới.
