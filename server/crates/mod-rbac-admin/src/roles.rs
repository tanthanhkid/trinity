//! Vai trò và gán vai trò cho người dùng (`roles.service.ts`).

use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection, Row};
use trinity_db::pg_error::{app_error, db_error};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_rbac::cache::Users;
use trinity_rbac::grants::grants_to_json;
use trinity_rbac::{Grants, OwnerIds, admin_grants};

use crate::audit::{self, Entry};
use crate::guardrails::{
    GrantRow, assert_can_edit_role, assert_can_grant_roles, assert_can_manage_user, assert_can_modify_existing_role,
    grants_to_rows, lock_admin_mutation, parse_grants_input, rows_to_grants,
};
use crate::{Actor, CreateRole, Ctx, UpdateRole};

/// Khoá advisory số chỗ người dùng của công ty (cùng số với `USER_SLOT_LOCK` của bản Node): lời mời bị huỷ cùng giao dịch xoá
/// vai trò phải lấy khoá này trước, như tạo/nhận lời mời.
const USER_SLOT_LOCK: i32 = 726_354_004;

/// Khoá advisory tuần tự hoá đặt/đổi tên vai trò (đặt/đổi tên hiếm nên khoá chung, không theo công ty): kiểm trùng tên rồi ghi phải nằm cùng một khoá, nếu
/// không hai request cùng tên (hoa/thường khác nhau) đều qua được bước kiểm.
const ROLE_NAME_LOCK: i64 = 726_354_005;

fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn conflict(msg: impl Into<String>) -> AppError {
    HttpError::conflict(msg.into()).into()
}

#[derive(Debug, Serialize)]
pub struct RoleSummary {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub member_count: i64,
}

#[derive(Debug, Serialize)]
pub struct RoleDetail {
    #[serde(flatten)]
    pub summary: RoleSummary,
    pub grants: Value,
}

#[derive(Debug, Serialize)]
pub struct Member {
    pub id: i32,
    pub full_name: String,
    pub email: Option<String>,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct RoleRef {
    pub id: i32,
    pub name: String,
    pub is_system: bool,
}

#[derive(Debug, Serialize)]
pub struct UserRoles {
    pub user_id: i32,
    pub roles: Vec<RoleRef>,
}

#[derive(Debug, Serialize)]
pub struct Message {
    pub message: &'static str,
}

struct RoleRow {
    summary: RoleSummary,
    grants: Vec<GrantRow>,
}

impl RoleRow {
    /// Quản trị = mọi quyền (không lưu dòng `role_permissions`): trả đủ cho giao diện và nhân bản.
    fn effective_grants(&self) -> Grants {
        if self.summary.is_system {
            admin_grants()
        } else {
            rows_to_grants(&self.grants)
        }
    }
}

macro_rules! summary_sql {
    () => {
        "SELECT r.id, r.name, r.description, r.is_system,
        (SELECT count(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL WHERE ur.role_id = r.id) AS member_count
    FROM roles r"
    };
}

fn summary_of(r: &sqlx::postgres::PgRow) -> RoleSummary {
    RoleSummary {
        id: r.get("id"),
        name: r.get("name"),
        description: r.get("description"),
        is_system: r.get("is_system"),
        member_count: r.get("member_count"),
    }
}

async fn load(conn: &mut PgConnection, id: i32) -> Result<RoleRow, AppError> {
    let row = sqlx::query(concat!(summary_sql!(), " WHERE r.id = $1"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or_else(|| HttpError::not_found("Không tìm thấy vai trò"))?;
    let grants = sqlx::query("SELECT permission, scope FROM role_permissions WHERE role_id = $1 ORDER BY permission")
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        .iter()
        .map(|g| GrantRow {
            permission: g.get("permission"),
            scope: g.get("scope"),
        })
        .collect();
    Ok(RoleRow {
        summary: summary_of(&row),
        grants,
    })
}

/// `GET /roles` (`roles.manage` hoặc `users.manage` hoặc `kanban.boards`).
pub async fn list(conn: &mut PgConnection) -> Result<Vec<RoleSummary>, AppError> {
    let rows = sqlx::query(concat!(summary_sql!(), " ORDER BY r.id ASC"))
        .fetch_all(conn)
        .await
        .map_err(db)?;
    Ok(rows.iter().map(summary_of).collect())
}

fn detail(r: RoleRow) -> RoleDetail {
    let grants = grants_to_json(&r.effective_grants());
    RoleDetail {
        summary: r.summary,
        grants,
    }
}

/// `GET /roles/:id` (`roles.manage`).
pub async fn get(conn: &mut PgConnection, id: i32) -> Result<RoleDetail, AppError> {
    Ok(detail(load(conn, id).await?))
}

async fn assert_name_free(conn: &mut PgConnection, name: &str, except: Option<i32>) -> Result<(), AppError> {
    let dup: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM roles WHERE lower(name) = lower($1) AND ($2::int4 IS NULL OR id <> $2) LIMIT 1",
    )
    .bind(name)
    .bind(except)
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    if dup.is_some() {
        Err(conflict("Tên vai trò đã tồn tại"))
    } else {
        Ok(())
    }
}

async fn lock_role_name(conn: &mut PgConnection) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(ROLE_NAME_LOCK)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// Khoá dòng vai trò TRONG giao dịch rồi đọc lại cờ hệ thống và quyền hiện có (đọc trước giao dịch có thể đã cũ: người
/// khác vừa sửa quyền hoặc gán người vào vai trò). 404 nếu vừa bị xoá.
async fn lock_role(tx: &mut PgConnection, id: i32) -> Result<(bool, Grants), AppError> {
    let is_system: Option<bool> = sqlx::query_scalar("SELECT is_system FROM roles WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
    let is_system = is_system.ok_or_else(|| HttpError::not_found("Không tìm thấy vai trò"))?;
    let rows: Vec<GrantRow> =
        sqlx::query("SELECT permission, scope FROM role_permissions WHERE role_id = $1 ORDER BY permission")
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?
            .iter()
            .map(|g| GrantRow {
                permission: g.get("permission"),
                scope: g.get("scope"),
            })
            .collect();
    let grants = if is_system {
        admin_grants()
    } else {
        rows_to_grants(&rows)
    };
    Ok((is_system, grants))
}

async fn free_copy_name(conn: &mut PgConnection, base: &str) -> Result<String, AppError> {
    for i in 1..100 {
        let name = if i == 1 {
            format!("{base} (bản sao)")
        } else {
            format!("{base} (bản sao {i})")
        };
        let dup: Option<i32> = sqlx::query_scalar("SELECT id FROM roles WHERE lower(name) = lower($1) LIMIT 1")
            .bind(&name)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
        if dup.is_none() {
            return Ok(name);
        }
    }
    Err(conflict("Quá nhiều bản sao cùng tên"))
}

fn grants_json(g: &Grants) -> Value {
    grants_to_json(g)
}

async fn insert_role(
    conn: &mut PgConnection,
    actor: &Actor,
    name: &str,
    description: Option<&str>,
    grants: &Grants,
) -> Result<i32, AppError> {
    let mut tx = conn.begin().await.map_err(db)?;
    lock_role_name(&mut tx).await?;
    assert_name_free(&mut tx, name, None).await?;
    let id: Result<i32, sqlx::Error> = sqlx::query_scalar(
        "INSERT INTO roles (name, description, is_system, updated_at) VALUES ($1, $2, false, now()) RETURNING id",
    )
    .bind(name)
    .bind(description)
    .fetch_one(&mut *tx)
    .await;
    let id = id.map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, None) {
            conflict("Tên vai trò đã tồn tại")
        } else {
            d.into()
        }
    })?;
    write_grants(&mut tx, id, grants).await?;
    audit::record(
        &mut tx,
        &Entry {
            actor_id: actor.user_id,
            action: "role.create",
            target_type: "role",
            target_id: id,
            before: None,
            after: Some(json!({ "name": name, "description": description, "grants": grants_json(grants) })),
        },
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(id)
}

async fn write_grants(conn: &mut PgConnection, role_id: i32, grants: &Grants) -> Result<(), AppError> {
    for (permission, scope) in grants_to_rows(grants) {
        sqlx::query("INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1, $2, $3)")
            .bind(role_id)
            .bind(permission)
            .bind(scope)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    Ok(())
}

/// `POST /roles` (`roles.manage`, 201): quyền mới phải ⊆ quyền người gọi.
pub async fn create(conn: &mut PgConnection, actor: &Actor, input: &CreateRole) -> Result<RoleDetail, AppError> {
    let name = input.name.trim();
    let grants = parse_grants_input(&input.grants)?;
    assert_can_edit_role(actor, false, &grants)?;
    assert_name_free(conn, name, None).await?;
    let description = input.description.as_deref().map(str::trim).filter(|d| !d.is_empty());
    let id = insert_role(conn, actor, name, description, &grants).await?;
    get(conn, id).await
}

/// `POST /roles/:id/clone` (`roles.manage`, 201).
pub async fn clone(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<RoleDetail, AppError> {
    let src = load(conn, id).await?;
    let grants = src.effective_grants();
    assert_can_edit_role(actor, false, &grants)?;
    let name = free_copy_name(conn, &src.summary.name).await?;
    let new_id = insert_role(conn, actor, &name, src.summary.description.as_deref(), &grants).await?;
    get(conn, new_id).await
}

/// `PATCH /roles/:id` (`roles.manage`): đổi tên/mô tả; vai trò hệ thống không sửa được.
pub async fn update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: i32,
    input: &UpdateRole,
) -> Result<RoleDetail, AppError> {
    let role = load(conn, id).await?;
    assert_can_modify_existing_role(actor, role.summary.is_system, &role.effective_grants())?;
    let name = input
        .name
        .as_deref()
        .map_or_else(|| role.summary.name.clone(), |n| n.trim().to_owned());
    if name.to_lowercase() != role.summary.name.to_lowercase() {
        assert_name_free(conn, &name, Some(id)).await?;
    }
    let description = match &input.description {
        Some(d) => d.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(str::to_owned),
        None => role.summary.description.clone(),
    };
    let mut tx = conn.begin().await.map_err(db)?;
    lock_role_name(&mut tx).await?;
    if name.to_lowercase() != role.summary.name.to_lowercase() {
        assert_name_free(&mut tx, &name, Some(id)).await?;
    }
    let res = sqlx::query("UPDATE roles SET name = $2, description = $3, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(&name)
        .bind(&description)
        .execute(&mut *tx)
        .await;
    res.map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, None) {
            conflict("Tên vai trò đã tồn tại")
        } else {
            d.into()
        }
    })?;
    audit::record(
        &mut tx,
        &Entry {
            actor_id: actor.user_id,
            action: "role.update",
            target_type: "role",
            target_id: id,
            before: Some(json!({ "name": role.summary.name, "description": role.summary.description })),
            after: Some(json!({ "name": name, "description": description })),
        },
    )
    .await?;
    tx.commit().await.map_err(db)?;
    get(conn, id).await
}

async fn member_ids(conn: &mut PgConnection, role_id: i32) -> Result<Vec<i32>, AppError> {
    sqlx::query_scalar("SELECT user_id FROM user_roles WHERE role_id = $1 ORDER BY user_id")
        .bind(role_id)
        .fetch_all(conn)
        .await
        .map_err(db)
}

/// `PUT /roles/:id/grants` (`roles.manage`): THAY toàn bộ quyền; người đang giữ vai trò được vô hiệu cache quyền SAU commit.
pub async fn set_grants(
    conn: &mut PgConnection,
    ctx: &Ctx,
    actor: &Actor,
    id: i32,
    input: &Map<String, Value>,
) -> Result<RoleDetail, AppError> {
    let role = load(conn, id).await?;
    let before = role.effective_grants();
    assert_can_modify_existing_role(actor, role.summary.is_system, &before)?;
    let next = parse_grants_input(input)?;
    assert_can_edit_role(actor, role.summary.is_system, &next)?;
    let mut tx = conn.begin().await.map_err(db)?;
    // Đọc lại dưới khoá dòng: quyền/cờ hệ thống có thể đã đổi từ lúc kiểm ngoài giao dịch.
    let (is_system, before) = lock_role(&mut tx, id).await?;
    assert_can_modify_existing_role(actor, is_system, &before)?;
    assert_can_edit_role(actor, is_system, &next)?;
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    write_grants(&mut tx, id, &next).await?;
    audit::record(
        &mut tx,
        &Entry {
            actor_id: actor.user_id,
            action: "role.grants",
            target_type: "role",
            target_id: id,
            before: Some(grants_json(&before)),
            after: Some(grants_json(&next)),
        },
    )
    .await?;
    tx.commit().await.map_err(db)?;
    let members = member_ids(conn, id).await?;
    if !members.is_empty() {
        ctx.cache.invalidate_users(ctx.company.id(), Users::Ids(members)).await;
    }
    get(conn, id).await
}

/// `DELETE /roles/:id` (`roles.manage`): 409 nếu hệ thống hoặc còn người giữ. Lời mời còn chờ vào vai trò đó bị huỷ cùng
/// giao dịch xoá.
pub async fn remove(conn: &mut PgConnection, ctx: &Ctx, actor: &Actor, id: i32) -> Result<Message, AppError> {
    let role = load(conn, id).await?;
    if role.summary.is_system {
        return Err(conflict("Không thể xoá vai trò hệ thống"));
    }
    let grants = role.effective_grants();
    assert_can_modify_existing_role(actor, false, &grants)?;
    if role.summary.member_count > 0 {
        return Err(conflict(format!(
            "Không thể xoá vai trò đang có {} người giữ",
            role.summary.member_count
        )));
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(USER_SLOT_LOCK)
        .bind(ctx.company.id())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    // Kiểm lại dưới khoá dòng (gán người vào vai trò chiếm khoá khoá ngoại nên bị tuần tự hoá với đây).
    let (is_system, grants) = lock_role(&mut tx, id).await?;
    if is_system {
        return Err(conflict("Không thể xoá vai trò hệ thống"));
    }
    assert_can_modify_existing_role(actor, false, &grants)?;
    let members: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL WHERE ur.role_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if members > 0 {
        return Err(conflict(format!("Không thể xoá vai trò đang có {members} người giữ")));
    }
    sqlx::query("UPDATE user_invitations SET revoked_at = now() WHERE role_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    audit::record(
        &mut tx,
        &Entry {
            actor_id: actor.user_id,
            action: "role.delete",
            target_type: "role",
            target_id: id,
            before: Some(json!({ "name": role.summary.name, "description": role.summary.description, "grants": grants_json(&grants) })),
            after: None,
        },
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(Message {
        message: "Đã xoá vai trò",
    })
}

/// `GET /roles/:id/members` (`roles.manage`). `roles.manage` KHÔNG kéo theo quyền xem người dùng nên email (PII) chỉ trả cho
/// người nằm trong phạm vi `users.view` của người gọi; ngoài phạm vi chỉ lộ id/tên/trạng thái (email `null`).
pub async fn members(conn: &mut PgConnection, ctx: &Ctx, actor: &Actor, id: i32) -> Result<Vec<Member>, AppError> {
    load(conn, id).await?;
    let owners = ctx
        .scope
        .owner_ids(ctx.company, actor.user_id, &actor.grants, "users.view")
        .await
        .map_err(AppError::internal)?;
    let rows = sqlx::query(
        "SELECT u.id, u.full_name, u.email, u.status FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.role_id = $1 AND u.deleted_at IS NULL ORDER BY ur.user_id ASC",
    )
    .bind(id)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows
        .iter()
        .map(|r| {
            let uid: i32 = r.get("id");
            let visible = match &owners {
                Some(OwnerIds::All) => true,
                Some(OwnerIds::Ids(ids)) => ids.contains(&uid),
                None => false,
            };
            Member {
                id: uid,
                full_name: r.get("full_name"),
                email: visible.then(|| r.get("email")),
                status: r.get("status"),
            }
        })
        .collect())
}

async fn user_roles(conn: &mut PgConnection, user_id: i32) -> Result<UserRoles, AppError> {
    let rows = sqlx::query(
        "SELECT r.id, r.name, r.is_system FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.id",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(UserRoles {
        user_id,
        roles: rows
            .iter()
            .map(|r| RoleRef {
                id: r.get("id"),
                name: r.get("name"),
                is_system: r.get("is_system"),
            })
            .collect(),
    })
}

/// `PUT /users/:id/roles` (`users.manage`): THAY toàn bộ vai trò của một người, qua đủ các chốt chống tự nâng quyền. Cache
/// quyền của người đó bị vô hiệu SAU commit.
pub async fn set_user_roles(
    conn: &mut PgConnection,
    ctx: &Ctx,
    actor: &Actor,
    user_id: i32,
    role_ids: &[i32],
) -> Result<UserRoles, AppError> {
    assert_can_manage_user(ctx, actor, user_id).await?;
    let target: Option<String> = sqlx::query_scalar("SELECT status FROM users WHERE id = $1 AND deleted_at IS NULL")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let target_status = target.ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
    assert_can_grant_roles(conn, ctx, actor, user_id, role_ids).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    lock_admin_mutation(&mut tx).await?;
    replace_user_roles(&mut tx, actor, user_id, &target_status, role_ids).await?;
    tx.commit().await.map_err(db)?;
    ctx.cache
        .invalidate_users(ctx.company.id(), Users::Ids(vec![user_id]))
        .await;
    user_roles(conn, user_id).await
}

async fn replace_user_roles(
    tx: &mut PgConnection,
    actor: &Actor,
    user_id: i32,
    status: &str,
    role_ids: &[i32],
) -> Result<(), AppError> {
    let prev = sqlx::query("SELECT r.id, r.name, r.is_system FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.id")
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
    let prev_ids: Vec<i32> = prev.iter().map(|r| r.get("id")).collect();
    let mut next_ids = role_ids.to_vec();
    next_ids.sort_unstable();
    if prev_ids == next_ids {
        return Ok(());
    }
    sqlx::query("DELETE FROM user_roles WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    for rid in &next_ids {
        sqlx::query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)")
            .bind(user_id)
            .bind(rid)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let next = sqlx::query("SELECT id, name, is_system FROM roles WHERE id = ANY($1) ORDER BY id")
        .bind(&next_ids)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
    let prev_system = prev.iter().any(|r| r.get::<bool, _>("is_system"));
    let next_system = next.iter().any(|r| r.get::<bool, _>("is_system"));
    if status == "active" && prev_system && !next_system {
        let remaining: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM users u WHERE u.status = 'active' AND u.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_system)",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if remaining == 0 {
            return Err(conflict("Phải còn ít nhất 1 Quản trị"));
        }
    }
    let names = |rows: &[sqlx::postgres::PgRow]| rows.iter().map(|r| r.get::<String, _>("name")).collect::<Vec<_>>();
    audit::record(
        tx,
        &Entry {
            actor_id: actor.user_id,
            action: "user.roles",
            target_type: "user",
            target_id: user_id,
            before: Some(json!({ "roleIds": prev_ids, "roles": names(&prev) })),
            after: Some(json!({ "roleIds": next_ids, "roles": names(&next) })),
        },
    )
    .await?;
    Ok(())
}
