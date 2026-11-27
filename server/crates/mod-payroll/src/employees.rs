//! Hồ sơ nhân viên của payroll (4 endpoint `/employees`, KHÁC `/management/employees` của mod-hr). Bản TS:
//! `services/payroll/src/employees`. Xem cần `employees.view` (theo phạm vi `user_id` chủ hồ sơ, `None` = tất cả), ghi cần
//! `employees.manage`. Hàm lấy `&mut PgConnection` đã gắn công ty.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::pg_error::app_error;
use trinity_db::types::{DecimalJs, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::instant::parse_instant_with;
use trinity_kernel::vi::escape_like;

use crate::{finish, is_in, len16, not_null, range, set, some_nullable};

type R<T> = Result<T, AppError>;

/// Vị trí hợp lệ (khớp `EMPLOYEE_POSITIONS`).
pub const POSITIONS: [&str; 7] = [
    "sales",
    "team_lead",
    "operations",
    "marketing",
    "accountant",
    "chief_accountant",
    "hr",
];
/// Trạng thái hợp lệ khi sửa (khớp `EMPLOYEE_STATUSES`).
pub const STATUSES: [&str; 4] = ["active", "on_leave", "probation", "resigned"];
const INT4_MAX: i64 = 2_147_483_647;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn id_range(field: &str, v: i64, out: &mut Vec<String>) {
    range(field, v, Some(1), Some(INT4_MAX), out);
}

fn max_len(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    if len16(v) > max {
        out.push(format!("{field} must be shorter than or equal to {max} characters"));
    }
}

/// `@IsIn(POSITIONS, { message })` kèm `@MaxLength(50)`: MaxLength báo trước.
fn position_errors(v: &str, out: &mut Vec<String>) {
    max_len("position", v, 50, out);
    if !POSITIONS.contains(&v) {
        out.push(format!("position phải là một trong: {}", POSITIONS.join(", ")));
    }
}

/// `@IsDateString`: mọi dạng ISO 8601 mà `new Date()` đọc được (bộ phân tích chung của kernel, không múi giờ = UTC).
fn is_date_string(v: &str) -> bool {
    parse_instant_with(v, 0).is_some()
}

// ---------------------------------------------------------------- DTO

/// Query `GET /employees` (`QueryEmployeeDto`): `team_id` ≥ 1, `position` ≤ 50, `status` ≤ 20, `search` ≤ 100.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryEmployee {
    #[serde(default)]
    pub team_id: Option<i64>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
}

impl QueryEmployee {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(t) = self.team_id {
            id_range("team_id", t, &mut e);
        }
        if let Some(v) = &self.position {
            max_len("position", v, 50, &mut e);
        }
        if let Some(v) = &self.status {
            max_len("status", v, 20, &mut e);
        }
        if let Some(v) = &self.search {
            max_len("search", v, 100, &mut e);
        }
        finish(e)
    }
}

/// Body `POST /employees` (`CreateEmployeeDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateEmployee {
    pub user_id: i64,
    pub position: String,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub team_id: Option<i64>,
    pub salary_rule_id: i64,
    pub joined_at: String,
}

impl CreateEmployee {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        id_range("user_id", self.user_id, &mut e);
        position_errors(&self.position, &mut e);
        if self.position.is_empty() {
            e.push("position should not be empty".to_owned());
        }
        if let Some(d) = &self.department {
            max_len("department", d, 100, &mut e);
        }
        if let Some(t) = self.team_id {
            id_range("team_id", t, &mut e);
        }
        id_range("salary_rule_id", self.salary_rule_id, &mut e);
        if !is_date_string(&self.joined_at) {
            e.push("joined_at must be a valid ISO 8601 date string".to_owned());
        }
        finish(e)
    }
}

/// Body `PATCH /employees/:id` (`UpdateEmployeeDto`): `position`/`status` không nhận `null` (cột NOT NULL ⇒ 400);
/// `department`, `team_id`, `salary_rule_id` nhận `null` (xoá).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateEmployee {
    #[serde(default, deserialize_with = "not_null")]
    pub position: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub department: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub team_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub salary_rule_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "not_null")]
    pub status: Option<String>,
}

impl UpdateEmployee {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(p) = &self.position {
            position_errors(p, &mut e);
        }
        if let Some(Some(d)) = &self.department {
            max_len("department", d, 100, &mut e);
        }
        if let Some(Some(t)) = self.team_id {
            id_range("team_id", t, &mut e);
        }
        if let Some(Some(r)) = self.salary_rule_id {
            id_range("salary_rule_id", r, &mut e);
        }
        if let Some(s) = &self.status {
            is_in("status", s, &STATUSES, &mut e);
        }
        finish(e)
    }
}

// ---------------------------------------------------------------- đọc

#[derive(Debug, sqlx::FromRow)]
struct ListRow {
    id: i32,
    user_id: i32,
    position: String,
    department: Option<String>,
    team_id: Option<i32>,
    salary_rule_id: Option<i32>,
    status: String,
    joined_at: Timestamp,
    created_at: Timestamp,
    full_name: Option<String>,
    email: String,
    phone: Option<String>,
    avatar_url: Option<String>,
}

/// `GET /employees`: theo `id`, lọc `team_id`/`position`/`status`/`search` (tên chứa, không phân biệt hoa thường; ký tự
/// `\ % _` của từ khoá là chữ thường). Như bản TS, KHÔNG loại hồ sơ đã xoá mềm.
pub async fn find_all(conn: &mut PgConnection, q: &QueryEmployee, scope: Option<&[i32]>) -> R<Vec<Value>> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT e.id, e.user_id, e.position, e.department, e.team_id, e.salary_rule_id, e.status, e.joined_at, \
         e.created_at, u.full_name, u.email, u.phone, u.avatar_url \
         FROM employees e JOIN users u ON u.id = e.user_id WHERE TRUE",
    );
    if let Some(ids) = scope {
        qb.push(" AND e.user_id = ANY(").push_bind(ids.to_vec()).push(")");
    }
    if let Some(t) = q.team_id.and_then(|t| i32::try_from(t).ok()) {
        qb.push(" AND e.team_id = ").push_bind(t);
    }
    if let Some(p) = q.position.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.position = ").push_bind(p.to_owned());
    }
    if let Some(s) = q.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.status = ").push_bind(s.to_owned());
    }
    if let Some(s) = q.search.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND u.full_name ILIKE ")
            .push_bind(format!("%{}%", escape_like(s)))
            .push(" ESCAPE '\\'");
    }
    qb.push(" ORDER BY e.id ASC");
    let rows: Vec<ListRow> = qb.build_query_as::<ListRow>().fetch_all(&mut *conn).await.map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id,
                "user_id": r.user_id,
                "position": r.position,
                "department": r.department,
                "team_id": r.team_id,
                "salary_rule_id": r.salary_rule_id,
                "status": r.status,
                "joined_at": r.joined_at,
                "created_at": r.created_at,
                "user": { "full_name": r.full_name, "email": r.email, "phone": r.phone, "avatar_url": r.avatar_url },
            })
        })
        .collect())
}

#[derive(Debug, sqlx::FromRow)]
struct DetailRow {
    id: i32,
    user_id: i32,
    position: String,
    department: Option<String>,
    team_id: Option<i32>,
    salary_rule_id: Option<i32>,
    status: String,
    joined_at: Timestamp,
    created_at: Timestamp,
    full_name: Option<String>,
    email: String,
    phone: Option<String>,
    avatar_url: Option<String>,
    user_team_id: Option<i32>,
    user_team_name: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct KpiRow {
    month: String,
    metric_name: String,
    actual_value: DecimalJs,
    target_value: DecimalJs,
    achievement_rate: Option<DecimalJs>,
}

/// `GET /employees/:id`: hồ sơ + lịch sử lương (12 tháng gần nhất) + KPI tháng hiện tại (giờ VN). Ngoài phạm vi ⇒ 404.
pub async fn find_by_id(conn: &mut PgConnection, id: i32, scope: Option<&[i32]>) -> R<Value> {
    let nf = || AppError::from(HttpError::not_found(format!("Nhân viên #{id} không tồn tại")));
    let row: DetailRow = sqlx::query_as::<_, DetailRow>(
        "SELECT e.id, e.user_id, e.position, e.department, e.team_id, e.salary_rule_id, e.status, e.joined_at, \
         e.created_at, u.full_name, u.email, u.phone, u.avatar_url, t.id AS user_team_id, t.name AS user_team_name \
         FROM employees e JOIN users u ON u.id = e.user_id LEFT JOIN teams t ON t.id = u.team_id WHERE e.id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(nf)?;
    if scope.is_some_and(|ids| !ids.contains(&row.user_id)) {
        return Err(HttpError::not_found("Không tìm thấy").into());
    }
    let history: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT month, total, status FROM payslips WHERE employee_id = $1 ORDER BY month DESC, id ASC LIMIT 12",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let current: String = sqlx::query_scalar("SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')")
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let kpis: Vec<KpiRow> = sqlx::query_as::<_, KpiRow>(
        "SELECT month, metric_name, actual_value, target_value, achievement_rate FROM kpi_results \
         WHERE employee_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut metrics = Map::new();
    for k in kpis.into_iter().filter(|k| k.month == current) {
        metrics.insert(
            k.metric_name,
            json!({ "actual": k.actual_value, "target": k.target_value, "rate": k.achievement_rate }),
        );
    }
    let team = match (row.user_team_id, &row.user_team_name) {
        (Some(tid), name) => json!({ "id": tid, "name": name }),
        _ => Value::Null,
    };
    Ok(json!({
        "id": row.id,
        "user_id": row.user_id,
        "full_name": row.full_name,
        "email": row.email,
        "phone": row.phone,
        "avatar_url": row.avatar_url,
        "position": row.position,
        "department": row.department,
        "team_id": row.team_id,
        "team": team,
        "salary_rule_id": row.salary_rule_id,
        "status": row.status,
        "joined_at": row.joined_at,
        "created_at": row.created_at,
        "salary_history": history
            .into_iter()
            .map(|(m, t, s)| json!({ "month": m, "total": t.to_string(), "status": s }))
            .collect::<Vec<_>>(),
        "kpi_summary": { "current_month": current, "metrics": metrics },
    }))
}

// ---------------------------------------------------------------- ghi

/// Hồ sơ như `select` của `create`/`update`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Brief {
    pub id: i32,
    pub user_id: i32,
    pub position: String,
    pub department: Option<String>,
    pub team_id: Option<i32>,
    pub salary_rule_id: Option<i32>,
    pub status: String,
    pub joined_at: Timestamp,
    pub created_at: Timestamp,
}

const BRIEF: &str = "id, user_id, position, department, team_id, salary_rule_id, status, joined_at, created_at";

/// `POST /employees`: user đã có hồ sơ ⇒ 409.
pub async fn create(conn: &mut PgConnection, input: &CreateEmployee) -> R<Brief> {
    let user_id = i32::try_from(input.user_id).map_err(|_| HttpError::bad_request("user_id không hợp lệ"))?;
    let taken: Option<i32> = sqlx::query_scalar("SELECT id FROM employees WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if taken.is_some() {
        return Err(HttpError::conflict(format!("User #{user_id} đã có hồ sơ nhân viên")).into());
    }
    let joined = parse_instant_with(&input.joined_at, 0)
        .ok_or_else(|| HttpError::bad_request("joined_at must be a valid ISO 8601 date string"))?;
    let team = input.team_id.and_then(|t| i32::try_from(t).ok());
    let rule =
        i32::try_from(input.salary_rule_id).map_err(|_| HttpError::bad_request("salary_rule_id không hợp lệ"))?;
    sqlx::query_as::<_, Brief>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO employees (user_id, position, department, team_id, salary_rule_id, joined_at) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING {BRIEF}"
    )))
    .bind(user_id)
    .bind(&input.position)
    .bind(&input.department)
    .bind(team)
    .bind(rule)
    .bind(Timestamp(joined))
    .fetch_one(&mut *conn)
    .await
    .map_err(db)
}

/// Đóng/mở giai đoạn làm việc khi đổi trạng thái (`recordEmploymentStatusChange`): vào `resigned` ⇒ đóng giai đoạn mở,
/// rời `resigned` ⇒ mở giai đoạn mới. Phải gọi TRƯỚC khi ghi `employees.status` (cần trạng thái cũ để dựng dòng đầu).
async fn record_status_change(conn: &mut PgConnection, id: i32, from: &str, to: &str) -> R<()> {
    let ending = to == "resigned" && from != "resigned";
    let starting = from == "resigned" && to != "resigned";
    if !ending && !starting {
        return Ok(());
    }
    sqlx::query("SELECT 1 FROM employees WHERE id = $1 FOR UPDATE")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    sqlx::query(
        "INSERT INTO employment_periods (employee_id, started_on, ended_on) \
         SELECT e.id, NULL, CASE WHEN e.status = 'resigned' THEN (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END \
         FROM employees e WHERE e.id = $1 AND NOT (e.status = 'resigned' AND e.resigned_at IS NULL) \
         AND NOT EXISTS (SELECT 1 FROM employment_periods p WHERE p.employee_id = e.id)",
    )
    .bind(id)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    if ending {
        sqlx::query(
            "UPDATE employment_periods SET ended_on = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date \
             WHERE employee_id = $1 AND ended_on IS NULL",
        )
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    } else {
        sqlx::query(
            "INSERT INTO employment_periods (employee_id, started_on) \
             SELECT $1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date \
             WHERE NOT EXISTS (SELECT 1 FROM employment_periods p WHERE p.employee_id = $1 AND p.ended_on IS NULL)",
        )
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    }
    Ok(())
}

/// `PATCH /employees/:id`: không có ⇒ 404. Đổi `status` giữ bất biến `status = 'resigned'` ⇔ `resigned_at` có giá trị và
/// đóng/mở giai đoạn làm việc.
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateEmployee) -> R<Brief> {
    let current: Option<String> = sqlx::query_scalar("SELECT status FROM employees WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some(current) = current else {
        return Err(HttpError::not_found(format!("Nhân viên #{id} không tồn tại")).into());
    };
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE employees SET id = id");
    if let Some(p) = &input.position {
        set(&mut qb, "position", p.clone());
    }
    if let Some(d) = &input.department {
        set(&mut qb, "department", d.clone());
    }
    if let Some(t) = &input.team_id {
        set(&mut qb, "team_id", t.and_then(|v| i32::try_from(v).ok()));
    }
    if let Some(r) = &input.salary_rule_id {
        set(&mut qb, "salary_rule_id", r.and_then(|v| i32::try_from(v).ok()));
    }
    if let Some(s) = &input.status {
        set(&mut qb, "status", s.clone());
        if *s != current {
            record_status_change(conn, id, &current, s).await?;
            qb.push(if s == "resigned" {
                ", resigned_at = now()"
            } else {
                ", resigned_at = NULL"
            });
        }
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(" RETURNING ").push(BRIEF);
    qb.build_query_as::<Brief>().fetch_one(&mut *conn).await.map_err(db)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(r: Result<(), HttpError>) -> Vec<String> {
        match r {
            Ok(()) => Vec::new(),
            Err(e) => {
                let (_, b) = AppError::Http(e).response(true);
                let v: Value = serde_json::from_str(&serde_json::to_string(&b.message).unwrap()).unwrap();
                match v {
                    Value::Array(a) => a.iter().map(|x| x.as_str().unwrap_or_default().to_owned()).collect(),
                    other => vec![other.as_str().unwrap_or_default().to_owned()],
                }
            }
        }
    }

    fn create(v: Value) -> CreateEmployee {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn tao_ho_so_kiem_nhu_class_validator() {
        let ok = create(json!({"user_id": 1, "position": "sales", "salary_rule_id": 2, "joined_at": "2026-01-15"}));
        assert!(ok.validate().is_ok());
        // Mọi dạng ISO của IsDateString.
        for d in [
            "2026",
            "2026-01",
            "2026-01-15T08:00",
            "2026-01-15 08:00:00+0700",
            "2026-01-15T08:00:00.123Z",
        ] {
            let c = create(json!({"user_id": 1, "position": "hr", "salary_rule_id": 2, "joined_at": d}));
            assert!(c.validate().is_ok(), "{d}");
        }
        let bad = create(json!({
            "user_id": 0, "position": "", "department": "d".repeat(101), "team_id": 3_000_000_000_i64,
            "salary_rule_id": 3_000_000_000_i64, "joined_at": "hôm qua"
        }));
        let m = msgs(bad.validate());
        assert_eq!(
            m,
            [
                "user_id must not be less than 1",
                "position phải là một trong: sales, team_lead, operations, marketing, accountant, chief_accountant, hr",
                "position should not be empty",
                "department must be shorter than or equal to 100 characters",
                "team_id must not be greater than 2147483647",
                "salary_rule_id must not be greater than 2147483647",
                "joined_at must be a valid ISO 8601 date string",
            ]
        );
    }

    #[test]
    fn sua_ho_so_null_cho_cot_bat_buoc_bi_tu_choi() {
        assert!(serde_json::from_value::<UpdateEmployee>(json!({"position": null})).is_err());
        assert!(serde_json::from_value::<UpdateEmployee>(json!({"status": null})).is_err());
        let u: UpdateEmployee =
            serde_json::from_value(json!({"department": null, "team_id": null, "salary_rule_id": 4})).unwrap();
        assert_eq!(
            (u.department, u.team_id, u.salary_rule_id),
            (Some(None), Some(None), Some(Some(4)))
        );
        let bad: UpdateEmployee = serde_json::from_value(json!({"position": "x", "status": "gone"})).unwrap();
        assert_eq!(msgs(bad.validate()).len(), 2);
        assert!(UpdateEmployee::default().validate().is_ok());
    }

    #[test]
    fn query_gioi_han_do_dai() {
        let q = QueryEmployee {
            team_id: Some(0),
            position: Some("p".repeat(51)),
            status: Some("s".repeat(21)),
            search: Some("x".repeat(101)),
        };
        assert_eq!(msgs(q.validate()).len(), 4);
        assert!(QueryEmployee::default().validate().is_ok());
    }
}
