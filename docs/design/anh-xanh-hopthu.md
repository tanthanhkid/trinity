# Hộp thư (`/inbox`) — giao diện «Ánh xanh»

Thiết kế: `hopthu-desktop` · `hopthu-mobile` · `hopthu-mobile2` (khay hồ sơ mở). Token và component: xem `anh-xanh.md`.

## Bố cục

| Khổ | Bố cục |
|---|---|
| ≥ 1024px | Ba thẻ rời (bo 16, cách 12): danh sách 300 · hội thoại · hồ sơ khách 320 (≥ 1536px: 372). Hồ sơ chỉ hiện ≥ 1280px; 1024–1279px có nút «Hồ sơ» ở đầu hội thoại mở khay đáy. |
| < 1024px | Một cột tại một lúc (danh sách ⇄ hội thoại). Đầu hội thoại là `HeroCard` (khối nhấn duy nhất của màn): quay lại · tên · nút «Hồ sơ», dưới là chip SĐT / giai đoạn / hẹn nhắc (mỗi chip mở khay hồ sơ). |

## Hồ sơ khách sửa tại chỗ (`components/inbox/customer-profile.tsx`)

- Dữ liệu và ghi dùng API sẵn có của màn chi tiết khách: `GET/PATCH /contacts/:id`, khoá cache `["contact", id]` dùng chung, quyền `contacts.view` (xem) / `contacts.update` (sửa). Không API mới.
- Sửa = lưu ngay + `showUndoToast("Đã lưu …")`; Hoàn tác PATCH lại giá trị cũ. Giá trị cũ rỗng mà BE không cho xoá (giai đoạn, trạng thái chi tiết) ⇒ toast không có Hoàn tác.
- Giai đoạn: `StageChip` theo mã bền nhóm `contact_stage` (`new`→new, `follow_up_2`→consult, `follow_up_3`→quote, `won`→won, mã khác→neutral).
- Họ tên: chỉ Quản trị (`isAdmin`) sửa — đúng luật BE `ContactsService.update`.
- Hẹn nhắc: mốc nhanh (hôm nay 17:00 nếu chưa qua · sáng mai 09:00 · thứ Hai tới 09:00, giờ VN) ghi `reminder_at`; «Bỏ hẹn» ghi `null`.
- Số điện thoại: **chỉ xem**. Nút «Lưu SĐT phát hiện trong tin nhắn vào hồ sơ» (dưới bong bóng) làm ở PR riêng cùng API Rust + tool MCP; `MessageThread` đã chừa prop `afterMessage` cho chỗ đó.

## Chỗ lệch có chủ đích so với thiết kế

- Thiết kế có «Nhu cầu» (văn bản tự do) — code chưa có trường này ⇒ bỏ; «Trạng thái chi tiết» là danh sách tuỳ chọn thật (`contact_detail_status`), không phải ô gõ tự do.
- Hội thoại Messenger chưa ghép khách trong CRM (API hội thoại không có `contact_id`) ⇒ khay «Hồ sơ» chỉ có thông tin hội thoại, chưa sửa được.
- Bong bóng khách dùng nền lõm `--ax-sunken` (thiết kế #FFF trên nền #FFF sẽ mất hình bong bóng).
- Giữ ô tìm + lọc «Chưa trả lời», tab «Tương tác» (bình luận) và các nhãn cửa sổ trả lời 48 giờ / 7 ngày — thiết kế không vẽ nhưng là chức năng đang chạy.
- Tab «Tương tác» (`InteractionsView`) chưa vẽ trong bộ thiết kế — giữ nguyên dáng cũ.
