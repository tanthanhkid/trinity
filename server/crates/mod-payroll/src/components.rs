//! Thành phần lương: phụ cấp, thưởng, khấu trừ (4 endpoint `/salary-components`, quyền `payroll.manage`, không phân đọc/
//! ghi/xoá riêng). Bản TS: `salary-components.service.ts`.
//!
//! Chuẩn hoá: `fixed` ⇒ bỏ `percent_value`; `percent_base` ⇒ bỏ `fixed_amount` (không bao giờ có cả hai).

use serde::Deserialize;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::SalaryComponent;
use trinity_db::pg_error::{app_error, db_error};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::{
    assert_period, dec, finish, frange, is_in, month, not_empty, not_null, range, set, set_num, some_nullable,
};

const FROM_MSG: &str = "effective_from phải dạng YYYY-MM";
const TO_MSG: &str = "effective_to phải dạng YYYY-MM";
const TYPES: [&str; 3] = ["allowance", "bonus", "deduction"];
const METHODS: [&str; 2] = ["fixed", "percent_base"];
const COLS: &str = "id, name, code, component_type, calc_method, fixed_amount, percent_value, applies_to, is_taxable, effective_from, \
                    effective_to, is_active, sort_order, description, created_by, created_at, updated_at";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn write_err(e: &sqlx::Error) -> AppError {
    let d = db_error(e);
    if d.is(DbErrorKind::UniqueViolation, None) {
        HttpError::conflict("Mã thành phần lương đã tồn tại").into()
    } else {
        d.into()
    }
}

/// Body `POST /salary-components` (`CreateSalaryComponentDto`): `name` không rỗng ≤ 100; `code` `^[a-z0-9_]+$` ≤ 60;
/// `component_type` `allowance|bonus|deduction`; `calc_method` `fixed|percent_base` (mặc định `fixed`); `fixed_amount` ≥ 0;
/// `percent_value` 0..100; `applies_to` `all` hoặc `rank:<mã>` ≤ 60; tháng `YYYY-MM`; `description` ≤ 255.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateComponent {
    pub name: String,
    pub code: String,
    pub component_type: String,
    #[serde(default)]
    pub calc_method: Option<String>,
    #[serde(default)]
    pub fixed_amount: Option<i64>,
    #[serde(default)]
    pub percent_value: Option<f64>,
    #[serde(default)]
    pub applies_to: Option<String>,
    pub effective_from: String,
    #[serde(default)]
    pub effective_to: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_taxable: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub description: Option<String>,
}

/// Body `PATCH /salary-components/:id`: `effective_to`/`description` nhận `null` (xoá).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateComponent {
    #[serde(default, deserialize_with = "not_null")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub code: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub component_type: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub calc_method: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub fixed_amount: Option<Option<i64>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub percent_value: Option<Option<f64>>,
    #[serde(default, deserialize_with = "not_null")]
    pub applies_to: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub effective_from: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub effective_to: Option<Option<String>>,
    #[serde(default, deserialize_with = "not_null")]
    pub is_active: Option<bool>,
    #[serde(default, deserialize_with = "not_null")]
    pub is_taxable: Option<bool>,
    #[serde(default, deserialize_with = "not_null")]
    pub sort_order: Option<i32>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
}

/// `^(all|rank:[A-Za-z0-9_]+)$`.
fn applies_ok(v: &str) -> bool {
    v == "all"
        || v.strip_prefix("rank:")
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

#[derive(Default)]
struct Fields<'a> {
    name: Option<&'a str>,
    code: Option<&'a str>,
    component_type: Option<&'a str>,
    calc_method: Option<&'a str>,
    fixed: Option<i64>,
    percent: Option<f64>,
    applies_to: Option<&'a str>,
    from: Option<&'a str>,
    to: Option<&'a str>,
    description: Option<&'a str>,
}

fn field_errors(f: &Fields<'_>, out: &mut Vec<String>) {
    if let Some(n) = f.name {
        not_empty("name", n, 100, out);
    }
    if let Some(c) = f.code {
        if crate::len16(c) > 60 {
            out.push("code must be shorter than or equal to 60 characters".to_owned());
        }
        if c.is_empty()
            || !c
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        {
            out.push("Mã chỉ gồm chữ thường, số và dấu gạch dưới".to_owned());
        }
    }
    if let Some(t) = f.component_type {
        is_in("component_type", t, &TYPES, out);
    }
    if let Some(m) = f.calc_method {
        is_in("calc_method", m, &METHODS, out);
    }
    if let Some(v) = f.fixed {
        range("fixed_amount", v, Some(0), None, out);
    }
    if let Some(p) = f.percent {
        frange("percent_value", p, Some(0.0), Some(100.0), out);
    }
    if let Some(a) = f.applies_to {
        if crate::len16(a) > 60 {
            out.push("applies_to must be shorter than or equal to 60 characters".to_owned());
        }
        if !applies_ok(a) {
            out.push("applies_to phải là 'all' hoặc 'rank:<mã>' (mã không có khoảng trắng)".to_owned());
        }
    }
    if let Some(v) = f.from {
        month(v, FROM_MSG, out);
    }
    if let Some(v) = f.to {
        month(v, TO_MSG, out);
    }
    if f.description.is_some_and(|d| crate::len16(d) > 255) {
        out.push("description must be shorter than or equal to 255 characters".to_owned());
    }
}

impl CreateComponent {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        field_errors(
            &Fields {
                name: Some(&self.name),
                code: Some(&self.code),
                component_type: Some(&self.component_type),
                calc_method: self.calc_method.as_deref(),
                fixed: self.fixed_amount,
                percent: self.percent_value,
                applies_to: self.applies_to.as_deref(),
                from: Some(&self.effective_from),
                to: self.effective_to.as_deref(),
                description: self.description.as_deref(),
            },
            &mut e,
        );
        finish(e)
    }
}

impl UpdateComponent {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        field_errors(
            &Fields {
                name: self.name.as_deref(),
                code: self.code.as_deref(),
                component_type: self.component_type.as_deref(),
                calc_method: self.calc_method.as_deref(),
                fixed: self.fixed_amount.flatten(),
                percent: self.percent_value.flatten(),
                applies_to: self.applies_to.as_deref(),
                from: self.effective_from.as_deref(),
                to: self.effective_to.as_ref().and_then(|v| v.as_deref()),
                description: self.description.as_ref().and_then(|v| v.as_deref()),
            },
            &mut e,
        );
        finish(e)
    }
}

/// `GET /salary-components?component_type=`: `sort_order`, rồi `id`.
pub async fn find_all(conn: &mut PgConnection, component_type: Option<&str>) -> Result<Vec<SalaryComponent>, AppError> {
    sqlx::query_as::<_, SalaryComponent>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM salary_components WHERE ($1::text IS NULL OR component_type = $1) ORDER BY sort_order ASC, id ASC"
    )))
    .bind(component_type.filter(|s| !s.is_empty()))
    .fetch_all(conn)
    .await
    .map_err(db)
}

fn trim_or_null(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_owned())
}

/// `POST /salary-components`: mã trùng ⇒ 409.
pub async fn create(
    conn: &mut PgConnection,
    input: &CreateComponent,
    created_by: Option<i32>,
) -> Result<SalaryComponent, AppError> {
    assert_period(&input.effective_from, input.effective_to.as_deref())?;
    let calc = input.calc_method.as_deref().unwrap_or("fixed");
    let fixed = (calc == "fixed").then(|| input.fixed_amount.unwrap_or(0));
    let percent = (calc == "percent_base").then(|| dec(input.percent_value.unwrap_or(0.0)));
    sqlx::query_as::<_, SalaryComponent>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO salary_components (name, code, component_type, calc_method, fixed_amount, percent_value, applies_to, \
         effective_from, effective_to, is_active, is_taxable, sort_order, description, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6::text::numeric, $7, $8, $9, COALESCE($10, true), COALESCE($11, true), COALESCE($12, 0), $13, $14, now()) \
         RETURNING {COLS}"
    )))
    .bind(input.name.trim())
    .bind(input.code.trim())
    .bind(&input.component_type)
    .bind(calc)
    .bind(fixed)
    .bind(percent)
    .bind(input.applies_to.as_deref().and_then(trim_or_null).unwrap_or_else(|| "all".into()))
    .bind(&input.effective_from)
    .bind(&input.effective_to)
    .bind(input.is_active)
    .bind(input.is_taxable)
    .bind(input.sort_order)
    .bind(input.description.as_deref().and_then(trim_or_null))
    .bind(created_by)
    .fetch_one(conn)
    .await
    .map_err(|e| write_err(&e))
}

/// `PATCH /salary-components/:id`: không có ⇒ 404; mã trùng ⇒ 409. Đổi `calc_method` hay giá trị thì đặt trường tương ứng
/// và LUÔN xoá trường đối lập (cách tính hiệu lực = `calc_method` gửi lên, không thì cách tính hiện tại).
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateComponent) -> Result<SalaryComponent, AppError> {
    let cur: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT calc_method, effective_from, effective_to FROM salary_components WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let (existing, cur_from, cur_to) = cur.ok_or_else(|| HttpError::not_found("Không tìm thấy thành phần lương"))?;
    assert_period(
        input.effective_from.as_deref().unwrap_or(&cur_from),
        match &input.effective_to {
            Some(t) => t.as_deref(),
            None => cur_to.as_deref(),
        },
    )?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE salary_components SET updated_at = now()");
    if let Some(v) = &input.name {
        set(&mut qb, "name", v.trim().to_owned());
    }
    if let Some(v) = &input.code {
        set(&mut qb, "code", v.trim().to_owned());
    }
    if let Some(v) = &input.component_type {
        set(&mut qb, "component_type", v.clone());
    }
    if let Some(v) = &input.applies_to {
        set(&mut qb, "applies_to", trim_or_null(v).unwrap_or_else(|| "all".into()));
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
    if let Some(v) = input.is_taxable {
        set(&mut qb, "is_taxable", v);
    }
    if let Some(v) = input.sort_order {
        set(&mut qb, "sort_order", v);
    }
    if let Some(v) = &input.description {
        set(&mut qb, "description", v.as_deref().and_then(trim_or_null));
    }
    if input.calc_method.is_some() || input.fixed_amount.is_some() || input.percent_value.is_some() {
        let method = input.calc_method.as_deref().unwrap_or(&existing);
        // Đổi sang cách tính khác mà không gửi giá trị ⇒ mặc định 0 như lúc tạo; gửi giá trị của cách tính KHÔNG khớp ⇒ 400.
        let switched = input.calc_method.as_deref().is_some_and(|m| m != existing);
        if method == "percent_base" {
            if matches!(input.fixed_amount, Some(Some(_))) {
                return Err(HttpError::bad_request("fixed_amount không dùng được với calc_method percent_base").into());
            }
            set(&mut qb, "calc_method", "percent_base");
            match input.percent_value {
                Some(Some(v)) => set_num(&mut qb, "percent_value", Some(v)),
                Some(None) => {
                    return Err(
                        HttpError::bad_request("percent_value không được null với calc_method percent_base").into(),
                    );
                }
                None if switched => set_num(&mut qb, "percent_value", Some(0.0)),
                None => {}
            }
            qb.push(", fixed_amount = NULL");
        } else {
            if matches!(input.percent_value, Some(Some(_))) {
                return Err(HttpError::bad_request("percent_value không dùng được với calc_method fixed").into());
            }
            set(&mut qb, "calc_method", "fixed");
            match input.fixed_amount {
                Some(Some(v)) => set(&mut qb, "fixed_amount", v),
                Some(None) => {
                    return Err(HttpError::bad_request("fixed_amount không được null với calc_method fixed").into());
                }
                None if switched => set(&mut qb, "fixed_amount", 0_i64),
                None => {}
            }
            qb.push(", percent_value = NULL");
        }
    }
    qb.push(" WHERE id = ").push_bind(id).push(format!(" RETURNING {COLS}"));
    qb.build_query_as::<SalaryComponent>()
        .fetch_one(conn)
        .await
        .map_err(|e| write_err(&e))
}

/// `DELETE /salary-components/:id` ⇒ `{ ok: true, id }`.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<serde_json::Value, AppError> {
    let found: Option<i32> = sqlx::query_scalar("SELECT id FROM salary_components WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if found.is_none() {
        return Err(HttpError::not_found("Không tìm thấy thành phần lương").into());
    }
    sqlx::query("DELETE FROM salary_components WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(serde_json::json!({ "ok": true, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> CreateComponent {
        CreateComponent {
            name: "Phụ cấp điện thoại".into(),
            code: "allowance_phone".into(),
            component_type: "allowance".into(),
            calc_method: None,
            fixed_amount: Some(300_000),
            percent_value: None,
            applies_to: Some("rank:A1".into()),
            effective_from: "2026-07".into(),
            effective_to: None,
            is_active: None,
            is_taxable: None,
            sort_order: None,
            description: None,
        }
    }

    #[test]
    fn kiem_luat_dto_thanh_phan() {
        assert!(input().validate().is_ok());
        for bad in [
            CreateComponent {
                component_type: "salary".into(),
                ..input()
            },
            CreateComponent {
                calc_method: Some("x".into()),
                ..input()
            },
            CreateComponent {
                applies_to: Some("rank: NV".into()),
                ..input()
            },
            CreateComponent {
                applies_to: Some("rank:".into()),
                ..input()
            },
            CreateComponent {
                percent_value: Some(100.01),
                ..input()
            },
            CreateComponent {
                fixed_amount: Some(-1),
                ..input()
            },
            CreateComponent {
                code: "Phone".into(),
                ..input()
            },
            CreateComponent {
                description: Some("x".repeat(256)),
                ..input()
            },
        ] {
            assert_eq!(bad.validate().unwrap_err().status(), 400);
        }
        assert!(applies_ok("all") && applies_ok("rank:SENIOR_1") && !applies_ok("rank") && !applies_ok("ALL"));
        let up: UpdateComponent = serde_json::from_str(r#"{"description":null,"percent_value":12.5}"#).unwrap();
        assert_eq!(
            (up.description.clone(), up.percent_value),
            (Some(None), Some(Some(12.5)))
        );
        assert!(serde_json::from_str::<UpdateComponent>(r#"{"name":null}"#).is_err());
    }
}
