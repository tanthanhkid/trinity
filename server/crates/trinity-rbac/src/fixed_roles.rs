//! Ba vai trò cố định của tổ chức (mô hình Claude Team): Chủ sở hữu, Quản trị, Thành viên.
//!
//! - Quản trị = vai trò hệ thống `is_system` (mọi quyền), có sẵn từ lúc tạo công ty.
//! - Thành viên = một dòng `roles` mang dấu [`MEMBER_ROLE_MARK`] ở `description`, quyền cố định [`MEMBER_GRANTS`] (không có
//!   quyền quản trị nào). Dòng này được tạo lười ([`ensure_member_role`]) và bằng migration cho dữ liệu cũ.
//! - Chủ sở hữu = đúng một người, khoá `owner_user_id` trong bảng `settings`; thiếu hoặc trỏ tới người không còn dùng được
//!   thì lấy Quản trị đang hoạt động có id nhỏ nhất ([`owner_id`]).
//!
//! Quyền thật vẫn đi qua `role_permissions` như cũ: Thành viên không giữ `users.manage`/`roles.manage`/... nên mọi API quản trị
//! trả 403 ở router, không chỉ ẩn nút.

use sqlx::PgConnection;

/// Dấu nhận ra vai trò Thành viên cố định (tên có thể bị đổi, dấu thì không).
pub const MEMBER_ROLE_MARK: &str = "Vai trò cố định: dùng nghiệp vụ, không có quyền quản trị";
pub const MEMBER_ROLE_NAME: &str = "Thành viên";
pub const OWNER_KEY: &str = "owner_user_id";

/// Quyền cố định của Thành viên: dùng nghiệp vụ trong phạm vi của mình, xem chung khách/deal/việc của công ty nhỏ, xem phiếu
/// lương của chính mình (`payroll.view` phạm vi `own`; công ty đã có vai trò này được bổ sung bằng migration
/// `0031_thanh_vien_xem_phieu_luong`).
pub const MEMBER_GRANTS: &[(&str, Option<&str>)] = &[
    ("contacts.view", Some("all")),
    ("contacts.create", None),
    ("contacts.update", Some("own")),
    ("contacts.phone_full", Some("own")),
    ("deals.view", Some("all")),
    ("deals.manage", Some("own")),
    ("reports.overview", Some("own")),
    ("kanban.view", Some("all")),
    ("kanban.manage", Some("own")),
    ("newsfeed.post", None),
    ("attendance.view", Some("own")),
    ("payroll.view", Some("own")),
    ("products.view", None),
    ("pos.sell", Some("own")),
    ("custom_records.view", Some("all")),
    ("custom_records.manage", Some("own")),
    ("custom_records.phone_full", Some("own")),
    ("users.view", Some("all")),
];

/// Quyền chỉ Quản trị mới nên có: vai trò tuỳ biến giữ một trong các quyền này được coi là Quản trị.
pub const ADMIN_MARKER_PERMS: &[&str] = &[
    "users.manage",
    "roles.manage",
    "org.manage",
    "settings.features",
    "settings.integrations",
];

/// Điều kiện SQL (trên bảng `users u`): người này là Quản trị (vai trò hệ thống hoặc vai trò tuỳ biến giữ quyền quản trị).
pub const IS_ADMIN_SQL: &str = "EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = u.id AND (r.is_system OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
      AND rp.permission IN ('users.manage', 'roles.manage', 'org.manage', 'settings.features', 'settings.integrations'))))";

/// Id vai trò Thành viên; chưa có thì tạo (tên trùng một vai trò tuỳ biến cũ thì đổi tên vai trò cũ, không xoá). Chạy lại
/// nhiều lần cho cùng kết quả; hai request đồng thời cùng qua nhờ khoá advisory.
pub async fn ensure_member_role(conn: &mut PgConnection) -> Result<i32, sqlx::Error> {
    if let Some(id) = member_role_id(conn).await? {
        return Ok(id);
    }
    sqlx::query("SELECT pg_advisory_xact_lock(726354007)")
        .execute(&mut *conn)
        .await?;
    if let Some(id) = member_role_id(conn).await? {
        return Ok(id);
    }
    sqlx::query("UPDATE roles SET name = name || ' (#' || id || ')', updated_at = now() WHERE lower(name) = lower($1)")
        .bind(MEMBER_ROLE_NAME)
        .execute(&mut *conn)
        .await?;
    let (id,): (i32,) = sqlx::query_as(
        "INSERT INTO roles (name, description, is_system, updated_at) VALUES ($1, $2, false, now()) RETURNING id",
    )
    .bind(MEMBER_ROLE_NAME)
    .bind(MEMBER_ROLE_MARK)
    .fetch_one(&mut *conn)
    .await?;
    for (perm, scope) in MEMBER_GRANTS {
        sqlx::query(
            "INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(perm)
        .bind(scope)
        .execute(&mut *conn)
        .await?;
    }
    Ok(id)
}

pub async fn member_role_id(conn: &mut PgConnection) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM roles WHERE description = $1 ORDER BY id LIMIT 1")
        .bind(MEMBER_ROLE_MARK)
        .fetch_optional(&mut *conn)
        .await
}

/// Id vai trò hệ thống "Quản trị".
pub async fn admin_role_id(conn: &mut PgConnection) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM roles WHERE is_system ORDER BY id LIMIT 1")
        .fetch_optional(&mut *conn)
        .await
}

/// Chủ sở hữu hiện tại của tổ chức (xem mô tả module).
pub async fn owner_id(conn: &mut PgConnection) -> Result<Option<i32>, sqlx::Error> {
    let want =
        format!("SELECT u.id FROM users u WHERE u.deleted_at IS NULL AND u.status = 'active' AND {IS_ADMIN_SQL}");
    let set: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(OWNER_KEY)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(id) = set.and_then(|v| v.trim().parse::<i32>().ok()) {
        let ok: Option<i32> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("{want} AND u.id = $1")))
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
        if ok.is_some() {
            return Ok(Some(id));
        }
    }
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("{want} ORDER BY u.id LIMIT 1")))
        .fetch_optional(&mut *conn)
        .await
}

/// Ghi chủ sở hữu (không kiểm quyền: người gọi tự kiểm).
pub async fn set_owner(conn: &mut PgConnection, user: i32) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(OWNER_KEY)
    .bind(user.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thanh_vien_khong_co_quyen_quan_tri() {
        for (p, _) in MEMBER_GRANTS {
            assert!(!ADMIN_MARKER_PERMS.contains(p), "{p}");
            assert!(crate::catalog().is_permission(p), "{p} không có trong catalog");
        }
    }

    #[test]
    fn quyen_pham_vi_khop_catalog() {
        for (p, scope) in MEMBER_GRANTS {
            let scoped = crate::catalog().get(p).is_some_and(|d| d.scoped);
            assert_eq!(scoped, scope.is_some(), "{p}");
        }
        for p in ADMIN_MARKER_PERMS {
            assert!(IS_ADMIN_SQL.contains(p), "{p}");
        }
    }
}
