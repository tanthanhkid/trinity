//! Quyền thấy bảng và nạp định nghĩa (chuyển từ `custom-object-access.ts`). `visible_role_ids` chỉ THU HẸP, không cấp quyền.

use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::models::{CustomField, CustomObject};
use trinity_rbac::can;

use crate::types::FieldDef;
use crate::{Actor, R, db, not_found};

/// Cột `custom_objects` theo thứ tự của model.
pub const OBJ_COLS: &str = "id, key, label, label_plural, icon, description, show_in_nav, nav_order, visible_role_ids, is_active, code_prefix, code_prefix_aliases, next_code_seq, created_by, created_at, updated_at, deleted_at";
pub const FIELD_COLS: &str = "id, object_id, key, label, type, required, is_unique, is_title, show_in_list, sort_order, options, help_text, created_at, updated_at, deleted_at";
pub const VIEW_COLS: &str = "id, object_id, key, label, type, config, icon, show_in_nav, nav_order, visible_role_ids, created_by, created_at, updated_at, deleted_at";

/// Bảng + các trường CÒN SỐNG (đã sắp theo `sort_order`).
#[derive(Debug, Clone)]
pub struct ObjectDef {
    pub obj: CustomObject,
    pub fields: Vec<FieldDef>,
}

#[derive(Debug, Clone)]
pub struct ObjectAccess {
    pub role_ids: Vec<i32>,
    /// Giữ `custom_objects.manage` ⇒ thấy MỌI bảng (kể cả tắt hoặc ngoài `visible_role_ids`) để còn cấu hình.
    pub can_manage: bool,
}

pub async fn load_access(conn: &mut PgConnection, actor: &Actor) -> R<ObjectAccess> {
    let roles: Vec<i32> = sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id = $1")
        .bind(actor.user_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    Ok(ObjectAccess {
        role_ids: roles,
        can_manage: can(&actor.grants, "custom_objects.manage", None),
    })
}

/// Bảng có hiện cho người này không (BE là cổng thật).
pub fn is_object_visible(obj: &CustomObject, access: &ObjectAccess) -> bool {
    if obj.deleted_at.is_some() {
        return false;
    }
    if access.can_manage {
        return true;
    }
    if !obj.is_active {
        return false;
    }
    obj.visible_role_ids.0.is_empty() || obj.visible_role_ids.0.iter().any(|id| access.role_ids.contains(id))
}

pub async fn load_fields(conn: &mut PgConnection, object_id: i32) -> R<Vec<FieldDef>> {
    let rows: Vec<CustomField> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FIELD_COLS} FROM custom_fields WHERE object_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC"
    )))
    .bind(object_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(rows.iter().map(FieldDef::from_row).collect())
}

/// Nạp bảng theo key + trường sống; 404 (không 403) nếu không tồn tại hoặc không được thấy.
pub async fn load_visible_object(
    conn: &mut PgConnection,
    actor: &Actor,
    key: &str,
    access: Option<&ObjectAccess>,
) -> R<ObjectDef> {
    let obj: Option<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE key = $1 AND deleted_at IS NULL LIMIT 1"
    )))
    .bind(key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let owned;
    let acc = match access {
        Some(a) => a,
        None => {
            owned = load_access(conn, actor).await?;
            &owned
        }
    };
    let obj = obj
        .filter(|o| is_object_visible(o, acc))
        .ok_or_else(|| not_found("Không tìm thấy tính năng này"))?;
    let fields = load_fields(conn, obj.id).await?;
    Ok(ObjectDef { obj, fields })
}

/// Nạp bảng theo id (cho các service khác); 404 nếu đã xoá.
pub async fn get_def_by_id(conn: &mut PgConnection, id: i32) -> R<ObjectDef> {
    let obj: Option<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE id = $1 AND deleted_at IS NULL"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let obj = obj.ok_or_else(|| not_found("Không tìm thấy tính năng này"))?;
    let fields = load_fields(conn, id).await?;
    Ok(ObjectDef { obj, fields })
}

pub fn present_object(obj: &CustomObject, fields: &[FieldDef]) -> Value {
    json!({
        "id": obj.id, "key": obj.key, "label": obj.label, "label_plural": obj.label_plural, "icon": obj.icon,
        "description": obj.description, "show_in_nav": obj.show_in_nav, "nav_order": obj.nav_order,
        "visible_role_ids": obj.visible_role_ids.0, "is_active": obj.is_active, "code_prefix": obj.code_prefix,
        "code_prefix_aliases": obj.code_prefix_aliases.0, "created_at": obj.created_at, "updated_at": obj.updated_at,
        "fields": fields,
    })
}
