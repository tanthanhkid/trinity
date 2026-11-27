//! Chức danh (M09): 5 endpoint `/api/v1/management/job-titles`. Bản TS: `job-titles.service.ts`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::models::JobTitle;
use trinity_db::pg_error::db_error;
use trinity_db::types::{JsBigInt, Timestamp};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::nullable::{lenient_i32, lenient_i32_opt, lenient_i64_opt, some_value};
use crate::{OK, OkBody, db, len16};

/// Một dòng trả về: như `mapJobTitle` (tiền lương là chuỗi, không phải số).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobTitleRow {
    pub id: i32,
    pub category: String,
    pub rank_code: String,
    pub name: String,
    pub symbol: String,
    pub base_salary: String,
    pub standard_target: String,
    pub default_insurance_salary: Option<String>,
    pub review_cycle_months: i32,
    pub is_active: bool,
    pub sort_order: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl From<JobTitle> for JobTitleRow {
    fn from(j: JobTitle) -> Self {
        Self {
            id: j.id,
            category: j.category,
            rank_code: j.rank_code,
            name: j.name,
            symbol: j.symbol,
            base_salary: j.base_salary.0.to_string(),
            standard_target: j.standard_target.0.to_string(),
            default_insurance_salary: j.default_insurance_salary.map(|v| v.0.to_string()),
            review_cycle_months: j.review_cycle_months,
            is_active: j.is_active,
            sort_order: j.sort_order,
            created_at: j.created_at,
            updated_at: j.updated_at,
        }
    }
}

/// Query `GET /job-titles` (`category` 1..100, `is_active` nhận `"true"`/`"false"`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryJobTitles {
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

impl QueryJobTitles {
    /// Luật của `QueryJobTitlesDto`: `@IsOptional() @IsString() @Length(1, 100)`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(c) = &self.category {
            length("category", c, 100, &mut e);
        }
        finish(e)
    }
}

/// Body `POST /job-titles`. Trường số nhận cả chuỗi số (`@Type(() => Number)`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateJobTitle {
    pub category: String,
    pub rank_code: String,
    pub name: String,
    pub symbol: String,
    #[serde(default, deserialize_with = "lenient_i64_opt")]
    pub base_salary: Option<i64>,
    #[serde(default, deserialize_with = "lenient_i64_opt")]
    pub standard_target: Option<i64>,
    #[serde(default, deserialize_with = "lenient_i64_opt")]
    pub default_insurance_salary: Option<i64>,
    #[serde(deserialize_with = "lenient_i32")]
    pub review_cycle_months: i32,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default, deserialize_with = "lenient_i32_opt")]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /job-titles/:id`. Giá trị giữ dạng JSON thô: không gửi khoá = `None` (giữ nguyên); các cột NOT NULL
/// gửi `null` ⇒ 400 như TS (`ValidateIf(v !== undefined)`); `default_insurance_salary: null` = xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateJobTitle {
    #[serde(default, deserialize_with = "some_value")]
    pub category: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub name: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub symbol: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub base_salary: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub standard_target: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub default_insurance_salary: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub review_cycle_months: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub is_active: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    pub sort_order: Option<Value>,
}

/// `UpdateJobTitle` đã kiểm: mỗi trường đúng kiểu cột.
#[derive(Debug, Default)]
struct UpdateParsed {
    category: Option<String>,
    name: Option<String>,
    symbol: Option<String>,
    base_salary: Option<i64>,
    standard_target: Option<i64>,
    /// `Some(None)` = xoá.
    default_insurance_salary: Option<Option<i64>>,
    review_cycle_months: Option<i32>,
    is_active: Option<bool>,
    sort_order: Option<i32>,
}

/// Thông điệp `@Length(1, max)` của class-validator: rỗng/falsy ⇒ câu "longer", quá dài ⇒ câu "shorter",
/// còn lại (không phải chuỗi) ⇒ câu gộp.
fn length_msg(field: &str, max: usize, n: Option<usize>, falsy: bool) -> Option<String> {
    let longer = format!("{field} must be longer than or equal to 1 characters");
    match n {
        Some(0) => Some(longer),
        Some(n) if n > max => Some(format!("{field} must be shorter than or equal to {max} characters")),
        Some(_) => None,
        None if falsy => Some(longer),
        None => Some(format!(
            "{field} must be longer than or equal to 1 and shorter than or equal to {max} characters"
        )),
    }
}

/// `@Length(1, max)` trên chuỗi: một câu khi ngoài khoảng.
fn length(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    out.extend(length_msg(field, max, Some(len16(v)), false));
}

/// `@IsNotEmpty() @IsString() @Length(1, max)`: class-validator báo ngược thứ tự khai báo (Length, IsString, IsNotEmpty).
fn required_text(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    length(field, v, max, out);
    if v.is_empty() {
        out.push(format!("{field} should not be empty"));
    }
}

fn min(field: &str, v: i64, min: i64, out: &mut Vec<String>) {
    if v < min {
        out.push(format!("{field} must not be less than {min}"));
    }
}

fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

/// `ValidateIf(v !== undefined) @IsString() @Length(1, max)`.
fn update_text(field: &str, v: &Value, max: usize, out: &mut Vec<String>) -> Option<String> {
    if let Value::String(s) = v {
        let n = len16(s);
        out.extend(length_msg(field, max, Some(n), false));
        return (n >= 1 && n <= max).then(|| s.clone());
    }
    let falsy = match v {
        Value::Null | Value::Bool(false) => true,
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    };
    out.extend(length_msg(field, max, None, falsy));
    out.push(format!("{field} must be a string"));
    None
}

/// `@Type(() => Number) @IsInt() @Min(lo)`: báo Min trước IsInt (ngược thứ tự khai báo).
fn update_int(field: &str, v: &Value, lo: i64, out: &mut Vec<String>) -> Option<i64> {
    let Some(f) = crate::js_number(v) else {
        out.push(format!("{field} must not be less than {lo}"));
        out.push(format!("{field} must be an integer number"));
        return None;
    };
    let mut ok = true;
    #[allow(clippy::cast_precision_loss)]
    if f < lo as f64 {
        out.push(format!("{field} must not be less than {lo}"));
        ok = false;
    }
    if f.fract() != 0.0 || f.abs() >= 9_007_199_254_740_992.0 {
        out.push(format!("{field} must be an integer number"));
        ok = false;
    }
    #[allow(clippy::cast_possible_truncation)]
    ok.then_some(f as i64)
}

fn update_i32(field: &str, v: &Value, lo: i64, out: &mut Vec<String>) -> Option<i32> {
    let n = update_int(field, v, lo, out)?;
    let r = i32::try_from(n).ok();
    if r.is_none() {
        out.push(format!("{field} must not be greater than {}", i32::MAX));
    }
    r
}

impl CreateJobTitle {
    /// Luật của `CreateJobTitleDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        required_text("category", &self.category, 100, &mut e);
        required_text("rank_code", &self.rank_code, 20, &mut e);
        required_text("name", &self.name, 100, &mut e);
        required_text("symbol", &self.symbol, 10, &mut e);
        if let Some(v) = self.base_salary {
            min("base_salary", v, 0, &mut e);
        }
        if let Some(v) = self.standard_target {
            min("standard_target", v, 0, &mut e);
        }
        if let Some(v) = self.default_insurance_salary {
            min("default_insurance_salary", v, 0, &mut e);
        }
        min("review_cycle_months", i64::from(self.review_cycle_months), 1, &mut e);
        if let Some(v) = self.sort_order {
            min("sort_order", i64::from(v), 0, &mut e);
        }
        finish(e)
    }
}

impl UpdateJobTitle {
    /// Luật của `UpdateJobTitleDto` (trường vắng thì bỏ qua; `null` ở cột NOT NULL ⇒ 400).
    pub fn validate(&self) -> Result<(), HttpError> {
        self.parse().map(|_| ())
    }

    fn parse(&self) -> Result<UpdateParsed, HttpError> {
        let mut e = Vec::new();
        let mut p = UpdateParsed::default();
        if let Some(v) = &self.category {
            p.category = update_text("category", v, 100, &mut e);
        }
        if let Some(v) = &self.name {
            p.name = update_text("name", v, 100, &mut e);
        }
        if let Some(v) = &self.symbol {
            p.symbol = update_text("symbol", v, 10, &mut e);
        }
        if let Some(v) = &self.base_salary {
            p.base_salary = update_int("base_salary", v, 0, &mut e);
        }
        if let Some(v) = &self.standard_target {
            p.standard_target = update_int("standard_target", v, 0, &mut e);
        }
        match &self.default_insurance_salary {
            None => {}
            Some(Value::Null) => p.default_insurance_salary = Some(None),
            Some(v) => p.default_insurance_salary = update_int("default_insurance_salary", v, 0, &mut e).map(Some),
        }
        if let Some(v) = &self.review_cycle_months {
            p.review_cycle_months = update_i32("review_cycle_months", v, 1, &mut e);
        }
        match &self.is_active {
            None => {}
            Some(Value::Bool(b)) => p.is_active = Some(*b),
            Some(_) => e.push("is_active must be a boolean value".to_owned()),
        }
        if let Some(v) = &self.sort_order {
            p.sort_order = update_i32("sort_order", v, 0, &mut e);
        }
        finish(e)?;
        Ok(p)
    }

    fn is_empty(&self) -> bool {
        self.category.is_none()
            && self.name.is_none()
            && self.symbol.is_none()
            && self.base_salary.is_none()
            && self.standard_target.is_none()
            && self.default_insurance_salary.is_none()
            && self.review_cycle_months.is_none()
            && self.is_active.is_none()
            && self.sort_order.is_none()
    }
}

/// `GET /job-titles?category=&is_active=`: `sort_order`, rồi `id`.
pub async fn find_all(conn: &mut PgConnection, query: &QueryJobTitles) -> Result<Vec<JobTitleRow>, AppError> {
    let rows = sqlx::query_as!(
        JobTitle,
        r#"SELECT id, category, rank_code, name, symbol, base_salary AS "base_salary: JsBigInt", standard_target AS "standard_target: JsBigInt",
                  default_insurance_salary AS "default_insurance_salary: JsBigInt",
                  review_cycle_months, is_active, sort_order,
                  created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp"
           FROM job_titles
           WHERE ($1::text IS NULL OR category = $1) AND ($2::bool IS NULL OR is_active = $2)
           ORDER BY sort_order ASC, id ASC"#,
        query.category.as_deref(),
        query.is_active
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// `GET /job-titles/:id`.
pub async fn find_one(conn: &mut PgConnection, id: i32) -> Result<JobTitleRow, AppError> {
    sqlx::query_as!(
        JobTitle,
        r#"SELECT id, category, rank_code, name, symbol, base_salary AS "base_salary: JsBigInt", standard_target AS "standard_target: JsBigInt",
                  default_insurance_salary AS "default_insurance_salary: JsBigInt",
                  review_cycle_months, is_active, sort_order,
                  created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp"
           FROM job_titles WHERE id = $1"#,
        id
    )
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .map(Into::into)
    .ok_or_else(|| HttpError::not_found(format!("Chức danh #{id} không tồn tại")).into())
}

fn rank_taken(rank_code: &str) -> AppError {
    HttpError::conflict(format!("Mã cấp bậc \"{rank_code}\" đã tồn tại")).into()
}

/// `POST /job-titles`: `rank_code` trùng ⇒ 409, cả khi hai request chạy song song. Gọi sau [`CreateJobTitle::validate`].
pub async fn create(conn: &mut PgConnection, input: &CreateJobTitle) -> Result<JobTitleRow, AppError> {
    let taken = sqlx::query_scalar!("SELECT id FROM job_titles WHERE rank_code = $1", input.rank_code)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if taken.is_some() {
        return Err(rank_taken(&input.rank_code));
    }
    let row = sqlx::query_as!(
        JobTitle,
        r#"INSERT INTO job_titles (category, rank_code, name, symbol, base_salary, standard_target,
                                   default_insurance_salary, review_cycle_months, is_active, sort_order, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           RETURNING id, category, rank_code, name, symbol, base_salary AS "base_salary: JsBigInt", standard_target AS "standard_target: JsBigInt",
                  default_insurance_salary AS "default_insurance_salary: JsBigInt",
                     review_cycle_months, is_active, sort_order,
                     created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp""#,
        input.category,
        input.rank_code,
        input.name,
        input.symbol,
        input.base_salary.unwrap_or(0),
        input.standard_target.unwrap_or(0),
        input.default_insurance_salary,
        input.review_cycle_months,
        input.is_active.unwrap_or(true),
        input.sort_order.unwrap_or(0)
    )
    .fetch_one(conn)
    .await;
    match row {
        Ok(r) => Ok(r.into()),
        Err(e) => {
            if db_error(&e).is(DbErrorKind::UniqueViolation, Some("job_titles_rank_code_key")) {
                Err(rank_taken(&input.rank_code))
            } else {
                Err(db(e))
            }
        }
    }
}

/// `PATCH /job-titles/:id`: 404 nếu không có; không có trường nào ⇒ 400; `rank_code` không đổi được.
/// Gọi sau [`UpdateJobTitle::validate`].
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateJobTitle) -> Result<JobTitleRow, AppError> {
    let parsed = input.parse()?;
    find_one(&mut *conn, id).await?;
    if input.is_empty() {
        return Err(HttpError::bad_request("Không có trường nào cần cập nhật").into());
    }
    let (set_ins, ins) = match parsed.default_insurance_salary {
        Some(v) => (true, v),
        None => (false, None),
    };
    let row = sqlx::query_as!(
        JobTitle,
        r#"UPDATE job_titles SET category = COALESCE($2, category), name = COALESCE($3, name),
                  symbol = COALESCE($4, symbol), base_salary = COALESCE($5, base_salary),
                  standard_target = COALESCE($6, standard_target),
                  default_insurance_salary = CASE WHEN $7 THEN $8 ELSE default_insurance_salary END,
                  review_cycle_months = COALESCE($9, review_cycle_months), is_active = COALESCE($10, is_active),
                  sort_order = COALESCE($11, sort_order), updated_at = now()
           WHERE id = $1
           RETURNING id, category, rank_code, name, symbol, base_salary AS "base_salary: JsBigInt", standard_target AS "standard_target: JsBigInt",
                  default_insurance_salary AS "default_insurance_salary: JsBigInt",
                     review_cycle_months, is_active, sort_order,
                     created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp""#,
        id,
        parsed.category.as_deref(),
        parsed.name.as_deref(),
        parsed.symbol.as_deref(),
        parsed.base_salary,
        parsed.standard_target,
        set_ins,
        ins,
        parsed.review_cycle_months,
        parsed.is_active,
        parsed.sort_order
    )
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    row.map(Into::into)
        .ok_or_else(|| HttpError::not_found(format!("Chức danh #{id} không tồn tại")).into())
}

/// `DELETE /job-titles/:id`: xoá thật (nhân viên đang giữ chức danh này về `job_title_id = NULL` theo khoá ngoại).
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<OkBody, AppError> {
    find_one(&mut *conn, id).await?;
    sqlx::query!("DELETE FROM job_titles WHERE id = $1", id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(r: Result<(), HttpError>) -> Vec<String> {
        match r.unwrap_err().body().message {
            trinity_kernel::error::Message::Many(m) => m,
            other => panic!("{other:?}"),
        }
    }

    fn base() -> CreateJobTitle {
        CreateJobTitle {
            category: "Nhân viên".into(),
            rank_code: "CV".into(),
            name: "Chuyên viên".into(),
            symbol: "CV".into(),
            base_salary: None,
            standard_target: None,
            default_insurance_salary: None,
            review_cycle_months: 3,
            is_active: None,
            sort_order: None,
        }
    }

    #[test]
    fn validate_tao() {
        assert!(base().validate().is_ok());
        let m = msgs(
            CreateJobTitle {
                rank_code: String::new(),
                symbol: "x".repeat(11),
                review_cycle_months: 0,
                base_salary: Some(-1),
                ..base()
            }
            .validate(),
        );
        assert_eq!(
            m,
            [
                "rank_code must be longer than or equal to 1 characters",
                "rank_code should not be empty",
                "symbol must be shorter than or equal to 10 characters",
                "base_salary must not be less than 0",
                "review_cycle_months must not be less than 1",
            ]
        );
    }

    #[test]
    fn tao_nhan_chuoi_so() {
        let c: CreateJobTitle = serde_json::from_str(
            r#"{"category":"a","rank_code":"b","name":"c","symbol":"d","base_salary":"500","review_cycle_months":"3","sort_order":"7"}"#,
        )
        .unwrap();
        assert_eq!(
            (c.base_salary, c.review_cycle_months, c.sort_order),
            (Some(500), 3, Some(7))
        );
    }

    #[test]
    fn sua_phan_biet_vang_mat_va_null() {
        let none: UpdateJobTitle = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(none.default_insurance_salary, None);
        let null: UpdateJobTitle = serde_json::from_str(r#"{"default_insurance_salary":null}"#).unwrap();
        assert!(null.validate().is_ok());
        assert_eq!(null.parse().unwrap().default_insurance_salary, Some(None));
        assert!(!null.is_empty());
        assert!(UpdateJobTitle::default().is_empty());
    }

    #[test]
    fn sua_null_cot_not_null_la_400() {
        let u: UpdateJobTitle = serde_json::from_str(
            r#"{"category":null,"name":null,"symbol":null,"base_salary":null,"standard_target":null,
                "review_cycle_months":null,"is_active":null,"sort_order":null}"#,
        )
        .unwrap();
        let m = msgs(u.validate());
        assert_eq!(
            m,
            [
                "category must be longer than or equal to 1 characters",
                "category must be a string",
                "name must be longer than or equal to 1 characters",
                "name must be a string",
                "symbol must be longer than or equal to 1 characters",
                "symbol must be a string",
                "base_salary must not be less than 0",
                "base_salary must be an integer number",
                "standard_target must not be less than 0",
                "standard_target must be an integer number",
                "review_cycle_months must not be less than 1",
                "review_cycle_months must be an integer number",
                "is_active must be a boolean value",
                "sort_order must not be less than 0",
                "sort_order must be an integer number",
            ]
        );
    }

    #[test]
    fn sua_chuoi_so_va_kieu_sai() {
        let ok: UpdateJobTitle =
            serde_json::from_str(r#"{"base_salary":"5","review_cycle_months":"2","name":"x"}"#).unwrap();
        let p = ok.parse().unwrap();
        assert_eq!((p.base_salary, p.review_cycle_months), (Some(5), Some(2)));
        let bad: UpdateJobTitle =
            serde_json::from_str(r#"{"category":5,"base_salary":1.5,"is_active":"true"}"#).unwrap();
        assert_eq!(
            msgs(bad.validate()),
            [
                "category must be longer than or equal to 1 and shorter than or equal to 100 characters",
                "category must be a string",
                "base_salary must be an integer number",
                "is_active must be a boolean value",
            ]
        );
    }

    #[test]
    fn query_category_length() {
        assert!(QueryJobTitles::default().validate().is_ok());
        let q = QueryJobTitles {
            category: Some(String::new()),
            is_active: None,
        };
        assert_eq!(
            msgs(q.validate()),
            ["category must be longer than or equal to 1 characters"]
        );
    }
}
