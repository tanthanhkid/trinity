//! Thống kê chấm công (M14a phần 3): `GET /management/attendance/stats`, `/stats/filters`, `/stats/discipline`,
//! `/stats/leave-analytics`, `/stats/weekly`, `/stats/monthly`, `/stats/weekly-hours`. Bản TS: `AttendanceService`
//! (`getAttendanceStats`, `getStatsFilterOptions`, `getDisciplineStats`, `getLeaveAnalytics`, `getWeeklyStats`,
//! `getMonthlyStats`, `getWeeklyHoursChart`).
//!
//! - Bốn route đầu cần `attendance.view`; phạm vi lấy từ `ScopeService` TRƯỚC khi lấy kết nối (không giữ hai kết nối). Phạm vi
//!   `all` không giới hạn, còn lại giới hạn theo `employees.user_id`. Ba route cuối chỉ cần đăng nhập; "xem toàn công ty" là
//!   phạm vi `all` của `attendance.view`.
//! - Ngày là ngày lịch Việt Nam; `work_date` là cột `date`. Khoảng mặc định là từ mùng 1 tháng hiện tại tới hôm nay.
//! - Roster "đang trong biên chế" tại một mốc theo `employedOnSql` (giai đoạn làm việc hoặc luật cũ `status`/`resigned_at`).
//! - Số liệu tính lại từ giờ chấm (không tin `total_hours`/`status` lưu DB), làm tròn như `Math.round` của JS.
//! - Khác bản TS có chủ đích: ngày/tháng sai dạng hoặc id ngoài int4 trả 400 (bản TS lỗi 500 hoặc tràn số).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Days, NaiveDate, Utc, Weekday};
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::types::{DbDate, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::{Collation, compare};
use trinity_kernel::vn_time::{vn_clock_minutes, vn_date};
use trinity_rbac::{OwnerIds, Scope, push_scope, scope_of};

use crate::check::{calc_status, hm_minutes, late_minutes, total_hours};
use crate::config::{self, ShiftConfig};
use crate::{R, db, js_num};

/// Dấu "Chưa có team" trong `team_id[]` (id team luôn dương).
const NO_TEAM_SENTINEL: i32 = -1;
const NO_DEPARTMENT: &str = "Chưa phân phòng";

/// Team CHÍNH THỨC (3 tầng) — `RESOLVED_TEAM_ID_SQL`; cần alias `e` (employees) và `u` (users).
const RESOLVED_TEAM_ID: &str = "COALESCE(e.team_id,
    (SELECT tl.id FROM teams tl WHERE tl.team_lead_id = u.id ORDER BY tl.id LIMIT 1),
    (SELECT tm.id FROM teams tm WHERE tm.team_lead_id = u.manager_id ORDER BY tm.id LIMIT 1))";

/// Mốc ngày hiện tại giờ VN (`NOW_VN_DATE_SQL`).
const NOW_VN_DATE: &str = "(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";

/// Cột bản ghi chấm công cần để tính lại giờ/trạng thái.
const REC_COLS: &str = "user_id, work_date, check_in_at, check_out_at, total_hours, status";

/// Query `GET /stats*` (`QueryAttendanceStatsDto`): `department` là CSV/mảng chuỗi, `team_id`/`office_id` là CSV/mảng số
/// (đã qua `@Transform`; số nguyên ngoài int4 bị từ chối ở [`Filter::new`]).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryAttendanceStatsDto {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub department: Option<Vec<String>>,
    #[serde(default)]
    pub team_id: Option<Vec<f64>>,
    #[serde(default)]
    pub office_id: Option<Vec<f64>>,
}

impl trinity_http::validate::Dto for QueryAttendanceStatsDto {
    const NAME: &'static str = "QueryAttendanceStatsDto";
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::Http(HttpError::bad_request(msg.into()))
}

// ───────────────────────────── số JS ─────────────────────────────

/// `Math.round`: làm tròn nửa lên.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Math.round(x * 1000) / 10`: phần trăm một chữ số thập phân.
fn round1(x: f64) -> f64 {
    js_round(x * 1000.0) / 10.0
}

/// `Math.round(x * 100) / 100`.
fn round2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}

fn num<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    js_num(*v).serialize(s)
}

fn num_opt<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => js_num(*x).serialize(s),
        None => s.serialize_none(),
    }
}

/// `Number(s)` cho chuỗi số nguyên không dấu (rỗng ⇒ 0); dạng khác ⇒ `None` (NaN).
fn js_number(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0);
    }
    if t.bytes().all(|b| b.is_ascii_digit()) {
        t.parse::<i64>().ok()
    } else {
        None
    }
}

/// `parseInt(s, 10)`: bỏ khoảng trắng đầu, dấu tuỳ chọn, lấy dãy chữ số đầu; không có ⇒ `None` (NaN). Quá i64 ⇒ giá trị lớn nhất.
fn js_parse_int(s: &str) -> Option<i64> {
    let t = trinity_kernel::vi::trim_js(s);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let v = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if neg { -v } else { v })
}

// ───────────────────────────── bộ lọc và SQL dùng chung ─────────────────────────────

struct Range {
    from_str: String,
    to_str: String,
    from: NaiveDate,
    to: NaiveDate,
}

fn parse_day(s: &str) -> R<NaiveDate> {
    s.get(..10)
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .ok_or_else(|| bad("Ngày không hợp lệ"))
}

impl Range {
    /// `resolveStatsRange`: mặc định từ mùng 1 tháng hiện tại (giờ VN) tới hôm nay.
    fn of(q: &QueryAttendanceStatsDto) -> R<Self> {
        let today = vn_date(Utc::now());
        let from_str = q
            .date_from
            .clone()
            .unwrap_or_else(|| format!("{:04}-{:02}-01", today.year(), today.month()));
        let to_str = q.date_to.clone().unwrap_or_else(|| today.to_string());
        let from = parse_day(&from_str)?;
        let to = parse_day(&to_str)?;
        Ok(Self {
            from_str,
            to_str,
            from,
            to,
        })
    }
}

/// Bộ dựng câu lệnh bắt đầu bằng `sql` (phần cố định, đã ghép sẵn; giá trị người dùng luôn đi qua `push_bind`).
fn builder(sql: &str) -> QueryBuilder<Postgres> {
    let mut qb = QueryBuilder::<Postgres>::new("");
    qb.push(sql);
    qb
}

/// Ngày thành literal SQL (`NaiveDate` luôn dạng `YYYY-MM-DD`, không chứa ký tự lạ).
fn lit(d: NaiveDate) -> String {
    format!("'{d}'::date")
}

/// `employedOnSql(ref)`: NV đang trong biên chế tại mốc `r` (cột SQL cố định hoặc literal ngày), alias `e`.
fn employed(r: &str) -> String {
    format!(
        "(CASE WHEN EXISTS (SELECT 1 FROM employment_periods ep0 WHERE ep0.employee_id = e.id)
    THEN e.status IN ('active', 'resigned') AND EXISTS (
      SELECT 1 FROM employment_periods ep WHERE ep.employee_id = e.id
        AND (ep.started_on IS NULL OR ep.started_on <= {r})
        AND (ep.ended_on IS NULL OR {r} < ep.ended_on))
    ELSE (e.status = 'active' OR (e.status = 'resigned' AND e.resigned_at IS NOT NULL AND (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > {r}))
  END)"
    )
}

/// Phạm vi + bộ lọc Phòng ban/Team/Văn phòng của thống kê.
struct Filter {
    owner: OwnerIds,
    departments: Vec<String>,
    teams: Vec<i32>,
    offices: Vec<i32>,
}

fn ids_of(v: Option<&[f64]>, name: &str) -> R<Vec<i32>> {
    v.into_iter()
        .flatten()
        .map(|n| {
            if n.fract() == 0.0 && *n >= f64::from(i32::MIN) && *n <= f64::from(i32::MAX) {
                Ok(*n as i32)
            } else {
                Err(bad(format!("{name} không hợp lệ")))
            }
        })
        .collect()
}

impl Filter {
    fn new(owner: OwnerIds, q: &QueryAttendanceStatsDto) -> R<Self> {
        Ok(Self {
            owner,
            departments: q.department.clone().unwrap_or_default(),
            teams: ids_of(q.team_id.as_deref(), "team_id")?,
            offices: ids_of(q.office_id.as_deref(), "office_id")?,
        })
    }

    fn has_filter(&self) -> bool {
        !self.departments.is_empty() || !self.teams.is_empty() || !self.offices.is_empty()
    }

    /// Có giới hạn phạm vi (quản lý) hoặc có bộ lọc ⇒ đi đường roster.
    fn scoped(&self) -> bool {
        matches!(self.owner, OwnerIds::Ids(_)) || self.has_filter()
    }

    /// `buildStatsEmpFilter`: ` AND <phạm vi> AND <phòng ban> AND <team> AND <văn phòng>` (alias `e`, `u`).
    fn push(&self, qb: &mut QueryBuilder<Postgres>) {
        qb.push(" AND ");
        push_scope(qb, &self.owner, &["e.user_id"]);
        if !self.departments.is_empty() {
            qb.push(format!(
                " AND COALESCE(NULLIF(TRIM(e.department), ''), '{NO_DEPARTMENT}') = ANY("
            ));
            qb.push_bind(self.departments.clone());
            qb.push(")");
        }
        if !self.teams.is_empty() {
            let real: Vec<i32> = self.teams.iter().copied().filter(|t| *t != NO_TEAM_SENTINEL).collect();
            let has_real = !real.is_empty();
            qb.push(" AND (");
            if has_real {
                qb.push(format!("{RESOLVED_TEAM_ID} = ANY("));
                qb.push_bind(real);
                qb.push(")");
            }
            if self.teams.contains(&NO_TEAM_SENTINEL) {
                if has_real {
                    qb.push(" OR ");
                }
                qb.push(format!("{RESOLVED_TEAM_ID} IS NULL"));
            }
            qb.push(")");
        }
        if !self.offices.is_empty() {
            qb.push(" AND e.office_id = ANY(");
            qb.push_bind(self.offices.clone());
            qb.push(")");
        }
    }
}

/// Phạm vi `attendance.view` (lấy trước khi lấy kết nối); không có phạm vi ⇒ rỗng (đóng).
async fn view_scope(ctx: &Ctx, actor: &Actor) -> R<OwnerIds> {
    Ok(ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "attendance.view")
        .await
        .map_err(AppError::internal)?
        .unwrap_or(OwnerIds::Ids(Vec::new())))
}

/// `isAttendanceFullView`: phạm vi `all` của `attendance.view`.
fn full_view(actor: &Actor) -> bool {
    scope_of(&actor.grants, "attendance.view") == Some(Scope::All)
}

// ───────────────────────────── bản ghi chấm công và tính lại ─────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
struct Rec {
    user_id: i32,
    work_date: DbDate,
    check_in_at: Option<Timestamp>,
    check_out_at: Option<Timestamp>,
    total_hours: Option<f64>,
    status: String,
}

impl Rec {
    fn on_leave(&self) -> bool {
        self.status == "leave" || self.status == "maternity"
    }

    /// `displayTotalHours`: nghỉ phép/thai sản giữ giờ lưu DB, còn lại tính lại từ giờ chấm (trừ nghỉ trưa).
    fn hours(&self, cfg: &ShiftConfig) -> Option<f64> {
        if self.on_leave() {
            return self.total_hours;
        }
        match (self.check_in_at, self.check_out_at) {
            (Some(i), Some(o)) => total_hours(i.0, o.0, cfg),
            _ => None,
        }
    }

    /// `displayStatus`: nghỉ phép/thai sản giữ nguyên; thiếu vào/ra ⇒ `incomplete`; còn lại theo giờ làm.
    fn display_status(&self, cfg: &ShiftConfig) -> String {
        if self.on_leave() {
            return self.status.clone();
        }
        match (self.check_in_at, self.check_out_at) {
            (Some(i), Some(o)) => calc_status(total_hours(i.0, o.0, cfg).unwrap_or(0.0), cfg).to_owned(),
            _ => "incomplete".to_owned(),
        }
    }

    /// `calcLateMinutes(check_in_at, lateAfter)`.
    fn late(&self, late_after: i64) -> i32 {
        self.check_in_at.map_or(0, |i| late_minutes(i.0, late_after))
    }
}

/// Bản ghi trong khoảng ngày, của các user cho trước (`None` = mọi user), theo ngày rồi user.
async fn load_records(conn: &mut PgConnection, users: Option<Vec<i32>>, from: NaiveDate, to: NaiveDate) -> R<Vec<Rec>> {
    let mut qb = builder(&format!(
        "SELECT {REC_COLS} FROM attendance_records WHERE work_date >= "
    ));
    qb.push_bind(from);
    qb.push(" AND work_date <= ");
    qb.push_bind(to);
    if let Some(ids) = users {
        qb.push(" AND user_id = ANY(");
        qb.push_bind(ids);
        qb.push(")");
    }
    qb.push(" ORDER BY work_date ASC, user_id ASC");
    let query = qb.build_query_as::<Rec>();
    query.fetch_all(&mut *conn).await.map_err(db)
}

// ───────────────────────────── GET /stats ─────────────────────────────

#[derive(Debug, sqlx::FromRow)]
struct DailyRow {
    day: String,
    checked_in: i32,
    checked_out: i32,
    complete: i32,
    late: i32,
    on_time: i32,
    late_minutes: i32,
}

#[derive(Debug, sqlx::FromRow)]
struct GroupRaw {
    id: Option<i32>,
    label: String,
    headcount: i32,
    checked_in_people: i32,
    present_people: i32,
    late_people: i32,
    total_late_minutes: i32,
}

/// Số liệu nhóm kèm Chưa đủ công / Vắng / Tỷ lệ (`deriveGroupStat`).
#[derive(Debug, Serialize)]
pub struct Counts {
    headcount: i32,
    checked_in_people: i32,
    present_people: i32,
    late_people: i32,
    total_late_minutes: i32,
    insufficient_people: i32,
    absent_people: i32,
    #[serde(serialize_with = "num")]
    attendance_rate: f64,
}

fn derive_counts(r: &GroupRaw) -> Counts {
    let rate = if r.headcount > 0 {
        round1(f64::from(r.checked_in_people) / f64::from(r.headcount))
    } else {
        0.0
    };
    Counts {
        headcount: r.headcount,
        checked_in_people: r.checked_in_people,
        present_people: r.present_people,
        late_people: r.late_people,
        total_late_minutes: r.total_late_minutes,
        insufficient_people: (r.checked_in_people - r.present_people).max(0),
        absent_people: (r.headcount - r.checked_in_people).max(0),
        attendance_rate: rate,
    }
}

#[derive(Debug, Serialize)]
pub struct TeamStat {
    team_id: Option<i32>,
    team_name: String,
    #[serde(flatten)]
    counts: Counts,
}

#[derive(Debug, Serialize)]
pub struct DepartmentStat {
    department: String,
    #[serde(flatten)]
    counts: Counts,
    head_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Leaver {
    user_id: i32,
    full_name: Option<String>,
    count: i64,
    minutes: i64,
}

#[derive(Debug, Serialize)]
pub struct EarlyLeave {
    total: i64,
    approved: i64,
    rejected: i64,
    pending: i64,
    total_minutes: i64,
    #[serde(serialize_with = "num")]
    approval_rate: f64,
    top_leavers: Vec<Leaver>,
}

#[derive(Debug, Default, Serialize)]
pub struct Summary {
    checked_in: i64,
    checked_out: i64,
    complete: i64,
    on_time: i64,
    late: i64,
    total_late_minutes: i64,
}

#[derive(Debug, Serialize)]
pub struct DailyOut {
    date: String,
    checked_in: i32,
    on_time: i32,
    late: i32,
}

#[derive(Debug, Serialize)]
pub struct StatsOut {
    date_from: String,
    date_to: String,
    total_employees: i64,
    distinct_checked_in: i64,
    not_checked_in: i64,
    summary: Summary,
    daily: Vec<DailyOut>,
    by_team: Vec<TeamStat>,
    by_department: Vec<DepartmentStat>,
    early_leave: EarlyLeave,
}

const FILTER_COUNTS: &str = "COUNT(DISTINCT e.user_id)::int AS headcount,
        COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL)::int AS checked_in_people,
        COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NOT NULL)::int AS present_people,
        COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) > 0)::int AS late_people,
        COALESCE(SUM(ar.late_minutes) FILTER (WHERE ar.check_in_at IS NOT NULL), 0)::int AS total_late_minutes";

/// Chuỗi theo ngày + tổng hợp, theo roster đã scope (`use_roster`) hoặc toàn bộ bản ghi (đường cũ, giữ nguyên số liệu).
async fn daily_rows(conn: &mut PgConnection, range: &Range, f: &Filter, use_roster: bool) -> R<Vec<DailyRow>> {
    let (from, to) = (lit(range.from), lit(range.to));
    let mut qb = QueryBuilder::<Postgres>::new("");
    if use_roster {
        qb.push(format!(
            "SELECT to_char(ar.work_date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL)::int AS checked_in,
            COUNT(*) FILTER (WHERE ar.check_out_at IS NOT NULL)::int AS checked_out,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NOT NULL)::int AS complete,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) > 0)::int AS late,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) = 0)::int AS on_time,
            COALESCE(SUM(ar.late_minutes) FILTER (WHERE ar.check_in_at IS NOT NULL), 0)::int AS late_minutes
          FROM attendance_records ar
          JOIN employees e ON e.user_id = ar.user_id AND e.deleted_at IS NULL AND {}
          JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
          WHERE ar.work_date >= {from} AND ar.work_date <= {to}",
            employed("ar.work_date")
        ));
        f.push(&mut qb);
        qb.push(" GROUP BY ar.work_date ORDER BY ar.work_date ASC");
    } else {
        qb.push(format!(
            "SELECT to_char(work_date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL)::int AS checked_in,
            COUNT(*) FILTER (WHERE check_out_at IS NOT NULL)::int AS checked_out,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND check_out_at IS NOT NULL)::int AS complete,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND COALESCE(late_minutes, 0) > 0)::int AS late,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND COALESCE(late_minutes, 0) = 0)::int AS on_time,
            COALESCE(SUM(late_minutes) FILTER (WHERE check_in_at IS NOT NULL), 0)::int AS late_minutes
          FROM attendance_records
          WHERE work_date >= {from} AND work_date <= {to}
          GROUP BY work_date ORDER BY work_date ASC"
        ));
    }
    let query = qb.build_query_as::<DailyRow>();
    query.fetch_all(&mut *conn).await.map_err(db)
}

async fn total_employees(conn: &mut PgConnection, range: &Range, f: &Filter, use_roster: bool) -> R<i64> {
    if !use_roster {
        return sqlx::query_scalar("SELECT count(*) FROM users WHERE deleted_at IS NULL AND status = 'active'")
            .fetch_one(&mut *conn)
            .await
            .map_err(db);
    }
    let mut qb = builder(&format!(
        "SELECT COUNT(*)::int FROM employees e
         JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
         WHERE e.deleted_at IS NULL AND {}",
        employed(&lit(range.from))
    ));
    f.push(&mut qb);
    let query = qb.build_query_scalar::<i32>();
    let n = query.fetch_one(&mut *conn).await.map_err(db)?;
    Ok(i64::from(n))
}

async fn distinct_checked_in(conn: &mut PgConnection, range: &Range, f: &Filter, use_roster: bool) -> R<i64> {
    let (from, to) = (lit(range.from), lit(range.to));
    let mut qb = QueryBuilder::<Postgres>::new("");
    if use_roster {
        qb.push(format!(
            "SELECT COUNT(DISTINCT ar.user_id)::int
          FROM attendance_records ar
          JOIN employees e ON e.user_id = ar.user_id AND e.deleted_at IS NULL AND {}
          JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
          WHERE ar.work_date >= {from} AND ar.work_date <= {to}
            AND ar.check_in_at IS NOT NULL",
            employed("ar.work_date")
        ));
        f.push(&mut qb);
    } else {
        qb.push(format!(
            "SELECT COUNT(DISTINCT user_id)::int
          FROM attendance_records
          WHERE work_date >= {from} AND work_date <= {to}
            AND check_in_at IS NOT NULL"
        ));
    }
    let query = qb.build_query_scalar::<i32>();
    let n = query.fetch_one(&mut *conn).await.map_err(db)?;
    Ok(i64::from(n))
}

/// `getStatsByTeam`: roster-based, đếm theo NGƯỜI distinct.
async fn stats_by_team(conn: &mut PgConnection, range: &Range, f: &Filter) -> R<Vec<TeamStat>> {
    let (from, to) = (lit(range.from), lit(range.to));
    let mut qb = builder(&format!(
        "SELECT
        resolved.team_id::int AS id,
        COALESCE(t.name, 'Chưa có team') AS label,
        {FILTER_COUNTS}
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      CROSS JOIN LATERAL (SELECT {RESOLVED_TEAM_ID} AS team_id) resolved
      LEFT JOIN teams t ON t.id = resolved.team_id
      LEFT JOIN attendance_records ar ON ar.user_id = e.user_id
        AND ar.work_date >= {from} AND ar.work_date <= {to}
      WHERE e.deleted_at IS NULL AND {}",
        employed(&from)
    ));
    f.push(&mut qb);
    qb.push(" GROUP BY resolved.team_id, COALESCE(t.name, 'Chưa có team') ORDER BY headcount DESC, label ASC");
    let query = qb.build_query_as::<GroupRaw>();
    let rows = query.fetch_all(&mut *conn).await.map_err(db)?;
    Ok(rows
        .iter()
        .map(|r| TeamStat {
            team_id: r.id,
            team_name: r.label.clone(),
            counts: derive_counts(r),
        })
        .collect())
}

/// `getStatsByDepartment`: kèm Trưởng phòng (NV có chức danh chứa "trưởng", ưu tiên "trưởng phòng").
async fn stats_by_department(conn: &mut PgConnection, range: &Range, f: &Filter) -> R<Vec<DepartmentStat>> {
    let (from, to) = (lit(range.from), lit(range.to));
    let mut qb = builder(&format!(
        "SELECT
          NULL::int AS id,
          COALESCE(NULLIF(TRIM(e.department), ''), '{NO_DEPARTMENT}') AS label,
          {FILTER_COUNTS}
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
        LEFT JOIN attendance_records ar ON ar.user_id = e.user_id
          AND ar.work_date >= {from} AND ar.work_date <= {to}
        WHERE e.deleted_at IS NULL AND {}",
        employed(&from)
    ));
    f.push(&mut qb);
    qb.push(format!(
        " GROUP BY COALESCE(NULLIF(TRIM(e.department), ''), '{NO_DEPARTMENT}') ORDER BY headcount DESC, label ASC"
    ));
    let query = qb.build_query_as::<GroupRaw>();
    let rows = query.fetch_all(&mut *conn).await.map_err(db)?;

    let mut hq = builder(&format!(
        "SELECT
          COALESCE(NULLIF(TRIM(e.department), ''), '{NO_DEPARTMENT}') AS department,
          u.full_name AS head_name
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
        WHERE e.deleted_at IS NULL AND {}
          AND e.position ILIKE '%trưởng%'",
        employed(&from)
    ));
    f.push(&mut hq);
    hq.push(" ORDER BY CASE WHEN e.position ILIKE '%trưởng phòng%' THEN 1 ELSE 2 END ASC, u.full_name ASC");
    let hquery = hq.build_query_as::<(String, Option<String>)>();
    let heads = hquery.fetch_all(&mut *conn).await.map_err(db)?;
    let mut head_map: HashMap<String, String> = HashMap::new();
    for (department, name) in heads {
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            head_map.entry(department).or_insert(n);
        }
    }
    Ok(rows
        .iter()
        .map(|r| DepartmentStat {
            department: r.label.clone(),
            counts: derive_counts(r),
            head_name: head_map.get(&r.label).cloned(),
        })
        .collect())
}

fn empty_early() -> EarlyLeave {
    EarlyLeave {
        total: 0,
        approved: 0,
        rejected: 0,
        pending: 0,
        total_minutes: 0,
        approval_rate: 0.0,
        top_leavers: Vec::new(),
    }
}

/// `getEarlyLeaveStats`: đơn về sớm, phút thiếu so với đủ công và top NV về sớm.
async fn early_leave_stats(conn: &mut PgConnection, range: &Range, f: &Filter) -> R<EarlyLeave> {
    let mut allowed: Option<Vec<i32>> = None;
    if f.scoped() {
        let mut qb = builder(&format!(
            "SELECT e.user_id::int FROM employees e
             JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
             WHERE e.deleted_at IS NULL AND {}",
            employed(&lit(range.from))
        ));
        f.push(&mut qb);
        let query = qb.build_query_scalar::<i32>();
        let ids = query.fetch_all(&mut *conn).await.map_err(db)?;
        if ids.is_empty() {
            return Ok(empty_early());
        }
        allowed = Some(ids);
    }

    let mut rq = QueryBuilder::<Postgres>::new(
        "SELECT user_id, work_date, status FROM attendance_requests WHERE type = 'early_leave' AND work_date >= ",
    );
    rq.push_bind(range.from);
    rq.push(" AND work_date <= ");
    rq.push_bind(range.to);
    if let Some(ids) = allowed {
        rq.push(" AND user_id = ANY(");
        rq.push_bind(ids);
        rq.push(")");
    }
    rq.push(" ORDER BY id ASC");
    let rquery = rq.build_query_as::<(i32, DbDate, String)>();
    let reqs = rquery.fetch_all(&mut *conn).await.map_err(db)?;
    if reqs.is_empty() {
        return Ok(empty_early());
    }

    let (mut approved, mut rejected, mut pending) = (0_i64, 0_i64, 0_i64);
    let mut order: Vec<i32> = Vec::new();
    let mut by_user: HashMap<i32, (i64, i64)> = HashMap::new();
    for (user_id, _, status) in &reqs {
        match status.as_str() {
            "approved" => approved += 1,
            "rejected" => rejected += 1,
            _ => pending += 1,
        }
        if !by_user.contains_key(user_id) {
            order.push(*user_id);
        }
        by_user.entry(*user_id).or_insert((0, 0)).0 += 1;
    }

    // Phút thiếu: bản ghi khớp (user, ngày) của đơn, so với đủ công.
    let cfg = config::get_shift(conn).await?;
    let full_day_minutes = cfg.full_day_min_hours * 60.0;
    let req_keys: HashSet<(i32, NaiveDate)> = reqs.iter().map(|(u, d, _)| (*u, d.0)).collect();
    let records = load_records(conn, Some(order.clone()), range.from, range.to).await?;
    let mut total_minutes = 0_i64;
    for rec in &records {
        if !req_keys.contains(&(rec.user_id, rec.work_date.0)) {
            continue;
        }
        let Some(hours) = rec.hours(&cfg) else { continue };
        let deficit = js_round(full_day_minutes - hours * 60.0) as i64;
        if deficit > 0 {
            total_minutes += deficit;
            if let Some(u) = by_user.get_mut(&rec.user_id) {
                u.1 += deficit;
            }
        }
    }

    let names: Vec<(i32, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, full_name, email FROM users WHERE id = ANY($1)")
            .bind(order.clone())
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let name_map: HashMap<i32, String> = names
        .into_iter()
        .map(|(id, full, email)| (id, full.or(email).unwrap_or_else(|| id.to_string())))
        .collect();
    let mut leavers: Vec<Leaver> = order
        .iter()
        .map(|id| {
            let (count, minutes) = by_user.get(id).copied().unwrap_or((0, 0));
            Leaver {
                user_id: *id,
                full_name: name_map.get(id).cloned(),
                count,
                minutes,
            }
        })
        .collect();
    leavers.sort_by(|a, b| b.count.cmp(&a.count).then(b.minutes.cmp(&a.minutes)));
    leavers.truncate(10);

    let decided = approved + rejected;
    let approval_rate = if decided > 0 {
        round1(approved as f64 / decided as f64)
    } else {
        0.0
    };
    Ok(EarlyLeave {
        total: reqs.len() as i64,
        approved,
        rejected,
        pending,
        total_minutes,
        approval_rate,
        top_leavers: leavers,
    })
}

/// `GET /stats`: thống kê tổng hợp cho popup biểu đồ (phạm vi `attendance.view`).
pub async fn stats(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<StatsOut> {
    let range = Range::of(q)?;
    let f = Filter::new(view_scope(ctx, actor).await?, q)?;
    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;
    let use_roster = f.scoped();

    let total = total_employees(conn, &range, &f, use_roster).await?;
    let daily = daily_rows(conn, &range, &f, use_roster).await?;
    let distinct = distinct_checked_in(conn, &range, &f, use_roster).await?;
    let by_team = stats_by_team(conn, &range, &f).await?;
    let by_department = stats_by_department(conn, &range, &f).await?;
    let early_leave = early_leave_stats(conn, &range, &f).await?;

    let mut summary = Summary::default();
    for d in &daily {
        summary.checked_in += i64::from(d.checked_in);
        summary.checked_out += i64::from(d.checked_out);
        summary.complete += i64::from(d.complete);
        summary.on_time += i64::from(d.on_time);
        summary.late += i64::from(d.late);
        summary.total_late_minutes += i64::from(d.late_minutes);
    }
    Ok(StatsOut {
        date_from: range.from_str,
        date_to: range.to_str,
        total_employees: total,
        distinct_checked_in: distinct,
        not_checked_in: (total - distinct).max(0),
        summary,
        daily: daily
            .into_iter()
            .map(|d| DailyOut {
                date: d.day,
                checked_in: d.checked_in,
                on_time: d.on_time,
                late: d.late,
            })
            .collect(),
        by_team,
        by_department,
        early_leave,
    })
}

// ───────────────────────────── GET /stats/filters ─────────────────────────────

#[derive(Debug, Serialize)]
pub struct IdName {
    id: i32,
    name: String,
}

#[derive(Debug, Serialize)]
pub struct FilterOptions {
    departments: Vec<String>,
    teams: Vec<IdName>,
    offices: Vec<IdName>,
}

/// `GET /stats/filters`: tuỳ chọn Phòng ban / Team / Văn phòng. Phòng ban và Team theo phạm vi của người xem; Văn phòng giữ toàn bộ.
pub async fn filters(ctx: &Ctx, actor: &Actor) -> R<FilterOptions> {
    let owner = view_scope(ctx, actor).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;
    let scoped = matches!(owner, OwnerIds::Ids(_));

    let mut dq = builder(&format!(
        "SELECT DISTINCT COALESCE(NULLIF(TRIM(e.department), ''), '{NO_DEPARTMENT}') AS department
         FROM employees e
         JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
         WHERE e.deleted_at IS NULL AND {} AND ",
        employed(NOW_VN_DATE)
    ));
    push_scope(&mut dq, &owner, &["e.user_id"]);
    dq.push(" ORDER BY department ASC");
    let dquery = dq.build_query_scalar::<String>();
    let departments = dquery.fetch_all(&mut *conn).await.map_err(db)?;

    // Admin (không giới hạn) thấy mọi team kể cả team 0 NV; quản lý chỉ thấy team có NV trong phạm vi.
    let teams: Vec<(i32, String)> = if scoped {
        let mut tq = builder(&format!(
            "SELECT DISTINCT t.id::int AS id, t.name AS name
             FROM employees e
             JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
             JOIN teams t ON t.id = {RESOLVED_TEAM_ID}
             WHERE e.deleted_at IS NULL AND {} AND ",
            employed(NOW_VN_DATE)
        ));
        push_scope(&mut tq, &owner, &["e.user_id"]);
        tq.push(" ORDER BY name ASC");
        let tquery = tq.build_query_as::<(i32, String)>();
        tquery.fetch_all(&mut *conn).await.map_err(db)?
    } else {
        sqlx::query_as("SELECT id::int AS id, name FROM teams ORDER BY name ASC")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };

    let offices: Vec<(i32, String)> =
        sqlx::query_as("SELECT id::int AS id, name FROM attendance_offices WHERE is_active = true ORDER BY name ASC")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;

    let mut team_list: Vec<IdName> = teams.into_iter().map(|(id, name)| IdName { id, name }).collect();
    team_list.push(IdName {
        id: NO_TEAM_SENTINEL,
        name: "Chưa có team".to_owned(),
    });
    Ok(FilterOptions {
        departments,
        teams: team_list,
        offices: offices.into_iter().map(|(id, name)| IdName { id, name }).collect(),
    })
}

// ───────────────────────────── GET /stats/discipline ─────────────────────────────

#[derive(Debug, sqlx::FromRow)]
struct RosterRow {
    user_id: i32,
    full_name: Option<String>,
    employee_code: Option<String>,
    position: Option<String>,
    gender: Option<String>,
    team_name: String,
}

#[derive(Debug, Serialize)]
pub struct AbsentRow {
    user_id: i32,
    full_name: Option<String>,
    employee_code: Option<String>,
    team_name: String,
    position: Option<String>,
    absent_days: i64,
    absent_occurrences: i64,
    #[serde(serialize_with = "num")]
    absent_rate: f64,
}

#[derive(Debug, Serialize)]
pub struct ViolationRow {
    user_id: i32,
    full_name: Option<String>,
    employee_code: Option<String>,
    team_name: String,
    position: Option<String>,
    late_minutes: i64,
    early_minutes: i64,
    violation_minutes: i64,
    late_count: i64,
    early_count: i64,
}

#[derive(Debug, Serialize)]
pub struct GenderStat {
    gender: &'static str,
    gender_label: &'static str,
    headcount: i64,
    total_absent_days: i64,
    total_late_count: i64,
    total_early_count: i64,
    #[serde(serialize_with = "num")]
    full_attendance_rate: f64,
    #[serde(serialize_with = "num")]
    insufficient_rate: f64,
}

#[derive(Debug, Serialize)]
pub struct DisciplineOut {
    date_from: String,
    date_to: String,
    work_end: String,
    total_workdays: i64,
    top_absent: Vec<AbsentRow>,
    top_violation: Vec<ViolationRow>,
    by_gender: Vec<GenderStat>,
}

/// `buildWorkdayList`: T2–T6 và các thứ 7 trong `saturdays`; chủ nhật nghỉ.
fn workdays(from: NaiveDate, to: NaiveDate, saturdays: &HashSet<String>) -> Vec<NaiveDate> {
    from.iter_days()
        .take_while(|d| *d <= to)
        .filter(|d| match d.weekday() {
            Weekday::Sat => saturdays.contains(&d.to_string()),
            Weekday::Sun => false,
            _ => true,
        })
        .collect()
}

/// 0 = Nam, 1 = Nữ, 2 = chưa xác định.
fn gender_idx(g: Option<&str>) -> usize {
    match g {
        Some("M") => 0,
        Some("F") => 1,
        _ => 2,
    }
}

const GENDERS: [(&str, &str); 3] = [("M", "Nam"), ("F", "Nữ"), ("unknown", "Chưa xác định")];

#[derive(Debug, Default, Clone, Copy)]
struct GenderAcc {
    headcount: i64,
    absent: i64,
    late: i64,
    early: i64,
    full: i64,
}

fn name_of(n: &Option<String>) -> &str {
    n.as_deref().unwrap_or("")
}

/// `GET /stats/discipline`: top nghỉ nhiều, top đi muộn/về sớm, so sánh giới tính (tính từ bản ghi + đơn về sớm đã duyệt).
pub async fn discipline(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<DisciplineOut> {
    let range = Range::of(q)?;
    let f = Filter::new(view_scope(ctx, actor).await?, q)?;
    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;

    let cfg = config::get_shift(conn).await?;
    let saturdays: HashSet<String> = config::get_saturdays(conn).await?.into_iter().collect();
    let days = workdays(range.from, range.to, &saturdays);
    let total_workdays = days.len() as i64;

    let mut out = DisciplineOut {
        date_from: range.from_str.clone(),
        date_to: range.to_str.clone(),
        work_end: cfg.work_end.clone(),
        total_workdays,
        top_absent: Vec::new(),
        top_violation: Vec::new(),
        by_gender: Vec::new(),
    };

    let mut qb = builder(&format!(
        "SELECT
        e.user_id::int AS user_id,
        u.full_name AS full_name,
        e.employee_code AS employee_code,
        e.position AS position,
        e.gender AS gender,
        COALESCE(mgr.full_name, 'Chưa có quản lý') AS team_name
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      LEFT JOIN users mgr ON mgr.id = u.manager_id
      WHERE e.deleted_at IS NULL AND {}",
        employed(&lit(range.from))
    ));
    f.push(&mut qb);
    let query = qb.build_query_as::<RosterRow>();
    let roster = query.fetch_all(&mut *conn).await.map_err(db)?;
    if roster.is_empty() {
        return Ok(out);
    }

    let user_ids: Vec<i32> = roster.iter().map(|r| r.user_id).collect();
    let records = load_records(conn, Some(user_ids.clone()), range.from, range.to).await?;
    let approved: Vec<(i32, DbDate)> = sqlx::query_as(
        "SELECT user_id, work_date FROM attendance_requests
         WHERE type = 'early_leave' AND status = 'approved' AND user_id = ANY($1) AND work_date >= $2 AND work_date <= $3",
    )
    .bind(user_ids)
    .bind(range.from)
    .bind(range.to)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;

    let mut rec_by_user: HashMap<i32, HashMap<NaiveDate, &Rec>> = HashMap::new();
    for r in &records {
        rec_by_user.entry(r.user_id).or_default().insert(r.work_date.0, r);
    }
    let approved_early: HashSet<(i32, NaiveDate)> = approved.iter().map(|(u, d)| (*u, d.0)).collect();

    let late_after = hm_minutes(&cfg.late_after);
    let work_end = hm_minutes(&cfg.work_end);
    let no_records: HashMap<NaiveDate, &Rec> = HashMap::new();

    let mut absent_rows: Vec<AbsentRow> = Vec::new();
    let mut violation_rows: Vec<ViolationRow> = Vec::new();
    let mut gender_acc = [GenderAcc::default(); 3];

    for emp in &roster {
        let rec_map = rec_by_user.get(&emp.user_id).unwrap_or(&no_records);
        let mut absent_days = 0_i64;
        let mut occurrences = 0_i64;
        let mut prev_absent = false;
        let mut late_min = 0_i64;
        let mut early_min = 0_i64;
        let mut late_count = 0_i64;
        let mut early_count = 0_i64;
        let mut full_days = 0_i64;

        for d in &days {
            let Some(rec) = rec_map.get(d) else {
                absent_days += 1;
                if !prev_absent {
                    occurrences += 1;
                }
                prev_absent = true;
                continue;
            };
            prev_absent = false;
            // Nghỉ phép/thai sản: giờ vào/ra chỉ là mốc tượng trưng ⇒ không tính trễ/sớm.
            let on_leave = rec.on_leave();
            let lm = if on_leave { 0 } else { i64::from(rec.late(late_after)) };
            if lm > 0 {
                late_min += lm;
                late_count += 1;
            }
            let is_approved_early = approved_early.contains(&(emp.user_id, *d));
            if let Some(out_at) = rec.check_out_at
                && !is_approved_early
                && !on_leave
            {
                let em = (work_end - i64::from(vn_clock_minutes(out_at.0))).max(0);
                if em > 0 {
                    early_min += em;
                    early_count += 1;
                }
            }
            if is_approved_early || rec.hours(&cfg).is_some_and(|h| h >= cfg.full_day_min_hours) {
                full_days += 1;
            }
        }

        let acc = &mut gender_acc[gender_idx(emp.gender.as_deref())];
        acc.headcount += 1;
        acc.absent += absent_days;
        acc.late += late_count;
        acc.early += early_count;
        acc.full += full_days;

        if absent_days > 0 {
            absent_rows.push(AbsentRow {
                user_id: emp.user_id,
                full_name: emp.full_name.clone(),
                employee_code: emp.employee_code.clone(),
                team_name: emp.team_name.clone(),
                position: emp.position.clone(),
                absent_days,
                absent_occurrences: occurrences,
                absent_rate: if total_workdays > 0 {
                    round1(absent_days as f64 / total_workdays as f64)
                } else {
                    0.0
                },
            });
        }
        let violation = late_min + early_min;
        if violation > 0 {
            violation_rows.push(ViolationRow {
                user_id: emp.user_id,
                full_name: emp.full_name.clone(),
                employee_code: emp.employee_code.clone(),
                team_name: emp.team_name.clone(),
                position: emp.position.clone(),
                late_minutes: late_min,
                early_minutes: early_min,
                violation_minutes: violation,
                late_count,
                early_count,
            });
        }
    }

    // `localeCompare` không truyền locale ⇒ thứ tự gốc CLDR.
    absent_rows.sort_by(|a, b| {
        b.absent_days
            .cmp(&a.absent_days)
            .then(b.absent_rate.partial_cmp(&a.absent_rate).unwrap_or(Ordering::Equal))
            .then_with(|| compare(name_of(&a.full_name), name_of(&b.full_name), Collation::Root))
    });
    absent_rows.truncate(10);
    violation_rows.sort_by(|a, b| {
        b.violation_minutes
            .cmp(&a.violation_minutes)
            .then(b.late_minutes.cmp(&a.late_minutes))
            .then_with(|| compare(name_of(&a.full_name), name_of(&b.full_name), Collation::Root))
    });
    violation_rows.truncate(10);

    let by_gender: Vec<GenderStat> = GENDERS
        .iter()
        .copied()
        .zip(gender_acc.iter())
        .map(|((gender, label), acc)| {
            let denom = acc.headcount * total_workdays;
            let full_rate = if denom > 0 {
                round1(acc.full as f64 / denom as f64)
            } else {
                0.0
            };
            GenderStat {
                gender,
                gender_label: label,
                headcount: acc.headcount,
                total_absent_days: acc.absent,
                total_late_count: acc.late,
                total_early_count: acc.early,
                full_attendance_rate: full_rate,
                insufficient_rate: js_round((100.0 - full_rate) * 10.0) / 10.0,
            }
        })
        .filter(|g| g.headcount > 0)
        .collect();

    out.top_absent = absent_rows;
    out.top_violation = violation_rows;
    out.by_gender = by_gender;
    Ok(out)
}

// ───────────────────────────── GET /stats/leave-analytics ─────────────────────────────

/// Thứ tự + nhãn 6 loại đơn (`LEAVE_ANALYTICS_TYPES`), luôn đủ 6 kể cả 0.
const LEAVE_TYPES: [(&str, &str); 6] = [
    ("forgot_check_in", "Quên chấm vào"),
    ("forgot_check_out", "Quên chấm ra"),
    ("late_arrival", "Đến muộn"),
    ("early_leave", "Về sớm"),
    ("leave", "Nghỉ phép"),
    ("maternity", "Nghỉ thai sản"),
];

const LEAVE_GENDERS: [(&str, &str); 3] = [("M", "Nam"), ("F", "Nữ"), ("unknown", "Khác")];

#[derive(Debug, Serialize)]
pub struct TypeSlice {
    #[serde(rename = "type")]
    kind: &'static str,
    label: &'static str,
    value: i64,
}

#[derive(Debug, Serialize)]
pub struct GenderSlice {
    gender: &'static str,
    label: &'static str,
    value: i64,
}

#[derive(Debug, Serialize)]
pub struct WeekBucket {
    label: String,
    from: String,
    to: String,
}

#[derive(Debug, Serialize)]
pub struct DeptSeries {
    department: String,
    values: Vec<i64>,
}

#[derive(Debug, Serialize)]
pub struct ByWeek {
    weeks: Vec<WeekBucket>,
    departments: Vec<DeptSeries>,
}

#[derive(Debug, Serialize)]
pub struct LeaveOut {
    date_from: String,
    date_to: String,
    by_type_days: Vec<TypeSlice>,
    by_type_requests: Vec<TypeSlice>,
    by_week: ByWeek,
    by_gender: Vec<GenderSlice>,
}

/// `buildLeaveWeekBuckets`: các khối 7 ngày liên tiếp tính từ `from` ("Tuần 1..N").
fn week_buckets(from: NaiveDate, to: NaiveDate) -> Vec<WeekBucket> {
    if to < from {
        return Vec::new();
    }
    let total_days = (to - from).num_days() + 1;
    let count = (total_days + 6) / 7;
    (0..count)
        .map(|i| {
            let start = from + chrono::Duration::days(i * 7);
            let end = (start + chrono::Duration::days(6)).min(to);
            WeekBucket {
                label: format!("Tuần {}", i + 1),
                from: start.to_string(),
                to: end.to_string(),
            }
        })
        .collect()
}

fn type_slices(counts: &HashMap<String, i64>) -> Vec<TypeSlice> {
    LEAVE_TYPES
        .iter()
        .copied()
        .map(|(kind, label)| TypeSlice {
            kind,
            label,
            value: counts.get(kind).copied().unwrap_or(0),
        })
        .collect()
}

fn gender_slices(counts: &[i64; 3]) -> Vec<GenderSlice> {
    LEAVE_GENDERS
        .iter()
        .copied()
        .zip(counts.iter())
        .map(|((gender, label), value)| GenderSlice {
            gender,
            label,
            value: *value,
        })
        .collect()
}

/// `GET /stats/leave-analytics`: ngày nghỉ đã duyệt theo loại, mọi đơn theo loại, tuần × phòng ban, giới tính.
pub async fn leave_analytics(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<LeaveOut> {
    let range = Range::of(q)?;
    let f = Filter::new(view_scope(ctx, actor).await?, q)?;
    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;
    let weeks = week_buckets(range.from, range.to);

    let mut qb = builder(&format!(
        "SELECT
        e.user_id::int AS user_id,
        e.gender AS gender,
        COALESCE(NULLIF(TRIM(e.department), ''), '{NO_DEPARTMENT}') AS department
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      WHERE e.deleted_at IS NULL AND {}",
        employed(&lit(range.from))
    ));
    f.push(&mut qb);
    let query = qb.build_query_as::<(i32, Option<String>, String)>();
    let roster = query.fetch_all(&mut *conn).await.map_err(db)?;

    let mut out = LeaveOut {
        date_from: range.from_str.clone(),
        date_to: range.to_str.clone(),
        by_type_days: type_slices(&HashMap::new()),
        by_type_requests: type_slices(&HashMap::new()),
        by_week: ByWeek {
            weeks: Vec::new(),
            departments: Vec::new(),
        },
        by_gender: gender_slices(&[0; 3]),
    };
    if roster.is_empty() {
        out.by_week.weeks = weeks;
        return Ok(out);
    }

    let mut info: HashMap<i32, (usize, String)> = HashMap::new();
    for (user_id, gender, department) in roster {
        info.insert(user_id, (gender_idx(gender.as_deref()), department));
    }
    let user_ids: Vec<i32> = info.keys().copied().collect();
    let reqs: Vec<(i32, DbDate, String, String)> = sqlx::query_as(
        "SELECT user_id, work_date, type, status FROM attendance_requests
         WHERE user_id = ANY($1) AND work_date >= $2 AND work_date <= $3 ORDER BY id ASC",
    )
    .bind(user_ids)
    .bind(range.from)
    .bind(range.to)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;

    let mut requests_by_type: HashMap<String, i64> = HashMap::new();
    let mut days_by_type: HashMap<String, i64> = HashMap::new();
    let mut days_by_gender = [0_i64; 3];
    let mut week_by_dept: HashMap<String, Vec<i64>> = HashMap::new();
    for (user_id, work_date, kind, status) in reqs {
        *requests_by_type.entry(kind.clone()).or_insert(0) += 1;
        if status != "approved" {
            continue;
        }
        *days_by_type.entry(kind).or_insert(0) += 1;
        let Some((gender, department)) = info.get(&user_id) else {
            continue;
        };
        days_by_gender[*gender] += 1;
        let week = (work_date.0 - range.from).num_days().div_euclid(7);
        let Ok(idx) = usize::try_from(week) else { continue };
        if idx >= weeks.len() {
            continue;
        }
        let series = week_by_dept
            .entry(department.clone())
            .or_insert_with(|| vec![0; weeks.len()]);
        series[idx] += 1;
    }

    let mut departments: Vec<DeptSeries> = week_by_dept
        .into_iter()
        .map(|(department, values)| DeptSeries { department, values })
        .collect();
    departments.sort_by(|a, b| {
        let sa: i64 = a.values.iter().sum();
        let sb: i64 = b.values.iter().sum();
        sb.cmp(&sa)
            .then_with(|| compare(&a.department, &b.department, Collation::Vi))
    });

    out.by_type_days = type_slices(&days_by_type);
    out.by_type_requests = type_slices(&requests_by_type);
    out.by_week = ByWeek { weeks, departments };
    out.by_gender = gender_slices(&days_by_gender);
    Ok(out)
}

// ───────────────────────────── giờ làm: weekly / monthly / weekly-hours ─────────────────────────────

/// Giá trị `@Query('name')`: chuỗi; khoá lặp (mảng) nối bằng dấu phẩy như `String(array)`.
fn query_param(q: &Value, name: &str) -> Option<String> {
    match q.get(name)? {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => {
            let parts: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
            Some(parts.join(","))
        }
        _ => None,
    }
}

/// `isAdmin && targetUserId ? targetUserId : userId` (NaN và 0 coi như không có); id ngoài int4 ⇒ 400.
fn effective_user(actor: &Actor, admin: bool, raw: Option<String>) -> R<i32> {
    let target = raw
        .filter(|s| !s.is_empty())
        .and_then(|s| js_parse_int(&s))
        .filter(|t| *t != 0);
    match target {
        Some(t) if admin => i32::try_from(t).map_err(|_| bad("user_id không hợp lệ")),
        _ => Ok(actor.user_id),
    }
}

/// Số JS `total_hours` (`null` khi không có bản ghi hoặc chưa đủ vào/ra).
#[derive(Debug, Serialize)]
pub struct WeeklyDay {
    date: String,
    #[serde(serialize_with = "num_opt")]
    total_hours: Option<f64>,
    status: Option<String>,
    check_in_at: Option<Timestamp>,
    check_out_at: Option<Timestamp>,
}

/// `GET /stats/weekly`: giờ làm 7 ngày qua (của tôi; `user_id` chỉ có tác dụng khi xem toàn công ty).
pub async fn weekly(ctx: &Ctx, actor: &Actor, q: &Value) -> R<Vec<WeeklyDay>> {
    let user = effective_user(actor, full_view(actor), query_param(q, "user_id"))?;
    let today = vn_date(Utc::now());
    let dates: Vec<NaiveDate> = (0..7_u64)
        .rev()
        .filter_map(|i| today.checked_sub_days(Days::new(i)))
        .collect();
    let (Some(first), Some(last)) = (dates.first().copied(), dates.last().copied()) else {
        return Ok(Vec::new());
    };
    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;
    let records = load_records(conn, Some(vec![user]), first, last).await?;
    let cfg = config::get_shift(conn).await?;
    let by_date: HashMap<NaiveDate, &Rec> = records.iter().map(|r| (r.work_date.0, r)).collect();
    Ok(dates
        .iter()
        .map(|d| {
            let rec = by_date.get(d);
            WeeklyDay {
                date: d.to_string(),
                total_hours: rec.and_then(|r| r.hours(&cfg)),
                status: rec.map(|r| r.display_status(&cfg)),
                check_in_at: rec.and_then(|r| r.check_in_at),
                check_out_at: rec.and_then(|r| r.check_out_at),
            }
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct MonthlyOut {
    month: String,
    #[serde(serialize_with = "num")]
    total_hours: f64,
    present_days: i64,
    late_days: i64,
    half_days: i64,
    records_count: i64,
    #[serde(serialize_with = "num_opt")]
    company_total_hours: Option<f64>,
}

/// `month` dạng `YYYY-MM` (`split('-').map(Number)`): năm 100–9999, tháng 1–12; sai ⇒ 400.
fn parse_month(m: &str) -> R<(i32, u32)> {
    let mut parts = m.split('-').map(js_number);
    let year = parts.next().flatten().and_then(|y| i32::try_from(y).ok());
    let month = parts.next().flatten().and_then(|v| u32::try_from(v).ok());
    match (year, month) {
        (Some(y), Some(mo)) if (100..=9999).contains(&y) && (1..=12).contains(&mo) => Ok((y, mo)),
        _ => Err(bad("month không hợp lệ")),
    }
}

/// `GET /stats/monthly`: tổng giờ tháng (của tôi; thêm tổng toàn công ty khi xem toàn công ty).
pub async fn monthly(ctx: &Ctx, actor: &Actor, q: &Value) -> R<MonthlyOut> {
    let admin = full_view(actor);
    let user = effective_user(actor, admin, query_param(q, "user_id"))?;
    let (y, m) = match query_param(q, "month").filter(|s| !s.is_empty()) {
        Some(s) => parse_month(&s)?,
        None => {
            let today = vn_date(Utc::now());
            (today.year(), today.month())
        }
    };
    let from = NaiveDate::from_ymd_opt(y, m, 1).ok_or_else(|| bad("month không hợp lệ"))?;
    let to = from
        .checked_add_months(chrono::Months::new(1))
        .and_then(|n| n.pred_opt())
        .ok_or_else(|| bad("month không hợp lệ"))?;

    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;
    let records = load_records(conn, Some(vec![user]), from, to).await?;
    let cfg = config::get_shift(conn).await?;
    let late_after = hm_minutes(&cfg.late_after);

    let mut total = 0.0_f64;
    let (mut present, mut late_days, mut half) = (0_i64, 0_i64, 0_i64);
    for r in &records {
        total += r.hours(&cfg).unwrap_or(0.0);
        let status = r.display_status(&cfg);
        if matches!(status.as_str(), "present" | "late" | "leave" | "maternity") {
            present += 1;
        }
        if r.late(late_after) > 0 {
            late_days += 1;
        }
        if status == "half_day" {
            half += 1;
        }
    }

    // Tổng giờ TOÀN BỘ nhân viên trong tháng — chỉ khi xem toàn công ty; tính lại từ giờ chấm.
    let company_total_hours = if admin {
        let all = load_records(conn, None, from, to).await?;
        let sum: f64 = all.iter().map(|r| r.hours(&cfg).unwrap_or(0.0)).sum();
        Some(round2(sum))
    } else {
        None
    };
    Ok(MonthlyOut {
        month: format!("{y}-{m:02}"),
        total_hours: round2(total),
        present_days: present,
        late_days,
        half_days: half,
        records_count: records.len() as i64,
        company_total_hours,
    })
}

#[derive(Debug, Serialize)]
pub struct HoursPoint {
    date: String,
    #[serde(serialize_with = "num")]
    total_hours: f64,
}

#[derive(Debug, Serialize)]
pub struct WeeklyHoursOut {
    scope: &'static str,
    data: Vec<HoursPoint>,
}

/// `Date.UTC(y, m - 1, d)` cho chuỗi `YYYY-MM-DD`: tháng/ngày tràn sang kỳ sau như V8.
fn js_utc_date(s: &str) -> Option<NaiveDate> {
    let part = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok());
    let (y, m, d) = (part(0..4)?, part(5..7)?, part(8..10)?);
    let months = y * 12 + (m - 1);
    let first = NaiveDate::from_ymd_opt(
        i32::try_from(months.div_euclid(12)).ok()?,
        u32::try_from(months.rem_euclid(12) + 1).ok()?,
        1,
    )?;
    first.checked_add_signed(chrono::Duration::days(d - 1))
}

fn is_ymd(s: &str) -> bool {
    s.split('-').map(str::len).eq([4, 2, 2]) && s.chars().all(|c| c == '-' || c.is_ascii_digit())
}

const MAX_RANGE_DAYS: i64 = 92;

/// Hai chuỗi ngày theo thứ tự tăng (đảo nếu nhập ngược).
fn ordered(a: String, b: String) -> (String, String) {
    if a <= b { (a, b) } else { (b, a) }
}

/// `GET /stats/weekly-hours`: tổng giờ làm theo ngày trong khoảng tuỳ chọn (mặc định 7 ngày, tối đa 92 ngày cuối).
pub async fn weekly_hours(ctx: &Ctx, actor: &Actor, q: &Value) -> R<WeeklyHoursOut> {
    let admin = full_view(actor);
    let date_from = query_param(q, "date_from").filter(|s| !s.is_empty());
    let date_to = query_param(q, "date_to").filter(|s| !s.is_empty());
    let today = vn_date(Utc::now());
    let (from_text, to_text) = match (date_from, date_to) {
        (Some(f), Some(t)) if is_ymd(&f) && is_ymd(&t) => ordered(f, t),
        _ => (
            today.checked_sub_days(Days::new(6)).unwrap_or(today).to_string(),
            today.to_string(),
        ),
    };
    let to = js_utc_date(&to_text).ok_or_else(|| bad("date_to không hợp lệ"))?;
    let mut from = js_utc_date(&from_text).ok_or_else(|| bad("date_from không hợp lệ"))?;
    let mut count = (to - from).num_days() + 1;
    if count > MAX_RANGE_DAYS {
        from = to - chrono::Duration::days(MAX_RANGE_DAYS - 1);
        count = MAX_RANGE_DAYS;
    }
    let dates: Vec<NaiveDate> = (0..count.max(0)).map(|i| from + chrono::Duration::days(i)).collect();

    let mut conn = ctx.conn(actor.company).await?;
    let conn: &mut PgConnection = &mut conn;
    let cfg = config::get_shift(conn).await?;
    let users = if admin { None } else { Some(vec![actor.user_id]) };
    let records = load_records(conn, users, from, to).await?;
    let mut by_day: HashMap<NaiveDate, f64> = HashMap::new();
    for r in &records {
        *by_day.entry(r.work_date.0).or_insert(0.0) += r.hours(&cfg).unwrap_or(0.0);
    }
    Ok(WeeklyHoursOut {
        scope: if admin { "all" } else { "self" },
        data: dates
            .iter()
            .map(|d| HoursPoint {
                date: d.to_string(),
                total_hours: round2(by_day.get(d).copied().unwrap_or(0.0)),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn lam_tron_nhu_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.4), 0.0);
        assert_eq!(round1(2.0 / 3.0), 66.7);
        assert_eq!(round1(1.0), 100.0);
        assert_eq!(round2(8.125), 8.13);
    }

    #[test]
    fn parse_int_va_number_cua_js() {
        assert_eq!(js_parse_int("12abc"), Some(12));
        assert_eq!(js_parse_int("  -7"), Some(-7));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_number(""), Some(0));
        assert_eq!(js_number(" 5 "), Some(5));
        assert_eq!(js_number("5x"), None);
    }

    #[test]
    fn thang_hop_le_va_sai() {
        assert_eq!(parse_month("2026-06").unwrap(), (2026, 6));
        assert_eq!(parse_month("2026-6-15").unwrap(), (2026, 6));
        assert!(parse_month("2026-13").is_err());
        assert!(parse_month("2026").is_err());
        assert!(parse_month("abc-01").is_err());
    }

    #[test]
    fn ngay_lam_viec_bo_chu_nhat_va_thu_bay() {
        // 2026-06-01 là thứ hai; 06-06 thứ bảy, 06-07 chủ nhật.
        let none = HashSet::new();
        let days = workdays(d("2026-06-01"), d("2026-06-08"), &none);
        assert_eq!(days.len(), 6);
        let sat: HashSet<String> = ["2026-06-06".to_owned()].into_iter().collect();
        assert_eq!(workdays(d("2026-06-01"), d("2026-06-08"), &sat).len(), 7);
    }

    #[test]
    fn tuan_chia_khoi_bay_ngay() {
        let w = week_buckets(d("2026-06-01"), d("2026-06-30"));
        assert_eq!(w.len(), 5);
        assert_eq!(w[0].label, "Tuần 1");
        assert_eq!(w[0].to, "2026-06-07");
        assert_eq!(w[4].from, "2026-06-29");
        assert_eq!(w[4].to, "2026-06-30");
        assert!(week_buckets(d("2026-06-30"), d("2026-06-01")).is_empty());
    }

    #[test]
    fn ngay_tran_nhu_date_utc() {
        assert_eq!(js_utc_date("2026-06-15"), Some(d("2026-06-15")));
        assert_eq!(js_utc_date("2026-13-01"), Some(d("2027-01-01")));
        assert_eq!(js_utc_date("2026-02-30"), Some(d("2026-03-02")));
        assert!(is_ymd("2026-06-15"));
        assert!(!is_ymd("2026-6-15"));
    }

    #[test]
    fn nhan_gioi_tinh_theo_thu_tu() {
        assert_eq!(gender_idx(Some("M")), 0);
        assert_eq!(gender_idx(Some("F")), 1);
        assert_eq!(gender_idx(Some("x")), 2);
        assert_eq!(gender_idx(None), 2);
    }

    #[test]
    fn so_nguyen_ngoai_int4_bi_tu_choi() {
        assert_eq!(ids_of(Some(&[1.0, -1.0]), "team_id").unwrap(), vec![1, -1]);
        assert!(ids_of(Some(&[3_000_000_000.0]), "team_id").is_err());
        assert!(ids_of(None, "team_id").unwrap().is_empty());
    }
}
