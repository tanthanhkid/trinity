//! Biểu thuế TNCN và giảm trừ gia cảnh (6 endpoint `/tax-config`, quyền `payroll.manage`). Bản TS: `tax-config.service.ts`.

use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{PayrollTaxSetting, TaxBracket};
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::{assert_period, dec, finish, frange, month, not_null, range, set, set_num, some_nullable};

const FROM_MSG: &str = "effective_from phải YYYY-MM";
const TO_MSG: &str = "effective_to phải YYYY-MM";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

const BRACKET_COLS: &str = "id, bracket_order, lower_bound, upper_bound, rate, effective_from, effective_to, is_active, created_by, created_at, updated_at";
const SETTING_COLS: &str = "id, personal_deduction, dependent_deduction, effective_from, effective_to, is_active, created_by, created_at, updated_at";

/// Body `POST /tax-config/brackets` (`CreateTaxBracketDto`): `bracket_order` ≥ 1, `lower_bound` ≥ 0, `upper_bound` ≥ 0
/// (bỏ trống = bậc cao nhất), `rate` 0..100 (%), tháng `YYYY-MM`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBracket {
    pub bracket_order: i32,
    pub lower_bound: i64,
    #[serde(default)]
    pub upper_bound: Option<i64>,
    pub rate: f64,
    pub effective_from: String,
    #[serde(default)]
    pub effective_to: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Body `PATCH /tax-config/brackets/:id`: `upper_bound`/`effective_to` nhận `null` (xoá).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateBracket {
    #[serde(default, deserialize_with = "not_null")]
    pub bracket_order: Option<i32>,
    #[serde(default, deserialize_with = "not_null")]
    pub lower_bound: Option<i64>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub upper_bound: Option<Option<i64>>,
    #[serde(default, deserialize_with = "not_null")]
    pub rate: Option<f64>,
    #[serde(default, deserialize_with = "not_null")]
    pub effective_from: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub effective_to: Option<Option<String>>,
    #[serde(default, deserialize_with = "not_null")]
    pub is_active: Option<bool>,
}

fn bracket_errors(
    order: Option<i32>,
    lower: Option<i64>,
    upper: Option<i64>,
    rate: Option<f64>,
    from: Option<&str>,
    to: Option<&str>,
    out: &mut Vec<String>,
) {
    if let Some(o) = order {
        range("bracket_order", o.into(), Some(1), None, out);
    }
    if let Some(l) = lower {
        range("lower_bound", l, Some(0), None, out);
    }
    if let Some(u) = upper {
        range("upper_bound", u, Some(0), None, out);
    }
    if let Some(r) = rate {
        frange("rate", r, Some(0.0), Some(100.0), out);
    }
    if let Some(f) = from {
        month(f, FROM_MSG, out);
    }
    if let Some(t) = to {
        month(t, TO_MSG, out);
    }
}

impl CreateBracket {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        bracket_errors(
            Some(self.bracket_order),
            Some(self.lower_bound),
            self.upper_bound,
            Some(self.rate),
            Some(&self.effective_from),
            self.effective_to.as_deref(),
            &mut e,
        );
        finish(e)
    }
}

impl UpdateBracket {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        bracket_errors(
            self.bracket_order,
            self.lower_bound,
            self.upper_bound.flatten(),
            self.rate,
            self.effective_from.as_deref(),
            self.effective_to.as_ref().and_then(|v| v.as_deref()),
            &mut e,
        );
        finish(e)
    }
}

/// Body `POST /tax-config/settings` (`CreateTaxSettingDto`): giảm trừ ≥ 0, tháng `YYYY-MM`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateSetting {
    pub personal_deduction: i64,
    pub dependent_deduction: i64,
    pub effective_from: String,
    #[serde(default)]
    pub effective_to: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Body `PATCH /tax-config/settings/:id`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateSetting {
    #[serde(default, deserialize_with = "not_null")]
    pub personal_deduction: Option<i64>,
    #[serde(default, deserialize_with = "not_null")]
    pub dependent_deduction: Option<i64>,
    #[serde(default, deserialize_with = "not_null")]
    pub effective_from: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub effective_to: Option<Option<String>>,
    #[serde(default, deserialize_with = "not_null")]
    pub is_active: Option<bool>,
}

fn setting_errors(
    personal: Option<i64>,
    dependent: Option<i64>,
    from: Option<&str>,
    to: Option<&str>,
    out: &mut Vec<String>,
) {
    if let Some(p) = personal {
        range("personal_deduction", p, Some(0), None, out);
    }
    if let Some(d) = dependent {
        range("dependent_deduction", d, Some(0), None, out);
    }
    if let Some(f) = from {
        month(f, FROM_MSG, out);
    }
    if let Some(t) = to {
        month(t, TO_MSG, out);
    }
}

impl CreateSetting {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        setting_errors(
            Some(self.personal_deduction),
            Some(self.dependent_deduction),
            Some(&self.effective_from),
            self.effective_to.as_deref(),
            &mut e,
        );
        finish(e)
    }
}

impl UpdateSetting {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        setting_errors(
            self.personal_deduction,
            self.dependent_deduction,
            self.effective_from.as_deref(),
            self.effective_to.as_ref().and_then(|v| v.as_deref()),
            &mut e,
        );
        finish(e)
    }
}

/// `GET /tax-config`.
#[derive(Debug, Clone, Serialize)]
pub struct TaxConfig {
    pub brackets: Vec<TaxBracket>,
    pub settings: Vec<PayrollTaxSetting>,
}

/// Cận trên phải lớn hơn cận dưới (bậc cao nhất để trống cận trên).
fn assert_range(lower: i64, upper: Option<i64>) -> Result<(), AppError> {
    match upper {
        Some(u) if u <= lower => Err(HttpError::bad_request("Cận trên phải lớn hơn cận dưới").into()),
        _ => Ok(()),
    }
}

/// `GET /tax-config`: bậc theo hiệu lực mới nhất trước rồi thứ tự bậc; giảm trừ theo hiệu lực mới nhất trước.
pub async fn get_config(conn: &mut PgConnection) -> Result<TaxConfig, AppError> {
    let brackets = sqlx::query_as::<_, TaxBracket>(sqlx::AssertSqlSafe(format!(
        "SELECT {BRACKET_COLS} FROM tax_brackets ORDER BY effective_from DESC, bracket_order ASC, id ASC"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let settings = sqlx::query_as::<_, PayrollTaxSetting>(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTING_COLS} FROM payroll_tax_settings ORDER BY effective_from DESC, id DESC"
    )))
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(TaxConfig { brackets, settings })
}

async fn find_bracket(conn: &mut PgConnection, id: i32) -> Result<TaxBracket, AppError> {
    sqlx::query_as::<_, TaxBracket>(sqlx::AssertSqlSafe(format!(
        "SELECT {BRACKET_COLS} FROM tax_brackets WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy bậc thuế").into())
}

async fn find_setting(conn: &mut PgConnection, id: i32) -> Result<PayrollTaxSetting, AppError> {
    sqlx::query_as::<_, PayrollTaxSetting>(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTING_COLS} FROM payroll_tax_settings WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy cấu hình giảm trừ").into())
}

/// `POST /tax-config/brackets`: cận trên ≤ cận dưới ⇒ 400.
pub async fn create_bracket(
    conn: &mut PgConnection,
    input: &CreateBracket,
    created_by: Option<i32>,
) -> Result<TaxBracket, AppError> {
    assert_range(input.lower_bound, input.upper_bound)?;
    assert_period(&input.effective_from, input.effective_to.as_deref())?;
    sqlx::query_as::<_, TaxBracket>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO tax_brackets (bracket_order, lower_bound, upper_bound, rate, effective_from, effective_to, is_active, created_by, updated_at) \
         VALUES ($1, $2, $3, $4::text::numeric, $5, $6, COALESCE($7, true), $8, now()) RETURNING {BRACKET_COLS}"
    )))
    .bind(input.bracket_order)
    .bind(input.lower_bound)
    .bind(input.upper_bound)
    .bind(dec(input.rate))
    .bind(&input.effective_from)
    .bind(&input.effective_to)
    .bind(input.is_active)
    .bind(created_by)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /tax-config/brackets/:id`: không có ⇒ 404; kiểm cận trên/dưới trên giá trị sau khi gộp.
pub async fn update_bracket(conn: &mut PgConnection, id: i32, input: &UpdateBracket) -> Result<TaxBracket, AppError> {
    let cur = find_bracket(&mut *conn, id).await?;
    assert_range(
        input.lower_bound.unwrap_or(cur.lower_bound.0),
        match input.upper_bound {
            Some(u) => u,
            None => cur.upper_bound.map(|v| v.0),
        },
    )?;
    assert_period(
        input.effective_from.as_deref().unwrap_or(&cur.effective_from),
        match &input.effective_to {
            Some(t) => t.as_deref(),
            None => cur.effective_to.as_deref(),
        },
    )?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE tax_brackets SET updated_at = now()");
    if let Some(v) = input.bracket_order {
        set(&mut qb, "bracket_order", v);
    }
    if let Some(v) = input.lower_bound {
        set(&mut qb, "lower_bound", v);
    }
    if let Some(v) = input.upper_bound {
        set(&mut qb, "upper_bound", v);
    }
    if let Some(v) = input.rate {
        set_num(&mut qb, "rate", Some(v));
    }
    if let Some(v) = &input.effective_from {
        set(&mut qb, "effective_from", v.clone());
    }
    if let Some(v) = &input.effective_to {
        set(&mut qb, "effective_to", v.clone());
    }
    if let Some(v) = input.is_active {
        set(&mut qb, "is_active", v);
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(format!(" RETURNING {BRACKET_COLS}"));
    qb.build_query_as::<TaxBracket>().fetch_one(conn).await.map_err(db)
}

/// `DELETE /tax-config/brackets/:id` ⇒ `{ ok: true, id }`.
pub async fn remove_bracket(conn: &mut PgConnection, id: i32) -> Result<serde_json::Value, AppError> {
    find_bracket(&mut *conn, id).await?;
    sqlx::query("DELETE FROM tax_brackets WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(serde_json::json!({ "ok": true, "id": id }))
}

/// `POST /tax-config/settings`.
pub async fn create_setting(
    conn: &mut PgConnection,
    input: &CreateSetting,
    created_by: Option<i32>,
) -> Result<PayrollTaxSetting, AppError> {
    assert_period(&input.effective_from, input.effective_to.as_deref())?;
    sqlx::query_as::<_, PayrollTaxSetting>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO payroll_tax_settings (personal_deduction, dependent_deduction, effective_from, effective_to, is_active, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, COALESCE($5, true), $6, now()) RETURNING {SETTING_COLS}"
    )))
    .bind(input.personal_deduction)
    .bind(input.dependent_deduction)
    .bind(&input.effective_from)
    .bind(&input.effective_to)
    .bind(input.is_active)
    .bind(created_by)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /tax-config/settings/:id`.
pub async fn update_setting(
    conn: &mut PgConnection,
    id: i32,
    input: &UpdateSetting,
) -> Result<PayrollTaxSetting, AppError> {
    let cur = find_setting(&mut *conn, id).await?;
    assert_period(
        input.effective_from.as_deref().unwrap_or(&cur.effective_from),
        match &input.effective_to {
            Some(t) => t.as_deref(),
            None => cur.effective_to.as_deref(),
        },
    )?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE payroll_tax_settings SET updated_at = now()");
    if let Some(v) = input.personal_deduction {
        set(&mut qb, "personal_deduction", v);
    }
    if let Some(v) = input.dependent_deduction {
        set(&mut qb, "dependent_deduction", v);
    }
    if let Some(v) = &input.effective_from {
        set(&mut qb, "effective_from", v.clone());
    }
    if let Some(v) = &input.effective_to {
        set(&mut qb, "effective_to", v.clone());
    }
    if let Some(v) = input.is_active {
        set(&mut qb, "is_active", v);
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(format!(" RETURNING {SETTING_COLS}"));
    qb.build_query_as::<PayrollTaxSetting>()
        .fetch_one(conn)
        .await
        .map_err(db)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bracket() -> CreateBracket {
        CreateBracket {
            bracket_order: 1,
            lower_bound: 0,
            upper_bound: Some(5_000_000),
            rate: 5.0,
            effective_from: "2026-06".into(),
            effective_to: None,
            is_active: None,
        }
    }

    #[test]
    fn kiem_luat_dto_thue() {
        assert!(bracket().validate().is_ok());
        let bad = CreateBracket {
            bracket_order: 0,
            rate: 100.5,
            effective_from: "2026-6".into(),
            ..bracket()
        };
        let e = bad.validate().unwrap_err();
        assert_eq!(e.status(), 400);
        let s = CreateSetting {
            personal_deduction: -1,
            dependent_deduction: 0,
            effective_from: "2026-13".into(),
            effective_to: None,
            is_active: None,
        };
        assert!(s.validate().is_err());
        let up: UpdateBracket = serde_json::from_str(r#"{"upper_bound":null,"rate":7.5}"#).unwrap();
        assert_eq!((up.upper_bound, up.rate), (Some(None), Some(7.5)));
        assert!(serde_json::from_str::<UpdateBracket>(r#"{"rate":null}"#).is_err());
        assert!(assert_range(5, Some(5)).is_err() && assert_range(5, None).is_ok() && assert_range(5, Some(6)).is_ok());
    }
}
