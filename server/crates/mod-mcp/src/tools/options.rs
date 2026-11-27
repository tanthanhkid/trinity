//! `list_crm_options` (`options-tool.ts`): id hợp lệ cho các tool ghi (nguồn/giai đoạn/trạng thái, bảng + cột công việc, nhân viên
//! nhận khách). CHỈ ĐỌC, theo quyền.

use serde_json::{Map, Value, json};
use sqlx::{Postgres, QueryBuilder};
use trinity_rbac::{OwnerIds, can};

use super::{forbidden, wrapped};
use crate::args::{opt_str, reject_digit_probe};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

fn internal(e: sqlx::Error) -> ToolError {
    ToolError::Internal(e.to_string())
}

const GROUPS: [(&str, &str); 3] = [
    ("sources", "contact_source"),
    ("stages", "contact_stage"),
    ("statuses", "contact_detail_status"),
];

pub fn list_crm_options<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let g = &p.grants;
        let kanban = can(g, "kanban.view", None) || can(g, "kanban.manage", None);
        let transfer = can(g, "contacts.transfer", None);
        // Người gọi/phạm vi lấy TRƯỚC khi giữ kết nối (không xin kết nối thứ hai khi đang giữ một).
        let actor = if kanban {
            Some(deps.kanban_actor(p).await?)
        } else {
            None
        };
        let owners = if transfer {
            let name = opt_str(args.get("user_name"), 100);
            if let Some(n) = &name {
                reject_digit_probe(n)?;
            }
            let o = deps
                .scopes
                .owner_ids(p.company, p.user_id, &p.grants, "contacts.transfer")
                .await
                .map_err(|e| ToolError::Internal(e.to_string()))?;
            Some((name, o))
        } else {
            None
        };
        let mut conn = deps.conn(p.company).await?;
        let mut data = Map::new();
        if can(g, "contacts.view", None) || can(g, "contacts.create", None) {
            for (key, group) in GROUPS {
                let rows: Vec<(i32, String)> = sqlx::query_as(
                    "SELECT id, label FROM setting_options WHERE group_key = $1 AND is_active ORDER BY sort_order ASC, id ASC LIMIT 50",
                )
                .bind(group)
                .fetch_all(&mut *conn)
                .await
                .map_err(internal)?;
                data.insert(
                    key.to_owned(),
                    Value::Array(
                        rows.into_iter()
                            .map(|(id, label)| json!({ "id": id, "label": label }))
                            .collect(),
                    ),
                );
            }
        }
        if let Some(actor) = &actor {
            data.insert("kanban_boards".into(), boards(actor, &mut conn).await?);
        }
        if let Some((name, owners)) = owners {
            data.insert(
                "assignable_users".into(),
                users(owners, &mut conn, name.as_deref()).await?,
            );
        }
        if data.is_empty() {
            return Err(forbidden("Bạn không có quyền nào cần danh mục này (contacts/kanban)."));
        }
        wrapped(&Value::Object(data))
    })
}

/// Bảng + cột công việc người gọi thấy được (`isBoardVisibleToUser`): quyền `kanban.boards` thấy hết, còn lại chỉ bảng đang bật và
/// (không giới hạn vai trò hoặc có vai trò trùng). Lọc ngay trong SQL (tối đa 10 bảng) và lấy cột của mọi bảng bằng MỘT truy vấn.
async fn boards(actor: &mod_kanban::Actor, conn: &mut trinity_db::TenantConn) -> Result<Value, ToolError> {
    let rows: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, name FROM kanban_boards
         WHERE deleted_at IS NULL
           AND ($1 OR (is_active AND (cardinality(visibility_role_ids) = 0 OR visibility_role_ids && $2)))
         ORDER BY id ASC LIMIT 10",
    )
    .bind(actor.access.can_manage_boards)
    .bind(actor.access.role_ids.clone())
    .fetch_all(&mut **conn)
    .await
    .map_err(internal)?;
    let ids: Vec<i32> = rows.iter().map(|r| r.0).collect();
    let cols: Vec<(i32, i32, String, bool)> = sqlx::query_as(
        "SELECT board_id, id, name, is_done FROM kanban_columns
         WHERE board_id = ANY($1) AND NOT is_archived ORDER BY board_id ASC, position ASC, id ASC",
    )
    .bind(&ids)
    .fetch_all(&mut **conn)
    .await
    .map_err(internal)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, name)| {
                let columns: Vec<Value> = cols
                    .iter()
                    .filter(|c| c.0 == id)
                    .take(20)
                    .map(|c| json!({ "id": c.1, "name": c.2, "is_done": c.3 }))
                    .collect();
                json!({ "id": id, "name": name, "columns": columns })
            })
            .collect(),
    ))
}

/// Nhân viên có thể nhận khách (phạm vi `contacts.transfer`), lọc theo tên, tối đa 30.
async fn users(
    owners: Option<OwnerIds>,
    conn: &mut trinity_db::TenantConn,
    name: Option<&str>,
) -> Result<Value, ToolError> {
    let mut qb =
        QueryBuilder::<Postgres>::new("SELECT id, full_name FROM users WHERE status = 'active' AND deleted_at IS NULL");
    match owners {
        Some(OwnerIds::All) => {}
        Some(OwnerIds::Ids(ids)) => {
            qb.push(" AND id = ANY(").push_bind(ids).push(")");
        }
        None => {
            qb.push(" AND FALSE");
        }
    }
    if let Some(n) = name {
        qb.push(" AND full_name ILIKE ")
            .push_bind(format!("%{}%", trinity_kernel::vi::escape_like(n)))
            .push(" ESCAPE '\\'");
    }
    qb.push(" ORDER BY full_name ASC LIMIT 30");
    let rows: Vec<(i32, Option<String>)> = qb.build_query_as().fetch_all(&mut **conn).await.map_err(internal)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, full_name)| json!({ "id": id, "full_name": full_name }))
            .collect(),
    ))
}
