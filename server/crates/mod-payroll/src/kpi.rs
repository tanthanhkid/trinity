//! KPI (5 endpoint `/kpi`). Bản TS: `kpi.controller.ts`, `kpi.service.ts`, `kpi-aggregator.service.ts`.
//!
//! - Cấu hình (`GET/POST /kpi/configs`), tính cả tháng (`POST /kpi/calculate`) và chốt tháng (`POST /kpi/close-month`)
//!   đòi `payroll.manage`.
//! - `GET /kpi` ("KPI của tôi") chỉ cần đăng nhập và chỉ trả KPI của CHÍNH hồ sơ nhân viên của người gọi; hồ sơ của người
//!   khác ⇒ 404 (không cho quản lý xem cấp dưới qua route này).
//! - Chưa có nguồn số liệu dựng sẵn: [`KpiAggregator`] trả giá trị thực tế theo tên chỉ số (chữ thường); chỉ số thiếu tính
//!   là 0. Chưa cấu hình nguồn thì `POST /kpi/calculate` trả 501, vì bản Node (nguồn rỗng) ghi đè mọi chỉ số bằng 0.

use std::collections::HashMap;

use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_db::types::DecimalJs;
use trinity_kernel::error::{AppError, HttpError};

use trinity_kernel::number::js_round;

use crate::{dec, finish, frange, is_month, range};

const ROLES: [&str; 4] = ["sales", "team_lead", "marketing", "operations"];
const MONTH_MSG: &str = "month phai dung format YYYY-MM";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Body `POST /kpi/configs` (`CreateKpiConfigDto`): `role` `sales|team_lead|marketing|operations`, `target` ≥ 0, `weight`
/// 0..100, `working_days_per_month` 1..31 (mặc định 24).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateConfig {
    pub role: String,
    pub metric_name: String,
    pub target: f64,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub working_days_per_month: Option<i32>,
}

impl CreateConfig {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !ROLES.contains(&self.role.as_str()) {
            e.push("role phải là sales, team_lead, marketing hoặc operations".to_owned());
        }
        frange("target", self.target, Some(0.0), None, &mut e);
        if let Some(w) = self.weight {
            frange("weight", w, Some(0.0), Some(100.0), &mut e);
        }
        if let Some(d) = self.working_days_per_month {
            range("working_days_per_month", d.into(), Some(1), Some(31), &mut e);
        }
        finish(e)
    }
}

/// Query `GET /kpi/configs` (`QueryKpiConfigDto`): lọc theo `role`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConfigQuery {
    #[serde(default)]
    pub role: Option<String>,
}

impl ConfigQuery {
    pub fn validate(&self) -> Result<(), HttpError> {
        Ok(())
    }
}

/// Body `POST /kpi/calculate` và `POST /kpi/close-month` (`CalculateKpiDto`): `month` `YYYY-MM`, `employee_ids` mỗi phần tử ≥ 1.
#[derive(Debug, Clone, Deserialize)]
pub struct CalculateInput {
    pub month: String,
    #[serde(default)]
    pub employee_ids: Option<Vec<i64>>,
}

impl CalculateInput {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        for id in self.employee_ids.iter().flatten() {
            range("each value in employee_ids", *id, Some(1), None, &mut e);
        }
        finish(e)
    }
}

/// Query `GET /kpi` (`QueryKpiDto`): `employee_id` ≥ 1, `month` `YYYY-MM`, `team_id` ≥ 1 (không dùng).
#[derive(Debug, Clone, Deserialize)]
pub struct KpiQuery {
    pub employee_id: i64,
    pub month: String,
    #[serde(default)]
    pub team_id: Option<i64>,
}

impl KpiQuery {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        range("employee_id", self.employee_id, Some(1), None, &mut e);
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        if let Some(t) = self.team_id {
            range("team_id", t, Some(1), None, &mut e);
        }
        finish(e)
    }
}

/// Cấu hình KPI như `getConfigs`/`createConfig` trả: `target`, `weight` là chuỗi `Decimal`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ConfigView {
    pub id: i32,
    pub role: String,
    pub metric_name: String,
    pub target: DecimalJs,
    pub unit: Option<String>,
    pub weight: Option<DecimalJs>,
    pub working_days_per_month: i32,
}

/// `GET /kpi/configs?role=`: theo `role`, `id`, tối đa 100.
pub async fn get_configs(conn: &mut PgConnection, role: Option<&str>) -> Result<Vec<ConfigView>, AppError> {
    sqlx::query_as::<_, ConfigView>(
        "SELECT id, role, metric_name, target, unit, weight, working_days_per_month \
         FROM kpi_configs WHERE ($1::text IS NULL OR role = $1) ORDER BY role ASC, id ASC LIMIT 100",
    )
    .bind(role.filter(|r| !r.is_empty()))
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /kpi/configs`: đã có cùng (`role`, `metric_name`) ⇒ 409.
pub async fn create_config(conn: &mut PgConnection, input: &CreateConfig) -> Result<ConfigView, AppError> {
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT id FROM kpi_configs WHERE role = $1 AND metric_name = $2 LIMIT 1")
            .bind(&input.role)
            .bind(&input.metric_name)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    if exists.is_some() {
        return Err(HttpError::conflict(format!(
            "KPI config cho role \"{}\" voi metric \"{}\" da ton tai",
            input.role, input.metric_name
        ))
        .into());
    }
    sqlx::query_as::<_, ConfigView>(
        "INSERT INTO kpi_configs (role, metric_name, target, unit, weight, working_days_per_month) \
         VALUES ($1, $2, $3::text::numeric, $4, $5::text::numeric, COALESCE($6, 24)) \
         RETURNING id, role, metric_name, target, unit, weight, working_days_per_month",
    )
    .bind(&input.role)
    .bind(&input.metric_name)
    .bind(dec(input.target))
    .bind(&input.unit)
    .bind(input.weight.map(dec))
    .bind(input.working_days_per_month)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// Số liệu thực tế của một nhân viên trong tháng, khoá là tên chỉ số viết thường.
pub type AggregatedKpiData = HashMap<String, f64>;

/// Nguồn số liệu KPI. Chưa có nguồn dựng sẵn: khi chưa có, [`calculate`] trả 501 thay vì ghi đè mọi chỉ số bằng 0.
pub trait KpiAggregator {
    fn aggregate_for_employee(&self, user_id: i32, month: &str) -> AggregatedKpiData;
}

/// Chỉ số theo ngày (`tasks/day`, `x_per_day`) nhân với số ngày làm việc; còn lại dùng thẳng.
pub fn resolve_target(metric_name: &str, target: f64, working_days: i32) -> f64 {
    let m = metric_name.to_lowercase();
    if m.contains("/day") || m.contains("per_day") {
        target * f64::from(working_days)
    } else {
        target
    }
}

/// `Math.round(actual / target * 10000) / 100`; mục tiêu ≤ 0 ⇒ 0.
pub fn achievement_rate(actual: f64, target: f64) -> f64 {
    if target > 0.0 {
        js_round(actual / target * 10000.0) / 100.0
    } else {
        0.0
    }
}

/// `POST /kpi/calculate` ⇒ `{ processed }`: chưa có nguồn số liệu ⇒ 501 (không ghi gì); tháng đã chốt ⇒ 400; duyệt mọi nhân viên đang hoạt động (hoặc theo
/// `employee_ids`) theo lô 100, ghi/cập nhật `kpi_results` (không đụng dòng đã khoá).
pub async fn calculate(
    conn: &mut PgConnection,
    month: &str,
    employee_ids: Option<&[i64]>,
    source: Option<&dyn KpiAggregator>,
) -> Result<serde_json::Value, AppError> {
    let Some(source) = source else {
        return Err(HttpError::new(
            501,
            "Chưa có nguồn số liệu KPI nên chưa tính được; cấu hình nguồn rồi thử lại",
        )
        .into());
    };
    let locked: Option<i32> = sqlx::query_scalar("SELECT id FROM kpi_results WHERE month = $1 AND is_locked LIMIT 1")
        .bind(month)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if locked.is_some() {
        return Err(HttpError::bad_request(format!("KPI thang {month} da duoc chot, khong the tinh lai")).into());
    }
    let ids = employee_ids.filter(|i| !i.is_empty());
    let (mut processed, mut cursor) = (0_i64, 0_i32);
    loop {
        let batch: Vec<(i32, Option<i32>, Option<String>)> = sqlx::query_as(
            "SELECT id, user_id, position FROM employees WHERE status = 'active' AND deleted_at IS NULL AND id > $1 \
             AND ($2::int8[] IS NULL OR id = ANY($2)) ORDER BY id ASC LIMIT 100",
        )
        .bind(cursor)
        .bind(ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        let Some(last) = batch.last().map(|b| b.0) else { break };
        for (id, user_id, position) in &batch {
            // Dòng thiếu `user_id` hoặc `position` (dữ liệu hỏng) thì bỏ qua, không làm hỏng cả lượt tính.
            let (Some(user_id), Some(position)) = (user_id, position) else {
                continue;
            };
            calculate_for_employee(&mut *conn, *id, *user_id, position, month, source).await?;
            processed += 1;
        }
        if batch.len() < 100 {
            break;
        }
        cursor = last;
    }
    Ok(serde_json::json!({ "processed": processed }))
}

async fn calculate_for_employee(
    conn: &mut PgConnection,
    employee_id: i32,
    user_id: i32,
    position: &str,
    month: &str,
    source: &dyn KpiAggregator,
) -> Result<(), AppError> {
    let configs: Vec<(String, f64, i32)> = sqlx::query_as(
        "SELECT metric_name, target::float8, working_days_per_month FROM kpi_configs WHERE role = $1 ORDER BY id ASC LIMIT 100",
    )
    .bind(position)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    if configs.is_empty() {
        return Ok(());
    }
    let data = source.aggregate_for_employee(user_id, month);
    for (metric, target, days) in configs {
        let actual = data.get(&metric.to_lowercase()).copied().unwrap_or(0.0);
        let target_value = resolve_target(&metric, target, days);
        let rate = achievement_rate(actual, target_value);
        sqlx::query(
            "INSERT INTO kpi_results (employee_id, month, metric_name, actual_value, target_value, achievement_rate, achieved, is_locked, created_at) \
             VALUES ($1, $2, $3, $4::text::numeric, $5::text::numeric, $6::text::numeric, $7, false, NOW()) \
             ON CONFLICT (employee_id, month, metric_name) DO UPDATE SET actual_value = EXCLUDED.actual_value, \
             target_value = EXCLUDED.target_value, achievement_rate = EXCLUDED.achievement_rate, achieved = EXCLUDED.achieved \
             WHERE kpi_results.is_locked = false",
        )
        .bind(employee_id)
        .bind(month)
        .bind(&metric)
        .bind(dec(actual))
        .bind(dec(target_value))
        .bind(dec(rate))
        .bind(rate >= 100.0)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    }
    Ok(())
}

/// `POST /kpi/close-month` ⇒ `{ closed: true, locked_count }`: không có dữ liệu ⇒ 404; đã chốt ⇒ 409.
pub async fn close_month(conn: &mut PgConnection, month: &str) -> Result<serde_json::Value, AppError> {
    let any: Option<i32> = sqlx::query_scalar("SELECT id FROM kpi_results WHERE month = $1 LIMIT 1")
        .bind(month)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if any.is_none() {
        return Err(HttpError::not_found(format!("Khong co du lieu KPI cho thang {month} de chot")).into());
    }
    let locked: Option<i32> = sqlx::query_scalar("SELECT id FROM kpi_results WHERE month = $1 AND is_locked LIMIT 1")
        .bind(month)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if locked.is_some() {
        return Err(HttpError::conflict(format!("KPI thang {month} da duoc chot truoc do")).into());
    }
    let res = sqlx::query("UPDATE kpi_results SET is_locked = true WHERE month = $1 AND NOT is_locked")
        .bind(month)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(serde_json::json!({ "closed": true, "locked_count": res.rows_affected() }))
}

/// Chỉ số của một nhân viên trong tháng.
#[derive(Debug, Clone, Serialize)]
pub struct MetricView {
    pub actual: DecimalJs,
    pub target: DecimalJs,
    pub rate: Option<DecimalJs>,
    pub achieved: bool,
}

/// Bản đồ `tên chỉ số → số liệu` giữ thứ tự chèn (serde_json không bật `preserve_order`).
#[derive(Debug, Clone)]
pub struct Metrics(pub Vec<(String, MetricView)>);

impl Serialize for Metrics {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

/// `GET /kpi`: thứ tự khoá như bản TS.
#[derive(Debug, Clone, Serialize)]
pub struct KpiView {
    pub employee_id: i32,
    pub month: String,
    pub metrics: Metrics,
    pub achievement_rate: f64,
    pub status: &'static str,
    pub is_locked: bool,
}

/// `on_track` từ 80, `exceeded` từ 100, còn lại `behind`.
pub fn determine_status(rate: f64) -> &'static str {
    if rate >= 100.0 {
        "exceeded"
    } else if rate >= 80.0 {
        "on_track"
    } else {
        "behind"
    }
}

/// `GET /kpi`: nhân viên phải là hồ sơ CỦA CHÍNH người gọi (`user_id`), không thì 404 "Không tìm thấy".
pub async fn get_mine(
    conn: &mut PgConnection,
    user_id: i32,
    employee_id: i32,
    month: &str,
) -> Result<KpiView, AppError> {
    let owner: Option<i32> = sqlx::query_scalar("SELECT user_id FROM employees WHERE id = $1")
        .bind(employee_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if owner != Some(user_id) {
        return Err(HttpError::not_found("Không tìm thấy").into());
    }
    get_by_employee(conn, employee_id, month).await
}

/// Kết quả KPI của nhân viên trong tháng: không có nhân viên hoặc không có dữ liệu ⇒ 404.
pub async fn get_by_employee(conn: &mut PgConnection, employee_id: i32, month: &str) -> Result<KpiView, AppError> {
    let emp: Option<i32> = sqlx::query_scalar("SELECT id FROM employees WHERE id = $1")
        .bind(employee_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if emp.is_none() {
        return Err(HttpError::not_found(format!("Nhan vien #{employee_id} khong ton tai")).into());
    }
    // (tên, thực tế, mục tiêu, tỷ lệ, đạt, khoá)
    let rows: Vec<(String, DecimalJs, DecimalJs, Option<DecimalJs>, bool, bool)> = sqlx::query_as(
        "SELECT metric_name, actual_value, target_value, achievement_rate, achieved, is_locked \
         FROM kpi_results WHERE employee_id = $1 AND month = $2 ORDER BY id ASC LIMIT 100",
    )
    .bind(employee_id)
    .bind(month)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    if rows.is_empty() {
        return Err(HttpError::not_found(format!(
            "Khong co du lieu KPI cho nhan vien #{employee_id} thang {month}"
        ))
        .into());
    }
    let rates: Vec<f64> = rows
        .iter()
        .map(|r| r.3.and_then(|d| d.0.to_f64()).unwrap_or(0.0))
        .collect();
    let overall = js_round(rates.iter().sum::<f64>() / rates.len() as f64 * 100.0) / 100.0;
    let is_locked = rows.iter().all(|r| r.5);
    // `metrics[tên] = …`: trùng tên thì ghi đè giá trị nhưng giữ vị trí đầu tiên, như object JS.
    let mut metrics: Vec<(String, MetricView)> = Vec::new();
    for (name, actual, target, rate, achieved, _) in rows {
        let v = MetricView {
            actual,
            target,
            rate,
            achieved,
        };
        match metrics.iter_mut().find(|m| m.0 == name) {
            Some(slot) => slot.1 = v,
            None => metrics.push((name, v)),
        }
    }
    Ok(KpiView {
        employee_id,
        month: month.to_owned(),
        metrics: Metrics(metrics),
        achievement_rate: overall,
        status: determine_status(overall),
        is_locked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiem_luat_dto_kpi() {
        let ok = CreateConfig {
            role: "sales".into(),
            metric_name: "tasks/day".into(),
            target: 5.0,
            unit: None,
            weight: Some(25.0),
            working_days_per_month: Some(24),
        };
        assert!(ok.validate().is_ok());
        for bad in [
            CreateConfig {
                role: "ceo".into(),
                ..ok.clone()
            },
            CreateConfig {
                target: -1.0,
                ..ok.clone()
            },
            CreateConfig {
                weight: Some(100.5),
                ..ok.clone()
            },
            CreateConfig {
                working_days_per_month: Some(32),
                ..ok.clone()
            },
            CreateConfig {
                working_days_per_month: Some(0),
                ..ok.clone()
            },
        ] {
            assert_eq!(bad.validate().unwrap_err().status(), 400);
        }
        assert!(
            CalculateInput {
                month: "2026-13".into(),
                employee_ids: None
            }
            .validate()
            .is_err()
        );
        assert!(
            CalculateInput {
                month: "2026-03".into(),
                employee_ids: Some(vec![1, 0])
            }
            .validate()
            .is_err()
        );
        assert!(
            KpiQuery {
                employee_id: 0,
                month: "2026-03".into(),
                team_id: None
            }
            .validate()
            .is_err()
        );
        assert!(
            KpiQuery {
                employee_id: 3,
                month: "2026-03".into(),
                team_id: Some(1)
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn tinh_ty_le_va_trang_thai() {
        assert_eq!(resolve_target("Tasks/Day", 5.0, 24), 120.0);
        assert_eq!(resolve_target("calls_per_day", 2.0, 20), 40.0);
        assert_eq!(resolve_target("revenue", 1000.0, 24), 1000.0);
        assert_eq!(achievement_rate(60.0, 120.0), 50.0);
        assert_eq!(achievement_rate(1.0, 3.0), 33.33);
        assert_eq!(achievement_rate(5.0, 0.0), 0.0);
        assert_eq!(
            (
                determine_status(100.0),
                determine_status(99.99),
                determine_status(80.0),
                determine_status(79.99)
            ),
            ("exceeded", "on_track", "on_track", "behind")
        );
    }

    fn dd(n: i64) -> DecimalJs {
        DecimalJs(rust_decimal::Decimal::from(n))
    }

    #[test]
    fn metrics_giu_thu_tu() {
        let m = Metrics(vec![
            (
                "z".into(),
                MetricView {
                    actual: dd(1),
                    target: dd(2),
                    rate: None,
                    achieved: false,
                },
            ),
            (
                "a".into(),
                MetricView {
                    actual: dd(3),
                    target: dd(4),
                    rate: Some(dd(75)),
                    achieved: true,
                },
            ),
        ]);
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.find("\"z\"").unwrap() < s.find("\"a\"").unwrap());
    }
}
