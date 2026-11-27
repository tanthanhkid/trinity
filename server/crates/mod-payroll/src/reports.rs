//! Báo cáo chi phí lương toàn công ty (M31, 3 route của `ReportsController`): tổng theo tháng, theo phòng ban và so sánh nhiều
//! tháng. Chỉ phiếu chưa loại khỏi kỳ (`deleted_at IS NULL`); không lọc theo nhân viên. Quyền `payroll.manage` (danh mục
//! quyền chưa có quyền báo cáo lương riêng). Tiền là chuỗi số nguyên VND như `bigint.toString()` của bản TS.
//!
//! Câu thông báo lỗi giữ nguyên bản TS của `query-report.dto.ts` (không dấu, khác `payslips`).

use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::{finish, is_month};

type R<T> = Result<T, AppError>;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

const MONTH_MSG: &str = "month phai co dinh dang YYYY-MM";
const MONTHS_MSG: &str = "months phai la danh sach YYYY-MM phan cach bang dau phay (toi da 24 thang)";
const MONTHS_MAX: usize = 24;

/// Query `GET /reports/summary` và `GET /reports/by-department` (`QuerySummaryDto`): `month` `YYYY-MM`.
#[derive(Debug, Clone, Deserialize)]
pub struct QuerySummary {
    pub month: String,
}

impl QuerySummary {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        finish(e)
    }
}

/// Query `GET /reports/comparison` (`QueryComparisonDto`): `months` = `YYYY-MM` cách nhau dấu phẩy (khoảng trắng sau dấu phẩy
/// được), tối đa 24 tháng: `^\d{4}-(0[1-9]|1[0-2])(,\s*\d{4}-(0[1-9]|1[0-2])){0,23}$`.
#[derive(Debug, Clone, Deserialize)]
pub struct QueryComparison {
    pub months: String,
}

/// `\s` của JS (khoảng trắng Unicode, kể cả BOM `U+FEFF`).
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

impl QueryComparison {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut parts = self.months.split(',');
        let first_ok = parts.next().is_some_and(is_month);
        let rest: Vec<&str> = parts.collect();
        let rest_ok = rest.len() < MONTHS_MAX && rest.iter().all(|p| is_month(p.trim_start_matches(is_js_space)));
        let mut e = Vec::new();
        if !(first_ok && rest_ok) {
            e.push(MONTHS_MSG.to_owned());
        }
        finish(e)
    }

    /// `months.split(',').map(trim).filter(Boolean)` (sau `validate()` mọi phần tử đều là tháng).
    pub fn list(&self) -> Vec<String> {
        self.months
            .split(',')
            .map(|m| m.trim_matches(is_js_space))
            .filter(|m| !m.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

/// Kết quả `GET /reports/summary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub month: String,
    pub total_employees: i64,
    pub total_base_salary: String,
    pub total_kpi_bonus: String,
    pub total_deductions: String,
    pub total_payroll_cost: String,
}

/// Một phòng ban của `GET /reports/by-department`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DepartmentBreakdown {
    pub department: String,
    pub employee_count: i64,
    pub total_base_salary: String,
    pub total_kpi_bonus: String,
    pub total_deductions: String,
    pub total_cost: String,
}

/// Một tháng của `GET /reports/comparison`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MonthComparison {
    pub month: String,
    pub total_payroll_cost: String,
    pub employee_count: i64,
}

/// `GET /reports/summary?month=`: số phiếu và tổng lương cơ bản, thưởng KPI, giảm trừ, chi phí lương của kỳ.
pub async fn summary(conn: &mut PgConnection, month: &str) -> R<Summary> {
    let (n, base, kpi, ded, total): (i64, String, String, String, String) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(base_salary), 0)::text, COALESCE(SUM(kpi_bonus), 0)::text, \
         COALESCE(SUM(deductions), 0)::text, COALESCE(SUM(total), 0)::text \
         FROM payslips WHERE month = $1 AND deleted_at IS NULL",
    )
    .bind(month)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    Ok(Summary {
        month: month.to_owned(),
        total_employees: n,
        total_base_salary: base,
        total_kpi_bonus: kpi,
        total_deductions: ded,
        total_payroll_cost: total,
    })
}

type DeptRow = (String, i64, String, String, String, String);

/// `GET /reports/by-department?month=`: gom theo phòng ban của nhân viên (chưa gán ⇒ "Khác"), xếp theo phiếu đầu tiên của từng
/// phòng như thứ tự chèn của `Map` bản TS.
pub async fn by_department(conn: &mut PgConnection, month: &str) -> R<Vec<DepartmentBreakdown>> {
    let rows: Vec<DeptRow> = sqlx::query_as(
        "SELECT COALESCE(e.department, 'Khác') AS department, COUNT(*), SUM(p.base_salary)::text, \
         SUM(p.kpi_bonus)::text, SUM(p.deductions)::text, SUM(p.total)::text \
         FROM payslips p JOIN employees e ON e.id = p.employee_id \
         WHERE p.month = $1 AND p.deleted_at IS NULL \
         GROUP BY COALESCE(e.department, 'Khác') ORDER BY MIN(p.id) ASC",
    )
    .bind(month)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|(department, n, base, kpi, ded, cost)| DepartmentBreakdown {
            department,
            employee_count: n,
            total_base_salary: base,
            total_kpi_bonus: kpi,
            total_deductions: ded,
            total_cost: cost,
        })
        .collect())
}

/// `GET /reports/comparison?months=`: mỗi tháng yêu cầu một dòng (đúng thứ tự, tháng trùng lặp lại, tháng không có phiếu ⇒ 0).
pub async fn comparison(conn: &mut PgConnection, months: &[String]) -> R<Vec<MonthComparison>> {
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT month, COUNT(*), COALESCE(SUM(total), 0)::text FROM payslips \
         WHERE deleted_at IS NULL AND month = ANY($1) GROUP BY month",
    )
    .bind(months.to_vec())
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(months
        .iter()
        .map(|m| {
            let found = rows.iter().find(|(k, _, _)| k == m);
            MonthComparison {
                month: m.clone(),
                total_payroll_cost: found.map_or_else(|| "0".to_owned(), |(_, _, t)| t.clone()),
                employee_count: found.map_or(0, |(_, n, _)| *n),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comparison_ok(s: &str) -> bool {
        QueryComparison { months: s.to_owned() }.validate().is_ok()
    }

    #[test]
    fn thang_bao_cao_kiem_nhu_class_validator() {
        assert!(
            QuerySummary {
                month: "2026-03".into()
            }
            .validate()
            .is_ok()
        );
        for bad in ["2026-13", "2026-3", "", " 2026-03", "2026-03 "] {
            let err = QuerySummary { month: bad.into() }.validate().unwrap_err();
            // trinity-lint: allow-json-value (thông báo lỗi/giá trị so sánh trong test, không phải model hay cột DB)
            let msg = serde_json::to_value(err.body().message).unwrap();
            assert_eq!(msg, serde_json::json!([MONTH_MSG]), "{bad:?}");
        }
    }

    #[test]
    fn danh_sach_thang_toi_da_24() {
        assert!(comparison_ok("2026-01"));
        assert!(comparison_ok("2026-01,2026-02,2026-03"));
        assert!(comparison_ok("2026-01, 2026-02,\t2026-03"));
        assert!(!comparison_ok(""));
        assert!(!comparison_ok("2026-01,"));
        assert!(
            !comparison_ok("2026-01 ,2026-02"),
            "khoảng trắng chỉ được đứng sau dấu phẩy"
        );
        assert!(!comparison_ok("2026-13"));
        assert!(!comparison_ok("2026-01;2026-02"));
        let ok24: Vec<String> = (0..24).map(|i| format!("20{:02}-0{}", 10 + i, 1 + i % 9)).collect();
        assert!(comparison_ok(&ok24.join(",")));
        let over: Vec<String> = (0..25).map(|i| format!("20{:02}-0{}", 10 + i, 1 + i % 9)).collect();
        assert!(!comparison_ok(&over.join(",")));
    }

    #[test]
    fn tach_danh_sach_thang() {
        let q = QueryComparison {
            months: "2026-01, 2026-02,2026-02".into(),
        };
        assert_eq!(q.list(), ["2026-01", "2026-02", "2026-02"]);
    }
}
