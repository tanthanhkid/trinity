# Chi tiết khách (`/contacts/:id`) — giao diện «Ánh xanh»

Thiết kế: `khach-desktop` · `khach-mobile` · `khach-mobile2` (bổ sung thông tin). Token và component: xem `anh-xanh.md`.

## Bố cục

| Khổ | Bố cục |
|---|---|
| ≥ 1024px | Ba cột: trái (khối nhấn khách + Gọi/Zalo · Giai đoạn · Hẹn gọi lại · điểm lead) · giữa (**Ghi nhanh cuộc gọi** · Lịch sử · Công việc · Được nhắc tới ở) · phải (Thông tin sửa tại chỗ · Chuyển khách hàng). |
| < 1024px | Thứ tự của `khach-mobile`: ‹ Khách hàng / Sửa · khối nhấn · chip giai đoạn · **Ghi nhanh** · Thông tin (+ «Bổ sung n thông tin còn thiếu») · Lịch sử. Khối thiết kế không vẽ nhưng là chức năng đang chạy (Hẹn gọi lại, Công việc, Chuyển khách hàng, điểm lead, Được nhắc tới ở) xếp sau Lịch sử. Thanh đáy: «Gọi» (nút chính, 2 phần) · «Zalo». |

## Ghi nhanh cuộc gọi (`_components/quick-note-card.tsx`)

- Lưu = `POST /contacts/:id/notes` `{ note }` (quyền `contacts.update`, khách trong phạm vi; 201 trả dòng hoạt động `note`). Cùng lõi `mod_contacts::notes::add_note` với tool MCP `add_contact_note`, thẻ @ đồng bộ như ghi từ AI (khoá `note:<id>`).
- Nút «Lưu ghi chú» nhạt (nền lõm) khi ô trống, thành nút chính khi có chữ; Ctrl/⌘+Enter lưu. Lưu xong xoá ô, toast «Đã lưu ghi chú», tải lại Lịch sử (`["contact-activities", id]`). Lỗi giữ nguyên chữ đã gõ.
- Không có quyền `contacts.update` ⇒ ẩn cả khối.

## Bổ sung thông tin — điện thoại (`_components/missing-info-sheet.tsx`, `MissingInfoScreen`)

- Màn toàn phần phủ cả thanh đầu app (Dialog Base UI: khoá focus, Esc đóng). Đầu màn: Huỷ · «Bổ sung thông tin» · «Lưu (n)» — n = số ô đã đổi, nút chỉ sáng khi có thay đổi.
- Khối nhấn «<tên> còn thiếu n thông tin» (n = số ô trống trong bộ ngày sinh, giới tính, nghề, công ty, SĐT phụ).
- Giới tính ba lựa chọn Nữ / Nam / **Khác** (giá trị `nu` / `nam` / `khac`; cột `contacts.gender` là `text` nên không cần migration, DTO tạo/sửa khách nhận thêm `khac`). Form đầy đủ, màn tạo khách, xuất Excel cũng hiện «Khác».
- «Lưu» gửi MỘT lần `PATCH /contacts/:id` chỉ với các ô đã đổi, toast có Hoàn tác.

## Chỗ lệch có chủ đích so với thiết kế

- Toast «Đã lưu ghi chú» không có Hoàn tác: chưa có API xoá hoạt động (và không có tool xoá).
- Nút «Messenger» (desktop) / biểu tượng nhắn (mobile) chưa làm: hồ sơ khách chưa có liên kết hội thoại Messenger để mở.
- Ô «Công ty» là chữ tự do (thiết kế ghi «Tìm hoặc tạo công ty» — chưa có danh mục công ty).
- Dòng Lịch sử chưa hiện tên người ghi như thiết kế (giữ dòng thời gian đang chạy).
