//! Báo cáo doanh thu ngày (`GET /pos/reports/daily`, quyền `pos.report`). Bản TS: `pos-reports.service.ts`.
//! Ngày theo giờ VN (UTC+7) trên `paid_at`, chỉ đơn `paid`. Mọi truy vấn là aggregate ở DB.
//!
//! `by_product.revenue` = Σ thành tiền dòng (TRƯỚC giảm giá cấp đơn); `revenue` toàn đơn là SAU giảm giá.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::finish;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Query `GET /pos/reports/daily` (`DailyReportQueryDto`): `date` dạng `YYYY-MM-DD`; vắng = hôm nay (giờ VN).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DailyQuery {
    #[serde(default)]
    pub date: Option<String>,
}

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

impl DailyQuery {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.date.as_deref().is_some_and(|d| !is_ymd(d)) {
            e.push("date phải dạng YYYY-MM-DD".to_owned());
        }
        finish(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MethodTotal {
    pub method: String,
    pub amount: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProductTotal {
    pub product_id: i32,
    pub product_name: String,
    pub quantity: i64,
    pub revenue: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HourTotal {
    pub hour: i32,
    pub orders: i64,
    pub revenue: i64,
}

/// Thứ tự khoá như bản TS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DailyReport {
    pub date: String,
    pub order_count: i64,
    pub revenue: i64,
    pub subtotal: i64,
    pub discount: i64,
    pub avg_order_value: i64,
    pub by_method: Vec<MethodTotal>,
    pub by_product: Vec<ProductTotal>,
    pub by_hour: Vec<HourTotal>,
    pub by_product_truncated: bool,
}

/// Ngày hôm nay theo giờ VN.
pub fn today_vn(now: DateTime<Utc>) -> NaiveDate {
    (now + Duration::hours(7)).date_naive()
}

/// `GET /pos/reports/daily?date=`: ngày không có thật (`2026-02-30`) ⇒ 400.
pub async fn daily(conn: &mut PgConnection, date: Option<&str>, now: DateTime<Utc>) -> Result<DailyReport, AppError> {
    let day = match date {
        Some(d) => NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| HttpError::bad_request("Ngày không hợp lệ"))?,
        None => today_vn(now),
    };
    const RANGE: &str = "paid_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') \
                         AND paid_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')";
    let (order_count, revenue, subtotal, discount): (i64, i64, i64, i64) =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*)::int8, COALESCE(SUM(total), 0)::int8, COALESCE(SUM(subtotal), 0)::int8, \
                COALESCE(SUM(discount_amount), 0)::int8 FROM pos_orders WHERE status = 'paid' AND {RANGE}"
        )))
        .bind(day)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let methods: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT p.method, COALESCE(SUM(p.amount), 0)::int8 FROM pos_payments p JOIN pos_orders o ON o.id = p.order_id \
         WHERE o.status = 'paid' AND {} GROUP BY p.method ORDER BY p.method",
        RANGE.replace("paid_at", "o.paid_at")
    )))
    .bind(day)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let products: Vec<(i32, String, i64, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT i.product_id, i.product_name, COALESCE(SUM(i.quantity), 0)::int8, COALESCE(SUM(i.line_total), 0)::int8 \
         FROM pos_order_items i JOIN pos_orders o ON o.id = i.order_id WHERE o.status = 'paid' AND {} \
         GROUP BY i.product_id, i.product_name ORDER BY 4 DESC, i.product_id ASC, i.product_name ASC LIMIT 50",
        RANGE.replace("paid_at", "o.paid_at")
    )))
    .bind(day)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let hours: Vec<(i32, i64, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT EXTRACT(HOUR FROM paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int4, COUNT(*)::int8, \
                COALESCE(SUM(total), 0)::int8 FROM pos_orders WHERE status = 'paid' AND {RANGE} GROUP BY 1 ORDER BY 1"
    )))
    .bind(day)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    let truncated = products.len() == 50;
    Ok(DailyReport {
        date: day.format("%Y-%m-%d").to_string(),
        order_count,
        revenue,
        subtotal,
        discount,
        avg_order_value: if order_count > 0 {
            revenue.div_euclid(order_count)
        } else {
            0
        },
        by_method: methods
            .into_iter()
            .map(|(method, amount)| MethodTotal { method, amount })
            .collect(),
        by_product: products
            .into_iter()
            .map(|(product_id, product_name, quantity, revenue)| ProductTotal {
                product_id,
                product_name,
                quantity,
                revenue,
            })
            .collect(),
        by_hour: hours
            .into_iter()
            .map(|(hour, orders, revenue)| HourTotal { hour, orders, revenue })
            .collect(),
        by_product_truncated: truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ngay_hom_nay_theo_gio_vn() {
        let t = DateTime::parse_from_rfc3339("2026-03-05T18:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(today_vn(t).to_string(), "2026-03-06");
        let t = DateTime::parse_from_rfc3339("2026-03-05T16:59:59Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(today_vn(t).to_string(), "2026-03-05");
    }

    #[test]
    fn kiem_dinh_dang_ngay() {
        assert!(
            DailyQuery {
                date: Some("2026-03-05".into())
            }
            .validate()
            .is_ok()
        );
        assert!(
            DailyQuery {
                date: Some("2026-3-5".into())
            }
            .validate()
            .is_err()
        );
        assert!(DailyQuery::default().validate().is_ok());
    }
}
