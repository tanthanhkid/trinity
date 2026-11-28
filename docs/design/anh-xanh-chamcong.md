# «Ánh xanh» — Chấm công (`/attendance`)

Thiết kế: `chamcong-desktop` (quản lý duyệt đơn), `chamcong-mobile` (nhân viên chấm công), `chamcong-mobile2` (tạo đơn).
Hệ thiết kế chung: [anh-xanh.md](./anh-xanh.md).

## Bố cục

| Người dùng / khổ | Màn |
|---|---|
| Có `attendance.manage`, ≥1024px | **Duyệt đơn** (mặc định): số liệu đầu trang, cột trái danh sách (Chờ duyệt / Đã xử lý), cột phải chi tiết đơn (khối nhấn, Công ngày, Hạn mức tháng), thanh Từ chối / Duyệt đơn nổi. Tab bên cạnh «Chấm công của tôi» mở màn nhân viên. |
| Còn lại (nhân viên, mọi người dùng <1024px) | **Nhân viên**: ngày + trạng thái ca, khối nhấn đồng hồ + nút chấm công, Hôm nay, Tháng N (dải ngày), hàng Tạo đơn + đơn gần đây; desktop chia hai cột. Lịch sử chấm công / Lịch cá nhân giữ ở tab bên dưới. |
| «Tạo đơn» | Toàn màn (điện thoại: nút quay lại «Chấm công»; desktop: khung giữa 640px) → màn «Đơn đã gửi». |

Quản lý trên điện thoại/máy tính bảng hẹp (<1024px) chỉ thấy màn nhân viên; duyệt đơn ở đó vẫn dùng **Nhân sự → Quản lý chấm công** (`/management/workdays`, không đổi).

## Dữ liệu và chức năng

- API không đổi: `useAttendanceRequests`, `useApproveRequest`/`useRejectRequest`, `useRequestConfig`, `useCreateRequest`, check-in/out kèm selfie.
- **Hoàn tác khi duyệt/từ chối**: máy chủ không có API «mở lại đơn», nên quyết định được giữ 5 giây (bằng thời gian toast) rồi mới gửi; Hoàn tác trong lúc đó = chưa gửi gì; rời trang trong 5 giây = gửi ngay.
- **Hạn mức tháng** = số đơn chờ duyệt + đã duyệt cùng nhóm (quên chấm / đến muộn–về sớm), cùng tháng, của cùng nhân viên (khớp `assert_monthly_limit` của máy chủ; đơn bị từ chối không tính; không tính chính đơn đang xem). Nghỉ phép / thai sản không có hạn mức theo đơn.
- Số liệu đầu trang: «Chờ duyệt» từ danh sách đơn; «Chưa chấm công» = `absent` của `/today`; «Đi muộn hôm nay» = số bản ghi hôm nay có `late_minutes > 0` (đọc tối đa 200 bản ghi, quá thì hiện `N+`).
- Chip trên khối chấm công nhân viên chỉ nói điều đã biết (đã chấm lúc mấy giờ); việc có đúng mạng văn phòng do máy chủ kiểm khi bấm chấm — lỗi hiện ngay trên khối, kèm nút Thử lại.

## Chỗ lệch có chủ đích so với thiết kế

- Thiết kế mobile ghi «Đang ở Cửa hàng Quận 1 / Ngoài mạng văn phòng» trước khi chấm: máy chủ chưa có API kiểm mạng trước khi chấm, nên không vẽ chip giả.
- «Gửi nhầm? Rút đơn lại» (mobile2) chưa có API rút đơn → chưa vẽ nút; «Chị Lan Anh sẽ duyệt» bỏ tên cứng.
- «Phép năm còn: 6 ngày» (mobile2) chưa có dữ liệu → nghỉ phép hiện «Không giới hạn theo đơn».
- Dòng «Đã sửa tay lúc … Lý do …» và nút «Sửa giờ công» (desktop): thuộc chức năng mới «Sửa giờ công kèm lý do» (API + tool MCP + lịch sử sửa) làm ở PR riêng; thẻ «Công ngày» đã chừa chỗ.
- Khay chụp selfie dùng `BottomSheet` ở mọi khổ (desktop: tối đa 560px); luồng hai bước chụp → xác nhận giữ nguyên.
