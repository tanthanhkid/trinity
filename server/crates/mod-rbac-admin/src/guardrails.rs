//! Chống tự nâng quyền (`role-guardrails.ts`): MỘT luật so theo QUYỀN, không theo tên vai trò. Người gọi không bao giờ
//! cấp hay thao tác được thứ không phải tập con quyền của chính mình ([`trinity_rbac::is_subset`]). Quản trị (`is_admin`)
//! không bị giới hạn bởi luật này, trừ việc vai trò hệ thống không ai sửa được và hệ thống luôn còn ít nhất một Quản trị.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grant, Grants, Scope, ScopeError, catalog, is_subset, merge_grants, normalize_grant};

use crate::{Actor, Ctx};

/// Khoá advisory xuyên tiến trình cho mọi thay đổi có thể làm hết Quản trị (cùng số với bản Node).
pub const ADMIN_MUTATION_LOCK: i64 = 724_001;

fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn forbidden(msg: &str) -> AppError {
    HttpError::forbidden(msg).into()
}

fn not_found(msg: &str) -> AppError {
    HttpError::not_found(msg).into()
}

fn conflict(msg: &str) -> AppError {
    HttpError::conflict(msg).into()
}

/// Một dòng `role_permissions`.
#[derive(Debug, Clone)]
pub struct GrantRow {
    pub permission: String,
    pub scope: Option<String>,
}

/// Dòng quyền → [`Grants`]: khoá lạ bị bỏ, scoped thiếu phạm vi thành `own`.
pub fn rows_to_grants(rows: &[GrantRow]) -> Grants {
    rows.iter()
        .filter_map(|r| normalize_grant(&r.permission, r.scope.as_deref()).map(|g| (r.permission.clone(), g)))
        .collect()
}

/// Hợp quyền của nhiều vai trò (`grantsOfRoles`).
pub fn grants_of_roles(roles: &[Vec<GrantRow>]) -> Grants {
    let each: Vec<Grants> = roles.iter().map(|r| rows_to_grants(r)).collect();
    merge_grants(&each)
}

/// Sửa quyền một vai trò: tập quyền MỚI phải ⊆ quyền người gọi; vai trò hệ thống không sửa được. Hàm thuần.
pub fn assert_can_edit_role(actor: &Actor, is_system: bool, next: &Grants) -> Result<(), AppError> {
    if is_system {
        return Err(forbidden("Không thể sửa vai trò hệ thống"));
    }
    if !actor.is_admin && !is_subset(next, &actor.grants) {
        return Err(forbidden("Không thể cấp quyền bạn không có"));
    }
    Ok(())
}

/// Vai trò đã tồn tại: ngoài [`assert_can_edit_role`], quyền HIỆN CÓ cũng phải ⊆ quyền người gọi (không hạ hay phá được
/// vai trò "to" hơn mình).
pub fn assert_can_modify_existing_role(actor: &Actor, is_system: bool, current: &Grants) -> Result<(), AppError> {
    if is_system {
        return Err(forbidden("Không thể sửa vai trò hệ thống"));
    }
    if !actor.is_admin && !is_subset(current, &actor.grants) {
        return Err(forbidden("Không thể sửa vai trò có quyền cao hơn bạn"));
    }
    Ok(())
}

/// Tuần tự hoá mọi thao tác có thể làm hết Quản trị: gọi ĐẦU giao dịch, trước khi đếm Quản trị còn lại.
pub async fn lock_admin_mutation(conn: &mut PgConnection) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(ADMIN_MUTATION_LOCK)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// Kiểm phạm vi `users.manage` của người gọi với `target` (ngoài phạm vi ⇒ 404 "Không tìm thấy").
async fn assert_in_users_manage_scope(ctx: &Ctx, actor: &Actor, target: i32) -> Result<(), AppError> {
    ctx.scope
        .assert_in_scope(
            ctx.company,
            actor.user_id,
            &actor.grants,
            "users.manage",
            &[Some(target)],
        )
        .await
        .map_err(|e| match e {
            ScopeError::NotFound(h) => AppError::Http(*h),
            ScopeError::Db(d) => AppError::internal(d),
        })
}

/// Sửa/khoá/xoá/đổi vai trò MỘT người đã có: trong phạm vi `users.manage` (404 nếu ngoài) VÀ quyền hiện có của họ ⊆ quyền
/// người gọi. Quản trị luôn qua.
pub async fn assert_can_manage_user(ctx: &Ctx, actor: &Actor, target: i32) -> Result<(), AppError> {
    assert_in_users_manage_scope(ctx, actor, target).await?;
    if actor.is_admin {
        return Ok(());
    }
    let t = ctx
        .permissions
        .grants_for(ctx.company, target)
        .await
        .map_err(AppError::internal)?;
    if t.is_admin || !is_subset(&t.grants, &actor.grants) {
        return Err(forbidden("Không thể thao tác người có quyền cao hơn bạn"));
    }
    Ok(())
}

/// Gán (thay toàn bộ) vai trò cho một người: id không tồn tại ⇒ 404; vai trò hệ thống chỉ Quản trị gán/gỡ; hợp quyền vai
/// trò mới ⊆ quyền người gọi; không tự đổi vai trò của mình (trừ Quản trị); không để hệ thống hết Quản trị đang hoạt động.
pub async fn assert_can_grant_roles(
    conn: &mut PgConnection,
    ctx: &Ctx,
    actor: &Actor,
    target: i32,
    role_ids: &[i32],
) -> Result<(), AppError> {
    assert_in_users_manage_scope(ctx, actor, target).await?;
    let roles: Vec<(i32, bool)> = sqlx::query_as("SELECT id, is_system FROM roles WHERE id = ANY($1) ORDER BY id")
        .bind(role_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    if roles.len() != role_ids.len() {
        return Err(not_found("Không tìm thấy vai trò"));
    }
    let next_has_system = roles.iter().any(|r| r.1);
    if next_has_system && !actor.is_admin {
        return Err(forbidden("Chỉ Quản trị mới được gán vai trò Quản trị"));
    }
    let target_is_admin: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.is_system)",
    )
    .bind(target)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    // Người thường không gỡ được vai trò Quản trị của người khác dù chỉ bằng cách gửi danh sách không chứa nó.
    if !actor.is_admin && target_is_admin {
        return Err(forbidden("Chỉ Quản trị mới được gỡ vai trò Quản trị"));
    }
    if !actor.is_admin {
        let rows: Vec<(i32, String, Option<String>)> = sqlx::query_as(
            "SELECT role_id, permission, scope FROM role_permissions WHERE role_id = ANY($1) ORDER BY role_id",
        )
        .bind(role_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        let mut per_role: BTreeMap<i32, Vec<GrantRow>> = role_ids.iter().map(|id| (*id, Vec::new())).collect();
        for (role_id, permission, scope) in rows {
            per_role
                .entry(role_id)
                .or_default()
                .push(GrantRow { permission, scope });
        }
        let lists: Vec<Vec<GrantRow>> = per_role.into_values().collect();
        if !is_subset(&grants_of_roles(&lists), &actor.grants) {
            return Err(forbidden("Không thể cấp quyền bạn không có"));
        }
    }
    if target == actor.user_id && !actor.is_admin {
        return Err(forbidden("Không thể tự đổi vai trò của mình"));
    }
    // Người đang bị khoá/chưa kích hoạt không tính là Quản trị hoạt động: gỡ vai trò của họ không làm hụt Quản trị.
    let target_active: bool =
        sqlx::query_scalar("SELECT status = 'active' FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(target)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?
            .unwrap_or(false);
    if !next_has_system && target_is_admin && target_active {
        let remaining: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM users u WHERE u.id <> $1 AND u.status = 'active' AND u.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_system)",
        )
        .bind(target)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        if remaining == 0 {
            return Err(conflict("Phải còn ít nhất 1 Quản trị"));
        }
    }
    Ok(())
}

/// Kiểm và chuẩn hoá `grants` do client gửi: khoá phải thuộc danh mục (lạ ⇒ 400, không lặng lẽ bỏ); quyền scoped bắt buộc
/// `own|team|subtree|all`; quyền không scoped nhận `null` hoặc `true`; `false` là không cấp (bỏ khoá).
pub fn parse_grants_input(input: &Map<String, Value>) -> Result<Grants, AppError> {
    let mut out = Grants::new();
    for (key, raw) in input {
        let Some(def) = catalog().get(key) else {
            return Err(HttpError::bad_request(format!("Quyền không tồn tại: {key}")).into());
        };
        if matches!(raw, Value::Bool(false)) {
            continue;
        }
        if def.scoped {
            let scope = raw.as_str().and_then(Scope::parse);
            let Some(scope) = scope else {
                return Err(HttpError::bad_request(format!(
                    "Quyền \"{}\" cần chọn phạm vi (own, team, subtree, all)",
                    def.label
                ))
                .into());
            };
            out.insert(key.clone(), Grant::Scope(scope));
        } else {
            if !matches!(raw, Value::Null | Value::Bool(true)) {
                return Err(HttpError::bad_request(format!("Quyền \"{}\" không có phạm vi", def.label)).into());
            }
            out.insert(key.clone(), Grant::Full);
        }
    }
    Ok(out)
}

/// [`Grants`] → (quyền, scope) của `role_permissions` (scope NULL với quyền không scoped).
pub fn grants_to_rows(grants: &Grants) -> Vec<(String, Option<&'static str>)> {
    grants
        .iter()
        .map(|(p, g)| {
            (
                p.clone(),
                match g {
                    Grant::Full => None,
                    Grant::Scope(s) => Some(s.as_str()),
                },
            )
        })
        .collect()
}
