//! Nhật ký thay đổi vai trò/quyền (`rbac-audit.service.ts`).

use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use trinity_db::pg_error::app_error;
use trinity_db::types::{JsonValue, Timestamp};
use trinity_kernel::error::AppError;

use crate::AuditQuery;

fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Một dòng nhật ký cần ghi.
#[derive(Debug, Clone)]
pub struct Entry<'a> {
    pub actor_id: i32,
    /// `role.create|role.update|role.delete|role.grants|user.roles`.
    pub action: &'a str,
    /// `role` hoặc `user`.
    pub target_type: &'a str,
    pub target_id: i32,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

/// Ghi trong CÙNG giao dịch với thay đổi (nhật ký và dữ liệu không lệch nhau): truyền kết nối của giao dịch.
pub async fn record(conn: &mut PgConnection, e: &Entry<'_>) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO rbac_audit_log (actor_id, action, target_type, target_id, before, after)
         VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)",
    )
    .bind(e.actor_id)
    .bind(e.action)
    .bind(e.target_type)
    .bind(e.target_id)
    .bind(e.before.as_ref().map(trinity_kernel::json::js_json))
    .bind(e.after.as_ref().map(trinity_kernel::json::js_json))
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct AuditRow {
    pub id: i64,
    pub actor_id: i32,
    pub actor_name: String,
    pub action: String,
    pub target_type: String,
    pub target_id: i32,
    pub target_name: Option<String>,
    pub before: Option<JsonValue>,
    pub after: Option<JsonValue>,
    pub created_at: Timestamp,
}

#[derive(Debug, Serialize)]
pub struct AuditPage {
    pub data: Vec<AuditRow>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
}

/// `GET /rbac/audit` (`roles.manage`): mới nhất trước. Với `targetType=role` + `targetId`, gộp thêm các dòng `user.roles` có
/// chứa id vai trò đó trong before/after (tab "Nhật ký" của vai trò thấy cả việc thêm/gỡ người).
pub async fn list(conn: &mut PgConnection, q: &AuditQuery) -> Result<AuditPage, AppError> {
    let page = q.page.unwrap_or(1);
    let limit = q.limit.unwrap_or(30);
    let offset = (page - 1) * limit;
    let (rows, total) = match (q.target_type.as_deref(), q.target_id) {
        (Some("role"), Some(id)) => {
            let rows = sqlx::query(
                "SELECT id, actor_id, action, target_type, target_id, before, after, created_at FROM rbac_audit_log
                 WHERE (target_type = 'role' AND target_id = $1)
                    OR (action = 'user.roles' AND (before->'roleIds' @> jsonb_build_array($1::int4) OR after->'roleIds' @> jsonb_build_array($1::int4)))
                 ORDER BY id DESC OFFSET $2 LIMIT $3",
            )
            .bind(id)
            .bind(offset)
            .bind(limit)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
            let total: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM rbac_audit_log
                 WHERE (target_type = 'role' AND target_id = $1)
                    OR (action = 'user.roles' AND (before->'roleIds' @> jsonb_build_array($1::int4) OR after->'roleIds' @> jsonb_build_array($1::int4)))",
            )
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
            (rows, total)
        }
        (target_type, target_id) => {
            let rows = sqlx::query(
                "SELECT id, actor_id, action, target_type, target_id, before, after, created_at FROM rbac_audit_log
                 WHERE ($1::text IS NULL OR target_type = $1) AND ($2::int4 IS NULL OR target_id = $2)
                 ORDER BY id DESC OFFSET $3 LIMIT $4",
            )
            .bind(target_type)
            .bind(target_id)
            .bind(offset)
            .bind(limit)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
            let total: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM rbac_audit_log WHERE ($1::text IS NULL OR target_type = $1) AND ($2::int4 IS NULL OR target_id = $2)",
            )
            .bind(target_type)
            .bind(target_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
            (rows, total)
        }
    };
    let mut ids: Vec<i32> = Vec::new();
    for r in &rows {
        ids.push(r.get("actor_id"));
        if r.get::<String, _>("target_type") == "user" {
            ids.push(r.get("target_id"));
        }
    }
    let names: Vec<(i32, String)> = sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let name_of = |id: i32| {
        names
            .iter()
            .find(|n| n.0 == id)
            .map_or_else(|| format!("#{id}"), |n| n.1.clone())
    };
    let data = rows
        .iter()
        .map(|r| {
            let target_type: String = r.get("target_type");
            let target_id: i32 = r.get("target_id");
            let actor_id: i32 = r.get("actor_id");
            AuditRow {
                id: r.get("id"),
                actor_id,
                actor_name: name_of(actor_id),
                action: r.get("action"),
                target_name: (target_type == "user").then(|| name_of(target_id)),
                target_type,
                target_id,
                before: r.get("before"),
                after: r.get("after"),
                created_at: r.get("created_at"),
            }
        })
        .collect();
    Ok(AuditPage {
        data,
        total,
        page,
        limit,
    })
}
