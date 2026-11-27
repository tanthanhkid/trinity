//! Khu vực, bàn, tuỳ chọn món (`GET/POST/PATCH /pos/areas|tables|modifiers`). Bản TS: `pos-layout.service.ts`.
//! Đọc đòi `pos.sell`, ghi đòi `pos.manage`. Không có xoá: ẩn bằng `is_active = false`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use trinity_db::models::{PosArea, PosModifier, PosTable};
use trinity_db::pg_error::{app_error, db_error};
use trinity_db::types::{JsBigInt, Timestamp};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::{MAX_MONEY, finish, range, text, trim, trim_opt};

const INT4_MAX: i64 = 2_147_483_647;
const NOT_FOUND: &str = "Không tìm thấy";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Lỗi ghi: trùng khoá duy nhất ⇒ 409 với câu `dup`.
fn write_err(e: &sqlx::Error, dup: &str) -> AppError {
    let d = db_error(e);
    if d.is(DbErrorKind::UniqueViolation, None) {
        HttpError::conflict(dup).into()
    } else {
        d.into()
    }
}

// ---------------------------------------------------------------- khu vực

/// Body `POST /pos/areas` (`CreateAreaDto`): `name` 1..100 (đã trim), `sort_order` 0..9999.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateArea {
    pub name: String,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /pos/areas/:id`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateArea {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

impl CreateArea {
    pub fn normalize(&mut self) {
        trim(&mut self.name);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        text("name", &self.name, 1, 100, &mut e);
        if let Some(s) = self.sort_order {
            range("sort_order", s.into(), 0, 9999, &mut e);
        }
        finish(e)
    }
}

impl UpdateArea {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.name);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(n) = &self.name {
            text("name", n, 1, 100, &mut e);
        }
        if let Some(s) = self.sort_order {
            range("sort_order", s.into(), 0, 9999, &mut e);
        }
        finish(e)
    }
}

const AREA_COLS: &str = "id, name, sort_order, is_active, created_at";

/// `GET /pos/areas`: `sort_order`, rồi `id`.
pub async fn list_areas(conn: &mut PgConnection) -> Result<Vec<PosArea>, AppError> {
    sqlx::query_as::<_, PosArea>(sqlx::AssertSqlSafe(format!(
        "SELECT {AREA_COLS} FROM pos_areas ORDER BY sort_order ASC, id ASC"
    )))
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /pos/areas`: tên trùng ⇒ 409.
pub async fn create_area(conn: &mut PgConnection, input: &CreateArea) -> Result<PosArea, AppError> {
    sqlx::query_as::<_, PosArea>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO pos_areas (name, sort_order) VALUES ($1, COALESCE($2, 0)) RETURNING {AREA_COLS}"
    )))
    .bind(&input.name)
    .bind(input.sort_order)
    .fetch_one(conn)
    .await
    .map_err(|e| write_err(&e, "Tên khu vực đã tồn tại"))
}

/// `PATCH /pos/areas/:id`: không có ⇒ 404, tên trùng ⇒ 409.
pub async fn update_area(conn: &mut PgConnection, id: i32, input: &UpdateArea) -> Result<PosArea, AppError> {
    sqlx::query_as::<_, PosArea>(sqlx::AssertSqlSafe(format!(
        "UPDATE pos_areas SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order), \
         is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING {AREA_COLS}"
    )))
    .bind(id)
    .bind(input.name.as_deref())
    .bind(input.sort_order)
    .bind(input.is_active)
    .fetch_optional(conn)
    .await
    .map_err(|e| write_err(&e, "Tên khu vực đã tồn tại"))?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

// ---------------------------------------------------------------- bàn

/// Body `POST /pos/tables` (`CreateTableDto`): `area_id` 1..INT4_MAX, `name` 1..50, `sort_order` 0..9999.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTable {
    pub area_id: i32,
    pub name: String,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /pos/tables/:id`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateTable {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

impl CreateTable {
    pub fn normalize(&mut self) {
        trim(&mut self.name);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        range("area_id", self.area_id.into(), 1, INT4_MAX, &mut e);
        text("name", &self.name, 1, 50, &mut e);
        if let Some(s) = self.sort_order {
            range("sort_order", s.into(), 0, 9999, &mut e);
        }
        finish(e)
    }
}

impl UpdateTable {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.name);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(n) = &self.name {
            text("name", n, 1, 50, &mut e);
        }
        if let Some(s) = self.sort_order {
            range("sort_order", s.into(), 0, 9999, &mut e);
        }
        finish(e)
    }
}

/// Đơn đang mở ở bàn, để FE tô màu bàn có khách.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenOrderRef {
    pub id: i32,
    pub code: String,
    pub total: i64,
}

/// Một phần tử của `GET /pos/tables`: cột của `pos_tables` (đúng thứ tự khoá Prisma) + `open_order`.
#[derive(Debug, Clone, Serialize)]
pub struct TableView {
    pub id: i32,
    pub area_id: i32,
    pub name: String,
    pub sort_order: i32,
    pub is_active: bool,
    pub created_at: Timestamp,
    pub open_order: Option<OpenOrderRef>,
}

const TABLE_COLS: &str = "id, area_id, name, sort_order, is_active, created_at";

/// `GET /pos/tables`: `area_id`, `sort_order`, `id`; mỗi bàn kèm đơn `open` (đơn nhỏ nhất nếu có nhiều).
pub async fn list_tables(conn: &mut PgConnection) -> Result<Vec<TableView>, AppError> {
    let tables = sqlx::query_as::<_, PosTable>(sqlx::AssertSqlSafe(format!(
        "SELECT {TABLE_COLS} FROM pos_tables ORDER BY area_id ASC, sort_order ASC, id ASC"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let open: Vec<(i32, String, JsBigInt, i32)> = sqlx::query_as(
        "SELECT id, code, total, table_id FROM pos_orders WHERE status = 'open' AND table_id IS NOT NULL ORDER BY id",
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(tables
        .into_iter()
        .map(|t| {
            let open_order = open.iter().find(|o| o.3 == t.id).map(|o| OpenOrderRef {
                id: o.0,
                code: o.1.clone(),
                total: o.2.0,
            });
            TableView {
                id: t.id,
                area_id: t.area_id,
                name: t.name,
                sort_order: t.sort_order,
                is_active: t.is_active,
                created_at: t.created_at,
                open_order,
            }
        })
        .collect())
}

/// `POST /pos/tables`: khu vực không có ⇒ 404; tên trùng trong khu vực ⇒ 409.
pub async fn create_table(conn: &mut PgConnection, input: &CreateTable) -> Result<PosTable, AppError> {
    let area: Option<i32> = sqlx::query_scalar("SELECT id FROM pos_areas WHERE id = $1")
        .bind(input.area_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if area.is_none() {
        return Err(HttpError::not_found("Khu vực không tồn tại").into());
    }
    sqlx::query_as::<_, PosTable>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO pos_tables (area_id, name, sort_order) VALUES ($1, $2, COALESCE($3, 0)) RETURNING {TABLE_COLS}"
    )))
    .bind(input.area_id)
    .bind(&input.name)
    .bind(input.sort_order)
    .fetch_one(conn)
    .await
    .map_err(|e| write_err(&e, "Tên bàn đã tồn tại trong khu vực"))
}

/// `PATCH /pos/tables/:id`.
pub async fn update_table(conn: &mut PgConnection, id: i32, input: &UpdateTable) -> Result<PosTable, AppError> {
    sqlx::query_as::<_, PosTable>(sqlx::AssertSqlSafe(format!(
        "UPDATE pos_tables SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order), \
         is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING {TABLE_COLS}"
    )))
    .bind(id)
    .bind(input.name.as_deref())
    .bind(input.sort_order)
    .bind(input.is_active)
    .fetch_optional(conn)
    .await
    .map_err(|e| write_err(&e, "Tên bàn đã tồn tại trong khu vực"))?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

// ---------------------------------------------------------------- tuỳ chọn món

/// Body `POST /pos/modifiers` (`CreateModifierDto`): `group_name`, `name` 1..100, `price_delta` ±[`MAX_MONEY`]
/// (có thể âm), `sort_order` 0..9999.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateModifier {
    pub group_name: String,
    pub name: String,
    #[serde(default)]
    pub price_delta: Option<i64>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /pos/modifiers/:id`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateModifier {
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub price_delta: Option<i64>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

fn modifier_errors(
    group: Option<&str>,
    name: Option<&str>,
    price: Option<i64>,
    sort: Option<i32>,
    out: &mut Vec<String>,
) {
    if let Some(g) = group {
        text("group_name", g, 1, 100, out);
    }
    if let Some(n) = name {
        text("name", n, 1, 100, out);
    }
    if let Some(p) = price {
        range("price_delta", p, -MAX_MONEY, MAX_MONEY, out);
    }
    if let Some(s) = sort {
        range("sort_order", s.into(), 0, 9999, out);
    }
}

impl CreateModifier {
    pub fn normalize(&mut self) {
        trim(&mut self.group_name);
        trim(&mut self.name);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        modifier_errors(
            Some(&self.group_name),
            Some(&self.name),
            self.price_delta,
            self.sort_order,
            &mut e,
        );
        finish(e)
    }
}

impl UpdateModifier {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.group_name);
        trim_opt(&mut self.name);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        modifier_errors(
            self.group_name.as_deref(),
            self.name.as_deref(),
            self.price_delta,
            self.sort_order,
            &mut e,
        );
        finish(e)
    }
}

const MOD_COLS: &str = "id, group_name, name, price_delta, sort_order, is_active, created_at";
const MOD_DUP: &str = "Tuỳ chọn đã tồn tại trong nhóm";

/// `GET /pos/modifiers?include_inactive=`: chỉ người có `pos.manage` (`can_manage`) mới thấy mục đã ẩn.
pub async fn list_modifiers(
    conn: &mut PgConnection,
    include_inactive: bool,
    can_manage: bool,
) -> Result<Vec<PosModifier>, AppError> {
    sqlx::query_as::<_, PosModifier>(sqlx::AssertSqlSafe(format!(
        "SELECT {MOD_COLS} FROM pos_modifiers WHERE $1 OR is_active \
         ORDER BY group_name ASC, sort_order ASC, id ASC"
    )))
    .bind(include_inactive && can_manage)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /pos/modifiers`: (nhóm, tên) trùng ⇒ 409.
pub async fn create_modifier(conn: &mut PgConnection, input: &CreateModifier) -> Result<PosModifier, AppError> {
    sqlx::query_as::<_, PosModifier>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO pos_modifiers (group_name, name, price_delta, sort_order) \
         VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0)) RETURNING {MOD_COLS}"
    )))
    .bind(&input.group_name)
    .bind(&input.name)
    .bind(input.price_delta)
    .bind(input.sort_order)
    .fetch_one(conn)
    .await
    .map_err(|e| write_err(&e, MOD_DUP))
}

/// `PATCH /pos/modifiers/:id`.
pub async fn update_modifier(
    conn: &mut PgConnection,
    id: i32,
    input: &UpdateModifier,
) -> Result<PosModifier, AppError> {
    sqlx::query_as::<_, PosModifier>(sqlx::AssertSqlSafe(format!(
        "UPDATE pos_modifiers SET group_name = COALESCE($2, group_name), name = COALESCE($3, name), \
         price_delta = COALESCE($4, price_delta), sort_order = COALESCE($5, sort_order), \
         is_active = COALESCE($6, is_active) WHERE id = $1 RETURNING {MOD_COLS}"
    )))
    .bind(id)
    .bind(input.group_name.as_deref())
    .bind(input.name.as_deref())
    .bind(input.price_delta)
    .bind(input.sort_order)
    .bind(input.is_active)
    .fetch_optional(conn)
    .await
    .map_err(|e| write_err(&e, MOD_DUP))?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khu_vuc_va_ban_kiem_luat_dto() {
        let mut a = CreateArea {
            name: "  Tầng 1  ".into(),
            sort_order: Some(3),
        };
        a.normalize();
        assert_eq!(a.name, "Tầng 1");
        assert!(a.validate().is_ok());
        let bad = CreateArea {
            name: String::new(),
            sort_order: Some(10_000),
        };
        let err = bad.validate().unwrap_err();
        assert_eq!(err.status(), 400);
        let t = CreateTable {
            area_id: 0,
            name: "x".repeat(51),
            sort_order: None,
        };
        assert!(t.validate().is_err());
    }

    #[test]
    fn tuy_chon_cho_phep_gia_am_trong_tran() {
        let ok = CreateModifier {
            group_name: "Size".into(),
            name: "S".into(),
            price_delta: Some(-5_000),
            sort_order: None,
        };
        assert!(ok.validate().is_ok());
        let over = CreateModifier {
            group_name: "Size".into(),
            name: "L".into(),
            price_delta: Some(MAX_MONEY + 1),
            sort_order: None,
        };
        assert!(over.validate().is_err());
    }
}
