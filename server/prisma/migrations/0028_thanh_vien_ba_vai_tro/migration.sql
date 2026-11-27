-- Tinh gọn Cài đặt › Thành viên (≤20 người/công ty): ba vai trò cố định Chủ sở hữu / Quản trị / Thành viên.
-- Chạy cho từng công ty (schema); bản chạy lại hoặc DB chưa có người dùng thì không làm gì (cờ `ba_vai_tro_v1` trong `settings`).
--   1. Tạo vai trò "Thành viên" (dấu nhận ra ở `description`; vai trò tuỳ biến cũ trùng tên được đổi tên, không xoá).
--   2. Ánh xạ: người có vai trò hệ thống hoặc vai trò tuỳ biến giữ quyền quản trị (users.manage, roles.manage, org.manage,
--      settings.features, settings.integrations) → chỉ còn vai trò "Quản trị"; còn lại → chỉ còn "Thành viên".
--      Vai trò tuỳ biến cũ KHÔNG bị xoá (API cũ còn chạy), chỉ không còn ai giữ.
--   3. Lời mời còn chờ đổi sang một trong hai vai trò theo cùng luật.
--   4. Chủ sở hữu = Quản trị đang hoạt động có id nhỏ nhất (khoá `owner_user_id` trong `settings`) nếu chưa có.
DO $$
DECLARE
  member_id int;
  admin_id int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM settings WHERE key = 'ba_vai_tro_v1') THEN RETURN; END IF;

  SELECT id INTO admin_id FROM roles WHERE is_system ORDER BY id LIMIT 1;
  IF admin_id IS NULL THEN RETURN; END IF;

  SELECT id INTO member_id FROM roles WHERE description = 'Vai trò cố định: dùng nghiệp vụ, không có quyền quản trị' ORDER BY id LIMIT 1;
  IF member_id IS NULL THEN
    UPDATE roles SET name = name || ' (#' || id || ')', updated_at = now() WHERE lower(name) = lower('Thành viên');
    INSERT INTO roles (name, description, is_system, updated_at) VALUES ('Thành viên', 'Vai trò cố định: dùng nghiệp vụ, không có quyền quản trị', false, now())
      RETURNING id INTO member_id;
    INSERT INTO role_permissions (role_id, permission, scope) VALUES
      (member_id, 'contacts.view', 'all'),
      (member_id, 'contacts.create', NULL),
      (member_id, 'contacts.update', 'own'),
      (member_id, 'contacts.phone_full', 'own'),
      (member_id, 'deals.view', 'all'),
      (member_id, 'deals.manage', 'own'),
      (member_id, 'reports.overview', 'own'),
      (member_id, 'kanban.view', 'all'),
      (member_id, 'kanban.manage', 'own'),
      (member_id, 'newsfeed.post', NULL),
      (member_id, 'attendance.view', 'own'),
      (member_id, 'products.view', NULL),
      (member_id, 'pos.sell', 'own'),
      (member_id, 'custom_records.view', 'all'),
      (member_id, 'custom_records.manage', 'own'),
      (member_id, 'custom_records.phone_full', 'own'),
      (member_id, 'users.view', 'all')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Người đang là Quản trị (tính TRƯỚC khi đổi gì) lấy vai trò hệ thống.
  INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, admin_id FROM users u
  WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND (r.is_system OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
      AND rp.permission IN ('users.manage', 'roles.manage', 'org.manage', 'settings.features', 'settings.integrations'))))
  ON CONFLICT DO NOTHING;

  -- Quản trị chỉ giữ vai trò "Quản trị"; người còn lại chỉ giữ "Thành viên".
  DELETE FROM user_roles WHERE role_id <> admin_id
    AND user_id IN (SELECT user_id FROM user_roles WHERE role_id = admin_id);
  DELETE FROM user_roles WHERE role_id <> member_id
    AND user_id NOT IN (SELECT user_id FROM user_roles WHERE role_id = admin_id);
  INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, member_id FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = admin_id)
  ON CONFLICT DO NOTHING;

  -- Lời mời còn chờ.
  UPDATE user_invitations i SET role_id = CASE WHEN EXISTS (
      SELECT 1 FROM roles r WHERE r.id = i.role_id AND (r.is_system OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
      AND rp.permission IN ('users.manage', 'roles.manage', 'org.manage', 'settings.features', 'settings.integrations')))) THEN admin_id ELSE member_id END
  WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.role_id IS NOT NULL;

  -- Chủ sở hữu.
  INSERT INTO settings (key, value, updated_at)
  SELECT 'owner_user_id', u.id::text, now() FROM users u
  WHERE u.status = 'active' AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = admin_id)
  ORDER BY u.id LIMIT 1
  ON CONFLICT (key) DO NOTHING;

  INSERT INTO settings (key, value, updated_at) VALUES ('ba_vai_tro_v1', 'done', now()) ON CONFLICT (key) DO NOTHING;
END $$;
