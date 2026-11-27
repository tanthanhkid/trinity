//! Bảng lương theo vị trí (4 endpoint `/salary-rules`, quyền `payroll.manage`). Bản TS: `salary-rules.service.ts`.
//!
//! Mỗi bảng gồm các dòng chi tiết (`base`, `kpi_bonus`, `allowance`) là số tiền cố định hoặc công thức; công thức được kiểm
//! bằng [`crate::formula::validate_formula`] TRƯỚC khi ghi. Đọc trả `amount` là số, còn tạo/sửa trả `amount` là chuỗi
//! (đúng như bản Node: đọc đi qua `BigInt.toJSON`, ghi trả `toString()`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Acquire, PgConnection};
use trinity_db::models::{SalaryRule, SalaryRuleDetail};
use trinity_db::pg_error::app_error;
use trinity_db::types::JsBigInt;
use trinity_kernel::error::{AppError, HttpError};

use crate::formula::validate_formula;
use crate::{finish, is_in, len16, not_empty, range, some_nullable};

const COMPONENTS: [&str; 3] = ["base", "kpi_bonus", "allowance"];

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Một dòng chi tiết đầu vào (`SalaryRuleDetailDto`): `component` `base|kpi_bonus|allowance`; `amount` chuỗi `^\d{1,18}$`;
/// `formula` ≤ 500; `order` ≥ 0.
#[derive(Debug, Clone, Deserialize)]
pub struct DetailInput {
    pub component: String,
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub formula: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub order: Option<i32>,
}

fn detail_errors(i: usize, d: &DetailInput, out: &mut Vec<String>) {
    let mut e = Vec::new();
    is_in("component", &d.component, &COMPONENTS, &mut e);
    if let Some(a) = &d.amount
        && !((1..=18).contains(&a.len()) && a.bytes().all(|b| b.is_ascii_digit()))
    {
        e.push("amount phải là số nguyên không âm (VND)".to_owned());
    }
    if d.formula.as_deref().is_some_and(|f| len16(f) > 500) {
        e.push("formula must be shorter than or equal to 500 characters".to_owned());
    }
    if let Some(o) = d.order {
        range("order", o.into(), Some(0), None, &mut e);
    }
    out.extend(e.into_iter().map(|m| format!("details.{i}.{m}")));
}

/// Body `POST /salary-rules` (`CreateSalaryRuleDto`): `position` không rỗng ≤ 50, `name` không rỗng ≤ 255, `description`
/// ≤ 1000, `details` là mảng (có thể rỗng).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateRule {
    pub position: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub details: Vec<DetailInput>,
}

/// Body `PATCH /salary-rules/:id`: `details` có gửi = THAY TOÀN BỘ; `description: null` = xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateRule {
    #[serde(default, deserialize_with = "crate::not_null")]
    pub position: Option<String>,
    #[serde(default, deserialize_with = "crate::not_null")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub details: Option<Vec<DetailInput>>,
}

impl CreateRule {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        not_empty("position", &self.position, 50, &mut e);
        not_empty("name", &self.name, 255, &mut e);
        if self.description.as_deref().is_some_and(|d| len16(d) > 1000) {
            e.push("description must be shorter than or equal to 1000 characters".to_owned());
        }
        for (i, d) in self.details.iter().enumerate() {
            detail_errors(i, d, &mut e);
        }
        finish(e)
    }
}

impl UpdateRule {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(p) = &self.position
            && len16(p) > 50
        {
            e.push("position must be shorter than or equal to 50 characters".to_owned());
        }
        if let Some(n) = &self.name
            && len16(n) > 255
        {
            e.push("name must be shorter than or equal to 255 characters".to_owned());
        }
        if self
            .description
            .as_ref()
            .and_then(|d| d.as_deref())
            .is_some_and(|d| len16(d) > 1000)
        {
            e.push("description must be shorter than or equal to 1000 characters".to_owned());
        }
        for (i, d) in self.details.iter().flatten().enumerate() {
            detail_errors(i, d, &mut e);
        }
        finish(e)
    }
}

/// Dòng chi tiết khi ĐỌC (`amount` là số).
#[derive(Debug, Clone, Serialize)]
pub struct DetailView {
    pub id: i32,
    pub component: String,
    pub amount: Option<JsBigInt>,
    pub formula: Option<String>,
    pub params: Option<trinity_db::types::JsonValue>,
    pub order: i32,
}

/// Bảng lương khi ĐỌC: `id, position, name, description, details`.
#[derive(Debug, Clone, Serialize)]
pub struct RuleView {
    pub id: i32,
    pub position: String,
    pub name: String,
    pub description: Option<String>,
    pub details: Vec<DetailView>,
}

/// Dòng chi tiết khi GHI (`amount` là chuỗi).
#[derive(Debug, Clone, Serialize)]
pub struct DetailWritten {
    pub id: i32,
    pub component: String,
    pub amount: Option<String>,
    pub formula: Option<String>,
    pub params: Option<trinity_db::types::JsonValue>,
    pub order: i32,
}

/// Bảng lương khi GHI: `...rule` rồi `details`.
#[derive(Debug, Clone, Serialize)]
pub struct RuleWritten {
    pub id: i32,
    pub position: String,
    pub name: String,
    pub description: Option<String>,
    pub details: Vec<DetailWritten>,
}

const RULE_COLS: &str = "id, position, name, description";
const DETAIL_COLS: &str = "id, salary_rule_id, component, amount, formula, params, \"order\"";

async fn views(conn: &mut PgConnection, rules: Vec<SalaryRule>) -> Result<Vec<RuleView>, AppError> {
    let ids: Vec<i32> = rules.iter().map(|r| r.id).collect();
    let details = sqlx::query_as::<_, SalaryRuleDetail>(sqlx::AssertSqlSafe(format!(
        "SELECT {DETAIL_COLS} FROM salary_rule_details WHERE salary_rule_id = ANY($1) ORDER BY \"order\" ASC, id ASC"
    )))
    .bind(&ids)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rules
        .into_iter()
        .map(|r| RuleView {
            details: details
                .iter()
                .filter(|d| d.salary_rule_id == r.id)
                .map(|d| DetailView {
                    id: d.id,
                    component: d.component.clone(),
                    amount: d.amount,
                    formula: d.formula.clone(),
                    params: d.params.clone(),
                    order: d.order,
                })
                .collect(),
            id: r.id,
            position: r.position,
            name: r.name,
            description: r.description,
        })
        .collect())
}

/// `GET /salary-rules?position=`: theo `id`.
pub async fn find_all(conn: &mut PgConnection, position: Option<&str>) -> Result<Vec<RuleView>, AppError> {
    let rules = sqlx::query_as::<_, SalaryRule>(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_COLS} FROM salary_rules WHERE ($1::text IS NULL OR position = $1) ORDER BY id ASC"
    )))
    .bind(position.filter(|p| !p.is_empty()))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    views(conn, rules).await
}

fn not_found(id: i32) -> AppError {
    HttpError::not_found(format!("Bảng lương #{id} không tồn tại")).into()
}

/// `GET /salary-rules/:id`.
pub async fn find_by_id(conn: &mut PgConnection, id: i32) -> Result<RuleView, AppError> {
    let rule = sqlx::query_as::<_, SalaryRule>(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_COLS} FROM salary_rules WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| not_found(id))?;
    Ok(views(conn, vec![rule]).await?.remove(0))
}

/// Công thức sai ⇒ 400 trước khi ghi bất cứ gì.
fn check_formulas(details: &[DetailInput]) -> Result<(), AppError> {
    for d in details {
        if let Some(f) = d.formula.as_deref().filter(|f| !f.is_empty())
            && !validate_formula(f)
        {
            return Err(HttpError::bad_request(format!(
                "Công thức không hợp lệ cho component \"{}\": {f}",
                d.component
            ))
            .into());
        }
    }
    Ok(())
}

async fn insert_details(
    conn: &mut PgConnection,
    rule_id: i32,
    details: &[DetailInput],
) -> Result<Vec<DetailWritten>, AppError> {
    let mut out = Vec::new();
    for (index, d) in details.iter().enumerate() {
        let amount: Option<i64> = d.amount.as_deref().map(|a| a.parse().unwrap_or(0));
        let params = d.params.as_ref().filter(|p| !p.is_null()).map(Value::to_string);
        let row = sqlx::query_as::<_, SalaryRuleDetail>(sqlx::AssertSqlSafe(format!(
            "INSERT INTO salary_rule_details (salary_rule_id, component, amount, formula, params, \"order\") \
             VALUES ($1, $2, $3, $4, $5::text::jsonb, $6) RETURNING {DETAIL_COLS}"
        )))
        .bind(rule_id)
        .bind(&d.component)
        .bind(amount)
        .bind(&d.formula)
        .bind(params)
        .bind(d.order.unwrap_or(i32::try_from(index).unwrap_or(i32::MAX)))
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        out.push(written(&row));
    }
    Ok(out)
}

fn written(d: &SalaryRuleDetail) -> DetailWritten {
    DetailWritten {
        id: d.id,
        component: d.component.clone(),
        amount: d.amount.map(|a| a.0.to_string()),
        formula: d.formula.clone(),
        params: d.params.clone(),
        order: d.order,
    }
}

/// `POST /salary-rules`: công thức sai ⇒ 400; tạo bảng và các dòng trong một giao dịch.
pub async fn create(conn: &mut PgConnection, input: &CreateRule) -> Result<RuleWritten, AppError> {
    check_formulas(&input.details)?;
    let mut tx = conn.begin().await.map_err(db)?;
    let rule = sqlx::query_as::<_, SalaryRule>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO salary_rules (position, name, description) VALUES ($1, $2, $3) RETURNING {RULE_COLS}"
    )))
    .bind(&input.position)
    .bind(&input.name)
    .bind(&input.description)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let details = insert_details(&mut tx, rule.id, &input.details).await?;
    tx.commit().await.map_err(db)?;
    Ok(RuleWritten {
        id: rule.id,
        position: rule.position,
        name: rule.name,
        description: rule.description,
        details,
    })
}

/// `PATCH /salary-rules/:id`: không có ⇒ 404; có `details` thì xoá hết dòng cũ và tạo lại.
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateRule) -> Result<RuleWritten, AppError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT id FROM salary_rules WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if exists.is_none() {
        return Err(not_found(id));
    }
    if let Some(d) = &input.details {
        check_formulas(d)?;
    }
    let mut tx = conn.begin().await.map_err(db)?;
    let (set_desc, desc) = match &input.description {
        Some(d) => (true, d.as_deref()),
        None => (false, None),
    };
    let rule = sqlx::query_as::<_, SalaryRule>(sqlx::AssertSqlSafe(format!(
        "UPDATE salary_rules SET position = COALESCE($2, position), name = COALESCE($3, name), \
         description = CASE WHEN $4 THEN $5 ELSE description END WHERE id = $1 RETURNING {RULE_COLS}"
    )))
    .bind(id)
    .bind(input.position.as_deref())
    .bind(input.name.as_deref())
    .bind(set_desc)
    .bind(desc)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let details = match &input.details {
        Some(d) => {
            sqlx::query("DELETE FROM salary_rule_details WHERE salary_rule_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            insert_details(&mut tx, id, d).await?
        }
        None => sqlx::query_as::<_, SalaryRuleDetail>(sqlx::AssertSqlSafe(format!(
            "SELECT {DETAIL_COLS} FROM salary_rule_details WHERE salary_rule_id = $1 ORDER BY \"order\" ASC, id ASC"
        )))
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?
        .iter()
        .map(written)
        .collect(),
    };
    tx.commit().await.map_err(db)?;
    Ok(RuleWritten {
        id: rule.id,
        position: rule.position,
        name: rule.name,
        description: rule.description,
        details,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(component: &str, amount: Option<&str>) -> DetailInput {
        DetailInput {
            component: component.into(),
            amount: amount.map(Into::into),
            formula: None,
            params: None,
            order: None,
        }
    }

    #[test]
    fn kiem_luat_dto_bang_luong() {
        let ok = CreateRule {
            position: "staff".into(),
            name: "Q1".into(),
            description: None,
            details: vec![detail("base", Some("7000000"))],
        };
        assert!(ok.validate().is_ok());
        let bad = CreateRule {
            position: String::new(),
            name: "x".repeat(256),
            description: None,
            details: vec![
                detail("salary", Some("-5")),
                detail("base", Some("1234567890123456789")),
            ],
        };
        assert_eq!(bad.validate().unwrap_err().status(), 400);
        assert!(
            CreateRule {
                details: vec![detail("kpi_bonus", Some("12a"))],
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(CreateRule { details: vec![], ..ok }.validate().is_ok());
        let up: UpdateRule = serde_json::from_str(r#"{"description":null}"#).unwrap();
        assert_eq!(up.description, Some(None));
    }

    #[test]
    fn cong_thuc_sai_bi_chan_truoc_khi_ghi() {
        let mut d = detail("kpi_bonus", None);
        d.formula = Some("base * ".into());
        let e = check_formulas(&[d]).unwrap_err();
        let (s, _) = e.response(true);
        assert_eq!(s, 400);
        let mut ok = detail("kpi_bonus", None);
        ok.formula = Some("max(0, base * achievement_rate / 100)".into());
        assert!(check_formulas(&[ok]).is_ok());
        let mut empty = detail("base", None);
        empty.formula = Some(String::new());
        assert!(check_formulas(&[empty]).is_ok());
    }
}
