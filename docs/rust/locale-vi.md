# Tiếng Việt, số điện thoại, giờ và định dạng Việt Nam ở bản Rust (K26)

Hàm chung nằm ở crate `trinity-kernel` (`server/crates/trinity-kernel/src/`): `vi` (bỏ dấu, `translate`, so sánh chuỗi),
`phone`, `vn_time`, `number`. Hành vi khớp từng byte với bản TS qua **bảng ca dùng chung**
`server/contracts/cases/kernel.json`:

- bản TS là chuẩn: `services/crm/src/common/helpers/kernel-cases.spec.ts` tính lại mọi ca bằng helper TS và đúng kiểu
  gọi `toLocale*`/`Intl`/`localeCompare` đang dùng, rồi so với cột `out` (chạy trong `Unit tests` của CI);
- Rust chạy cùng đầu vào ở `server/crates/trinity-kernel/tests/shared_cases.rs` (`Rust unit`);
- thêm ca: thêm đầu vào vào nhóm tương ứng, chạy `UPDATE_KERNEL_CASES=1 npx jest kernel-cases` trong `services/crm`
  để sinh cột `out`, rồi chạy test Rust. Số không biểu diễn được bằng JSON ghi dạng chuỗi (`"NaN"`, `"-0"`, `"Infinity"`).

Thư viện: `icu_collator` và `icu_normalizer` (ICU4X 2.x, cùng họ dữ liệu CLDR với ICU của V8), `chrono-tz` cho múi
`Asia/Ho_Chi_Minh`.

## Giờ Việt Nam: hai cách tính, giữ đúng bản TS

| Bản TS | Rust | Ghi chú |
|---|---|---|
| `Intl.DateTimeFormat`/`toLocale*` với `timeZone: 'Asia/Ho_Chi_Minh'` | `vn_time::to_vn`, `format_vn_date`, `vn_date`, `vn_clock_minutes` | Theo cơ sở dữ liệu múi giờ: trước 13/06/1975 là UTC+8 (ngày sinh cũ, mốc 1970 có ca trong bảng) |
| Chuỗi cứng `…T00:00:00+07:00`, cộng 7 giờ | `vn_time::vn_to_utc`, `parse_vn_date_range*`, `is_business_hours`, `next_business_start` | UTC+7 cố định |

`new Date('YYYY-MM-DDT…')` của V8 nhận ngày 1–31 với mọi tháng và tràn sang tháng sau (`2026-02-30` → 02/03); tháng
13, ngày 00 hoặc 32 thành `Invalid Date`. Rust làm y như vậy; `Invalid Date` thành lỗi `VnRangeError::InvalidDate`
(bản TS để lọt xuống truy vấn rồi lỗi 500).

## 33 chỗ `toLocale*`/`Intl` của backend → hai hàm chung

`format_vn_number(f64)` thay `toLocaleString('vi-VN')` của số; `format_vn_date(thời điểm, VnDateStyle)` thay định dạng
ngày giờ. Phần lấy ngày/tháng theo giờ VN dùng `vn_date`/`vn_clock_minutes`.

| Chỗ (TS) | Rust |
|---|---|
| `attendance/attendance-export.service.ts:80` `formatVnTime` | `format_vn_date(.., HourMinute)` |
| `attendance/attendance-export.service.ts:224` (×2) | `format_vn_number` |
| `attendance/attendance-matrix-export.service.ts:114` | `format_vn_date(.., IsoMonth)` |
| `attendance/attendance-matrix.helper.ts:69` `vnHhmm` | `format_vn_date(.., HourMinute)` |
| `attendance/attendance.controller.ts:84`, `attendance/attendance.service.ts:505` | `format_vn_date(.., IsoDate)` |
| `attendance/attendance.service.ts:562`, `:569` (`toLocaleString('en-US')` rồi đọc giờ) | `vn_clock_minutes` |
| `common/helpers/parse-vn-date-range.helper.ts:55`, `:60` (`buildFilterDates`) | `vn_date` + trừ 7 ngày lịch |
| `connectors/commerce-sync.service.ts:46`, `store/store.service.ts:41` (`vnd`) | `format_vn_number` (sau `Math.round` → `js_round`, PLAN mục 10.1) + `đ` |
| `contacts/contacts-export.service.ts:228`, `:231` | `format_vn_date(.., DayMonthYear)` |
| `contacts/contacts-export.service.ts:266` (×2) | `format_vn_number` |
| `custom-objects/refs/ref-preview.service.ts:35`, `:65` | `format_vn_number` + ` đ` |
| `employees/employee-birthday-export.service.ts:37`, `employees/employee-list-export.service.ts:90` | `format_vn_date(.., DayMonthYear2)` |
| `employees/employees.service.ts:184` (`vnMonthDay`), `:196` (`currentVnMonth`) | `vn_date(..).month()/.day()` |
| `integrations/mcp/actions/action-helpers.ts:105` | `format_vn_date(.., ShortDateTime)` |
| `integrations/mcp/tools/ai-activity-tool.ts:8`, `reports/custom/report-def.ts:87` | `format_vn_date(.., IsoDate)` |
| `reports/helpers/report-time-buckets.helper.ts:28` | `format_vn_date(.., DayMonth2 \| MonthYear2)` |
| `reports/report-employee-performance-export.service.ts:54` (×2) | `format_vn_number` |
| `notification/subscribers/subscribers.service.ts:117` | `format_vn_number` |
| `payroll/employees/employees.service.ts:241` | `format_vn_date(.., IsoMonth)` |
| `payroll/payslips/payslip-import.helper.ts:149` (`toLocaleString('en-US')` của hằng `MONEY_MAX`) | Chuỗi hằng trong mã (giá trị cố định, không cần hàm) |
| `packages/utils` `formatVND`, `formatCurrencyShort`, `formatDate`, `formatDateTime` (4 chỗ) | Không có chỗ gọi trong backend; kiểu `HourMinuteDayMonthYear2`/`DayMonthYear2` đã có nếu cần |

## 21 chỗ `localeCompare`: sắp ở đâu

Không chỗ nào chuyển sang `ORDER BY` của Postgres theo chữ: collation của DB tự cài không chắc là tiếng Việt (bản tự
cài có thể là `C` hay `en_US`), nên thứ tự tên sẽ lệch bản TS. Các chỗ so chuỗi ISO là so thời điểm, sắp theo giá trị
thời gian. Mọi chỗ sắp trong bộ nhớ dùng sắp ổn định (`sort_by`, giống `Array.prototype.sort` của V8) để dòng bằng nhau
giữ thứ tự cũ.

| # | Chỗ (TS) | So gì | Quyết định |
|---|---|---|---|
| 1–3 | `attendance/attendance-org-sort.helper.ts:169`, `:177`, `:184` | phòng, nhóm, họ tên (`'vi'`) | `compare(.., Collation::Vi)` trong bộ nhớ (cây tổ chức dựng sau khi gom) |
| 4 | `attendance/attendance.service.ts:1330` | họ tên (`'vi'`) | `Collation::Vi` |
| 5 | `attendance/attendance.service.ts:2331` | phòng (`'vi'`), sau điểm | `Collation::Vi` |
| 6–7 | `attendance/attendance.service.ts:2536`, `:2544` | họ tên, **không** truyền locale | `Collation::Root` (giữ đúng bản TS; khác `'vi'` ở thứ tự `ă/â/đ`, ghi nhận để thống nhất sau X06) |
| 8 | `contacts/contacts-export.service.ts:159` | khoá nhóm (`'vi'`) | `Collation::Vi` |
| 9 | `contracts/contracts.service.ts:81` | họ tên (`'vi'`) | `Collation::Vi` |
| 10 | `contracts/contracts.service.ts:228` | cột sắp động, `String(v)` (`'vi'`) | `Collation::Vi` |
| 11 | `custom-objects/custom-objects.service.ts:66` | `menu_key` sau `nav_order`, không locale | `Collation::Root` (khoá ASCII có `_`: thứ tự gốc CLDR khác thứ tự byte) |
| 12 | `custom-objects/refs/record-refs.service.ts:47` | mã bản ghi (`'en'`, `numeric`) | `Collation::EnNumeric` (`KH-2` < `KH-10`) |
| 13 | `employees/employees.service.ts:156` | họ tên (`'vi'`) | `Collation::Vi` |
| 14 | `employees/employees.service.ts:435` | cột sắp động (`'vi'`) | `Collation::Vi` |
| 15 | `employees/employees.service.ts:771` | họ tên (`'vi'`) | `Collation::Vi` |
| 16 | `interactions/interactions.service.ts:150` | `at` dạng ISO, giảm dần | Theo giá trị thời gian (gộp hai nguồn trong bộ nhớ; mỗi truy vấn nguồn đã `ORDER BY` ở DB) |
| 17 | `reports/dashboard-tasks.service.ts:112` | `due_at` dạng ISO | Theo giá trị thời gian (gộp thẻ việc và nhắc hẹn trong bộ nhớ) |
| 18 | `teams/teams.service.ts:372` | tên nhóm (`'vi'`) | `Collation::Vi` |
| 19–21 | `payroll/payslips/payslips.service.ts:456`, `:733`, `:1389` | họ tên (`'vi'`), sau trưởng nhóm | `Collation::Vi` |

Locale mặc định của tiến trình Node trên máy chủ và CI là `en-US`, nên `localeCompare` không truyền locale là thứ tự
gốc CLDR (`Collation::Root`).
