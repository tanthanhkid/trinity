//! Phiên bản cấu trúc (chuyển từ `schema-versions.service.ts`): chụp toàn bộ bảng/trường/màn/tính năng, lưu, liệt kê, so và
//! quay lui. Không có route HTTP riêng (dùng cho công cụ MCP và dựng hệ thống); mọi hàm chạy trên kết nối của người gọi.

use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::models::{CustomField, CustomObject, CustomView};

use crate::access::{FIELD_COLS, OBJ_COLS, VIEW_COLS};
use crate::types::Limits;
use crate::views::MAX_VIEWS_PER_OBJECT;
use crate::{R, db, not_found};

fn to_json<T: serde::Serialize>(rows: &[T]) -> R<Value> {
    crate::json_of(rows)
}

/// Ảnh chụp cấu trúc hiện tại: `{ objects, fields, views, features }`.
pub async fn snapshot(conn: &mut PgConnection) -> R<Value> {
    let objects: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE deleted_at IS NULL LIMIT {}",
        Limits::MAX_OBJECTS + 10
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let fields: Vec<CustomField> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FIELD_COLS} FROM custom_fields f WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM custom_objects o WHERE o.id = f.object_id AND o.deleted_at IS NULL) LIMIT {}",
        (Limits::MAX_OBJECTS + 10) * i64::try_from(Limits::MAX_FIELDS_PER_OBJECT).unwrap_or(60)
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let views: Vec<CustomView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLS} FROM custom_views v WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM custom_objects o WHERE o.id = v.object_id AND o.deleted_at IS NULL) ORDER BY id ASC LIMIT {}",
        (Limits::MAX_OBJECTS + 10) * i64::try_from(MAX_VIEWS_PER_OBJECT).unwrap_or(10)
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let features: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'org_features'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    Ok(
        json!({ "objects": to_json(&objects)?, "fields": to_json(&fields)?, "views": to_json(&views)?, "features": features }),
    )
}

/// Lưu một phiên bản (trước khi công cụ đổi cấu trúc); trả id.
pub async fn save(conn: &mut PgConnection, draft_id: Option<i32>, tool: &str, summary: &str, user_id: i32) -> R<i32> {
    let snap = snapshot(conn).await?;
    let summary: String = summary.chars().take(1000).collect();
    sqlx::query_scalar("INSERT INTO custom_schema_versions (draft_id, tool, summary, snapshot, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id")
        .bind(draft_id)
        .bind(tool)
        .bind(summary)
        .bind(snap)
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)
}

/// Phiên bản gần đây, mới nhất trước (tối đa 50, không kèm ảnh chụp).
pub async fn list(conn: &mut PgConnection, limit: i64) -> R<Value> {
    type Row = (
        i32,
        String,
        String,
        trinity_db::types::Timestamp,
        Option<i32>,
        Option<i32>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, tool, summary, created_at, created_by, draft_id FROM custom_schema_versions ORDER BY id DESC LIMIT $1",
    )
    .bind(limit.clamp(1, 50))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, tool, summary, created_at, created_by, draft_id)| {
                json!({ "id": id, "tool": tool, "summary": summary, "created_at": created_at, "created_by": created_by, "draft_id": draft_id })
            })
            .collect(),
    ))
}

pub async fn load(conn: &mut PgConnection, id: i32) -> R<Value> {
    let v: Option<sqlx::types::Json<Value>> =
        sqlx::query_scalar("SELECT snapshot FROM custom_schema_versions WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    v.map(|j| j.0)
        .ok_or_else(|| not_found(&format!("Không có phiên bản cấu trúc #{id}.")))
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn id_of(v: &Value) -> i64 {
    v.get("id").and_then(Value::as_i64).unwrap_or(0)
}

fn same_field(a: &Value, b: &Value) -> bool {
    [
        "label",
        "type",
        "required",
        "is_unique",
        "is_title",
        "show_in_list",
        "sort_order",
        "options",
        "help_text",
    ]
    .iter()
    .all(|k| a.get(*k) == b.get(*k))
}

/// Mỗi dòng của ảnh chụp phải còn đúng một dòng trong DB; thiếu thì dừng (giao dịch của người gọi hoàn tác), không bỏ lặng.
fn one_row(r: sqlx::postgres::PgQueryResult, what: &str, id: i64) -> R<()> {
    if r.rows_affected() == 1 {
        Ok(())
    } else {
        Err(crate::conflict(format!(
            "Không khôi phục được: {what} #{id} trong phiên bản không còn trong hệ thống"
        )))
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// Khác biệt giữa cấu trúc hiện tại và `target`: bảng/trường nào sẽ ẩn, hiện lại hoặc trả định nghĩa; kèm số bản ghi bị ảnh hưởng.
pub async fn diff(conn: &mut PgConnection, target: &Value) -> R<Value> {
    let now = snapshot(conn).await?;
    let counts: Vec<(i32, i64)> =
        sqlx::query_as("SELECT object_id, count(*) FROM custom_records WHERE deleted_at IS NULL GROUP BY object_id")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let n = |id: i64| counts.iter().find(|c| i64::from(c.0) == id).map_or(0, |c| c.1);
    let keep: Vec<i64> = arr(target, "objects").iter().map(id_of).collect();
    let mut tables: Vec<(String, String, i64, String)> = Vec::new();
    for o in arr(&now, "objects").iter().filter(|o| !keep.contains(&id_of(o))) {
        tables.push((
            s(o, "key").into(),
            s(o, "label").into(),
            n(id_of(o)),
            "bảng tạo sau phiên bản này sẽ bị ẨN (dữ liệu giữ trong hệ thống)".into(),
        ));
    }
    for o in arr(target, "objects") {
        let oid = id_of(o);
        if !arr(&now, "objects").iter().any(|x| id_of(x) == oid) {
            tables.push((
                s(o, "key").into(),
                s(o, "label").into(),
                n(oid),
                "bảng được HIỆN LẠI".into(),
            ));
            continue;
        }
        let of = |snap: &'_ Value| -> Vec<Value> {
            arr(snap, "fields")
                .iter()
                .filter(|f| f.get("object_id").and_then(Value::as_i64) == Some(oid))
                .cloned()
                .collect()
        };
        let (tf, nf) = (of(target), of(&now));
        let labels = |v: Vec<&Value>| v.iter().map(|f| s(f, "label").to_owned()).collect::<Vec<_>>();
        let added = labels(nf.iter().filter(|f| !tf.iter().any(|t| id_of(t) == id_of(f))).collect());
        let restored = labels(tf.iter().filter(|t| !nf.iter().any(|f| id_of(f) == id_of(t))).collect());
        let changed = labels(
            tf.iter()
                .filter(|t| {
                    nf.iter()
                        .find(|f| id_of(f) == id_of(t))
                        .is_some_and(|f| !same_field(f, t))
                })
                .collect(),
        );
        let mut parts: Vec<String> = Vec::new();
        if !added.is_empty() {
            parts.push(format!("ẩn {}", added.join(", ")));
        }
        if !restored.is_empty() {
            parts.push(format!("hiện lại {}", restored.join(", ")));
        }
        if !changed.is_empty() {
            parts.push(format!("trả định nghĩa {}", changed.join(", ")));
        }
        if !parts.is_empty() {
            tables.push((s(o, "key").into(), s(o, "label").into(), n(oid), parts.join("; ")));
        }
    }
    let affected: i64 = tables.iter().map(|t| t.2).sum();
    Ok(json!({
        "tables": tables.iter().map(|t| json!({ "key": t.0, "label": t.1, "records": t.2, "change": t.3 })).collect::<Vec<_>>(),
        "affected_records": affected,
    }))
}

fn ids(v: &Value, k: &str) -> Vec<i32> {
    arr(v, k)
        .iter()
        .filter_map(|x| x.as_i64().and_then(|n| i32::try_from(n).ok()))
        .collect()
}

/// Quay lui về phiên bản `id`: bảng tạo sau bị ẩn, bảng/trường/màn trong ảnh chụp hiện lại với định nghĩa cũ, tiêu đề dựng lại,
/// `org_features` trả về. PHẢI chạy trong giao dịch của người gọi. Dữ liệu bản ghi không bị đụng.
pub async fn restore(conn: &mut PgConnection, id: i32, user_id: i32) -> R<Value> {
    let t = load(conn, id).await?;
    let obj_ids: Vec<i32> = arr(&t, "objects").iter().map(|o| id_of(o) as i32).collect();
    sqlx::query(
        "UPDATE custom_objects SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL AND id <> ALL($1)",
    )
    .bind(&obj_ids)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    for o in arr(&t, "objects") {
        sqlx::query(
            "UPDATE custom_objects SET label = $2, label_plural = $3, icon = $4, description = $5, show_in_nav = $6, nav_order = $7,
               visible_role_ids = $8, is_active = $9, deleted_at = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id_of(o) as i32)
        .bind(s(o, "label"))
        .bind(s(o, "label_plural"))
        .bind(o.get("icon").and_then(Value::as_str))
        .bind(o.get("description").and_then(Value::as_str))
        .bind(o.get("show_in_nav").and_then(Value::as_bool).unwrap_or(true))
        .bind(o.get("nav_order").and_then(Value::as_i64).unwrap_or(0) as i32)
        .bind(ids(o, "visible_role_ids"))
        .bind(o.get("is_active").and_then(Value::as_bool).unwrap_or(true))
        .execute(&mut *conn)
        .await
        .map_err(db)
        .and_then(|r| one_row(r, "bảng", id_of(o)))?;
    }
    let field_ids: Vec<i32> = arr(&t, "fields").iter().map(|f| id_of(f) as i32).collect();
    sqlx::query("UPDATE custom_fields SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL AND object_id = ANY($1) AND id <> ALL($2)")
        .bind(&obj_ids)
        .bind(&field_ids)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    // Bỏ cờ tiêu đề trước rồi đặt lại từng trường (chỉ mục duy nhất một tiêu đề mỗi bảng).
    sqlx::query("UPDATE custom_fields SET is_title = false, updated_at = now() WHERE object_id = ANY($1) AND is_title")
        .bind(&obj_ids)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    for f in arr(&t, "fields") {
        sqlx::query(
            "UPDATE custom_fields SET label = $2, type = $3, required = $4, is_unique = $5, is_title = $6, show_in_list = $7, sort_order = $8,
               options = $9, help_text = $10, deleted_at = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id_of(f) as i32)
        .bind(s(f, "label"))
        .bind(s(f, "type"))
        .bind(f.get("required").and_then(Value::as_bool).unwrap_or(false))
        .bind(f.get("is_unique").and_then(Value::as_bool).unwrap_or(false))
        .bind(f.get("is_title").and_then(Value::as_bool).unwrap_or(false))
        .bind(f.get("show_in_list").and_then(Value::as_bool).unwrap_or(true))
        .bind(f.get("sort_order").and_then(Value::as_i64).unwrap_or(0) as i32)
        .bind(f.get("options").cloned().unwrap_or_else(|| json!({})))
        .bind(f.get("help_text").and_then(Value::as_str))
        .execute(&mut *conn)
        .await
        .map_err(db)
        .and_then(|r| one_row(r, "trường", id_of(f)))?;
    }
    let view_ids: Vec<i32> = arr(&t, "views").iter().map(|v| id_of(v) as i32).collect();
    sqlx::query("UPDATE custom_views SET deleted_at = now(), show_in_nav = false, updated_at = now() WHERE deleted_at IS NULL AND id <> ALL($1)").bind(&view_ids).execute(&mut *conn).await.map_err(db)?;
    for v in arr(&t, "views") {
        sqlx::query(
            "UPDATE custom_views SET label = $2, type = $3, config = $4, icon = $5, show_in_nav = $6, nav_order = $7, visible_role_ids = $8,
               deleted_at = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id_of(v) as i32)
        .bind(s(v, "label"))
        .bind(s(v, "type"))
        .bind(v.get("config").cloned().unwrap_or_else(|| json!({})))
        .bind(v.get("icon").and_then(Value::as_str))
        .bind(v.get("show_in_nav").and_then(Value::as_bool).unwrap_or(false))
        .bind(v.get("nav_order").and_then(Value::as_i64).unwrap_or(0) as i32)
        .bind(ids(v, "visible_role_ids"))
        .execute(&mut *conn)
        .await
            .map_err(db)
            .and_then(|r| one_row(r, "màn xem", id_of(v)))?;
    }
    for f in arr(&t, "fields")
        .iter()
        .filter(|f| f.get("is_title") == Some(&Value::Bool(true)))
    {
        sqlx::query("UPDATE custom_records SET title = NULLIF(left(data ->> $1, $2::int), '') WHERE object_id = $3")
            .bind(s(f, "key"))
            .bind(Limits::MAX_TITLE)
            .bind(f.get("object_id").and_then(Value::as_i64).unwrap_or(0) as i32)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    match t.get("features").and_then(Value::as_str) {
        None => {
            sqlx::query("DELETE FROM settings WHERE key = 'org_features'")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
        }
        Some(v) => {
            sqlx::query(
                "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('org_features', $1, $2, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
            )
            .bind(v)
            .bind(user_id)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        }
    }
    tracing::warn!("cấu trúc tuỳ biến quay lui về phiên bản #{id} bởi user {user_id}");
    Ok(json!({ "restored_version": id }))
}
