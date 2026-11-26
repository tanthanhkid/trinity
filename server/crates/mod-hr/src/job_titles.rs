//! Chức danh (M09): 5 endpoint `/api/v1/management/job-titles`. Bản TS: `job-titles.service.ts`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use trinity_db::models::JobTitle;
use trinity_db::pg_error::db_error;
use trinity_db::types::{JsBigInt, Timestamp};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::nullable::some_nullable;
use crate::{OK, Ok, db, len16};

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

/// Body `POST /job-titles`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateJobTitle {
    pub category: String,
    pub rank_code: String,
    pub name: String,
    pub symbol: String,
    #[serde(default)]
    pub base_salary: Option<i64>,
    #[serde(default)]
    pub standard_target: Option<i64>,
    #[serde(default)]
    pub default_insurance_salary: Option<i64>,
    pub review_cycle_months: i32,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// Body `PATCH /job-titles/:id`. `default_insurance_salary`: không gửi = giữ nguyên, `null` = xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateJobTitle {
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub base_salary: Option<i64>,
    #[serde(default)]
    pub standard_target: Option<i64>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub default_insurance_salary: Option<Option<i64>>,
    #[serde(default)]
    pub review_cycle_months: Option<i32>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

/// `@Length(1, max)`: class-validator báo một câu khi ngoài khoảng.
fn length(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    let n = len16(v);
    if n < 1 || n > max {
        out.push(format!(
            "{field} must be longer than or equal to 1 and shorter than or equal to {max} characters"
        ));
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

impl CreateJobTitle {
    /// Luật của `CreateJobTitleDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        length("category", &self.category, 100, &mut e);
        length("rank_code", &self.rank_code, 20, &mut e);
        length("name", &self.name, 100, &mut e);
        length("symbol", &self.symbol, 10, &mut e);
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
    /// Luật của `UpdateJobTitleDto` (trường vắng thì bỏ qua).
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(v) = &self.category {
            length("category", v, 100, &mut e);
        }
        if let Some(v) = &self.name {
            length("name", v, 100, &mut e);
        }
        if let Some(v) = &self.symbol {
            length("symbol", v, 10, &mut e);
        }
        if let Some(v) = self.base_salary {
            min("base_salary", v, 0, &mut e);
        }
        if let Some(v) = self.standard_target {
            min("standard_target", v, 0, &mut e);
        }
        if let Some(Some(v)) = self.default_insurance_salary {
            min("default_insurance_salary", v, 0, &mut e);
        }
        if let Some(v) = self.review_cycle_months {
            min("review_cycle_months", i64::from(v), 1, &mut e);
        }
        if let Some(v) = self.sort_order {
            min("sort_order", i64::from(v), 0, &mut e);
        }
        finish(e)
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
            if db_error(&e).is(DbErrorKind::UniqueViolation, None) {
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
    find_one(&mut *conn, id).await?;
    if input.is_empty() {
        return Err(HttpError::bad_request("Không có trường nào cần cập nhật").into());
    }
    let (set_ins, ins) = match input.default_insurance_salary {
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
        input.category.as_deref(),
        input.name.as_deref(),
        input.symbol.as_deref(),
        input.base_salary,
        input.standard_target,
        set_ins,
        ins,
        input.review_cycle_months,
        input.is_active,
        input.sort_order
    )
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    row.map(Into::into)
        .ok_or_else(|| HttpError::not_found(format!("Chức danh #{id} không tồn tại")).into())
}

/// `DELETE /job-titles/:id`: xoá thật (nhân viên đang giữ chức danh này về `job_title_id = NULL` theo khoá ngoại).
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<Ok, AppError> {
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
        assert_eq!(m.len(), 4, "{m:?}");
    }

    #[test]
    fn sua_phan_biet_vang_mat_va_null() {
        let none: UpdateJobTitle = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(none.default_insurance_salary, None);
        let null: UpdateJobTitle = serde_json::from_str(r#"{"default_insurance_salary":null}"#).unwrap();
        assert_eq!(null.default_insurance_salary, Some(None));
        assert!(!null.is_empty());
        assert!(UpdateJobTitle::default().is_empty());
    }
}
