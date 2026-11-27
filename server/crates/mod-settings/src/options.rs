//! Danh mục động `setting_options` (`settings-options.service.ts`).

use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use trinity_kernel::error::{AppError, HttpError};

use crate::db;
use crate::validate::{CreateOption, QueryOptions, UpdateOption};

/// Dòng tuỳ chọn, thứ tự khoá như `OPTION_SELECT` của bản Node.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OptionView {
    pub id: i32,
    pub group_key: String,
    pub value: String,
    pub label: String,
    pub sort_order: i32,
    pub is_active: bool,
    pub is_system: bool,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OptionList {
    pub data: Vec<OptionView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Removed {
    pub deleted: bool,
    pub id: i32,
}

fn view(r: &sqlx::postgres::PgRow) -> Result<OptionView, AppError> {
    Ok(OptionView {
        id: r.try_get("id").map_err(db)?,
        group_key: r.try_get("group_key").map_err(db)?,
        value: r.try_get("value").map_err(db)?,
        label: r.try_get("label").map_err(db)?,
        sort_order: r.try_get("sort_order").map_err(db)?,
        is_active: r.try_get("is_active").map_err(db)?,
        is_system: r.try_get("is_system").map_err(db)?,
        metadata: r
            .try_get::<Option<Value>, _>("metadata")
            .map_err(db)?
            .unwrap_or(Value::Null),
    })
}

/// `GET /settings/options`: mặc định chỉ dòng đang bật (`active=false` mới lấy cả dòng đã ẩn), tối đa 500 dòng.
pub async fn list(conn: &mut PgConnection, q: &QueryOptions) -> Result<OptionList, AppError> {
    let active_only = q.active != Some(false);
    let rows = sqlx::query(
        "SELECT id, group_key, value, label, sort_order, is_active, is_system, metadata FROM setting_options \
         WHERE ($1::text IS NULL OR group_key = $1) AND (NOT $2 OR is_active) \
         ORDER BY group_key ASC, sort_order ASC, id ASC LIMIT 500",
    )
    .bind(q.group.as_deref())
    .bind(active_only)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(OptionList {
        data: rows.iter().map(view).collect::<Result<_, _>>()?,
    })
}

/// `POST /settings/options` (201). `group_key` + `value` trùng ⇒ 409. `metadata` vắng hoặc `null` lưu JSON `null`
/// (`Prisma.JsonNull`), không phải SQL NULL.
pub async fn create(conn: &mut PgConnection, dto: &CreateOption, user_id: i32) -> Result<OptionView, AppError> {
    let dup: Option<i32> = sqlx::query_scalar("SELECT id FROM setting_options WHERE group_key = $1 AND value = $2")
        .bind(&dto.group_key)
        .bind(&dto.value)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if dup.is_some() {
        return Err(HttpError::conflict(format!(
            "Giá trị \"{}\" đã tồn tại trong nhóm \"{}\"",
            dto.value, dto.group_key
        ))
        .into());
    }
    let metadata = dto.metadata.clone().unwrap_or(Value::Null);
    let row = sqlx::query(
        "INSERT INTO setting_options (group_key, value, label, sort_order, is_active, is_system, metadata, updated_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, false, $6::text::jsonb, $7, now()) \
         RETURNING id, group_key, value, label, sort_order, is_active, is_system, metadata",
    )
    .bind(&dto.group_key)
    .bind(&dto.value)
    .bind(&dto.label)
    .bind(dto.sort_order.unwrap_or(0))
    .bind(dto.is_active.unwrap_or(true))
    .bind(trinity_kernel::json::js_json(&metadata))
    .bind(user_id)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    tracing::info!("Option created: {}/{} by user {user_id}", dto.group_key, dto.value);
    view(&row)
}

fn not_found(id: i32) -> AppError {
    HttpError::not_found(format!("Không tìm thấy option ID {id}")).into()
}

/// `PATCH /settings/options/:id`: chỉ `label`, `sort_order`, `is_active`, `metadata` (không đổi `group_key`, `value`).
pub async fn update(
    conn: &mut PgConnection,
    id: i32,
    dto: &UpdateOption,
    user_id: i32,
) -> Result<OptionView, AppError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT id FROM setting_options WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if exists.is_none() {
        return Err(not_found(id));
    }
    let meta_set = dto.metadata.is_some();
    let meta = dto.metadata.clone().map(|m| trinity_kernel::json::js_json(&m));
    let row = sqlx::query(
        "UPDATE setting_options SET label = COALESCE($2, label), sort_order = COALESCE($3, sort_order), \
           is_active = COALESCE($4, is_active), metadata = CASE WHEN $5 THEN $6::text::jsonb ELSE metadata END, \
           updated_by = $7, updated_at = now() WHERE id = $1 \
         RETURNING id, group_key, value, label, sort_order, is_active, is_system, metadata",
    )
    .bind(id)
    .bind(dto.label.as_deref())
    .bind(dto.sort_order)
    .bind(dto.is_active)
    .bind(meta_set)
    .bind(meta)
    .bind(user_id)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    tracing::info!("Option updated: ID {id} by user {user_id}");
    view(&row)
}

/// `DELETE /settings/options/:id`: xoá mềm (`is_active = false`); `is_system` ⇒ 400.
pub async fn remove(conn: &mut PgConnection, id: i32, user_id: i32) -> Result<Removed, AppError> {
    let row = sqlx::query("SELECT is_system, is_active FROM setting_options WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or_else(|| not_found(id))?;
    if row.try_get::<bool, _>("is_system").map_err(db)? {
        return Err(HttpError::bad_request("Không xoá được giá trị hệ thống (is_system=true)").into());
    }
    if row.try_get::<bool, _>("is_active").map_err(db)? {
        sqlx::query("UPDATE setting_options SET is_active = false, updated_by = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(user_id)
            .execute(conn)
            .await
            .map_err(db)?;
    }
    tracing::info!("Option soft-deleted: ID {id} by user {user_id}");
    Ok(Removed { deleted: true, id })
}
