# Đánh giá thay chrono / chrono-tz bằng jiff (#301)

Ngày 27/11/2026. Việc đánh giá, không đổi mã. Số liệu đếm trên `origin/main` (6c99997a), thư mục `server/`.

## Bối cảnh

RustSec đánh dấu `chrono` (RUSTSEC-2026-0543) và `chrono-tz` (RUSTSEC-2026-0555) là không còn bảo trì, không phải lỗ hổng.
`server/deny.toml` đang `ignore` hai mã này kèm lý do trỏ về #301.

## Hiện trạng dùng

| Chỉ số | Số đếm |
|---|---|
| File `.rs` nhắc `chrono` | 119 (khoảng 167 dòng `chrono`) |
| Crate khai báo `chrono` | 17 crate (`mod-*`, `trinity-auth`, `trinity-db`, `trinity-docgen`, `trinity-integrations`, `trinity-kernel`...) |
| Crate khai báo `chrono-tz` | **1**: `trinity-kernel` |
| File dùng `chrono_tz` | **1**: `trinity-kernel/src/vn_time.rs` (`Tz`, `Asia::Ho_Chi_Minh`, hàm `to_vn`) |
| `Utc::now` | 115 |
| `DateTime<Utc>` | 286 |
| `NaiveDate` / `NaiveDateTime` | 86 / 23 |
| `FixedOffset` | 7 (chủ yếu `vn_offset()` UTC+7 cố định) |
| `Duration::` / `TimeDelta` | 409 |
| `parse_from_rfc3339` / `parse_from_str` | 20 / 19 |
| `with_timezone` và tương đương | 20 |
| `.format(` | 28 |
| `timestamp()` / `timestamp_millis()` | 67 |
| `Datelike` / `Timelike` | 13 |
| `from_timestamp*` | 10 |

Loại thao tác: lấy giờ hiện tại, cộng trừ khoảng, đọc RFC 3339 và ngày `YYYY-MM-DD`, đổi sang giờ VN, định dạng chuỗi
kiểu `Intl`, đọc/ghi cột `timestamptz` và `date` qua `sqlx`, ghi ngày vào xlsx (`trinity-docgen`).

Phần xử lý múi giờ nằm gọn ở một file: `trinity-kernel/src/vn_time.rs`. Bên ngoài file đó gần như chỉ dùng
`DateTime<Utc>` và `NaiveDate`. Phần tính "Asia/Ho_Chi_Minh" ở SQL dùng `AT TIME ZONE` của Postgres, không đi qua crate nào.

## Rủi ro múi giờ Asia/Ho_Chi_Minh

- Bản TS dùng `Intl` với cơ sở dữ liệu IANA: trước 13/06/1975 miền Nam dùng UTC+8, nên `to_vn` (qua `chrono-tz`) mới
  khớp từng byte với ngày cũ (năm sinh, mốc 1970). Bất kỳ thư viện thay thế nào cũng phải giữ đúng hành vi này.
- Chỗ TS cộng cứng 7 giờ hoặc viết `+07:00` (khoảng ngày lọc, giờ làm việc) đã tách riêng, dùng UTC+7 cố định
  (`vn_to_utc`, `fixed_vn`). Giữ tách đôi này sau khi đổi thư viện, không gộp hai đường.
- `jiff` dùng IANA tzdb (đọc từ hệ thống, hoặc nhúng qua `jiff-tzdb`). Máy 1-2 GB, container tối giản có thể không có
  `/usr/share/zoneinfo`: phải bật tzdb nhúng (`tzdb-bundle-always`) để binary tự đủ.
- Bảng ca `server/contracts/cases/kernel.json` (dùng chung với TS) là cổng kiểm: đổi thư viện xong phải xanh bảng này
  và `crates/trinity-kernel/tests/shared_cases.rs`.

## Parse dạng `@IsDateString`

Các bộ đọc đang tự viết, không dựa vào `parse_from_rfc3339` thuần: `mod-hr` (`parse_instant`, golden sinh bằng Node
thật: `YYYY`, `YYYY-MM`, giờ, `Z`, `±HHmm`, dấu cách), `mod-apikeys::parse_iso`, `trinity-docgen::parse_iso`,
`vn_time::is_date_only`. Chúng chỉ dùng chrono ở lớp dựng giá trị cuối (`NaiveDate::from_ymd_opt`, `DateTime::from_naive_utc_and_offset`).
`jiff` đọc chuỗi nghiêm ngặt hơn (chuẩn RFC 9557/ISO 8601), không có sẵn các dạng lỏng kiểu V8 (`YYYY-MM`, dấu cách thay `T`),
nên không đỡ được công nào ở đây; vẫn phải giữ bộ đọc tay. Rủi ro khi đổi là sai lệch ở ngày không tồn tại, năm ngoài 0000-9999
(`js_iso_string`), và giây nhuận.

## So sánh

| Tiêu chí | chrono 0.4 + chrono-tz 0.10 | jiff |
|---|---|---|
| Bảo trì | RustSec: không còn bảo trì (chrono, chrono-tz) | Đang bảo trì tích cực |
| Múi giờ IANA | chrono-tz biên dịch cứng toàn bộ tzdb vào binary (mã nguồn crate 7 MB; tăng thời gian build đáng kể) | tzdb hệ thống hoặc nhúng, có thể chọn |
| Dịch thuật `DST`/ngày cũ | Đúng (đã có test ngày 1970 trong `vn_time`) | Đúng (cùng IANA) |
| Tích hợp `sqlx` 0.9.1 | Có feature `chrono` (đang dùng cho `timestamptz`, `date`) | **Không có feature `jiff`** trong `sqlx`/`sqlx-core`/`sqlx-postgres` 0.9.1 (đã kiểm trong cargo registry cục bộ) |
| `serde` | Có | Có (`jiff/serde`) |
| `rust_xlsxwriter`, `utoipa` | Đang dùng chrono qua `sqlx`/`serde` | Không có cầu nối sẵn; phải chuyển tay qua `timestamp` |
| Chi phí đổi | 0 | ~119 file, ~1000 chỗ dùng; viết lớp chuyển đổi ở mọi biên `sqlx` |

Hiệu năng và kích thước binary: chưa đo, và không đo ở lượt này (chế độ chỉ viết, không build). Không nên quyết định
dựa vào hai tiêu chí này: thời gian không nằm trên đường nóng của CRM. Mức giảm kích thước đáng kể nhất đến từ việc bỏ
bảng tzdb nhúng của `chrono-tz`, nhưng chỉ cần thay riêng crate này.

## Khuyến nghị

1. **Giữ `chrono` cho toàn bộ module.** Không chuyển hàng loạt sang `jiff`: `sqlx` 0.9.1 chưa có cầu nối `jiff`, mọi cột
   `timestamptz`/`date` sẽ phải đổi tay, chi phí lớn (119 file) mà không sửa được lỗ hổng nào. Cảnh báo RustSec là "không bảo trì",
   không phải lỗ hổng; rủi ro ngắn hạn thấp.
2. **Tiếp tục `ignore` có lý do trong `deny.toml`**, cập nhật lý do thành "đã đánh giá ở #301: giữ chrono, xem
   `docs/rust/DANH-GIA-JIFF.md`", kèm ngày xem lại (khi `sqlx` có feature `jiff`, hoặc khi chrono phát hành bản mới
   có người bảo trì).
3. **Việc đáng làm riêng (issue con, nhỏ):** thay `chrono-tz` bằng `jiff` chỉ ở trong `trinity-kernel/src/vn_time.rs`.
   `to_vn` trả `DateTime<Tz>` chỉ để lấy năm/tháng/ngày/giờ/phút. Có thể đổi thành hàm tính các trường đó bằng
   `jiff::tz::TimeZone::get("Asia/Ho_Chi_Minh")` (bật tzdb nhúng) và trả struct trường thời gian của riêng kernel; chrono vẫn
   ở các biên khác. Phạm vi một file, có bảng ca `kernel.json` làm cổng kiểm; bỏ được RUSTSEC-2026-0555 và tzdb biên dịch cứng.
   Điều kiện nhận: `shared_cases` xanh, test ngày 1970 xanh, binary không phụ thuộc `/usr/share/zoneinfo`.
4. Các issue module (M..) tiếp tục dùng `chrono` như khuôn có sẵn; không được thêm `jiff` ở module khác cho tới khi có quyết định (3).
5. Chưa chuyển `chrono` sang `jiff` ngay cả khi làm (3); xem lại sau khi `sqlx` hỗ trợ `jiff`.

## Chưa kiểm, cần đo nếu muốn đi tiếp

- Kích thước binary và thời gian build trước/sau khi bỏ `chrono-tz` (cần `cargo build --release`, bị cấm ở lượt này).
- Bản `jiff` cụ thể và tên feature tzdb nhúng: xác nhận lúc làm issue con (3), chưa có trong `Cargo.lock`.
