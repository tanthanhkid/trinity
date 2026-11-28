# Thành viên và ba vai trò cố định

Cài đặt › **Thành viên** là nơi duy nhất quản lý người dùng của một công ty (mô hình Claude Team, công ty tối đa 20 người).

## Ba vai trò

| Vai trò | Làm được |
|---|---|
| **Chủ sở hữu** (đúng một người) | Mọi việc của Quản trị, quản lý gói, chuyển quyền chủ |
| **Quản trị** | Mời, đổi vai trò, đặt lại mật khẩu, khoá, xoá thành viên; cài đặt công ty |
| **Thành viên** | Dùng nghiệp vụ: xem chung khách, deal, việc kanban; sửa phần của mình; bán hàng; chấm công của mình; xem phiếu lương của mình |

Không có vai trò tuỳ biến và không có ma trận quyền ở giao diện. Phía server vẫn kiểm theo quyền (`role_permissions`), nên Thành viên gọi API quản trị nhận 403.

Cách cài trên RBAC sẵn có (`server/crates/trinity-rbac/src/fixed_roles.rs`):

- Quản trị = vai trò hệ thống "Quản trị" (`roles.is_system`).
- Thành viên = một dòng `roles` mang dấu ở `description`, quyền cố định `MEMBER_GRANTS`; không sửa/xoá được qua `/roles`.
- Chủ sở hữu = khoá `owner_user_id` trong `settings`; thiếu thì là Quản trị đang hoạt động có id nhỏ nhất.
- Chủ sở hữu không bị khoá, xoá, hạ vai trò hay đặt lại mật khẩu bởi người khác; phải chuyển quyền chủ trước.

## API

| Route | Quyền | Việc |
|---|---|---|
| `GET /api/v1/members` | `users.view` | Danh sách: tên, email (chỉ người quản lý thấy email người khác), vai trò, trạng thái, ngày tham gia, `max_users` |
| `PUT /api/v1/members/:id/role` | `users.manage` + Quản trị | `{ "role": "admin" \| "member" }` |
| `POST /api/v1/members/transfer-owner` | chỉ Chủ sở hữu | `{ "user_id": n }` |
| `DELETE /api/v1/members/:id` | `users.manage` + Quản trị | `{ "reassign_to": n }` bắt buộc; chuyển khách, deal, thẻ kanban, bản ghi tuỳ biến, người nhận mặc định của fanpage/webhook trong cùng giao dịch |

Mời thành viên dùng API sẵn có `/api/v1/auth/invitations` (link mời, thu hồi, giới hạn `maxUsers`); đặt lại mật khẩu `PATCH /users/:id/reset-password`; tạm khoá `PATCH /users/:id {status}`. Các API cũ `/users`, `/roles`, `/management/teams` vẫn chạy nhưng giao diện không dùng.

## Dữ liệu cũ

Migration `0028_thanh_vien_ba_vai_tro` (idempotent, chạy theo từng công ty): người có vai trò hệ thống hoặc vai trò tuỳ biến giữ một trong `users.manage`, `roles.manage`, `org.manage`, `settings.features`, `settings.integrations` thành Quản trị; còn lại thành Thành viên. Lời mời đang chờ đổi theo cùng luật. Vai trò tuỳ biến cũ không bị xoá.

Migration `0031_thanh_vien_xem_phieu_luong` (idempotent, chạy theo từng công ty): vai trò Thành viên đã có được thêm `payroll.view` phạm vi `own` (đã có `payroll.view` thì giữ nguyên). Thành viên chỉ thấy phiếu lương của chính mình (`GET /payslips`, `GET /payslips/:id` ngoài phạm vi ⇒ 404); lập/sửa/duyệt/xuất phiếu, cấu hình và báo cáo lương vẫn 403. `payroll.view` phạm vi `own` không mở ba cột lương của chức danh (`GET /management/job-titles`): cần `payroll.view` từ `team` trở lên, `payroll.manage` hoặc `org.manage`.

## Nhóm và nhân sự

Nhóm (team) là mục thu gọn ngay trong trang Thành viên, dùng để lọc khách và chấm công. Phòng ban, hồ sơ nhân viên, hợp đồng, chấm công, lương thuộc nhóm "Nhân sự (HR)" riêng.
