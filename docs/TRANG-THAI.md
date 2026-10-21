# Năm trạng thái của một màn hình

"Đẹp" là khi mọi thứ chạy đúng. "Premium" là khi mạng chập chờn, máy chủ lỗi hay tài khoản còn trống mà màn hình vẫn nói thật và chỉ đường. Mỗi màn chính của Trinity web phải có đủ năm trạng thái dưới đây.

| Trạng thái | Phải có | Không được |
|---|---|---|
| **Đang tải** | Khung xương đúng hình nội dung sắp hiện (`LoadingBlock`, `Skeleton`), có `role="status"` | Màn trắng, chữ "Đang tải…" trơ trọi, khung xương quay mãi khi đã lỗi |
| **Trống** | Câu nói vì sao trống + **một** hành động tiếp theo (`EmptyState` với `action`). Đang lọc mà không khớp ⇒ nói "không khớp bộ lọc" + "Xoá bộ lọc" | Coi lỗi tải là "chưa có dữ liệu" |
| **Lỗi** | Nói chuyện gì xảy ra + cách sửa + nút **Thử lại** (`ErrorState`, gọi `refetch`) | Dòng chữ đỏ không có lối ra, chỉ hiện toast rồi để danh sách trống |
| **Mất mạng** | Dải báo ở đầu vùng nội dung (`OfflineBanner`), có mạng lại thì tự cập nhật + báo một câu | Im lặng (React Query tự dừng khi mất mạng nên người dùng tưởng app treo) |
| **Thành công** | Toast ngắn nói việc đã xong ("Đã ngắt kết nối Zalo OA") | Thao tác xong mà không có phản hồi gì |

## Thành phần dùng chung

- `components/ui/loading-block.tsx`: khung xương dòng chữ hoặc thẻ.
- `components/ui/empty-state.tsx`: trạng thái trống, có biểu tượng, câu giải thích và một hành động.
- `components/ui/error-state.tsx`: trạng thái lỗi. Nhận `error` (lấy câu giải thích qua `getApiErrorMessage`), `onRetry` và `retrying`. Có bản `compact` một dòng cho ô nhỏ như cột kanban hay thẻ.
- `components/offline-banner.tsx`: dải báo mất mạng, gắn sẵn trong `app/(dashboard)/layout.tsx`. Có hook `useOffline()` cho màn nào cần khoá nút gửi khi mất mạng.
- `lib/api-client.ts`, hàm `getApiErrorMessage`: yêu cầu không tới được máy chủ ⇒ "Không kết nối được máy chủ. Kiểm tra Internet rồi thử lại."; quá giờ ⇒ câu riêng.
- `app/(dashboard)/error.tsx`: lỗi hiển thị ⇒ "Thử lại" (dựng lại phần lỗi) trước, "Tải lại trang" là phương án cuối.

Quy ước: lỗi **khi chưa có dữ liệu** ⇒ `ErrorState` thay chỗ nội dung. Lỗi **khi đang có dữ liệu cũ** ⇒ giữ dữ liệu cũ, báo bằng toast.

## Cùng tình huống → cùng một mẫu

Người dùng học một lần, nhận ra ở mọi màn. Trước đợt này, "Chờ duyệt" có khoảng 9 kiểu hiển thị; "cần kết nối lại" có 4 cách nói ("Cần liên kết lại", "Cần cấp quyền lại"…) và 7 kiểu màu. Cùng một kênh còn đỏ ở màn Đăng đa kênh nhưng vàng ở màn Kết nối.

| Tình huống | Mẫu | Chữ | Màu |
|---|---|---|---|
| Trống | `EmptyState` | Vì sao trống + một hành động | Xám |
| Lỗi tải | `ErrorState` | "Không tải được …" + cách sửa + Thử lại | Hổ phách (biểu tượng) |
| Chờ người duyệt | `StatusTag kind="pending"` | "Chờ duyệt" (cụ thể hơn khi cần: "Chờ Kế toán duyệt", "Bản mới chờ duyệt") | Hổ phách |
| Kênh mất quyền truy cập | `StatusTag kind="reauth"` trong danh sách; `ReconnectNotice` trên thẻ kênh | "Cần kết nối lại" + vì sao + nút "Kết nối lại" | Hổ phách |
| Đang chạy / Đã tắt / Lỗi | `StatusTag kind="running" \| "off" \| "error"` | "Đang chạy", "Đã tắt", "Lỗi" | Xanh lá / xám / đỏ |

`components/ui/status-tag.tsx` giữ chữ chuẩn trong `STATUS_LABEL`, dùng chung cho toast và aria-label. Dòng kết nối dùng `StatusPill` cỡ nhỏ thì lấy chữ từ `STATUS_LABEL` để khớp câu chữ.

**Số và ngày** (`lib/format.ts`):

- Số đếm hiện ra luôn kèm đơn vị: `formatCount(12, "khách")` ⇒ "12 khách". Cột kanban ghi "12/15 card", không còn "12/15" trơ trọi.
- Số dùng `formatNumber` (1.234.567); tiền dùng `formatVnd` (1.250.000 ₫).
- Ngày: `formatDate` (21/10/2026), `formatDateTime` (14:30 21/10/2026), `formatDateTimeShort` (14:30 21/10) cho mốc gần trong danh sách dày. Luôn theo giờ Việt Nam, không tự gọi `toLocaleString` với tuỳ chọn riêng.

## Kiểm kê (21/10/2026)

✅ đủ · ⚠️ có nhưng yếu · ❌ thiếu. Cột "Sau" là trạng thái sau đợt sửa đầu tiên.

### Tổng quan (`/dashboard`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ✅ | ✅ | Khung xương ở mọi khối |
| Trống | ⚠️ | ✅ | Thêm lối sang Kanban cho khối "Việc cần làm hôm nay". "Khách gần đây" vẫn tự ẩn khi trống, có chủ ý |
| Lỗi | ❌ | ⚠️ | Số liệu kinh doanh: hết khung xương quay mãi, có Thử lại. Việc hôm nay: lỗi không còn hiện "Không có việc". **Còn lại:** khối Trợ lý AI/Kênh và "Cần bạn xem" (file của PR #48, sửa sau khi #48 gộp) |
| Mất mạng | ❌ | ✅ | `OfflineBanner` |
| Thành công | ✅ | ✅ | Bật tính năng có toast |

### Khách hàng (`/contacts`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ✅ | ✅ | |
| Trống | ⚠️ | ✅ | Chưa có khách ⇒ "Thêm khách". Lọc không khớp ⇒ "Xoá bộ lọc" |
| Lỗi | ❌ | ✅ | Trước: toast rồi hiện "Không tìm thấy khách hàng nào". Nay: `ErrorState` + Thử lại; dữ liệu cũ còn thì toast "đang hiện dữ liệu cũ" |
| Mất mạng | ❌ | ✅ | |
| Thành công | ✅ | ✅ | Xoá, chuyển hàng loạt |

### Pipeline / Kanban (`/kanban`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ⚠️ | ✅ | Danh sách board và chế độ Bảng chuyển sang khung xương |
| Trống | ⚠️ | ✅ | Chưa có board ⇒ "Tạo board" (người có quyền cấu hình) hoặc câu nhờ quản trị viên. **Còn lại:** board chưa có cột vẫn chỉ là chữ |
| Lỗi | ❌ | ✅ | Danh sách board, chi tiết board (trước: khung xương quay mãi), từng cột, chế độ Bảng |
| Mất mạng | ❌ | ✅ | |
| Thành công | ✅ | ✅ | Kéo thẻ lạc quan, lỗi thì toast. Hoàn tác thuộc phần C |

### Kênh (`/connections`: Facebook, Zalo OA)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ⚠️ | ⚠️ | Zalo OA chuyển sang khung xương. **Còn lại:** Facebook vẫn là vòng quay |
| Trống | ✅ | ✅ | Facebook: chỉ cách kết nối Fanpage |
| Lỗi | ⚠️ | ✅ | Facebook có Thử lại. Zalo OA tách "tính năng đang tắt" (404) khỏi lỗi thật |
| Mất mạng | ❌ | ✅ | |
| Thành công | ⚠️ | ✅ | Thêm toast khi ngắt Zalo OA |

### Đăng đa kênh (`/social`)

| Trạng thái | Trước | Sau | Ghi chú |
|---|---|---|---|
| Đang tải | ⚠️ | ✅ | Trang (trước: màn trắng), kênh, bài, nháp đều có khung xương |
| Trống | ✅ | ✅ | "Soạn bài đầu tiên", "Đến mục Kênh" |
| Lỗi | ❌ | ⚠️ | Kênh: trước hiện lưới trống. Soạn bài: trước báo sai "Chưa có kênh nào được liên kết". Bài, nháp: thêm Thử lại. **Còn lại:** lịch, thư viện, thống kê vẫn chỉ là chữ |
| Mất mạng | ❌ | ✅ | Dải báo chung. **Còn lại:** chưa khoá nút Đăng/Hẹn giờ khi mất mạng |
| Thành công | ✅ | ✅ | |

## Việc còn lại

- Khối Trợ lý AI/Kênh và "Cần bạn xem" trên Tổng quan: thêm Thử lại; "Cần bạn xem" đang coi lỗi là "không có gì". Làm sau khi PR #48 gộp để khỏi đụng cùng file.
- Đăng đa kênh: lịch, thư viện, thống kê dùng `ErrorState`; khoá nút Đăng/Hẹn giờ khi `useOffline()`.
- Mẫu chung (phần B) còn chưa áp: khối Kênh trên Tổng quan (file của PR #48); nhãn trạng thái của đề xuất AI đã đúng màu hổ phách nhưng vẫn qua bảng riêng `lib/ai-actions.ts`; vòng tròn nét đứt ở "Cần bạn xem".
- Hoàn tác (xoá, đổi trạng thái, kéo thẻ) và khoảnh khắc hỏng (kênh mất kết nối, đăng bài lỗi): phần C.
