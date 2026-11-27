//! Cấu hình bảo hiểm (4 endpoint `/insurance-settings`, quyền `payroll.manage`). Bản TS: `insurance-settings.service.ts`.
//!
//! Bộ tính lương cộng MỌI dòng khớp tháng, nên hai dòng đang áp dụng cùng mã mà chồng lấn thời gian nghĩa là trừ bảo hiểm
//! hai lần: ghi bị từ chối (400).

use serde::Deserialize;
use sqlx::{Acquire, PgConnection, Postgres, QueryBuilder};
use trinity_db::models::InsuranceSetting;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::{dec, finish, frange, month, not_empty, not_null, range, set, set_num, some_nullable};

const FROM_MSG: &str = "effective_from phải dạng YYYY-MM";
const TO_MSG: &str = "effective_to phải dạng YYYY-MM";
const COLS: &str = "id, name, code, employee_rate, base_cap, effective_from, effective_to, is_active, sort_order, created_by, created_at, updated_at";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Body `POST /insurance-settings` (`CreateInsuranceSettingDto`): `name` không rỗng ≤ 100; `code` `^[a-z0-9_]+$` ≤ 40;
/// `employee_rate` 0..100 (%); `base_cap` ≥ 0 (bỏ trống = không trần); tháng `YYYY-MM`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateInsurance {
    pub name: String,
    pub code: String,
    pub employee_rate: f64,
    #[serde(default)]
    pub base_cap: Option<i64>,
    pub effective_from: String,
    #[serde(default)]
    pub effective_to: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /insurance-settings/:id`: `base_cap`/`effective_to` nhận `null` (xoá).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateInsurance {
    #[serde(default, deserialize_with = "not_null")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub code: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub employee_rate: Option<f64>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub base_cap: Option<Option<i64>>,
    #[serde(default, deserialize_with = "not_null")]
    pub effective_from: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub effective_to: Option<Option<String>>,
    #[serde(default, deserialize_with = "not_null")]
    pub is_active: Option<bool>,
    #[serde(default, deserialize_with = "not_null")]
    pub sort_order: Option<i32>,
}

fn code_errors(code: &str, out: &mut Vec<String>) {
    if crate::len16(code) > 40 {
        out.push("code must be shorter than or equal to 40 characters".to_owned());
    }
    if code.is_empty()
        || !code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        out.push("Mã chỉ gồm chữ thường, số, gạch dưới".to_owned());
    }
}

#[allow(clippy::too_many_arguments)]
fn fields(
    name: Option<&str>,
    code: Option<&str>,
    rate: Option<f64>,
    cap: Option<i64>,
    from: Option<&str>,
    to: Option<&str>,
    out: &mut Vec<String>,
) {
    if let Some(n) = name {
        not_empty("name", n, 100, out);
    }
    if let Some(c) = code {
        code_errors(c, out);
    }
    if let Some(r) = rate {
        frange("employee_rate", r, Some(0.0), Some(100.0), out);
    }
    if let Some(c) = cap {
        range("base_cap", c, Some(0), None, out);
    }
    if let Some(f) = from {
        month(f, FROM_MSG, out);
    }
    if let Some(t) = to {
        month(t, TO_MSG, out);
    }
}

impl CreateInsurance {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        fields(
            Some(&self.name),
            Some(&self.code),
            Some(self.employee_rate),
            self.base_cap,
            Some(&self.effective_from),
            self.effective_to.as_deref(),
            &mut e,
        );
        finish(e)
    }
}

impl UpdateInsurance {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        fields(
            self.name.as_deref(),
            self.code.as_deref(),
            self.employee_rate,
            self.base_cap.flatten(),
            self.effective_from.as_deref(),
            self.effective_to.as_ref().and_then(|v| v.as_deref()),
            &mut e,
        );
        finish(e)
    }
}

/// `GET /insurance-settings`: `sort_order`, rồi `id`.
pub async fn find_all(conn: &mut PgConnection) -> Result<Vec<InsuranceSetting>, AppError> {
    sqlx::query_as::<_, InsuranceSetting>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM insurance_settings ORDER BY sort_order ASC, id ASC"
    )))
    .fetch_all(conn)
    .await
    .map_err(db)
}

async fn get_or_throw(conn: &mut PgConnection, id: i32) -> Result<InsuranceSetting, AppError> {
    sqlx::query_as::<_, InsuranceSetting>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM insurance_settings WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy cấu hình bảo hiểm").into())
}

/// Hai khoảng tháng `[a_from, a_to]` và `[b_from, b_to]` (`None` = vô hạn) có chung ít nhất một tháng? Tháng `YYYY-MM`
/// so sánh theo chữ, như bản TS.
pub fn overlaps(a_from: &str, a_to: Option<&str>, b_from: &str, b_to: Option<&str>) -> bool {
    a_from <= b_to.unwrap_or("9999-12") && b_from <= a_to.unwrap_or("9999-12")
}

/// Khoá advisory theo giao dịch cho một mã bảo hiểm (có schema, nên mỗi công ty một khoá riêng).
async fn lock_code(conn: &mut PgConnection, code: &str) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.insurance.' || $1))")
        .bind(code)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// `effective_to >= effective_from` và (nếu đang áp dụng) không chồng lấn dòng đang áp dụng cùng mã.
async fn assert_period_valid(
    conn: &mut PgConnection,
    code: &str,
    from: &str,
    to: Option<&str>,
    active: bool,
    exclude_id: Option<i32>,
) -> Result<(), AppError> {
    crate::assert_period(from, to)?;
    if !active {
        return Ok(());
    }
    let others: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT effective_from, effective_to FROM insurance_settings \
         WHERE code = $1 AND is_active AND ($2::int4 IS NULL OR id <> $2)",
    )
    .bind(code)
    .bind(exclude_id)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    if others.iter().any(|o| overlaps(from, to, &o.0, o.1.as_deref())) {
        return Err(HttpError::bad_request(format!(
            "Mã \"{code}\" đã có cấu hình đang áp dụng chồng lấn khoảng thời gian này (sẽ trừ bảo hiểm hai lần)"
        ))
        .into());
    }
    Ok(())
}

/// `POST /insurance-settings`.
pub async fn create(
    conn: &mut PgConnection,
    input: &CreateInsurance,
    created_by: Option<i32>,
) -> Result<InsuranceSetting, AppError> {
    let code = input.code.trim();
    // Kiểm chồng kỳ và ghi trong CÙNG giao dịch, dưới khoá advisory theo mã: hai request đồng thời cùng mã không cùng qua
    // được bước kiểm rồi cùng ghi (sẽ trừ bảo hiểm hai lần).
    let mut tx = conn.begin().await.map_err(db)?;
    lock_code(&mut tx, code).await?;
    assert_period_valid(
        &mut tx,
        code,
        &input.effective_from,
        input.effective_to.as_deref(),
        input.is_active.unwrap_or(true),
        None,
    )
    .await?;
    let row = sqlx::query_as::<_, InsuranceSetting>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO insurance_settings (name, code, employee_rate, base_cap, effective_from, effective_to, is_active, sort_order, created_by, updated_at) \
         VALUES ($1, $2, $3::text::numeric, $4, $5, $6, COALESCE($7, true), COALESCE($8, 0), $9, now()) RETURNING {COLS}"
    )))
    .bind(input.name.trim())
    .bind(code)
    .bind(dec(input.employee_rate))
    .bind(input.base_cap)
    .bind(&input.effective_from)
    .bind(&input.effective_to)
    .bind(input.is_active)
    .bind(input.sort_order)
    .bind(created_by)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(row)
}

/// `PATCH /insurance-settings/:id`: không có ⇒ 404; kiểm khoảng thời gian trên giá trị sau khi gộp.
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateInsurance) -> Result<InsuranceSetting, AppError> {
    let before = get_or_throw(&mut *conn, id).await?;
    let code = input.code.as_deref().map_or(before.code.as_str(), str::trim).to_owned();
    let mut tx = conn.begin().await.map_err(db)?;
    // Khoá cả mã cũ lẫn mã mới (theo thứ tự chữ để không bế tắc), rồi đọc lại dòng dưới khoá.
    let mut codes = vec![before.code.clone(), code.clone()];
    codes.sort();
    codes.dedup();
    for c in &codes {
        lock_code(&mut tx, c).await?;
    }
    let cur = get_or_throw(&mut tx, id).await?;
    if cur.code != before.code {
        return Err(HttpError::conflict("Cấu hình vừa bị sửa ở nơi khác, tải lại rồi thử lại").into());
    }
    let from = input
        .effective_from
        .clone()
        .unwrap_or_else(|| cur.effective_from.clone());
    let to = match &input.effective_to {
        Some(t) => t.clone(),
        None => cur.effective_to.clone(),
    };
    assert_period_valid(
        &mut tx,
        &code,
        &from,
        to.as_deref(),
        input.is_active.unwrap_or(cur.is_active),
        Some(id),
    )
    .await?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE insurance_settings SET updated_at = now()");
    if let Some(v) = &input.name {
        set(&mut qb, "name", v.trim().to_owned());
    }
    if input.code.is_some() {
        set(&mut qb, "code", code);
    }
    if let Some(v) = input.employee_rate {
        set_num(&mut qb, "employee_rate", Some(v));
    }
    if let Some(v) = input.base_cap {
        set(&mut qb, "base_cap", v);
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
    if let Some(v) = input.sort_order {
        set(&mut qb, "sort_order", v);
    }
    qb.push(" WHERE id = ").push_bind(id).push(format!(" RETURNING {COLS}"));
    let row = qb
        .build_query_as::<InsuranceSetting>()
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(row)
}

/// `DELETE /insurance-settings/:id` ⇒ `{ ok: true, id }`.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<serde_json::Value, AppError> {
    get_or_throw(&mut *conn, id).await?;
    sqlx::query("DELETE FROM insurance_settings WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(serde_json::json!({ "ok": true, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> CreateInsurance {
        CreateInsurance {
            name: "BHXH".into(),
            code: "bhxh".into(),
            employee_rate: 8.0,
            base_cap: Some(46_800_000),
            effective_from: "2024-07".into(),
            effective_to: None,
            is_active: None,
            sort_order: None,
        }
    }

    #[test]
    fn kiem_luat_dto_bao_hiem() {
        assert!(input().validate().is_ok());
        let bad = CreateInsurance {
            name: String::new(),
            code: "BH XH".into(),
            employee_rate: 101.0,
            base_cap: Some(-1),
            effective_from: "2024-7".into(),
            ..input()
        };
        assert_eq!(bad.validate().unwrap_err().status(), 400);
        let long = CreateInsurance {
            code: "a".repeat(41),
            ..input()
        };
        assert!(long.validate().is_err());
        let up: UpdateInsurance = serde_json::from_str(r#"{"base_cap":null,"effective_to":"2025-06"}"#).unwrap();
        assert_eq!(
            (up.base_cap, up.effective_to.clone()),
            (Some(None), Some(Some("2025-06".into())))
        );
        assert!(up.validate().is_ok());
    }

    #[test]
    fn chong_lan_theo_thang() {
        assert!(overlaps("2024-07", None, "2025-01", Some("2025-12")));
        assert!(overlaps("2024-01", Some("2024-06"), "2024-06", None));
        assert!(!overlaps("2024-01", Some("2024-06"), "2024-07", None));
        assert!(!overlaps("2025-01", None, "2024-01", Some("2024-12")));
    }
}
