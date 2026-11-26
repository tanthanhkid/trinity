//! Định nghĩa thuộc tính động của danh mục (M25): `GET/POST /product-categories/:categoryId/attribute-defs`,
//! `PATCH/DELETE /product-attribute-defs/:id`. Bản TS: `attribute-defs/product-attribute-defs.service.ts`.
//! GET đòi `products.view`, ghi đòi `products.manage`. Xoá là xoá cứng (bảng cấu hình), trả 204. `key` không sửa được.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::models::ProductAttributeDef;
use trinity_db::pg_error::{app_error, db_error};
use trinity_db::types::JsonValue;
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::attributes::AttributeDef;
use crate::categories;
use crate::nullable::some_nullable;

/// Một lựa chọn của kiểu select/multiselect (K15: `value` 1..64, `label` 1..255).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct AttributeOption {
    pub value: String,
    pub label: String,
}

/// Body `POST .../attribute-defs` (K15: `key` 1..64 `^[a-z][a-z0-9_]*$`, `label` 1..255, `type` thuộc 9 kiểu, `options`
/// ≤ 100 phần tử, `sort_order` 0..INT4_MAX).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAttributeDef {
    pub key: String,
    pub label: String,
    pub r#type: String,
    #[serde(default)]
    pub options: Option<Vec<AttributeOption>>,
    #[serde(default)]
    pub is_required: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /product-attribute-defs/:id`; `options`: `null` = xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateAttributeDef {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub options: Option<Option<Vec<AttributeOption>>>,
    #[serde(default)]
    pub is_required: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn options_json(o: &[AttributeOption]) -> Value {
    Value::Array(
        o.iter()
            .map(|x| {
                let mut m = serde_json::Map::new();
                m.insert("value".into(), Value::String(x.value.clone()));
                m.insert("label".into(), Value::String(x.label.clone()));
                Value::Object(m)
            })
            .collect(),
    )
}

/// `GET /product-categories/:categoryId/attribute-defs`: `sort_order`, rồi `id`. Danh mục không có ⇒ mảng rỗng.
pub async fn find_all_for_category(
    conn: &mut PgConnection,
    category_id: i32,
) -> Result<Vec<ProductAttributeDef>, AppError> {
    sqlx::query_as::<_, ProductAttributeDef>(
        "SELECT id, category_id, key, label, type, options, is_required, sort_order, created_at, updated_at \
         FROM product_attribute_defs WHERE category_id = $1 ORDER BY sort_order ASC, id ASC",
    )
    .bind(category_id)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// Định nghĩa rút gọn cho `validate_product_attributes`.
pub async fn validator_defs(conn: &mut PgConnection, category_id: i32) -> Result<Vec<AttributeDef>, AppError> {
    Ok(find_all_for_category(conn, category_id)
        .await?
        .into_iter()
        .map(|d| AttributeDef {
            key: d.key,
            label: d.label,
            r#type: d.r#type,
            options: d.options.map(|o| o.0),
            is_required: d.is_required,
        })
        .collect())
}

/// kiểu select/multiselect mà không có lựa chọn ⇒ 400 ngay từ lúc khai báo.
fn assert_select_has_options(ty: &str, options: Option<&Value>) -> Result<(), AppError> {
    if matches!(ty, "select" | "multiselect") && !options.is_some_and(|o| o.as_array().is_some_and(|a| !a.is_empty())) {
        return Err(HttpError::bad_request(
            "Thuộc tính kiểu select/multiselect phải có ít nhất một lựa chọn (options)",
        )
        .into());
    }
    Ok(())
}

/// `POST /product-categories/:categoryId/attribute-defs`: danh mục không có ⇒ 400; `key` trùng trong danh mục ⇒ 409.
pub async fn create(
    conn: &mut PgConnection,
    category_id: i32,
    input: &CreateAttributeDef,
) -> Result<ProductAttributeDef, AppError> {
    categories::assert_exists(&mut *conn, category_id).await?;
    let taken = format!("Thuộc tính key \"{}\" đã tồn tại trong danh mục này", input.key);
    let existing: Option<i32> =
        sqlx::query_scalar("SELECT id FROM product_attribute_defs WHERE category_id = $1 AND key = $2 LIMIT 1")
            .bind(category_id)
            .bind(&input.key)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    if existing.is_some() {
        return Err(HttpError::conflict(taken).into());
    }
    let options = input.options.as_deref().map(options_json);
    assert_select_has_options(&input.r#type, options.as_ref())?;
    let row = sqlx::query_as::<_, ProductAttributeDef>(
        "INSERT INTO product_attribute_defs (category_id, key, label, type, options, is_required, sort_order, updated_at) \
         VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7, now()) \
         RETURNING id, category_id, key, label, type, options, is_required, sort_order, created_at, updated_at",
    )
    .bind(category_id)
    .bind(&input.key)
    .bind(&input.label)
    .bind(&input.r#type)
    .bind(options.as_ref().map(trinity_kernel::json::js_json))
    .bind(input.is_required.unwrap_or(false))
    .bind(input.sort_order.unwrap_or(0))
    .fetch_one(conn)
    .await;
    row.map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, None) {
            HttpError::conflict(taken).into()
        } else {
            d.into()
        }
    })
}

async fn find_for_update(conn: &mut PgConnection, id: i32) -> Result<(String, Option<Value>), AppError> {
    let row: Option<(String, Option<JsonValue>)> =
        sqlx::query_as("SELECT type, options FROM product_attribute_defs WHERE id = $1")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    row.map(|(t, o)| (t, o.map(|j| j.0)))
        .ok_or_else(|| HttpError::not_found("Thuộc tính không tồn tại").into())
}

/// `PATCH /product-attribute-defs/:id`: kiểm select/multiselect theo trạng thái SAU khi sửa.
pub async fn update(
    conn: &mut PgConnection,
    id: i32,
    input: &UpdateAttributeDef,
) -> Result<ProductAttributeDef, AppError> {
    let (cur_type, cur_options) = find_for_update(&mut *conn, id).await?;
    let new_options: Option<Value> = match &input.options {
        Some(Some(o)) => Some(options_json(o)),
        Some(None) => None,
        None => cur_options,
    };
    assert_select_has_options(input.r#type.as_deref().unwrap_or(&cur_type), new_options.as_ref())?;
    let (set_options, options_text) = match &input.options {
        Some(o) => (
            true,
            o.as_deref().map(|o| trinity_kernel::json::js_json(&options_json(o))),
        ),
        None => (false, None),
    };
    sqlx::query_as::<_, ProductAttributeDef>(
        "UPDATE product_attribute_defs SET label = COALESCE($2, label), type = COALESCE($3, type), \
         options = CASE WHEN $4 THEN $5::text::jsonb ELSE options END, is_required = COALESCE($6, is_required), \
         sort_order = COALESCE($7, sort_order), updated_at = now() WHERE id = $1 \
         RETURNING id, category_id, key, label, type, options, is_required, sort_order, created_at, updated_at",
    )
    .bind(id)
    .bind(input.label.as_deref())
    .bind(input.r#type.as_deref())
    .bind(set_options)
    .bind(options_text)
    .bind(input.is_required)
    .bind(input.sort_order)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Thuộc tính không tồn tại").into())
}

/// `DELETE /product-attribute-defs/:id` (204): xoá cứng. Giá trị đã nhập trong `products.attributes` giữ nguyên.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    find_for_update(&mut *conn, id).await?;
    sqlx::query("DELETE FROM product_attribute_defs WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}
