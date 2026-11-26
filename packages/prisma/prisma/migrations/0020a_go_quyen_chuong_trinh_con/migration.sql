-- G02: chương trình con đã gỡ. Xoá các dòng cấp 3 quyền `extensions.view|draft|approve` khỏi vai trò.
-- Quyền không còn trong catalog nên vốn đã bị bỏ qua khi đọc; dọn để màn quản trị vai trò và bản Rust không gặp khoá lạ.
-- Chạy lại nhiều lần không sao (DELETE theo điều kiện). Ba khoá này không được dùng lại (xem packages/rbac/src/catalog.ts).
DELETE FROM "role_permissions"
WHERE "permission" IN ('extensions.view', 'extensions.draft', 'extensions.approve');
