-- Thành viên (vai trò cố định, nhận ra bằng dấu ở `description`) được xem phiếu lương của CHÍNH MÌNH: `payroll.view` phạm vi `own`.
-- Chạy cho từng công ty (schema). Chưa có vai trò Thành viên thì không làm gì (vai trò được tạo lười với đủ `MEMBER_GRANTS`).
-- Đã có `payroll.view` (bất kỳ phạm vi) thì giữ nguyên. Chạy lại nhiều lần cho cùng kết quả.
INSERT INTO role_permissions (role_id, permission, scope)
SELECT r.id, 'payroll.view', 'own' FROM roles r
WHERE r.description = 'Vai trò cố định: dùng nghiệp vụ, không có quyền quản trị'
ON CONFLICT (role_id, permission) DO NOTHING;
