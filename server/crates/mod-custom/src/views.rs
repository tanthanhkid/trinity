//! Màn xem của bảng tuỳ biến (chuyển từ `custom-views.service.ts` và `view-config.ts`): danh sách, chi tiết, tạo, sửa. Chỉ
//! hai route GET là HTTP; tạo/sửa dành cho công cụ MCP và dựng hệ thống (M19).

use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::models::CustomView;

use crate::access::{ObjectAccess, ObjectDef, VIEW_COLS, load_access, load_visible_object};
use crate::filters::{prune_stale_filter, validate_filters};
use crate::types::{CUSTOM_ICONS, DATE_TYPES, SORTABLE_TYPES, valid_key};
use crate::{Actor, Ctx, R, bad, conflict, db, not_found};

pub const VIEW_TYPES: [&str; 4] = ["list", "kanban", "calendar", "table"];
pub const MAX_VIEWS_PER_OBJECT: usize = 10;
pub const MAX_CARD_FIELDS: usize = 6;
pub const MAX_COLUMNS: usize = 12;

/// `(type, tên, tóm tắt, cần)` của từng loại màn, đủ để dựng câu báo lỗi "loại màn chưa hỗ trợ".
type ViewTypeInfo = (
    &'static str,
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);
const VIEW_TYPE_INFO: [ViewTypeInfo; 4] = [
    (
        "list",
        "Danh sách",
        "Danh sách bản ghi có cột, tìm kiếm, lọc, sắp xếp; bấm một dòng để mở chi tiết",
        &[],
    ),
    (
        "kanban",
        "Kanban",
        "Mỗi cột là một giá trị của một trường lựa chọn (select, vd Trạng thái, Giai đoạn); kéo thẻ sang cột khác để đổi giá trị. Chỉ chia cột theo trường select — trường người dùng, chữ, số, ngày không chia cột được",
        &[("group_by", "khoá một trường kiểu select (lựa chọn) của bảng")],
    ),
    (
        "calendar",
        "Lịch",
        "Lịch tháng hoặc tuần; mỗi bản ghi nằm ở ngày của một trường ngày / ngày giờ",
        &[("date_field", "khoá một trường kiểu date hoặc datetime của bảng")],
    ),
    (
        "table",
        "Bảng sửa nhanh",
        "Bảng tính: sửa giá trị ngay tại ô, không mở form",
        &[],
    ),
];

pub fn view_types_line() -> String {
    VIEW_TYPE_INFO
        .iter()
        .map(|(t, name, summary, req)| {
            let r: Vec<String> = req.iter().map(|(k, v)| format!("{k} = {v}")).collect();
            format!(
                "{t} ({name}: {summary}{})",
                if r.is_empty() {
                    String::new()
                } else {
                    format!("; cần {}", r.join(", "))
                }
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn unsupported_view_type_message(kind: Option<&str>) -> String {
    let given = kind
        .filter(|k| !k.is_empty())
        .map(|k| k.chars().take(40).collect::<String>());
    format!(
        "{} Các loại màn Trinity hiển thị được: {}. Loại màn do người dùng chọn trong các loại trên. / {} Supported types: {} (details: list_screen_types).",
        given.as_ref().map_or_else(
            || "Thiếu loại màn (type).".to_owned(),
            |g| format!("Loại màn “{g}” chưa được Trinity hỗ trợ.")
        ),
        view_types_line(),
        given.as_ref().map_or_else(
            || "Missing screen type (type).".to_owned(),
            |g| format!("Screen type \"{g}\" is not supported.")
        ),
        VIEW_TYPES.join(", ")
    )
}

/// Màn thấy được: Quản lý thấy hết; còn lại theo `visible_role_ids` (rỗng = mọi người).
pub fn is_view_visible(v: &CustomView, access: &ObjectAccess) -> bool {
    if v.deleted_at.is_some() {
        return false;
    }
    access.can_manage
        || v.visible_role_ids.0.is_empty()
        || v.visible_role_ids.0.iter().any(|id| access.role_ids.contains(id))
}

fn href(object_key: &str, view_key: &str) -> String {
    format!("/x/{object_key}/v/{view_key}")
}

pub fn present_view(v: &CustomView, object_key: &str) -> Value {
    let config = if v.config.0.is_object() {
        v.config.0.clone()
    } else {
        json!({})
    };
    json!({
        "id": v.id, "key": v.key, "object_key": object_key, "label": v.label, "type": v.r#type, "config": config,
        "icon": v.icon, "show_in_nav": v.show_in_nav, "nav_order": v.nav_order, "href": href(object_key, &v.key),
    })
}

/// Như `presentViewFor`: bộ lọc đã lưu được dọn khỏi trường/lựa chọn không còn.
pub fn present_view_for(def: &ObjectDef, v: &CustomView, object_key: &str) -> Value {
    let mut dto = present_view(v, object_key);
    if let Some(filter) = dto["config"].get("filter").and_then(Value::as_object) {
        let pruned = prune_stale_filter(&def.fields, filter);
        dto["config"]["filter"] = Value::Object(pruned);
    }
    dto
}

/// `GET /custom-objects/:key/views`.
pub async fn list(ctx: &Ctx, actor: &Actor, object_key: &str) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let access = load_access(&mut c, actor).await?;
    let def = load_visible_object(&mut c, actor, object_key, Some(&access)).await?;
    let rows: Vec<CustomView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLS} FROM custom_views WHERE object_id = $1 AND deleted_at IS NULL ORDER BY nav_order ASC, id ASC LIMIT {}",
        MAX_VIEWS_PER_OBJECT * 2
    )))
    .bind(def.obj.id)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    Ok(Value::Array(
        rows.iter()
            .filter(|v| is_view_visible(v, &access))
            .map(|v| present_view_for(&def, v, object_key))
            .collect(),
    ))
}

/// `GET /custom-objects/:key/views/:view`.
pub async fn get(ctx: &Ctx, actor: &Actor, object_key: &str, view_key: &str) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let access = load_access(&mut c, actor).await?;
    let def = load_visible_object(&mut c, actor, object_key, Some(&access)).await?;
    let v: Option<CustomView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLS} FROM custom_views WHERE object_id = $1 AND key = $2 AND deleted_at IS NULL LIMIT 1"
    )))
    .bind(def.obj.id)
    .bind(view_key)
    .fetch_optional(&mut *c)
    .await
    .map_err(db)?;
    let v = v
        .filter(|v| is_view_visible(v, &access))
        .ok_or_else(|| not_found("Không tìm thấy màn xem này"))?;
    Ok(present_view_for(&def, &v, object_key))
}

fn field_keys(def: &ObjectDef, raw: Option<&Value>, max: usize, what: &str) -> R<Option<Vec<String>>> {
    let Some(raw) = raw.filter(|r| !r.is_null()) else {
        return Ok(None);
    };
    let Some(arr) = raw.as_array() else {
        return Err(bad(format!("{what} phải là danh sách khoá trường")));
    };
    let mut keys: Vec<String> = Vec::new();
    for x in arr {
        let k = x.as_str().map_or_else(|| x.to_string(), str::to_owned);
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    if keys.len() > max {
        return Err(bad(format!("{what}: tối đa {max} trường")));
    }
    for k in &keys {
        if !def.fields.iter().any(|f| f.key == *k) {
            return Err(bad(format!(
                "{what}: không có trường “{}” trong bảng “{}”",
                k.chars().take(40).collect::<String>(),
                def.obj.label
            )));
        }
    }
    Ok(Some(keys))
}

/// `normalizeViewConfig`: giữ đúng các khoá hợp lệ của từng loại màn, kiểm trường tham chiếu.
pub fn normalize_view_config(def: &ObjectDef, kind: &str, raw: &Value) -> R<Value> {
    let empty = Map::new();
    let c = raw.as_object().unwrap_or(&empty);
    let mut out = Map::new();
    let label = &def.obj.label;
    let name = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
    match kind {
        "kanban" => {
            let g = name("group_by");
            let f = def.fields.iter().find(|x| x.key == g);
            if g.is_empty() {
                return Err(bad(format!(
                    "Kanban cần group_by là khoá một trường “lựa chọn” (select) của bảng “{label}”."
                )));
            }
            let Some(f) = f else {
                return Err(bad(format!(
                    "group_by: cột không tồn tại: “{}” (bảng “{label}”). Gọi describe_schema để lấy khoá trường.",
                    g.chars().take(40).collect::<String>()
                )));
            };
            if f.kind != "select" {
                return Err(bad(format!(
                    "Trường “{}” kiểu {} — kanban chỉ chia cột theo trường “lựa chọn” (select).",
                    f.label, f.kind
                )));
            }
            out.insert("group_by".into(), json!(g));
            if let Some(k) = field_keys(def, c.get("card_fields"), MAX_CARD_FIELDS, "card_fields")? {
                out.insert("card_fields".into(), json!(k));
            }
        }
        "calendar" => {
            let k = name("date_field");
            let f = def.fields.iter().find(|x| x.key == k);
            if k.is_empty() {
                return Err(bad(format!(
                    "Lịch cần date_field là khoá một trường ngày (date) hoặc ngày giờ (datetime) của bảng “{label}”."
                )));
            }
            let Some(f) = f else {
                return Err(bad(format!(
                    "date_field: cột không tồn tại: “{}” (bảng “{label}”). Gọi describe_schema để lấy khoá trường.",
                    k.chars().take(40).collect::<String>()
                )));
            };
            if !DATE_TYPES.contains(&f.kind.as_str()) {
                return Err(bad(format!(
                    "Trường “{}” kiểu {} — lịch chỉ dùng trường ngày (date) hoặc ngày giờ (datetime).",
                    f.label, f.kind
                )));
            }
            out.insert("date_field".into(), json!(k));
            out.insert(
                "mode".into(),
                json!(if name("mode") == "week" { "week" } else { "month" }),
            );
            if let Some(k) = field_keys(def, c.get("card_fields"), MAX_CARD_FIELDS, "card_fields")? {
                out.insert("card_fields".into(), json!(k));
            }
        }
        _ => {
            if let Some(k) = field_keys(def, c.get("columns"), MAX_COLUMNS, "columns")? {
                out.insert("columns".into(), json!(k));
            }
        }
    }
    if let Some(s) = c.get("sort").filter(|s| !s.is_null()) {
        let s = s.as_object().unwrap_or(&empty);
        let field = s.get("field").and_then(Value::as_str).unwrap_or("");
        let ok = def
            .fields
            .iter()
            .find(|x| x.key == field)
            .is_some_and(|f| SORTABLE_TYPES.contains(&f.kind.as_str()));
        if !ok {
            return Err(bad("sort.field phải là trường sắp xếp được (văn bản/số/tiền/ngày…)"));
        }
        out.insert("sort".into(), json!({ "field": field, "dir": if s.get("dir").and_then(Value::as_str) == Some("desc") { "desc" } else { "asc" } }));
    }
    if let Some(f) = c.get("filter").filter(|f| !f.is_null()) {
        let filter = f.as_object().unwrap_or(&empty);
        validate_filters(&def.fields, &Value::Object(filter.clone()).to_string())?;
        out.insert("filter".into(), Value::Object(filter.clone()));
    }
    Ok(Value::Object(out))
}

pub fn assert_view_meta(key: &str, label: &str, kind: &str, icon: Option<&str>) -> R<()> {
    if !valid_key(key) {
        return Err(bad(format!(
            "Khoá view “{}” không hợp lệ: chỉ a-z, 0-9, _ ; bắt đầu bằng chữ.",
            key.chars().take(50).collect::<String>()
        )));
    }
    if trinity_kernel::vi::trim_js(label).is_empty() {
        return Err(bad("View cần có tên."));
    }
    if !VIEW_TYPES.contains(&kind) {
        return Err(bad(unsupported_view_type_message(Some(kind))));
    }
    if let Some(i) = icon.filter(|i| !i.is_empty())
        && !CUSTOM_ICONS.contains(&i)
    {
        return Err(bad(format!("Biểu tượng “{i}” không hợp lệ.")));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ViewSpec {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub config: Value,
    pub icon: Option<String>,
    pub show_in_nav: Option<bool>,
}

/// Kiểm một màn mới với danh sách khoá đã dùng của bảng.
pub fn check(def: &ObjectDef, spec: &ViewSpec, taken: &[String]) -> R<ViewSpec> {
    assert_view_meta(&spec.key, &spec.label, &spec.kind, spec.icon.as_deref())?;
    if taken.contains(&spec.key) {
        return Err(conflict(format!(
            "Bảng “{}” đã có view khoá “{}”.",
            def.obj.label, spec.key
        )));
    }
    if taken.len() >= MAX_VIEWS_PER_OBJECT {
        return Err(bad(format!("Mỗi bảng tối đa {MAX_VIEWS_PER_OBJECT} view.")));
    }
    Ok(ViewSpec {
        config: normalize_view_config(def, &spec.kind, &spec.config)?,
        ..spec.clone()
    })
}

/// Tạo màn (công cụ MCP, dựng hệ thống). Chạy trên kết nối/giao dịch của người gọi.
pub async fn create(conn: &mut PgConnection, def: &ObjectDef, spec: &ViewSpec, user_id: i32) -> R<CustomView> {
    let taken: Vec<String> =
        sqlx::query_scalar("SELECT key FROM custom_views WHERE object_id = $1 AND deleted_at IS NULL")
            .bind(def.obj.id)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let ok = check(def, spec, &taken)?;
    let max: Option<i32> = sqlx::query_scalar("SELECT max(nav_order) FROM custom_views WHERE deleted_at IS NULL")
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let row: CustomView = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO custom_views (object_id, key, label, type, config, icon, show_in_nav, nav_order, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING {VIEW_COLS}"
    )))
    .bind(def.obj.id)
    .bind(&ok.key)
    .bind(trinity_kernel::vi::trim_js(&ok.label))
    .bind(&ok.kind)
    .bind(&ok.config)
    .bind(&ok.icon)
    .bind(ok.show_in_nav.unwrap_or(false))
    .bind(max.unwrap_or(0) + 1)
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    tracing::info!(
        "custom_view {}.{} ({}) tạo bởi user {user_id}",
        def.obj.key,
        ok.key,
        ok.kind
    );
    Ok(row)
}

/// Sửa hoặc xoá mềm (`is_deleted`) một màn.
pub async fn update(
    conn: &mut PgConnection,
    def: &ObjectDef,
    view_key: &str,
    patch: &Value,
    user_id: i32,
) -> R<CustomView> {
    let cur: Option<CustomView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLS} FROM custom_views WHERE object_id = $1 AND key = $2 AND deleted_at IS NULL"
    )))
    .bind(def.obj.id)
    .bind(view_key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let cur = cur.ok_or_else(|| not_found(&format!("Bảng “{}” không có view “{view_key}”.", def.obj.label)))?;
    let kind = patch
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(&cur.r#type)
        .to_owned();
    let label = patch
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&cur.label)
        .to_owned();
    let icon: Option<Option<String>> = patch.get("icon").map(|i| i.as_str().map(str::to_owned));
    assert_view_meta(
        view_key,
        &label,
        &kind,
        icon.as_ref().map_or(cur.icon.as_deref(), |i| i.as_deref()),
    )?;
    let config = if patch.get("config").is_some() || patch.get("type").is_some() {
        let base = patch
            .get("config")
            .filter(|c| !c.is_null()) // `config: null` như không gửi: giữ cấu hình hiện tại
            .cloned()
            .unwrap_or_else(|| present_view_for(def, &cur, &def.obj.key)["config"].clone());
        Some(normalize_view_config(def, &kind, &base)?)
    } else {
        None
    };
    let deleted = patch.get("is_deleted") == Some(&Value::Bool(true));
    let row: CustomView = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE custom_views SET label = $2, type = $3, config = COALESCE($4, config),
           icon = CASE WHEN $5 THEN $6 ELSE icon END, show_in_nav = CASE WHEN $8 THEN false WHEN $7::bool IS NOT NULL THEN $7 ELSE show_in_nav END,
           deleted_at = CASE WHEN $8 THEN now() ELSE deleted_at END, updated_at = now()
         WHERE id = $1 RETURNING {VIEW_COLS}"
    )))
    .bind(cur.id)
    .bind(trinity_kernel::vi::trim_js(&label))
    .bind(&kind)
    .bind(config)
    .bind(icon.is_some())
    .bind(icon.flatten())
    .bind(patch.get("show_in_nav").and_then(Value::as_bool))
    .bind(deleted)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    tracing::info!("custom_view {}.{view_key} sửa bởi user {user_id}", def.obj.key);
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cau_loai_man_khong_ho_tro() {
        let m = unsupported_view_type_message(Some("gantt"));
        assert!(m.starts_with(
            "Loại màn “gantt” chưa được Trinity hỗ trợ. Các loại màn Trinity hiển thị được: list (Danh sách:"
        ));
        assert!(
            m.contains("kanban (Kanban:")
                && m.contains("; cần group_by = khoá một trường kiểu select (lựa chọn) của bảng)")
        );
        assert!(m.ends_with("Supported types: list, kanban, calendar, table (details: list_screen_types)."));
        assert!(unsupported_view_type_message(None).starts_with("Thiếu loại màn (type)."));
    }

    #[test]
    fn meta_man() {
        assert!(assert_view_meta("kanban_1", "Bảng", "kanban", Some("star")).is_ok());
        for (k, l, t, i) in [
            ("A", "x", "list", None),
            ("a", " ", "list", None),
            ("a", "x", "gantt", None),
            ("a", "x", "list", Some("xx")),
        ] {
            assert!(assert_view_meta(k, l, t, i).is_err());
        }
    }
}
