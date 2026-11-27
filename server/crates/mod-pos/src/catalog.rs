//! Cấu hình quán và menu bán hàng (`GET/PATCH /pos/settings`, `GET /pos/menu`). Bản TS: `pos-catalog.service.ts`.
//! Đọc đòi `pos.sell`, sửa đòi `pos.manage`. Menu đọc từ `products`/`product_categories` (POS không có bảng món riêng).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::PosSettings;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::{finish, len16, range, some_nullable, text, trim, trim_opt};

const INT4_MAX: i64 = 2_147_483_647;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

const SETTINGS_COLS: &str = "id, store_name, address, phone, receipt_footer, bank_bin, bank_account_no, \
                             bank_account_name, menu_category_ids, updated_at";

/// Body `PATCH /pos/settings` (`UpdateSettingsDto`). Chuỗi gửi `""` ⇒ xoá (lưu `NULL`); `null` cũng xoá; không gửi
/// khoá = giữ nguyên. `store_name` không xoá được. `menu_category_ids` rỗng = menu lấy mọi danh mục.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateSettings {
    #[serde(default)]
    pub store_name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub address: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub phone: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub receipt_footer: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub bank_bin: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub bank_account_no: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub bank_account_name: Option<Option<String>>,
    #[serde(default)]
    pub menu_category_ids: Option<Vec<i32>>,
}

fn digits(v: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())
}

impl UpdateSettings {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.store_name);
        for f in [
            &mut self.address,
            &mut self.phone,
            &mut self.receipt_footer,
            &mut self.bank_account_name,
        ] {
            if let Some(Some(v)) = f {
                trim(v);
            }
        }
    }

    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(v) = &self.store_name {
            text("store_name", v, 1, 255, &mut e);
        }
        for (name, f, max) in [
            ("address", &self.address, 500),
            ("phone", &self.phone, 32),
            ("receipt_footer", &self.receipt_footer, 500),
        ] {
            if let Some(Some(v)) = f
                && len16(v) > max
            {
                e.push(format!("{name} must be shorter than or equal to {max} characters"));
            }
        }
        if let Some(Some(v)) = &self.bank_bin
            && !digits(v, 6, 6)
        {
            e.push("BIN ngân hàng gồm 6 chữ số".to_owned());
        }
        if let Some(Some(v)) = &self.bank_account_no
            && !digits(v, 4, 19)
        {
            e.push("Số tài khoản gồm 4–19 chữ số".to_owned());
        }
        if let Some(Some(v)) = &self.bank_account_name
            && len16(v) > 255
        {
            e.push("bank_account_name must be shorter than or equal to 255 characters".to_owned());
        }
        if let Some(ids) = &self.menu_category_ids {
            if ids.len() > 100 {
                e.push("menu_category_ids must contain no more than 100 elements".to_owned());
            }
            for id in ids {
                range("each value in menu_category_ids", (*id).into(), 1, INT4_MAX, &mut e);
            }
        }
        finish(e)
    }
}

/// `GET /pos/settings`: dòng `id = 1` (migration đã seed; tạo nếu thiếu, như `upsert` của bản TS).
pub async fn get_settings(conn: &mut PgConnection) -> Result<PosSettings, AppError> {
    sqlx::query("INSERT INTO pos_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    sqlx::query_as::<_, PosSettings>(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM pos_settings WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /pos/settings`: chuỗi rỗng ⇒ `NULL`.
pub async fn update_settings(conn: &mut PgConnection, input: &UpdateSettings) -> Result<PosSettings, AppError> {
    sqlx::query("INSERT INTO pos_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE pos_settings SET updated_at = now()");
    if let Some(v) = &input.store_name {
        qb.push(", store_name = ").push_bind(v.clone());
    }
    for (col, f) in [
        ("address", &input.address),
        ("phone", &input.phone),
        ("receipt_footer", &input.receipt_footer),
        ("bank_bin", &input.bank_bin),
        ("bank_account_no", &input.bank_account_no),
        ("bank_account_name", &input.bank_account_name),
    ] {
        if let Some(v) = f {
            let v = v.clone().filter(|s| !s.is_empty());
            qb.push(", ").push(col).push(" = ").push_bind(v);
        }
    }
    if let Some(ids) = &input.menu_category_ids {
        qb.push(", menu_category_ids = ").push_bind(ids.clone());
    }
    qb.push(" WHERE id = 1 RETURNING ").push(SETTINGS_COLS);
    qb.build_query_as::<PosSettings>().fetch_one(conn).await.map_err(db)
}

/// Query `GET /pos/menu` (`MenuQueryDto`): `category_id` 1..INT4_MAX, `q` ≤ 100 (đã trim).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MenuQuery {
    #[serde(default)]
    pub category_id: Option<i32>,
    #[serde(default)]
    pub q: Option<String>,
}

impl MenuQuery {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.q);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(c) = self.category_id {
            range("category_id", c.into(), 1, INT4_MAX, &mut e);
        }
        if let Some(q) = &self.q
            && len16(q) > 100
        {
            e.push("q must be shorter than or equal to 100 characters".to_owned());
        }
        finish(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct MenuCategory {
    pub id: i32,
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct MenuProduct {
    pub id: i32,
    pub code: String,
    pub name: String,
    pub price: i64,
    pub image_url: Option<String>,
    pub category_id: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Menu {
    pub categories: Vec<MenuCategory>,
    pub products: Vec<MenuProduct>,
}

/// Danh mục được phép lọc sản phẩm: `None` = không lọc; lọc theo danh mục không được vượt ra ngoài danh mục menu đã cấu hình.
fn allowed_categories(configured: &[i32], wanted: Option<i32>) -> Option<Vec<i32>> {
    match wanted {
        Some(c) if configured.is_empty() || configured.contains(&c) => Some(vec![c]),
        Some(_) => Some(Vec::new()),
        None if configured.is_empty() => None,
        None => Some(configured.to_vec()),
    }
}

/// `GET /pos/menu`: sản phẩm đang bán, chưa xoá, có giá; không phân trang (bảng nhỏ, như bản TS). Nổi bật trước, rồi tên.
pub async fn menu(conn: &mut PgConnection, q: &MenuQuery) -> Result<Menu, AppError> {
    let settings = get_settings(&mut *conn).await?;
    let cats = settings.menu_category_ids.0;
    let categories = sqlx::query_as::<_, MenuCategory>(
        "SELECT id, code, name FROM product_categories \
         WHERE is_active AND (cardinality($1::int4[]) = 0 OR id = ANY($1)) ORDER BY sort_order ASC, id ASC",
    )
    .bind(&cats)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let allowed = allowed_categories(&cats, q.category_id);
    let products = sqlx::query_as::<_, MenuProduct>(
        "SELECT id, code, name, price, image_url, category_id FROM products \
         WHERE is_active AND deleted_at IS NULL AND price IS NOT NULL \
           AND ($1::int4[] IS NULL OR category_id = ANY($1)) \
           AND ($2::text IS NULL OR strpos(lower(name), lower($2)) > 0 OR strpos(lower(code), lower($2)) > 0) \
         ORDER BY is_featured DESC, name ASC, id ASC",
    )
    .bind(allowed)
    .bind(q.q.as_deref().filter(|s| !s.is_empty()))
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(Menu { categories, products })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loc_danh_muc_khong_vuot_menu_da_cau_hinh() {
        assert_eq!(allowed_categories(&[], None), None);
        assert_eq!(allowed_categories(&[], Some(5)), Some(vec![5]));
        assert_eq!(allowed_categories(&[1, 2], None), Some(vec![1, 2]));
        assert_eq!(allowed_categories(&[1, 2], Some(2)), Some(vec![2]));
        assert_eq!(allowed_categories(&[1, 2], Some(9)), Some(vec![]));
    }

    #[test]
    fn cai_dat_kiem_bin_va_so_tai_khoan() {
        let mut s = UpdateSettings {
            bank_bin: Some(Some("970436".into())),
            bank_account_no: Some(Some("0123456789".into())),
            ..Default::default()
        };
        assert!(s.validate().is_ok());
        s.bank_bin = Some(Some("97043".into()));
        s.bank_account_no = Some(Some("12a".into()));
        assert_eq!(s.validate().unwrap_err().status(), 400);
        let nul: UpdateSettings = serde_json::from_str(r#"{"address":null,"phone":""}"#).unwrap();
        assert_eq!(nul.address, Some(None));
        assert_eq!(nul.phone, Some(Some(String::new())));
        assert_eq!(nul.store_name, None);
    }
}
