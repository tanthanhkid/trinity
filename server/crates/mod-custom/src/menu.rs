//! Menu tuỳ biến (chuyển từ `custom-menu.service.ts`): đặt lại những bảng/màn nào hiện ở menu và theo thứ tự nào. Dùng cho
//! công cụ MCP (`set_menu`); không có route HTTP riêng.

use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::{R, bad, db};

pub const MAX_MENU_ENTRIES: usize = 40;

/// Một mục menu: bảng, màn tuỳ chọn, và (tuỳ chọn) tên các vai trò được thấy.
#[derive(Debug, Clone)]
pub struct MenuEntry {
    pub object: String,
    pub view: Option<String>,
    pub roles: Option<Vec<String>>,
}

struct Resolved {
    object_id: i32,
    view_id: Option<i32>,
    label: String,
    role_ids: Vec<i32>,
    roles_given: bool,
}

async fn resolve(conn: &mut PgConnection, entries: &[MenuEntry]) -> R<Vec<Resolved>> {
    if entries.is_empty() {
        return Err(bad("Menu cần ít nhất một mục."));
    }
    if entries.len() > MAX_MENU_ENTRIES {
        return Err(bad(format!("Menu tối đa {MAX_MENU_ENTRIES} mục.")));
    }
    let objects: Vec<(i32, String, String)> =
        sqlx::query_as("SELECT id, key, label FROM custom_objects WHERE deleted_at IS NULL")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let views: Vec<(i32, String, i32, String)> =
        sqlx::query_as("SELECT id, key, object_id, label FROM custom_views WHERE deleted_at IS NULL")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let roles: Vec<(i32, String)> = sqlx::query_as("SELECT id, name FROM roles")
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let cut = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for e in entries {
        let Some(o) = objects.iter().find(|x| x.1 == e.object) else {
            return Err(bad(format!("Không có bảng “{}”.", cut(&e.object, 48))));
        };
        let v = match &e.view {
            Some(k) if !k.is_empty() => match views.iter().find(|x| x.2 == o.0 && x.1 == *k) {
                Some(v) => Some(v),
                None => return Err(bad(format!("Bảng “{}” không có view “{}”.", o.2, cut(k, 48)))),
            },
            _ => None,
        };
        let id = format!("{}__{}", o.1, v.map_or("", |v| v.1.as_str()));
        if seen.contains(&id) {
            return Err(bad(format!("Mục menu “{}” bị lặp.", v.map_or(&o.2, |v| &v.3))));
        }
        seen.push(id);
        let mut role_ids = Vec::new();
        for name in e.roles.iter().flatten() {
            let n = trinity_kernel::vi::trim_js(name).to_lowercase();
            match roles
                .iter()
                .find(|r| trinity_kernel::vi::trim_js(&r.1).to_lowercase() == n)
            {
                Some(r) => role_ids.push(r.0),
                None => {
                    let have: Vec<&str> = roles.iter().take(15).map(|r| r.1.as_str()).collect();
                    return Err(bad(format!(
                        "Không có vai trò “{}”. Vai trò hiện có: {}.",
                        cut(name, 60),
                        have.join(", ")
                    )));
                }
            }
        }
        out.push(Resolved {
            object_id: o.0,
            view_id: v.map(|v| v.0),
            label: v.map_or(o.2.clone(), |v| v.3.clone()),
            role_ids,
            roles_given: e.roles.is_some(),
        });
    }
    Ok(out)
}

/// Đặt lại menu: ẩn tất cả rồi hiện đúng các mục, đánh số `nav_order` liên tục. PHẢI chạy trong giao dịch của người gọi.
pub async fn apply(conn: &mut PgConnection, entries: &[MenuEntry], user_id: i32) -> R<Value> {
    let items = resolve(conn, entries).await?;
    sqlx::query("UPDATE custom_objects SET show_in_nav = false, updated_at = now() WHERE deleted_at IS NULL")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    sqlx::query("UPDATE custom_views SET show_in_nav = false, updated_at = now() WHERE deleted_at IS NULL")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    for (i, it) in items.iter().enumerate() {
        let order = i32::try_from(i + 1).unwrap_or(i32::MAX);
        let (table, id) = match it.view_id {
            Some(v) => ("custom_views", v),
            None => ("custom_objects", it.object_id),
        };
        let sql = format!(
            "UPDATE {table} SET show_in_nav = true, nav_order = $1, visible_role_ids = CASE WHEN $2 THEN $3 ELSE visible_role_ids END, updated_at = now() WHERE id = $4"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(order)
            .bind(it.roles_given)
            .bind(&it.role_ids)
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let _ = &it.label;
    }
    tracing::info!("menu tuỳ biến đặt lại bởi user {user_id}: {} mục", items.len());
    Ok(json!({ "shown": items.len() }))
}
