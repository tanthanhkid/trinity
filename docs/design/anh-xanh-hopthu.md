# Hộp thư (`/inbox`) — giao diện «Ánh xanh»

Thiết kế: `hopthu-desktop` · `hopthu-mobile` · `hopthu-mobile2` (khay hồ sơ mở). Token và component: xem `anh-xanh.md`.

## Bố cục

| Khổ | Bố cục |
|---|---|
| ≥ 1024px | Ba thẻ rời (bo 16, cách 12): danh sách 300 · hội thoại · hồ sơ khách 320 (≥ 1536px: 372). Hồ sơ chỉ hiện ≥ 1280px; 1024–1279px có nút «Hồ sơ» ở đầu hội thoại mở khay đáy. |
| < 1024px | Một cột tại một lúc (danh sách ⇄ hội thoại). Hội thoại mở ra **chiếm toàn màn** (`InboxFrame`: lớp `fixed inset-0 z-50` chỉ dưới `lg`, nền trang mobile, chừa vùng an toàn trên/dưới) — che thanh đầu app và tiêu đề «Tương tác»; khay «Hồ sơ khách» và toast vẫn nằm trên. Đầu hội thoại là `HeroCard` (khối nhấn duy nhất của màn): quay lại · tên · dòng «Kênh · Phụ trách …» · nút «Hồ sơ», dưới là chip SĐT (thiếu ⇒ «Thêm số điện thoại», nền vàng nhạt viền đứt) / giai đoạn / hẹn nhắc (`ProfileChips`, mỗi chip mở khay hồ sơ). Bong bóng khách nền trắng trên nền trang như thiết kế; ô soạn «Soạn trả lời». Áp cho cả Zalo OA và Messenger. |

## Hồ sơ khách sửa tại chỗ (`components/inbox/customer-profile.tsx`)

- Dùng cho **cả Zalo OA và Messenger** (hội thoại Messenger có `contact_id`: tin đầu của khách tự tìm/tạo hồ sơ, link chat / bình luận cũng ghép) — cột phải desktop và khay «Hồ sơ khách» điện thoại đều sửa được, cùng quyền.
- Dữ liệu và ghi dùng API sẵn có của màn chi tiết khách: `GET/PATCH /contacts/:id`, khoá cache `["contact", id]` dùng chung, quyền `contacts.view` (xem) / `contacts.update` (sửa).
- Sửa = lưu ngay + `showUndoToast("Đã lưu …")`; Hoàn tác PATCH lại giá trị cũ. Giá trị cũ rỗng mà BE không cho xoá (giai đoạn, trạng thái chi tiết) ⇒ toast không có Hoàn tác.
- Giai đoạn: `StageChip` theo mã bền nhóm `contact_stage` (`new`→new, `follow_up_2`→consult, `follow_up_3`→quote, `won`→won, mã khác→neutral).
- Họ tên: chỉ Quản trị (`isAdmin`) sửa — đúng luật BE `ContactsService.update`.
- Hẹn nhắc: mốc nhanh (hôm nay 17:00 nếu chưa qua · sáng mai 09:00 · thứ Hai tới 09:00, giờ VN) ghi `reminder_at`; «Bỏ hẹn» ghi `null`.
- Số điện thoại: **chỉ xem** trong hồ sơ. Lưu SĐT khách nhắn vào hồ sơ = nút «Lưu 0912 345 678 vào hồ sơ» ngay dưới bong bóng khách (`components/inbox/save-phone.tsx`, chỉ Zalo OA): số do MÁY CHỦ dò (`phones` của từng tin ở `GET /zalo-oa/threads/:id/messages`), bấm = `POST /zalo-oa/threads/:id/save-phone` (tạo khách hoặc ghép khách đã có số, ghép vào hội thoại); tool MCP `save_phone_from_message`. Nút chỉ hiện khi hội thoại CHƯA ghép khách và có `contacts.update`; khách đã mang đúng số ⇒ chữ «Đã lưu số này vào hồ sơ»; khách mang số khác ⇒ không hiện gì (BE trả 409, không ghi đè). Toast «Đã lưu số điện thoại…» **không có Hoàn tác** (khách vừa tạo không xoá được qua API/MCP). Chi tiết API: `docs/integrations/zalo-oa.md`.

## Chỗ lệch có chủ đích so với thiết kế

- Thiết kế có «Nhu cầu» (văn bản tự do) — code chưa có trường này ⇒ bỏ; «Trạng thái chi tiết» là danh sách tuỳ chọn thật (`contact_detail_status`), không phải ô gõ tự do.
- Hội thoại Messenger CHƯA ghép khách (`contact_id` null) ⇒ hồ sơ chỉ xem, ghi «Chưa ghép với khách nào trong CRM». Nút «Lưu SĐT vào hồ sơ» dưới bong bóng vẫn chỉ có ở Zalo OA.
- Desktop: bong bóng khách dùng nền lõm `--ax-sunken` (thiết kế #FFF trên thẻ #FFF sẽ mất hình bong bóng); điện thoại: nền trắng trên nền trang như thiết kế.
- Giữ vạch ngày và dòng «tên · giờ» dưới bong bóng (dữ liệu thật) dù thiết kế mobile không vẽ.
- Giữ ô tìm + lọc «Chưa trả lời», tab «Tương tác» (bình luận) và các nhãn cửa sổ trả lời 48 giờ / 7 ngày — thiết kế không vẽ nhưng là chức năng đang chạy.
- Tab «Tương tác» (`InteractionsView`) chưa vẽ trong bộ thiết kế — giữ nguyên dáng cũ.
- Thiết kế hiện nút khi «hồ sơ chưa có SĐT». Ở code hồ sơ khách luôn có SĐT (cột bắt buộc) nên «chưa có» = hội thoại chưa ghép khách; số khác với số trong hồ sơ KHÔNG được đề nghị lưu (tránh ghi đè), người dùng đổi số ở màn hồ sơ khách.
