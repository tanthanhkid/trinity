-- M04 (nit #375): tên vai trò duy nhất KHÔNG phân biệt hoa thường (khớp kiểm `lower(name)` ở mod-rbac-admin).
-- Bước 1: đổi tên các vai trò trùng `lower(name)` sẵn có, giữ nguyên bản ưu tiên (vai trò hệ thống trước, rồi id nhỏ nhất),
--         bản còn lại thêm hậu tố ` (#<id>)`; không xoá dòng nào nên user_roles / role_permissions giữ nguyên.
-- Bước 2: tạo index duy nhất trên lower(name). Chạy lại nhiều lần cho cùng kết quả (bước 1 không còn dòng trùng).
UPDATE "roles" r
SET "name" = r."name" || ' (#' || r."id" || ')',
    "updated_at" = now()
FROM (
    SELECT "id",
           row_number() OVER (PARTITION BY lower("name") ORDER BY "is_system" DESC, "id" ASC) AS rn
    FROM "roles"
) d
WHERE d."id" = r."id" AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_lower_key" ON "roles" (lower("name"));
