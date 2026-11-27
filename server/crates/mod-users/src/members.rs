//! Trang Thành viên (mô hình Claude Team, ≤20 người/công ty): ba vai trò cố định — Chủ sở hữu, Quản trị, Thành viên —
//! phủ lên RBAC sẵn có (xem [`trinity_rbac::fixed_roles`]). API cũ (`/users`, `/roles`, `/auth/invitations`) vẫn chạy;
//! module này chỉ thêm bốn route gọn cho giao diện:
//!
//! - `GET /members`: danh sách tên, email, vai trò, trạng thái, ngày tham gia + id hai vai trò để mời.
//! - `PUT /members/:id/role`: đổi giữa Quản trị và Thành viên (chỉ Quản trị; không đụng Chủ sở hữu).
//! - `POST /members/transfer-owner`: chủ chuyển quyền chủ cho một Quản trị khác (chỉ chủ).
//! - `DELETE /members/:id`: xoá khỏi tổ chức, BẮT BUỘC chọn người nhận dữ liệu (khách, deal, việc kanban...).

#![allow(clippy::result_large_err)]

use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::types::Timestamp;
use trinity_kernel::error::HttpError;
use trinity_rbac::fixed_roles::{self, IS_ADMIN_SQL};

use crate::guards::{Actor, R, assert_can_manage_user, db};
use crate::service::{self, Ctx};

/// Chủ sở hữu hiện tại (`None` khi tổ chức chưa có Quản trị nào hoạt động).
pub async fn owner_of(conn: &mut PgConnection) -> R<Option<i32>> {
    fixed_roles::owner_id(conn).await.map_err(db)
}

/// Id vai trò Thành viên, tạo nếu chưa có (công ty mới chưa có dòng này). Trong giao dịch để khoá advisory có tác dụng.
async fn ensure_member_role(ctx: &Ctx, company: trinity_db::CompanyRef) -> R<i32> {
    let mut tx = ctx.begin(company).await?;
    let id = fixed_roles::ensure_member_role(&mut tx).await.map_err(db)?;
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    Ok(id)
}

/// Tên vai trò hiển thị: `owner` | `admin` | `member`.
pub fn role_key(is_owner: bool, is_admin: bool) -> &'static str {
    if is_owner {
        "owner"
    } else if is_admin {
        "admin"
    } else {
        "member"
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i32,
    full_name: String,
    email: String,
    status: String,
    created_at: Timestamp,
    is_admin: bool,
}

/// `GET /members`.
pub async fn list(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut conn = ctx.conn(actor.company).await?;
    let owner = owner_of(&mut conn).await?;
    let mut member_role = fixed_roles::member_role_id(&mut conn).await.map_err(db)?;
    let admin_role = fixed_roles::admin_role_id(&mut conn).await.map_err(db)?;
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.full_name, u.email, u.status, u.created_at, {IS_ADMIN_SQL} AS is_admin
         FROM users u WHERE u.deleted_at IS NULL ORDER BY u.id LIMIT 500"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    // Người xem chỉ thấy email của người khác khi có quyền quản lý; Thành viên thấy tên và vai trò.
    let can_manage = actor.is_admin || trinity_rbac::can(&actor.grants, "users.manage", None);
    if member_role.is_none() && can_manage {
        drop(conn);
        member_role = Some(ensure_member_role(ctx, actor.company).await?);
        conn = ctx.conn(actor.company).await?;
    }
    let me = rows
        .iter()
        .find(|r| r.id == actor.user_id)
        .map_or("member", |r| role_key(Some(r.id) == owner, r.is_admin));
    let members: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "full_name": r.full_name,
                "email": if can_manage || r.id == actor.user_id { json!(r.email) } else { Value::Null },
                "role": role_key(Some(r.id) == owner, r.is_admin),
                "status": r.status,
                "joined_at": r.created_at,
            })
        })
        .collect();
    let plan: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'org_plan'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let max_users = crate::guards::max_users(plan.as_deref(), actor.company, ctx.multi_tenant());
    Ok(json!({
        "members": members,
        "me": { "id": actor.user_id, "role": me },
        "roles": { "admin_role_id": admin_role, "member_role_id": member_role },
        "max_users": max_users,
        "owner_id": owner,
    }))
}

/// Chỉ Quản trị (hoặc chủ) mới được dùng các thao tác ghi dưới đây; `users.manage` ở router là lớp ngoài, đây là lớp trong
/// (vai trò tuỳ biến cũ có `users.manage` nhưng không phải Quản trị thật vẫn bị chặn thao tác đổi vai trò/xoá).
fn assert_admin(actor: &Actor) -> R<()> {
    if actor.is_admin {
        Ok(())
    } else {
        Err(HttpError::forbidden("Chỉ Quản trị hoặc Chủ sở hữu mới làm được việc này").into())
    }
}

/// `PUT /members/:id/role`: `role` = `admin` | `member`.
pub async fn set_role(ctx: &Ctx, actor: &Actor, id: i32, role: &str) -> R<Value> {
    assert_admin(actor)?;
    if role != "admin" && role != "member" {
        return Err(HttpError::validation(vec!["role phải là admin hoặc member".to_owned()]).into());
    }
    let role_id = if role == "admin" {
        let mut conn = ctx.conn(actor.company).await?;
        fixed_roles::admin_role_id(&mut conn).await.map_err(db)?
    } else {
        Some(ensure_member_role(ctx, actor.company).await?)
    }
    .ok_or_else(|| HttpError::not_found("Không tìm thấy vai trò"))?;
    service::set_roles(ctx, actor, id, &[role_id]).await?;
    Ok(json!({ "user_id": id, "role": role }))
}

/// `POST /members/transfer-owner`: chủ hiện tại chuyển quyền chủ cho một thành viên đang hoạt động (người đó thành Quản trị,
/// chủ cũ vẫn là Quản trị).
pub async fn transfer_owner(ctx: &Ctx, actor: &Actor, to: i32) -> R<Value> {
    let admin_role = {
        let mut conn = ctx.conn(actor.company).await?;
        if owner_of(&mut conn).await? != Some(actor.user_id) {
            return Err(HttpError::forbidden("Chỉ Chủ sở hữu mới chuyển được quyền chủ").into());
        }
        fixed_roles::admin_role_id(&mut conn)
            .await
            .map_err(db)?
            .ok_or_else(|| HttpError::not_found("Không tìm thấy vai trò Quản trị"))?
    };
    if to == actor.user_id {
        return Err(HttpError::bad_request("Bạn đang là Chủ sở hữu").into());
    }
    let mut tx = ctx.begin(actor.company).await?;
    crate::guards::lock_admin_mutation(&mut tx).await?;
    if owner_of(&mut tx).await? != Some(actor.user_id) {
        return Err(HttpError::forbidden("Chỉ Chủ sở hữu mới chuyển được quyền chủ").into());
    }
    let ok: Option<i32> =
        sqlx::query_scalar("SELECT id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL")
            .bind(to)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    if ok.is_none() {
        return Err(HttpError::bad_request("Người nhận quyền chủ phải là thành viên đang hoạt động").into());
    }
    let has: Option<i32> = sqlx::query_scalar("SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2")
        .bind(to)
        .bind(admin_role)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
    if has.is_none() {
        sqlx::query("DELETE FROM user_roles WHERE user_id = $1")
            .bind(to)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)")
            .bind(to)
            .bind(admin_role)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    fixed_roles::set_owner(&mut tx, to).await.map_err(db)?;
    sqlx::query(
        "INSERT INTO rbac_audit_log (actor_id, action, target_type, target_id, before, after) VALUES ($1, 'user.owner', 'user', $2, $3, $4)",
    )
    .bind(actor.user_id)
    .bind(to)
    .bind(json!({ "ownerId": actor.user_id }))
    .bind(json!({ "ownerId": to }))
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    ctx.cache
        .invalidate_users(actor.company.id(), trinity_rbac::cache::Users::All)
        .await;
    Ok(json!({ "owner_id": to }))
}

/// `DELETE /members/:id` với `reassign_to` bắt buộc.
pub async fn remove(ctx: &Ctx, actor: &Actor, id: i32, reassign_to: Option<i32>) -> R<Value> {
    assert_admin(actor)?;
    let Some(to) = reassign_to else {
        return Err(HttpError::validation(vec![
            "reassign_to: chọn người nhận dữ liệu của thành viên bị xoá".to_owned(),
        ])
        .into());
    };
    if to == id {
        return Err(HttpError::bad_request("Người nhận dữ liệu phải khác người bị xoá").into());
    }
    {
        let mut conn = ctx.conn(actor.company).await?;
        let ok: Option<i32> =
            sqlx::query_scalar("SELECT id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL")
                .bind(to)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        if ok.is_none() {
            return Err(HttpError::bad_request("Người nhận dữ liệu phải là thành viên đang hoạt động").into());
        }
    }
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    service::permanent_delete_with(ctx, actor, id, Some(to), Some(to)).await
}

/// Chuyển mọi thứ gán cho `from` sang `to`: khách, deal, thẻ kanban (+ người tham gia), bản ghi tuỳ biến, người nhận mặc định
/// của fanpage và webhook vào. Chạy trong giao dịch của người gọi.
pub async fn transfer_data(conn: &mut PgConnection, from: i32, to: i32) -> R<()> {
    for sql in [
        "UPDATE contacts SET assigned_to = $2, updated_at = now() WHERE assigned_to = $1",
        "UPDATE deals SET assigned_to = $2, updated_at = now() WHERE assigned_to = $1",
        "UPDATE kanban_cards SET assignee_id = $2 WHERE assignee_id = $1",
        "DELETE FROM kanban_card_assignees WHERE user_id = $1
           AND card_id IN (SELECT card_id FROM kanban_card_assignees WHERE user_id = $2)",
        "UPDATE kanban_card_assignees SET user_id = $2 WHERE user_id = $1",
        "UPDATE custom_records SET owner_id = $2 WHERE owner_id = $1",
        "UPDATE facebook_pages SET default_assignee_id = $2 WHERE default_assignee_id = $1",
        "UPDATE webhook_inbound_sources SET default_assignee_id = $2 WHERE default_assignee_id = $1",
    ] {
        sqlx::query(sql)
            .bind(from)
            .bind(to)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    Ok(())
}
