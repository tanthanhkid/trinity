//! Danh mục/ngành sản phẩm (M25): `GET/POST /product-categories`, `GET/PATCH /product-categories/:id`.
//! Bản TS: `categories/product-categories.service.ts`. GET đòi `products.view`, ghi đòi `products.manage`.
//!
//! Bảng nhỏ nên không phân trang (cố ý, như bản TS). `code` không sửa được sau khi tạo.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::Deserialize;
use sqlx::PgConnection;
use trinity_db::models::ProductCategory;
use trinity_db::pg_error::{app_error, db_error};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::nullable::some_nullable;

/// Body `POST /product-categories` (đã qua K15: `code` 2..64 `^[A-Za-z0-9_-]+$`, `name` 2..255, `description` ≤ 2000,
/// `sort_order` 0..INT4_MAX).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateCategory {
    pub code: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Body `PATCH /product-categories/:id`; `description`: `null` = xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateCategory {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// `GET /product-categories?include_inactive=true`: `sort_order`, rồi `id`.
pub async fn find_all(conn: &mut PgConnection, include_inactive: bool) -> Result<Vec<ProductCategory>, AppError> {
    let sql = if include_inactive {
        "SELECT id, code, name, description, is_active, sort_order, created_by, created_at, updated_at \
         FROM product_categories ORDER BY sort_order ASC, id ASC"
    } else {
        "SELECT id, code, name, description, is_active, sort_order, created_by, created_at, updated_at \
         FROM product_categories WHERE is_active ORDER BY sort_order ASC, id ASC"
    };
    sqlx::query_as::<_, ProductCategory>(sql)
        .fetch_all(conn)
        .await
        .map_err(db)
}

/// `GET /product-categories/:id`.
pub async fn find_one(conn: &mut PgConnection, id: i32) -> Result<ProductCategory, AppError> {
    sqlx::query_as::<_, ProductCategory>(
        "SELECT id, code, name, description, is_active, sort_order, created_by, created_at, updated_at \
         FROM product_categories WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Danh mục sản phẩm không tồn tại").into())
}

/// `POST /product-categories`: mã trùng (không phân biệt hoa/thường) ⇒ 409.
pub async fn create(
    conn: &mut PgConnection,
    input: &CreateCategory,
    user_id: i32,
) -> Result<ProductCategory, AppError> {
    // `lower(code) = lower($1)`: `_` trong mã là ký tự thường (bản Node dùng `ILIKE` không thoát, đã sửa cùng PR).
    let existing: Option<String> =
        sqlx::query_scalar("SELECT code FROM product_categories WHERE lower(code) = lower($1) LIMIT 1")
            .bind(&input.code)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    if let Some(code) = existing {
        return Err(HttpError::conflict(format!(
            "Mã danh mục \"{}\" đã tồn tại (trùng \"{code}\", không phân biệt hoa/thường)",
            input.code
        ))
        .into());
    }
    let row = sqlx::query_as::<_, ProductCategory>(
        "INSERT INTO product_categories (code, name, description, sort_order, is_active, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now()) \
         RETURNING id, code, name, description, is_active, sort_order, created_by, created_at, updated_at",
    )
    .bind(&input.code)
    .bind(&input.name)
    .bind(&input.description)
    .bind(input.sort_order.unwrap_or(0))
    .bind(input.is_active.unwrap_or(true))
    .bind(user_id)
    .fetch_one(conn)
    .await;
    row.map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, None) && d.constraint.as_deref().is_none_or(|c| c.contains("code")) {
            HttpError::conflict(format!("Mã danh mục \"{}\" đã tồn tại", input.code)).into()
        } else {
            d.into()
        }
    })
}

/// `PATCH /product-categories/:id`.
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateCategory) -> Result<ProductCategory, AppError> {
    find_one(&mut *conn, id).await?;
    let (set_desc, desc) = match &input.description {
        Some(d) => (true, d.as_deref()),
        None => (false, None),
    };
    sqlx::query_as::<_, ProductCategory>(
        "UPDATE product_categories SET name = COALESCE($2, name), \
         description = CASE WHEN $3 THEN $4 ELSE description END, sort_order = COALESCE($5, sort_order), \
         is_active = COALESCE($6, is_active), updated_at = now() WHERE id = $1 \
         RETURNING id, code, name, description, is_active, sort_order, created_by, created_at, updated_at",
    )
    .bind(id)
    .bind(input.name.as_deref())
    .bind(set_desc)
    .bind(desc)
    .bind(input.sort_order)
    .bind(input.is_active)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Danh mục sản phẩm không tồn tại").into())
}

/// Danh mục phải tồn tại khi tạo thuộc tính cho nó (400, không phải 404). Không đòi `is_active`.
pub async fn assert_exists(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let found: Option<i32> = sqlx::query_scalar("SELECT id FROM product_categories WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    found
        .map(|_| ())
        .ok_or_else(|| HttpError::bad_request(format!("Danh mục sản phẩm ID {id} không tồn tại")).into())
}
