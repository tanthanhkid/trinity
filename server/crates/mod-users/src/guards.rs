//! Luật bảo vệ dùng chung của quản lý người dùng: chống leo thang, Quản trị cuối cùng, hạn mức người dùng của gói, lời
//! mời đang chờ và giai đoạn làm việc. Chuyển từ `role-guardrails.ts`, `plan-limits.ts`, `invitations.ts` và
//! `employment-periods.ts`. Mọi hàm nhận `&mut PgConnection` đã gắn công ty (`TenantConn`/`TenantTx` deref ra kiểu này);
//! hàm cần khoá advisory phải chạy TRONG giao dịch.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::LazyLock;

use serde::Deserialize;
use sqlx::PgConnection;
use trinity_db::CompanyRef;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, ScopeError, ScopeService, is_subset};

pub type R<T> = Result<T, AppError>;

pub fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Khoá advisory tuần tự hoá mọi thao tác có thể làm hết Quản trị.
pub const ADMIN_MUTATION_LOCK: i64 = 724_001;
/// Khoá advisory của việc "đếm chỗ trống rồi thêm người" (khoá đôi: loại khoá + id công ty).
pub const USER_SLOT_LOCK: i32 = 726_354_004;

pub async fn lock_admin_mutation(conn: &mut PgConnection) -> R<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(ADMIN_MUTATION_LOCK)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

pub async fn lock_user_slots(conn: &mut PgConnection, company: CompanyRef) -> R<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(USER_SLOT_LOCK)
        .bind(company.id())
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// Hệ thống luôn còn ít nhất 1 Quản trị đang hoạt động: `user` là Quản trị mà không còn Quản trị active khác ⇒ 409.
pub async fn assert_not_last_admin(conn: &mut PgConnection, user: i32) -> R<()> {
    let is_admin: Option<i32> = sqlx::query_scalar(
        "SELECT u.id FROM users u WHERE u.id = $1
           AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_system)",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if is_admin.is_none() {
        return Ok(());
    }
    let others: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users u WHERE u.id <> $1 AND u.status = 'active' AND u.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_system)",
    )
    .bind(user)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    if others == 0 {
        return Err(HttpError::conflict("Phải còn ít nhất 1 Quản trị").into());
    }
    Ok(())
}

/// Người gọi, đủ cho kiểm quyền theo dữ liệu. Do guard của router điền (`CurrentUser`).
#[derive(Debug, Clone)]
pub struct Actor {
    pub user_id: i32,
    pub company: CompanyRef,
    pub grants: Grants,
    pub is_admin: bool,
}

pub fn scope_err(e: ScopeError) -> AppError {
    match e {
        ScopeError::NotFound(b) => AppError::Http(*b),
        ScopeError::Db(d) => AppError::internal(d),
    }
}

/// Target ngoài phạm vi `users.manage` ⇒ 404; quyền hiện có của target không ⊆ quyền actor ⇒ 403. Quản trị luôn qua.
pub async fn assert_can_manage_user(
    scopes: &ScopeService,
    perms: &trinity_rbac::PermissionService,
    actor: &Actor,
    target: i32,
) -> R<()> {
    scopes
        .assert_in_scope(
            actor.company,
            actor.user_id,
            &actor.grants,
            "users.manage",
            &[Some(target)],
        )
        .await
        .map_err(scope_err)?;
    if actor.is_admin {
        return Ok(());
    }
    let t = perms
        .grants_for(actor.company, target)
        .await
        .map_err(AppError::internal)?;
    if t.is_admin || !is_subset(&t.grants, &actor.grants) {
        return Err(HttpError::forbidden("Không thể thao tác người có quyền cao hơn bạn").into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct PlanRow {
    #[serde(rename = "maxUsers")]
    max_users: Option<i64>,
}

#[derive(Deserialize)]
struct PlansFile {
    plans: std::collections::BTreeMap<String, PlanRow>,
    default_plan: String,
    default_signup_plan: String,
}

static PLANS: LazyLock<PlansFile> = LazyLock::new(|| {
    #[allow(clippy::expect_used)]
    serde_json::from_str(include_str!("../../../contracts/rbac.json")).expect("rbac.json nhúng hỏng")
});

/// Giới hạn người dùng của gói đang áp: dòng `org_plan` hợp lệ thì theo dòng đó; thiếu thì công ty khác 1 của chế độ
/// nhiều công ty dùng gói đăng ký mặc định, còn lại gói mặc định. `None` = không giới hạn.
pub fn max_users(raw: Option<&str>, company: CompanyRef, multi_tenant: bool) -> Option<i64> {
    let key = match raw.map(str::trim).filter(|k| PLANS.plans.contains_key(*k)) {
        Some(k) => k.to_owned(),
        None if multi_tenant && company.id() != 1 => PLANS.default_signup_plan.clone(),
        None => PLANS.default_plan.clone(),
    };
    PLANS.plans.get(&key).and_then(|p| p.max_users)
}

/// Lời mời "nhận được thật" (còn hạn, chưa dùng/huỷ, vai trò còn, người mời còn hoạt động và còn `users.manage`).
const USABLE_INVITATION_SQL: &str = "i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  AND i.role_id IS NOT NULL AND EXISTS (SELECT 1 FROM roles r0 WHERE r0.id = i.role_id)
  AND EXISTS (
    SELECT 1 FROM users u WHERE u.id = i.created_by AND u.status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'users.manage'
         WHERE ur.user_id = u.id AND (r.is_system OR rp.role_id IS NOT NULL)))";

/// Chặn thêm/kích hoạt người khi `người active + lời mời đang chờ` đã đạt `maxUsers` của gói. PHẢI chạy trong giao dịch và
/// TRƯỚC khi ghi người mới (lấy khoá advisory của công ty đến hết giao dịch).
pub async fn assert_user_slot_available(conn: &mut PgConnection, company: CompanyRef, multi_tenant: bool) -> R<()> {
    let plan: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'org_plan'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some(max) = max_users(plan.as_deref(), company, multi_tenant) else {
        return Ok(());
    };
    lock_user_slots(conn, company).await?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE status = 'active' AND deleted_at IS NULL")
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let pending: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM user_invitations i WHERE {USABLE_INVITATION_SQL}"
    )))
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    if active + pending >= max {
        return Err(HttpError::conflict(format!("Gói hiện tại tối đa {max} người, liên hệ để nâng gói.")).into());
    }
    Ok(())
}

/// Thêm người trực tiếp cho email đang có lời mời chờ: huỷ lời mời TRONG giao dịch và TRƯỚC khi kiểm chỗ. `owners = None`
/// = mọi lời mời; có danh sách thì lời mời còn hiệu lực của người ngoài phạm vi ⇒ 409.
pub async fn revoke_pending_for_email(
    conn: &mut PgConnection,
    company: CompanyRef,
    email: &str,
    owners: Option<&[i32]>,
) -> R<()> {
    lock_user_slots(conn, company).await?;
    let open: Vec<(i32, Option<i32>, bool)> = sqlx::query_as(
        "SELECT id, created_by, expires_at > now() FROM user_invitations
         WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
    )
    .bind(email.trim().to_lowercase())
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    if let Some(owners) = owners
        && open
            .iter()
            .any(|(_, by, live)| *live && by.is_none_or(|b| !owners.contains(&b)))
    {
        return Err(HttpError::conflict(
            "Email này đang có lời mời do người khác tạo. Nhờ người đó huỷ lời mời trước.",
        )
        .into());
    }
    if !open.is_empty() {
        let ids: Vec<i32> = open.iter().map(|o| o.0).collect();
        sqlx::query("UPDATE user_invitations SET revoked_at = now() WHERE id = ANY($1) AND accepted_at IS NULL AND revoked_at IS NULL")
            .bind(ids)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    Ok(())
}

/// Người mời bị khoá/xoá: các lời mời còn chờ của họ chết cùng.
pub async fn revoke_pending_by(conn: &mut PgConnection, company: CompanyRef, user: i32) -> R<()> {
    lock_user_slots(conn, company).await?;
    sqlx::query("UPDATE user_invitations SET revoked_at = now() WHERE created_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL")
        .bind(user)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// Khoá dòng nhân viên rồi, nếu người này CHƯA có giai đoạn nào, dựng giai đoạn tương đương luật cũ.
async fn materialize_legacy(conn: &mut PgConnection, employee: i32) -> R<()> {
    sqlx::query("SELECT 1 FROM employees WHERE id = $1 FOR UPDATE")
        .bind(employee)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    sqlx::query(
        "INSERT INTO employment_periods (employee_id, started_on, ended_on)
         SELECT e.id, NULL,
                CASE WHEN e.status = 'resigned' THEN (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END
         FROM employees e
         WHERE e.id = $1
           AND NOT (e.status = 'resigned' AND e.resigned_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM employment_periods p WHERE p.employee_id = e.id)",
    )
    .bind(employee)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Nghỉ việc / bị khoá từ ngày hôm nay (giờ VN): đóng giai đoạn đang mở.
pub async fn record_employment_end(conn: &mut PgConnection, employee: i32) -> R<()> {
    materialize_legacy(conn, employee).await?;
    sqlx::query(
        "UPDATE employment_periods SET ended_on = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
         WHERE employee_id = $1 AND ended_on IS NULL",
    )
    .bind(employee)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Đi làm lại / được mở khoá: mở giai đoạn mới nếu chưa có giai đoạn đang mở.
pub async fn record_employment_start(conn: &mut PgConnection, employee: i32) -> R<()> {
    materialize_legacy(conn, employee).await?;
    sqlx::query(
        "INSERT INTO employment_periods (employee_id, started_on)
         SELECT $1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
         WHERE NOT EXISTS (SELECT 1 FROM employment_periods p WHERE p.employee_id = $1 AND p.ended_on IS NULL)",
    )
    .bind(employee)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Đồng bộ trạng thái nghỉ việc sang `employees`: khoá = `resigned` + `resigned_at` (không dời ngày của người đã nghỉ);
/// mở khoá = `active` và xoá mốc. Người chưa có hồ sơ nhân viên ⇒ không làm gì.
pub async fn sync_employee_resignation(conn: &mut PgConnection, user: i32, resigned: bool) -> R<()> {
    let emp: Option<i32> = sqlx::query_scalar("SELECT id FROM employees WHERE user_id = $1")
        .bind(user)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some(emp) = emp else { return Ok(()) };
    if resigned {
        record_employment_end(conn, emp).await?;
        sqlx::query(
            "UPDATE employees SET status = 'resigned', resigned_at = now() WHERE id = $1 AND status <> 'resigned'",
        )
        .bind(emp)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    } else {
        record_employment_start(conn, emp).await?;
        sqlx::query("UPDATE employees SET status = 'active', resigned_at = NULL WHERE id = $1")
            .bind(emp)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gioi_han_nguoi_dung_theo_goi() {
        let c1 = CompanyRef::DEFAULT;
        let c2 = CompanyRef::new(2).unwrap();
        // Một công ty, không có dòng: gói mặc định `custom` ⇒ không giới hạn.
        assert_eq!(max_users(None, c1, false), None);
        assert_eq!(max_users(Some("rác"), c1, false), None);
        // Đa công ty: công ty 2 thiếu dòng ⇒ gói đăng ký mặc định (10 người); công ty 1 không giới hạn.
        assert_eq!(max_users(None, c2, true), Some(10));
        assert_eq!(max_users(None, c1, true), None);
        assert_eq!(max_users(Some(" ket_noi "), c1, false), Some(10));
    }
}
