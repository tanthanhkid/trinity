//! Sản phẩm (M25): 8 endpoint `/api/v1/products` (danh sách, chi tiết, tạo, sửa, xoá = lưu trữ, khôi phục, xoá hẳn,
//! tải ảnh lên — phần tải ảnh ở [`crate::image`]). Bản TS: `products.service.ts` + `product-write.helper.ts` +
//! `product-delete.helper.ts` + `product.mapper.ts`.
//!
//! Quyền: GET đòi `products.view`; ghi đòi `products.manage`; xem mục "đã xoá" và xoá hẳn chỉ Quản trị (kiểm ở đây theo
//! [`Actor`]). `code` và `project_id` không sửa được sau khi tạo (không có trong [`UpdateProduct`], cố ý).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::TenantDb;
use trinity_db::pg_error::{app_error, db_error};
use trinity_db::types::{JsBigInt, JsonValue, PgList, Timestamp};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError, Message};
use trinity_kernel::json::js_json;
use trinity_storage::LocalUploadsStore;

use crate::Actor;
use crate::attribute_defs;
use crate::attributes::validate_product_attributes;
use crate::image::delete_product_image_file;
use crate::nullable::some_nullable;

/// Cửa sổ Hoàn tác phía máy chủ: 10 phút.
pub const RESTORE_WINDOW_MINUTES: i32 = 10;

/// Cột trả về (đúng `PRODUCT_SELECT`; không có `deleted_at`/`deleted_by`).
macro_rules! cols {
    () => {
        "id, code, name, project_id, brand, color, tags, is_featured, image_url, category_id, attributes, description, \
         price, is_active, created_by, created_at, updated_at"
    };
}

/// Sản phẩm như `toProductDto`: thứ tự khoá của `PRODUCT_SELECT`, `price` là số JSON (hoặc `null`, không về 0),
/// `attributes` luôn là object.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Product {
    pub id: i32,
    pub code: String,
    pub name: String,
    pub project_id: Option<i32>,
    pub brand: Option<String>,
    pub color: Option<String>,
    pub tags: PgList<String>,
    pub is_featured: bool,
    pub image_url: Option<String>,
    pub category_id: Option<i32>,
    pub attributes: JsonValue,
    pub description: Option<String>,
    pub price: Option<JsBigInt>,
    pub is_active: bool,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Product {
    /// `attributes` của dòng DB luôn là object phẳng; giá trị khác (mảng, số) coi là `{}`.
    fn normalized(mut self) -> Self {
        if !self.attributes.0.is_object() {
            self.attributes = JsonValue(Value::Object(serde_json::Map::new()));
        }
        self
    }
}

/// Query `GET /products` (đã qua K15; `is_active`, `archived` nhận `true`/`false` dạng chuỗi).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListProducts {
    #[serde(default)]
    pub project_id: Option<i32>,
    #[serde(default)]
    pub category_id: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub q: Option<String>,
}

/// Body `POST /products` (K15: mã 2..64 `^[A-Za-z0-9_-]+$`, tên 2..255, `price` 0..1e12, `tags` ≤ 30 phần tử ≤ 255…).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProduct {
    pub code: String,
    pub name: String,
    #[serde(default)]
    pub project_id: Option<i32>,
    #[serde(default)]
    pub category_id: Option<i32>,
    #[serde(default)]
    pub attributes: Option<Value>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "int_or_whole_float")]
    pub price: Option<i64>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub is_featured: Option<bool>,
    #[serde(default)]
    pub image_url: Option<String>,
}

/// Body `PATCH /products/:id`. Trường nhận NULL: không gửi = giữ nguyên, `null` = xoá giá trị.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateProduct {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub category_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub attributes: Option<Option<Value>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_int")]
    pub price: Option<Option<i64>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub brand: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub is_featured: Option<bool>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub image_url: Option<Option<String>>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Số nguyên trong JSON có thể tới dạng `500000.0` (sau chuyển kiểu của K15); `i64` của serde không nhận.
fn int_or_whole_float<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Option::<serde_json::Number>::deserialize(d)?.map_or(Ok(None), |n| {
        n.as_i64()
            .or_else(|| {
                n.as_f64()
                    .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
                    .map(|f| f as i64)
            })
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("không phải số nguyên"))
    })
}

fn nullable_int<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    int_or_whole_float(d).map(Some)
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn not_found() -> AppError {
    HttpError::not_found("Sản phẩm không tồn tại").into()
}

/// `GET /products`: nổi bật trước, rồi theo `id`. Không phân trang (bảng nhỏ, cố ý như bản TS). `archived=true` chỉ
/// Quản trị (403 nếu không).
pub async fn find_all(conn: &mut PgConnection, query: &ListProducts, actor: Actor) -> Result<Vec<Product>, AppError> {
    if query.archived == Some(true) && !actor.is_admin {
        return Err(HttpError::forbidden("Chỉ Quản trị mới xem được sản phẩm đã xoá").into());
    }
    let mut qb = QueryBuilder::<Postgres>::new(concat!("SELECT ", cols!(), " FROM products WHERE deleted_at IS "));
    qb.push(if query.archived == Some(true) {
        "NOT NULL"
    } else {
        "NULL"
    });
    if let Some(v) = query.project_id {
        qb.push(" AND project_id = ").push_bind(v);
    }
    if let Some(v) = query.category_id {
        qb.push(" AND category_id = ").push_bind(v);
    }
    if let Some(v) = query.is_active {
        qb.push(" AND is_active = ").push_bind(v);
    }
    if let Some(q) = query.q.as_deref().filter(|q| !q.is_empty()) {
        // Như Prisma `contains` + `mode: 'insensitive'`: `ILIKE '%q%'` không thoát `%`/`_` (khớp bản Node từng byte).
        let pattern = format!("%{q}%");
        qb.push(" AND (name ILIKE ")
            .push_bind(pattern.clone())
            .push(" OR code ILIKE ")
            .push_bind(pattern.clone())
            .push(" OR brand ILIKE ")
            .push_bind(pattern)
            .push(")");
    }
    qb.push(" ORDER BY is_featured DESC, id ASC");
    let rows: Vec<Product> = qb.build_query_as().fetch_all(conn).await.map_err(db)?;
    Ok(rows.into_iter().map(Product::normalized).collect())
}

/// `GET /products/:id`: sản phẩm đã xoá (lưu trữ) coi như không tồn tại.
pub async fn find_one(conn: &mut PgConnection, id: i32) -> Result<Product, AppError> {
    sqlx::query_as::<_, Product>(concat!(
        "SELECT ",
        cols!(),
        " FROM products WHERE id = $1 AND deleted_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .map(Product::normalized)
    .ok_or_else(not_found)
}

/// Dự án phải tồn tại VÀ đang hoạt động.
async fn assert_project_usable(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let row: Option<(String, bool)> = sqlx::query_as("SELECT name, is_active FROM projects WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    match row {
        None => Err(HttpError::bad_request(format!("Dự án ID {id} không tồn tại")).into()),
        Some((name, false)) => Err(HttpError::bad_request(format!("Dự án \"{name}\" đã ngưng hoạt động")).into()),
        Some(_) => Ok(()),
    }
}

/// Danh mục phải tồn tại VÀ đang hoạt động khi gán cho sản phẩm.
async fn assert_category_usable(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let row: Option<(String, bool)> = sqlx::query_as("SELECT name, is_active FROM product_categories WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    match row {
        None => Err(HttpError::bad_request(format!("Danh mục sản phẩm ID {id} không tồn tại")).into()),
        Some((name, false)) => Err(HttpError::bad_request(format!("Danh mục \"{name}\" đã ngưng hoạt động")).into()),
        Some(_) => Ok(()),
    }
}

/// Mã không phân biệt hoa/thường (index DB phân biệt). So bằng `lower(code) = lower($1)`: `_` trong mã là ký tự thường
/// (bản Node trước đây dùng `ILIKE` không thoát nên `_` khớp mọi ký tự; đã sửa cùng PR).
async fn assert_code_available(conn: &mut PgConnection, code: &str) -> Result<(), AppError> {
    let row: Option<(String, Option<Timestamp>)> =
        sqlx::query_as("SELECT code, deleted_at FROM products WHERE lower(code) = lower($1) LIMIT 1")
            .bind(code)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    match row {
        Some((_, Some(_))) => Err(HttpError::conflict(format!(
            "Mã sản phẩm \"{code}\" đang thuộc một sản phẩm đã xoá (lưu trữ) — khôi phục sản phẩm đó, hoặc nhờ Quản trị xoá hẳn rồi dùng lại mã"
        ))
        .into()),
        Some((existing, None)) => Err(HttpError::conflict(format!(
            "Mã sản phẩm \"{code}\" đã tồn tại (trùng \"{existing}\", không phân biệt hoa/thường)"
        ))
        .into()),
        None => Ok(()),
    }
}

/// Kiểm `attributes` theo định nghĩa của danh mục; không có danh mục thì phải rỗng. Trả chữ JSON để ghi vào cột.
async fn resolve_attributes(
    conn: &mut PgConnection,
    category_id: Option<i32>,
    raw: Option<&Value>,
    previous: Option<&serde_json::Map<String, Value>>,
) -> Result<String, AppError> {
    let defs = if let Some(c) = category_id {
        assert_category_usable(&mut *conn, c).await?;
        attribute_defs::validator_defs(conn, c).await?
    } else {
        Vec::new()
    };
    let map = validate_product_attributes(&defs, raw, previous)?;
    Ok(js_json(&Value::Object(map)))
}

/// `POST /products`. Thứ tự kiểm như bản TS: dự án → mã → thuộc tính. Mã trùng khi hai request song song ⇒ 409.
pub async fn create(conn: &mut PgConnection, input: &CreateProduct, user_id: i32) -> Result<Product, AppError> {
    if let Some(p) = input.project_id {
        assert_project_usable(&mut *conn, p).await?;
    }
    assert_code_available(&mut *conn, &input.code).await?;
    let attributes = resolve_attributes(&mut *conn, input.category_id, input.attributes.as_ref(), None).await?;
    let row = sqlx::query_as::<_, Product>(concat!(
        "INSERT INTO products (code, name, project_id, category_id, attributes, description, price, brand, color, tags, \
         is_featured, image_url, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, now()) RETURNING ",
        cols!()
    ))
    .bind(&input.code)
    .bind(&input.name)
    .bind(input.project_id)
    .bind(input.category_id)
    .bind(attributes)
    .bind(&input.description)
    .bind(input.price)
    .bind(&input.brand)
    .bind(&input.color)
    .bind(input.tags.clone().unwrap_or_default())
    .bind(input.is_featured.unwrap_or(false))
    .bind(&input.image_url)
    .bind(user_id)
    .fetch_one(conn)
    .await;
    match row {
        Ok(p) => Ok(p.normalized()),
        Err(e) => {
            let d = db_error(&e);
            // Mã trùng: cả index thường (`products_code_key`) lẫn tên index khác chứa `code`.
            if d.is(DbErrorKind::UniqueViolation, None) && d.constraint.as_deref().is_none_or(|c| c.contains("code")) {
                Err(HttpError::conflict(format!("Mã sản phẩm \"{}\" đã tồn tại", input.code)).into())
            } else {
                Err(d.into())
            }
        }
    }
}

/// `PATCH /products/:id`: 404 nếu không có. Đổi `category_id` hoặc `attributes` thì kiểm lại `attributes` theo danh
/// mục hiệu lực (danh mục mới nếu có gửi, không thì danh mục cũ; giá trị mới nếu có gửi, không thì giá trị cũ).
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateProduct) -> Result<Product, AppError> {
    let existing = find_one(&mut *conn, id).await?;
    let mut attributes: Option<String> = None;
    if input.category_id.is_some() || input.attributes.is_some() {
        let category = input.category_id.unwrap_or(existing.category_id);
        let raw = match &input.attributes {
            Some(a) => a.as_ref(),
            None => Some(&existing.attributes.0),
        };
        attributes = Some(resolve_attributes(&mut *conn, category, raw, existing.attributes.0.as_object()).await?);
    }
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE products SET updated_at = now()");
    if let Some(v) = &input.name {
        qb.push(", name = ").push_bind(v);
    }
    if let Some(v) = input.category_id {
        qb.push(", category_id = ").push_bind(v);
    }
    if let Some(v) = attributes {
        qb.push(", attributes = ").push_bind(v).push("::text::jsonb");
    }
    if let Some(v) = &input.description {
        qb.push(", description = ").push_bind(v);
    }
    if let Some(v) = input.price {
        qb.push(", price = ").push_bind(v);
    }
    if let Some(v) = &input.brand {
        qb.push(", brand = ").push_bind(v);
    }
    if let Some(v) = &input.color {
        qb.push(", color = ").push_bind(v);
    }
    if let Some(v) = &input.tags {
        qb.push(", tags = ").push_bind(v);
    }
    if let Some(v) = input.is_featured {
        qb.push(", is_featured = ").push_bind(v);
    }
    if let Some(v) = &input.image_url {
        qb.push(", image_url = ").push_bind(v);
    }
    if let Some(v) = input.is_active {
        qb.push(", is_active = ").push_bind(v);
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(concat!(" RETURNING ", cols!()));
    let row: Option<Product> = qb.build_query_as().fetch_optional(conn).await.map_err(db)?;
    row.map(Product::normalized).ok_or_else(not_found)
}

/// Ẩn sản phẩm (`is_active = false`, bật lại được).
pub async fn hide(conn: &mut PgConnection, id: i32) -> Result<Product, AppError> {
    update(
        conn,
        id,
        &UpdateProduct {
            is_active: Some(false),
            ..UpdateProduct::default()
        },
    )
    .await
}

/// Kết quả `DELETE /products/:id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Archived {
    pub id: i32,
    pub archived: bool,
}

/// `DELETE /products/:id`: xoá mềm. Cập nhật có điều kiện `deleted_at IS NULL`: hai người xoá cùng lúc thì chỉ một
/// lệnh ghi được, người kia nhận 404 và `deleted_by` của người trước không bị ghi đè.
pub async fn remove(conn: &mut PgConnection, id: i32, actor: Actor) -> Result<Archived, AppError> {
    let done = sqlx::query(
        "UPDATE products SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(actor.user_id)
    .execute(conn)
    .await
    .map_err(db)?;
    if done.rows_affected() == 0 {
        return Err(not_found());
    }
    Ok(Archived { id, archived: true })
}

/// `POST /products/:id/restore`: người đã xoá hoặc Quản trị, trong 10 phút (quá hạn ⇒ 410).
pub async fn restore(conn: &mut PgConnection, id: i32, actor: Actor) -> Result<Product, AppError> {
    let row: Option<(Option<i32>, bool)> = sqlx::query_as(
        "SELECT deleted_by, now() - deleted_at > make_interval(mins => $2) FROM products \
         WHERE id = $1 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(RESTORE_WINDOW_MINUTES)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let Some((deleted_by, expired)) = row else {
        return Err(HttpError::not_found("Không có sản phẩm đang chờ khôi phục").into());
    };
    if deleted_by != Some(actor.user_id) && !actor.is_admin {
        return Err(HttpError::forbidden("Chỉ người đã xoá hoặc Quản trị mới khôi phục được sản phẩm này").into());
    }
    if expired {
        return Err(HttpError::nest(
            410,
            Some(Message::One(
                "Đã quá thời gian hoàn tác — sản phẩm vẫn nằm trong mục đã xoá".to_owned(),
            )),
        )
        .into());
    }
    sqlx::query_as::<_, Product>(concat!(
        "UPDATE products SET deleted_at = NULL, deleted_by = NULL, updated_at = now() \
         WHERE id = $1 AND deleted_at IS NOT NULL RETURNING ",
        cols!()
    ))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .map(Product::normalized)
    .ok_or_else(not_found)
}

/// Kết quả `DELETE /products/:id/permanent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Purged {
    pub id: i32,
    pub deleted: bool,
}

/// `DELETE /products/:id/permanent`: chỉ Quản trị. 404 nếu không có; 409 kèm lý do nếu còn đơn bán hàng/liên hệ trỏ
/// tới. Xoá dòng trong giao dịch (khoá hàng chống race với đơn POS đang tạo), rồi MỚI dọn file ảnh, sau commit và chỉ
/// khi không sản phẩm nào khác dùng chung URL.
pub async fn purge(db: &TenantDb, store: &LocalUploadsStore, id: i32, actor: Actor) -> Result<Purged, AppError> {
    if !actor.is_admin {
        return Err(HttpError::forbidden("Chỉ Quản trị mới xoá hẳn được sản phẩm").into());
    }
    let mut tx = db.begin().await.map_err(AppError::internal)?;
    let image_url = hard_delete(&mut tx, id).await?;
    tx.commit().await.map_err(AppError::internal)?;
    if let Some(url) = image_url {
        let mut conn = db.acquire().await.map_err(AppError::internal)?;
        let still_used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE image_url = $1")
            .bind(&url)
            .fetch_one(&mut *conn)
            .await
            .map_err(self::db)?;
        if still_used == 0 {
            delete_product_image_file(store, db.company(), Some(&url)).await;
        }
    }
    Ok(Purged { id, deleted: true })
}

/// Các tham chiếu là soft-FK (DB không tự chặn), nên an toàn nằm ở đây: `pos_order_items.product_id` (mọi trạng thái
/// đơn) và `contacts.product_id`. Khoá `FOR UPDATE` dòng sản phẩm TRƯỚC khi đếm; phía POS khoá `FOR SHARE` cùng dòng.
async fn hard_delete(conn: &mut PgConnection, id: i32) -> Result<Option<String>, AppError> {
    let locked: Option<i32> = sqlx::query_scalar("SELECT id FROM products WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if locked.is_none() {
        return Err(not_found());
    }
    let orders: i32 =
        sqlx::query_scalar("SELECT COUNT(DISTINCT order_id)::int4 FROM pos_order_items WHERE product_id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
    let contacts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM contacts WHERE product_id = $1")
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let mut reasons = Vec::new();
    if orders > 0 {
        reasons.push(format!("{orders} đơn bán hàng"));
    }
    if contacts > 0 {
        reasons.push(format!("{contacts} liên hệ"));
    }
    if !reasons.is_empty() {
        return Err(HttpError::conflict(format!(
            "Sản phẩm đã có trong {} — không thể xoá hẳn, chỉ có thể ẩn",
            reasons.join(" và ")
        ))
        .into());
    }
    let image_url: Option<String> = sqlx::query_scalar("SELECT image_url FROM products WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM products WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(image_url)
}
