//! Sổ chấm công (M14a phần 2): `GET /management/attendance` (danh sách), `GET|PATCH|DELETE /:id`, `GET /:id/proof/:slot`,
//! `GET /today`, `GET /absent`, `GET /workdays-matrix`. Bản TS: `AttendanceService.listRecords/getRecordById/patchRecord/
//! deleteRecord/streamProof/getTodaySummary/getAbsentEmployees/getWorkdaysMatrix`.
//!
//! - Ngày làm việc là ngày lịch Việt Nam (cột `work_date` kiểu `date`); giờ vào/ra đổi sang giờ VN bằng `trinity_kernel::vn_time`.
//! - Trạng thái và tổng giờ HIỂN THỊ luôn tính lại từ giờ chấm + cấu hình ca (không tin cột lưu); `leave`/`maternity` giữ nguyên.
//! - Phạm vi xem/sửa lấy từ `ScopeService` TRƯỚC khi lấy kết nối (không giữ hai kết nối cùng lúc); bản ghi ngoài phạm vi ⇒ 404.
//! - Team là team CHÍNH THỨC theo 3 tầng (`RESOLVED_TEAM_ID`), lọc theo team cũng bằng đúng biểu thức đó.
//! - Ngày trong query chỉ nhận đúng `YYYY-MM-DD` (ngày tràn tháng như `Date.UTC`); dạng ISO khác mà bản TS làm Prisma lỗi 500 thì
//!   ở đây là 400.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Months, NaiveDate, Utc};
use mod_hr::contracts::Download;
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::types::{DbDate, JsNumber, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::instant::parse_instant_with;
use trinity_kernel::vi::{Collation, compare, escape_like, trim_js};
use trinity_kernel::vn_time::{to_vn, vn_date};
use trinity_rbac::{OwnerIds, Scope, scope_of};
use trinity_storage::StorageError;

use crate::check::{CheckCtx, calc_status, hm_minutes, late_minutes, total_hours};
use crate::config::{self, ShiftConfig};
use crate::dto::{PatchAttendanceDto, QueryAttendanceDto, QueryTodaySummaryDto};
use crate::requests::{RESOLVED_TEAM_ID, owner_of, parse_work_date};
use crate::{R, db};

const NOT_FOUND: &str = "Không tìm thấy bản ghi chấm công.";
/// Trần bản ghi nạp khi lọc theo trạng thái (status tính lại ở tầng ứng dụng).
const STATUS_FILTER_CAP: i64 = 5000;
/// Trần bản ghi nạp khi sắp theo sơ đồ tổ chức (khớp `EXPORT_LIMIT` của bản xuất Excel).
const ORG_SORT_CAP: i64 = 20_000;
/// Trần bản ghi nạp cho bảng chấm công tháng.
const MATRIX_RECORD_CAP: i64 = 20_000;
/// Trần số nhân viên vắng nạp một lần.
const ABSENT_CAP: i64 = 5000;

fn bad(msg: impl Into<String>) -> AppError {
    AppError::Http(HttpError::bad_request(msg.into()))
}

fn not_found() -> AppError {
    AppError::Http(HttpError::not_found(NOT_FOUND))
}

fn i32_of(v: i64, name: &str) -> R<i32> {
    i32::try_from(v).map_err(|_| bad(format!("{name} không hợp lệ")))
}

/// Chỉ nhận đúng `YYYY-MM-DD` (như `parseDateToUtcMidnight`), ngày tràn tháng như `Date.UTC`.
fn day_of(s: &str, name: &str) -> R<NaiveDate> {
    let b = s.as_bytes();
    let shaped = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    shaped
        .then(|| parse_work_date(s))
        .flatten()
        .ok_or_else(|| bad(format!("{name} không hợp lệ")))
}

fn opt_day(s: Option<&str>, name: &str) -> R<Option<NaiveDate>> {
    s.map(|v| day_of(v, name)).transpose()
}

// ───────────────────────────── cột và kiểu dòng ─────────────────────────────

const COLS: [&str; 25] = [
    "id",
    "user_id",
    "employee_id",
    "work_date",
    "check_in_at",
    "check_out_at",
    "check_in_proof_key",
    "check_out_proof_key",
    "check_in_lat",
    "check_in_lng",
    "check_out_lat",
    "check_out_lng",
    "check_in_note",
    "check_out_note",
    "total_hours",
    "overtime_hours",
    "late_minutes",
    "status",
    "check_in_ip",
    "check_out_ip",
    "check_in_office_id",
    "check_out_office_id",
    "device_id",
    "created_at",
    "updated_at",
];

/// Danh sách cột có tiền tố bảng (`ar.id, ar.user_id, …`).
fn cols(prefix: &str) -> String {
    COLS.iter()
        .map(|c| format!("{prefix}.{c}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `AttendanceRecord` của Prisma (khoá theo thứ tự cột).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Rec {
    pub id: i32,
    pub user_id: i32,
    pub employee_id: Option<i32>,
    pub work_date: DbDate,
    pub check_in_at: Option<Timestamp>,
    pub check_out_at: Option<Timestamp>,
    pub check_in_proof_key: Option<String>,
    pub check_out_proof_key: Option<String>,
    pub check_in_lat: Option<JsNumber>,
    pub check_in_lng: Option<JsNumber>,
    pub check_out_lat: Option<JsNumber>,
    pub check_out_lng: Option<JsNumber>,
    pub check_in_note: Option<String>,
    pub check_out_note: Option<String>,
    pub total_hours: Option<JsNumber>,
    pub overtime_hours: Option<JsNumber>,
    pub late_minutes: Option<i32>,
    pub status: String,
    pub check_in_ip: Option<String>,
    pub check_out_ip: Option<String>,
    pub check_in_office_id: Option<i32>,
    pub check_out_office_id: Option<i32>,
    pub device_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

// ───────────────────────────── tính toán hiển thị ─────────────────────────────

fn is_leave(status: &str) -> bool {
    status == "leave" || status == "maternity"
}

/// `displayStatus`: tính lại từ giờ chấm; `leave`/`maternity` giữ nguyên.
fn display_status(
    status: &str,
    check_in: Option<DateTime<Utc>>,
    check_out: Option<DateTime<Utc>>,
    cfg: &ShiftConfig,
) -> String {
    if is_leave(status) {
        return status.to_owned();
    }
    match (check_in, check_out) {
        (Some(i), Some(o)) => calc_status(total_hours(i, o, cfg).unwrap_or(0.0), cfg).to_owned(),
        _ => "incomplete".to_owned(),
    }
}

/// `displayTotalHours`: `leave`/`maternity` giữ giờ lưu; còn lại tính lại (trừ nghỉ trưa).
fn display_hours(
    status: &str,
    check_in: Option<DateTime<Utc>>,
    check_out: Option<DateTime<Utc>>,
    stored: Option<f64>,
    cfg: &ShiftConfig,
) -> Option<f64> {
    if is_leave(status) {
        return stored;
    }
    match (check_in, check_out) {
        (Some(i), Some(o)) => total_hours(i, o, cfg),
        _ => None,
    }
}

/// `calcLateMinutes`: không có giờ vào thì 0.
fn late_of(check_in: Option<DateTime<Utc>>, late_after: i64) -> i32 {
    check_in.map_or(0, |t| late_minutes(t, late_after))
}

/// Đưa bản ghi về dạng hiển thị: muộn, trạng thái, tổng giờ tính lại.
fn enrich(rec: &mut Rec, cfg: &ShiftConfig, late_after: i64) {
    let ci = rec.check_in_at.map(|t| t.0);
    let co = rec.check_out_at.map(|t| t.0);
    let stored = rec.total_hours.map(|h| h.0);
    let status = display_status(&rec.status, ci, co, cfg);
    rec.total_hours = display_hours(&rec.status, ci, co, stored, cfg).map(JsNumber);
    rec.late_minutes = Some(late_of(ci, late_after));
    rec.status = status;
}

// ───────────────────────────── phạm vi và bộ lọc ─────────────────────────────

/// Giao `user_id` của client với phạm vi thật (`intersectUserIdFilter`): `None` = không giới hạn.
fn user_filter(owner: &OwnerIds, user_id: Option<i64>) -> R<Option<Vec<i32>>> {
    let wanted = match user_id {
        None => None,
        Some(v) => match i32::try_from(v) {
            Ok(n) => Some(n),
            Err(_) if matches!(owner, OwnerIds::All) => return Err(bad("user_id không hợp lệ")),
            Err(_) => Some(-1),
        },
    };
    Ok(match (owner, wanted) {
        (OwnerIds::All, None | Some(0)) => None,
        (OwnerIds::All, Some(n)) => Some(vec![n]),
        (OwnerIds::Ids(ids), None) => Some(ids.clone()),
        (OwnerIds::Ids(ids), Some(n)) => Some(if ids.contains(&n) { vec![n] } else { Vec::new() }),
    })
}

struct Filters {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    users: Option<Vec<i32>>,
    /// Mẫu `ILIKE` đã escape (`%tên%`).
    search: Option<String>,
    department: Option<String>,
    job_title: Option<i32>,
    team: Option<i32>,
}

fn filters(q: &QueryAttendanceDto, owner: &OwnerIds, with_search: bool) -> R<Filters> {
    let search = q
        .search
        .as_deref()
        .map(trim_js)
        .filter(|s| !s.is_empty() && with_search)
        .map(|s| format!("%{}%", escape_like(s)));
    Ok(Filters {
        from: opt_day(q.date_from.as_deref(), "date_from")?,
        to: opt_day(q.date_to.as_deref(), "date_to")?,
        users: user_filter(owner, q.user_id)?,
        search,
        department: q
            .department
            .as_deref()
            .map(trim_js)
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        job_title: q
            .job_title_id
            .filter(|j| *j != 0)
            .map(|j| i32_of(j, "job_title_id"))
            .transpose()?,
        team: q
            .team_id
            .filter(|t| *t != 0)
            .map(|t| i32_of(t, "team_id"))
            .transpose()?,
    })
}

const BASE_FROM: &str = " FROM attendance_records ar LEFT JOIN users u ON u.id = ar.user_id
    LEFT JOIN employees e ON e.user_id = ar.user_id";

fn push_where(qb: &mut QueryBuilder<Postgres>, f: &Filters) {
    qb.push(" WHERE TRUE");
    if let Some(d) = f.from {
        qb.push(" AND ar.work_date >= ").push_bind(d);
    }
    if let Some(d) = f.to {
        qb.push(" AND ar.work_date <= ").push_bind(d);
    }
    if let Some(ids) = &f.users {
        qb.push(" AND ar.user_id = ANY(").push_bind(ids.clone()).push(")");
    }
    if let Some(s) = &f.search {
        qb.push(" AND u.full_name ILIKE ").push_bind(s.clone());
    }
    if let Some(d) = &f.department {
        qb.push(" AND e.department = ").push_bind(d.clone());
    }
    if let Some(j) = f.job_title {
        qb.push(" AND e.job_title_id = ").push_bind(j);
    }
    if let Some(t) = f.team {
        qb.push(format!(" AND {RESOLVED_TEAM_ID} = ")).push_bind(t);
    }
}

// ───────────────────────────── danh sách ─────────────────────────────

#[derive(Debug, Serialize)]
struct JobTitleOut {
    sort_order: i32,
}

#[derive(Debug, Serialize)]
struct EmployeeOut {
    position: String,
    team_id: Option<i32>,
    department: Option<String>,
    #[serde(rename = "jobTitle")]
    job_title: Option<JobTitleOut>,
    team_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct UserOut {
    id: i32,
    full_name: Option<String>,
    email: Option<String>,
    manager_id: Option<i32>,
    employee: Option<EmployeeOut>,
}

#[derive(Debug, Serialize)]
struct Listed {
    #[serde(flatten)]
    rec: Rec,
    user: Option<UserOut>,
}

#[derive(Debug, Serialize)]
pub struct Pagination {
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Debug, Serialize)]
pub struct RecordPage {
    data: Vec<Listed>,
    pagination: Pagination,
}

#[derive(Debug, sqlx::FromRow)]
struct ListRow {
    #[sqlx(flatten)]
    rec: Rec,
    u_id: Option<i32>,
    u_full_name: Option<String>,
    u_email: Option<String>,
    u_manager_id: Option<i32>,
    e_id: Option<i32>,
    e_position: Option<String>,
    e_team_id: Option<i32>,
    e_department: Option<String>,
    jt_sort_order: Option<i32>,
    team_name: Option<String>,
}

fn listed(row: ListRow, cfg: &ShiftConfig, late_after: i64) -> Listed {
    let mut rec = row.rec;
    enrich(&mut rec, cfg, late_after);
    let employee = row.e_id.map(|_| EmployeeOut {
        position: row.e_position.unwrap_or_default(),
        team_id: row.e_team_id,
        department: row.e_department,
        job_title: row.jt_sort_order.map(|sort_order| JobTitleOut { sort_order }),
        team_name: row.team_name,
    });
    let user = row.u_id.map(|id| UserOut {
        id,
        full_name: row.u_full_name,
        email: row.u_email,
        manager_id: row.u_manager_id,
        employee,
    });
    Listed { rec, user }
}

fn order_by(sort_by: Option<&str>, desc: bool) -> String {
    let dir = if desc { "DESC" } else { "ASC" };
    let primary = match sort_by {
        Some("work_date") => format!("ar.work_date {dir}"),
        Some("employee") => format!("u.full_name {dir}"),
        Some("check_out") => format!("ar.check_out_at {dir} NULLS LAST"),
        Some("total_hours") => format!("ar.total_hours {dir} NULLS LAST"),
        Some("status") => format!("ar.status {dir}"),
        _ => format!("ar.check_in_at {dir} NULLS LAST"),
    };
    format!(" ORDER BY {primary}, ar.id ASC")
}

/// `None` = hai giá trị bằng nhau (xét tiêu chí kế); trống xếp cuối, còn lại so theo thứ tự chữ tiếng Việt.
fn cmp_org_text(a: Option<&str>, b: Option<&str>) -> Option<Ordering> {
    let (a, b) = (
        a.map(trim_js).filter(|s| !s.is_empty()),
        b.map(trim_js).filter(|s| !s.is_empty()),
    );
    if a == b {
        return None;
    }
    Some(match (a, b) {
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(x), Some(y)) => compare(x, y, Collation::Vi),
    })
}

fn emp(l: &Listed) -> Option<&EmployeeOut> {
    l.user.as_ref().and_then(|u| u.employee.as_ref())
}

fn name_of(l: &Listed) -> &str {
    l.user.as_ref().and_then(|u| u.full_name.as_deref()).unwrap_or("")
}

/// `compareByOrgOrder`: phòng ban → team → cấp chức danh (cao trước) → tên.
fn org_cmp(a: &Listed, b: &Listed) -> Ordering {
    let (ea, eb) = (emp(a), emp(b));
    let dept_a = ea.and_then(|x| x.department.as_deref());
    let dept_b = eb.and_then(|x| x.department.as_deref());
    if let Some(o) = cmp_org_text(dept_a, dept_b) {
        return o;
    }
    let team_a = ea.and_then(|x| x.team_name.as_deref());
    let team_b = eb.and_then(|x| x.team_name.as_deref());
    if let Some(o) = cmp_org_text(team_a, team_b) {
        return o;
    }
    let rank_a = ea.and_then(|x| x.job_title.as_ref()).map_or(-1, |j| j.sort_order);
    let rank_b = eb.and_then(|x| x.job_title.as_ref()).map_or(-1, |j| j.sort_order);
    if rank_a != rank_b {
        return rank_b.cmp(&rank_a);
    }
    compare(name_of(a), name_of(b), Collation::Vi)
}

/// `GET /` : sổ chấm công có phân trang và lọc; phạm vi `attendance.view`.
pub async fn list(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceDto) -> R<RecordPage> {
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(20).max(1);
    let skip = (page - 1).saturating_mul(page_size);
    let owner = owner_of(ctx, actor, "attendance.view").await?;
    let f = filters(q, &owner, true)?;
    let mut conn = ctx.conn(actor.company).await?;
    let cfg = config::get_shift(&mut conn).await?;
    let late_after = hm_minutes(&cfg.late_after);

    let org = q.sort_by.as_deref() == Some("org");
    let status = q.status.as_deref().filter(|s| !s.is_empty());
    let app_side = org || status.is_some();

    let mut qb = QueryBuilder::<Postgres>::new("SELECT ");
    qb.push(cols("ar"));
    qb.push(
        ", u.id AS u_id, u.full_name AS u_full_name, u.email AS u_email, u.manager_id AS u_manager_id,
         e.id AS e_id, e.position AS e_position, e.team_id AS e_team_id, e.department AS e_department,
         jt.sort_order AS jt_sort_order, t.name AS team_name",
    );
    qb.push(BASE_FROM);
    qb.push(" LEFT JOIN job_titles jt ON jt.id = e.job_title_id LEFT JOIN teams t ON t.id = ");
    qb.push(RESOLVED_TEAM_ID);
    push_where(&mut qb, &f);
    qb.push(order_by(q.sort_by.as_deref(), q.sort_dir.as_deref() == Some("desc")));
    if app_side {
        qb.push(" LIMIT ")
            .push_bind(if org { ORG_SORT_CAP } else { STATUS_FILTER_CAP });
    } else {
        qb.push(" LIMIT ").push_bind(page_size);
        qb.push(" OFFSET ").push_bind(skip);
    }
    let query = qb.build_query_as::<ListRow>();
    let rows = query.fetch_all(&mut *conn).await.map_err(db)?;
    let mut items: Vec<Listed> = rows.into_iter().map(|r| listed(r, &cfg, late_after)).collect();

    if app_side {
        if let Some(s) = status {
            items.retain(|r| r.rec.status == s);
        }
        if org {
            items.sort_by(|a, b| {
                org_cmp(a, b)
                    .then_with(|| a.rec.work_date.cmp(&b.rec.work_date))
                    .then_with(|| a.rec.id.cmp(&b.rec.id))
            });
        }
        let total = i64::try_from(items.len()).unwrap_or(i64::MAX);
        let start = usize::try_from(skip).unwrap_or(usize::MAX).min(items.len());
        let data: Vec<Listed> = items
            .into_iter()
            .skip(start)
            .take(usize::try_from(page_size).unwrap_or(usize::MAX))
            .collect();
        return Ok(RecordPage {
            data,
            pagination: Pagination {
                page,
                page_size,
                total,
                total_pages: (total + page_size - 1) / page_size,
            },
        });
    }

    let mut cq = QueryBuilder::<Postgres>::new("SELECT count(*)");
    cq.push(BASE_FROM);
    push_where(&mut cq, &f);
    let count = cq.build_query_scalar::<i64>();
    let total = count.fetch_one(&mut *conn).await.map_err(db)?;
    Ok(RecordPage {
        data: items,
        pagination: Pagination {
            page,
            page_size,
            total,
            total_pages: (total + page_size - 1) / page_size,
        },
    })
}

// ───────────────────────────── chi tiết, sửa, xoá ─────────────────────────────

#[derive(Debug, Serialize)]
struct DetailEmployee {
    position: String,
    office_id: Option<i32>,
}

#[derive(Debug, Serialize)]
struct DetailUser {
    id: i32,
    full_name: Option<String>,
    email: Option<String>,
    employee: Option<DetailEmployee>,
}

#[derive(Debug, Serialize)]
pub struct Detail {
    #[serde(flatten)]
    rec: Rec,
    user: Option<DetailUser>,
    check_in_office_name: Option<String>,
    check_out_office_name: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct DetailRow {
    #[sqlx(flatten)]
    rec: Rec,
    u_id: Option<i32>,
    u_full_name: Option<String>,
    u_email: Option<String>,
    e_id: Option<i32>,
    e_position: Option<String>,
    e_office_id: Option<i32>,
}

/// `GET /:id`: ngoài phạm vi `attendance.view` ⇒ 404.
pub async fn get(ctx: &Ctx, actor: &Actor, id: i32) -> R<Detail> {
    let owner = owner_of(ctx, actor, "attendance.view").await?;
    let mut conn = ctx.conn(actor.company).await?;
    let row: Option<DetailRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {}, u.id AS u_id, u.full_name AS u_full_name, u.email AS u_email,
            e.id AS e_id, e.position AS e_position, e.office_id AS e_office_id
         FROM attendance_records ar LEFT JOIN users u ON u.id = ar.user_id LEFT JOIN employees e ON e.user_id = ar.user_id
         WHERE ar.id = $1",
        cols("ar")
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let row = row.filter(|r| in_owner(&owner, r.rec.user_id)).ok_or_else(not_found)?;

    let assigned = row.e_office_id;
    let mut office_ids: Vec<i32> = [row.rec.check_in_office_id, row.rec.check_out_office_id, assigned]
        .into_iter()
        .flatten()
        .collect();
    office_ids.sort_unstable();
    office_ids.dedup();
    let mut names: HashMap<i32, String> = HashMap::new();
    if !office_ids.is_empty() {
        let found: Vec<(i32, String)> = sqlx::query_as("SELECT id, name FROM attendance_offices WHERE id = ANY($1)")
            .bind(&office_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
        names.extend(found);
    }
    let name_of = |oid: Option<i32>| oid.and_then(|o| names.get(&o).cloned());
    let fallback = name_of(assigned);
    let check_in_office_name = name_of(row.rec.check_in_office_id).or_else(|| fallback.clone());
    let check_out_office_name = name_of(row.rec.check_out_office_id).or(fallback);

    let cfg = config::get_shift(&mut conn).await?;
    let late_after = hm_minutes(&cfg.late_after);
    let mut rec = row.rec;
    enrich(&mut rec, &cfg, late_after);
    let employee = row.e_id.map(|_| DetailEmployee {
        position: row.e_position.unwrap_or_default(),
        office_id: assigned,
    });
    let user = row.u_id.map(|id| DetailUser {
        id,
        full_name: row.u_full_name,
        email: row.u_email,
        employee,
    });
    Ok(Detail {
        rec,
        user,
        check_in_office_name,
        check_out_office_name,
    })
}

fn in_owner(owner: &OwnerIds, user_id: i32) -> bool {
    match owner {
        OwnerIds::All => true,
        OwnerIds::Ids(ids) => ids.contains(&user_id),
    }
}

/// `new Date(str)` của bản TS; chuỗi không đọc được ⇒ 400 (bản TS để Prisma báo lỗi 500).
fn instant_of(v: Option<&Option<String>>, name: &str) -> R<Option<DateTime<Utc>>> {
    match v {
        None => Ok(None),
        // `new Date(null)` là mốc epoch.
        Some(None) => Ok(Some(DateTime::<Utc>::UNIX_EPOCH)),
        Some(Some(s)) => parse_instant_with(s, 0)
            .map(Some)
            .ok_or_else(|| bad(format!("{name} không hợp lệ"))),
    }
}

/// `PATCH /:id`: sửa tay bản ghi; phạm vi `attendance.manage`, ngoài phạm vi ⇒ 404.
pub async fn patch(ctx: &Ctx, actor: &Actor, id: i32, dto: &PatchAttendanceDto) -> R<Rec> {
    let owner = owner_of(ctx, actor, "attendance.manage").await?;
    let mut conn = ctx.conn(actor.company).await?;
    let found: Option<Rec> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM attendance_records WHERE id = $1",
        COLS.join(", ")
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let record = found.filter(|r| in_owner(&owner, r.user_id)).ok_or_else(not_found)?;
    let cfg = config::get_shift(&mut conn).await?;
    let late_after = hm_minutes(&cfg.late_after);

    let set_in = instant_of(dto.check_in_at.as_ref(), "check_in_at")?;
    let set_out = instant_of(dto.check_out_at.as_ref(), "check_out_at")?;
    let new_in = set_in.or(record.check_in_at.map(|t| t.0));
    let new_out = set_out.or(record.check_out_at.map(|t| t.0));

    let mut qb = QueryBuilder::<Postgres>::new("UPDATE attendance_records SET updated_at = now()");
    if let Some(t) = set_in {
        qb.push(", check_in_at = ").push_bind(t);
    }
    if let Some(t) = set_out {
        qb.push(", check_out_at = ").push_bind(t);
    }
    if let Some(n) = &dto.check_in_note {
        qb.push(", check_in_note = ").push_bind(n.clone());
    }
    if let Some(n) = &dto.check_out_note {
        qb.push(", check_out_note = ").push_bind(n.clone());
    }
    match dto.total_hours {
        Some(h) => {
            qb.push(", total_hours = ").push_bind(h);
        }
        None => {
            let computed = new_in.zip(new_out).and_then(|(i, o)| total_hours(i, o, &cfg));
            if let Some(h) = computed {
                qb.push(", total_hours = ").push_bind(h);
            }
        }
    }
    let late = dto.late_minutes.unwrap_or_else(|| Some(late_of(new_in, late_after)));
    qb.push(", late_minutes = ").push_bind(late);
    let status = match &dto.status {
        Some(Some(s)) => s.clone(),
        Some(None) => return Err(bad("status không hợp lệ")),
        None => {
            // `calcStatus` của bản TS khi sửa tay dùng ngưỡng mặc định 1/4/8 giờ, không dùng ngưỡng cấu hình.
            let fixed = ShiftConfig {
                review_max_hours: 1.0,
                half_day_min_hours: 4.0,
                full_day_min_hours: 8.0,
                ..cfg.clone()
            };
            match new_in.zip(new_out) {
                Some((i, o)) => calc_status(total_hours(i, o, &cfg).unwrap_or(0.0), &fixed).to_owned(),
                None => "incomplete".to_owned(),
            }
        }
    };
    qb.push(", status = ").push_bind(status);
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(" RETURNING ");
    qb.push(COLS.join(", "));
    let query = qb.build_query_as::<Rec>();
    query.fetch_one(&mut *conn).await.map_err(db)
}

/// Kết quả `DELETE /:id`.
#[derive(Debug, Serialize)]
pub struct Deleted {
    ok: bool,
    id: i32,
    user_id: i32,
}

/// `DELETE /:id`: xoá bản ghi để nhân viên chấm lại; phạm vi `attendance.manage`, ngoài phạm vi ⇒ 404.
pub async fn remove(ctx: &Ctx, actor: &Actor, id: i32) -> R<Deleted> {
    let owner = owner_of(ctx, actor, "attendance.manage").await?;
    let mut conn = ctx.conn(actor.company).await?;
    let found: Option<(i32, DbDate)> =
        sqlx::query_as("SELECT user_id, work_date FROM attendance_records WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let (user_id, work_date) = found.filter(|(u, _)| in_owner(&owner, *u)).ok_or_else(not_found)?;
    sqlx::query("DELETE FROM attendance_records WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    tracing::info!(
        "Attendance record {id} (user {user_id}, date {}) deleted by user {}",
        work_date.0,
        actor.user_id
    );
    Ok(Deleted { ok: true, id, user_id })
}

// ───────────────────────────── ảnh selfie ─────────────────────────────

/// `GET /:id/proof/:slot`: stream ảnh qua backend; `slot` là `in` hoặc `out`. Ngoài phạm vi `attendance.view` ⇒ 404.
pub async fn proof(cc: &CheckCtx, actor: &Actor, id: i32, slot: &str) -> R<Download> {
    if slot != "in" && slot != "out" {
        return Err(bad("slot phải là 'in' hoặc 'out'."));
    }
    let owner = owner_of(&cc.ctx, actor, "attendance.view").await?;
    let key = {
        let mut conn = cc.ctx.conn(actor.company).await?;
        let row: Option<(i32, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT user_id, check_in_proof_key, check_out_proof_key FROM attendance_records WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        let (user_id, in_key, out_key) = row.ok_or_else(not_found)?;
        if !in_owner(&owner, user_id) {
            return Err(not_found());
        }
        if slot == "in" { in_key } else { out_key }
    };
    let no_proof = || AppError::Http(HttpError::not_found("Không có ảnh selfie cho bản ghi này."));
    let key = key.ok_or_else(no_proof)?;
    cc.store.get(&key).await.map_err(|e| match e {
        StorageError::NotFound(_) => no_proof(),
        other => AppError::internal(other),
    })
}

// ───────────────────────────── hôm nay ─────────────────────────────

#[derive(Debug, Serialize)]
struct TodayMine {
    work_date: String,
    record: Option<Rec>,
}

/// `GET /today`: người có `attendance.view` phạm vi `all` thấy số liệu cả công ty, còn lại thấy bản ghi của mình.
pub async fn today(ctx: &Ctx, actor: &Actor, q: &QueryTodaySummaryDto) -> R<Value> {
    let date_str = q.date.clone().unwrap_or_else(|| vn_date(Utc::now()).to_string());
    let day = day_of(&date_str, "date")?;
    let full_view = scope_of(&actor.grants, "attendance.view") == Some(Scope::All);
    let mut conn = ctx.conn(actor.company).await?;
    if full_view {
        let (total, checked_in, present, incomplete): (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL AND status = 'active'),
                count(*) FILTER (WHERE check_in_at IS NOT NULL),
                count(*) FILTER (WHERE check_in_at IS NOT NULL AND status <> 'incomplete'),
                count(*) FILTER (WHERE status = 'incomplete' AND check_in_at IS NOT NULL)
             FROM attendance_records WHERE work_date = $1",
        )
        .bind(day)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        return Ok(json!({
            "work_date": date_str,
            "total": total,
            "checked_in": checked_in,
            "present": present,
            "incomplete": incomplete,
            "absent": (total - checked_in).max(0),
        }));
    }
    let found: Option<Rec> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM attendance_records WHERE user_id = $1 AND work_date = $2",
        COLS.join(", ")
    )))
    .bind(actor.user_id)
    .bind(day)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let record = match found {
        None => None,
        Some(mut rec) => {
            let cfg = config::get_shift(&mut conn).await?;
            let ci = rec.check_in_at.map(|t| t.0);
            let co = rec.check_out_at.map(|t| t.0);
            let stored = rec.total_hours.map(|h| h.0);
            // Chỉ trạng thái và tổng giờ tính lại; số phút muộn giữ giá trị lưu.
            let status = display_status(&rec.status, ci, co, &cfg);
            rec.total_hours = display_hours(&rec.status, ci, co, stored, &cfg).map(JsNumber);
            rec.status = status;
            Some(rec)
        }
    };
    // trinity-lint: allow-json-value (model cần vá thêm khoá rồi trả Value (hoặc ghi cột jsonb), giữ hành vi cũ; không phải đường ghi chuỗi JSON thẳng)
    serde_json::to_value(TodayMine {
        work_date: date_str,
        record,
    })
    .map_err(AppError::internal)
}

// ───────────────────────────── vắng mặt ─────────────────────────────

/// Nhân viên vắng (chưa chấm cả vào lẫn ra) trong một ngày.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AbsentEmployee {
    pub(crate) user_id: i32,
    pub(crate) employee_code: Option<String>,
    pub(crate) full_name: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) phone: Option<String>,
    pub(crate) position: Option<String>,
    pub(crate) department: Option<String>,
    pub(crate) gender: Option<String>,
    pub(crate) office_name: Option<String>,
    pub(crate) team_name: Option<String>,
    pub(crate) team_id: Option<i32>,
}

/// Kết quả `GET /absent`.
#[derive(Debug, Serialize)]
pub struct AbsentList {
    pub(crate) absent_date: String,
    pub(crate) absent_employees: Vec<AbsentEmployee>,
}

/// `resolveVnDateParam`: đúng `YYYY-MM-DD` thì giữ, thiếu/sai dạng thì hôm nay (giờ VN).
pub fn resolve_vn_date_param(date: Option<&str>) -> String {
    match date {
        Some(d) if day_of(d, "date").is_ok() => d.to_owned(),
        _ => vn_date(Utc::now()).to_string(),
    }
}

/// Cột sắp xếp cho phép của danh sách vắng (khoá do client gửi chỉ tra bảng này, không ghép vào SQL).
fn absent_order_col(sort_by: Option<&str>) -> &'static str {
    match sort_by {
        Some("employee_code") => "COALESCE(NULLIF(TRIM(e.employee_code), ''), 'NV' || LPAD(e.id::text, 4, '0'))",
        Some("full_name") => "u.full_name",
        Some("email") => "u.email",
        Some("phone") => "u.phone",
        Some("position") => "e.position",
        Some("department") => "e.department",
        Some("gender") => "e.gender",
        Some("office_name") => "ao.name",
        _ => "mgr.full_name",
    }
}

/// `employedOnSql($1::date)`: nhân viên `e` đang làm vào ngày `$1`. Đã có giai đoạn làm việc: status `active`/`resigned` và có
/// giai đoạn phủ ngày; chưa có: `active`, hoặc `resigned` mà ngày còn trước ngày nghỉ (giờ VN).
const EMPLOYED_ON: &str = "(CASE WHEN EXISTS (SELECT 1 FROM employment_periods ep0 WHERE ep0.employee_id = e.id)
    THEN e.status IN ('active', 'resigned') AND EXISTS (
      SELECT 1 FROM employment_periods ep WHERE ep.employee_id = e.id
        AND (ep.started_on IS NULL OR ep.started_on <= $1::date)
        AND (ep.ended_on IS NULL OR $1::date < ep.ended_on))
    ELSE (e.status = 'active' OR (e.status = 'resigned' AND e.resigned_at IS NOT NULL
        AND (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > $1::date))
  END)";

/// `GET /absent`: phạm vi `attendance.view`; `date` sai dạng ⇒ hôm nay; `sort_by` ngoài danh sách ⇒ sắp theo team.
pub async fn absent(
    ctx: &Ctx,
    actor: &Actor,
    date: Option<&str>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> R<AbsentList> {
    let date_str = resolve_vn_date_param(date);
    let owner = owner_of(ctx, actor, "attendance.view").await?;
    let scope: Option<Vec<i32>> = match owner {
        OwnerIds::All => None,
        OwnerIds::Ids(ids) => Some(ids),
    };
    let dir = if sort_dir == Some("desc") { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT u.id::int AS user_id,
            COALESCE(NULLIF(TRIM(e.employee_code), ''), 'NV' || LPAD(e.id::text, 4, '0')) AS employee_code,
            u.full_name AS full_name, u.email AS email, u.phone AS phone,
            NULLIF(TRIM(e.position), '') AS position, NULLIF(TRIM(e.department), '') AS department,
            e.gender AS gender, ao.name AS office_name, mgr.full_name AS team_name, u.manager_id::int AS team_id
         FROM employees e
         JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
         LEFT JOIN attendance_offices ao ON ao.id = e.office_id
         LEFT JOIN users mgr ON mgr.id = u.manager_id
         WHERE e.deleted_at IS NULL AND {EMPLOYED_ON} AND ($2::int[] IS NULL OR e.user_id = ANY($2))
           AND NOT EXISTS (
             SELECT 1 FROM attendance_records ar
             WHERE ar.user_id = e.user_id AND ar.work_date = $1::date
               AND (ar.check_in_at IS NOT NULL OR ar.check_out_at IS NOT NULL))
         ORDER BY {} {dir} NULLS LAST, u.full_name ASC, e.id ASC
         LIMIT {ABSENT_CAP}",
        absent_order_col(sort_by)
    );
    let mut conn = ctx.conn(actor.company).await?;
    let rows: Vec<AbsentEmployee> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(&date_str)
        .bind(scope)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    Ok(AbsentList {
        absent_date: date_str,
        absent_employees: rows,
    })
}

// ───────────────────────────── ma trận công ─────────────────────────────

#[derive(Debug, Serialize)]
pub(crate) struct Cell {
    pub(crate) day: u32,
    pub(crate) status: String,
    pub(crate) hours: Option<JsNumber>,
    pub(crate) late_minutes: i32,
    pub(crate) check_in: Option<String>,
    pub(crate) check_out: Option<String>,
    pub(crate) early_leave_compensated: bool,
}

#[derive(Debug, Serialize)]
pub struct MatrixRow {
    pub(crate) user_id: i32,
    pub(crate) full_name: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) employee_code: Option<String>,
    pub(crate) position: Option<String>,
    pub(crate) department: Option<String>,
    pub(crate) team_name: Option<String>,
    pub(crate) total_work_days: JsNumber,
    pub(crate) total_work_days_after_approval: JsNumber,
    pub(crate) total_hours: JsNumber,
    pub(crate) present_days: i64,
    pub(crate) half_days: i64,
    pub(crate) insufficient_days: i64,
    pub(crate) incomplete_days: i64,
    pub(crate) leave_days: i64,
    pub(crate) maternity_days: i64,
    pub(crate) late_days: i64,
    pub(crate) total_late_minutes: i64,
    pub(crate) early_leave_count: i64,
    pub(crate) early_leave_approved: i64,
    pub(crate) early_leave_rejected: i64,
    pub(crate) early_leave_minutes: i64,
    pub(crate) compensated_days: i64,
    pub(crate) notes: String,
    pub(crate) cells: BTreeMap<u32, Cell>,
}

#[derive(Debug, Serialize)]
pub struct Matrix {
    pub(crate) date_from: Option<String>,
    pub(crate) date_to: Option<String>,
    pub(crate) days_in_month: u32,
    pub(crate) count: usize,
    pub(crate) capped: bool,
    pub(crate) rows: Vec<MatrixRow>,
}

#[derive(Debug, sqlx::FromRow)]
struct MxRow {
    user_id: i32,
    work_date: DbDate,
    check_in_at: Option<Timestamp>,
    check_out_at: Option<Timestamp>,
    total_hours: Option<JsNumber>,
    status: String,
    u_full_name: Option<String>,
    u_email: Option<String>,
    e_employee_code: Option<String>,
    e_position: Option<String>,
    e_department: Option<String>,
    team_name: Option<String>,
}

/// `computeNotes`: ghi chú bất thường ngày công.
fn notes_of(incomplete: i64, half: i64, insufficient: i64, late: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if incomplete > 0 {
        parts.push(format!("Thiếu vào/ra: {incomplete} ngày"));
    }
    let under = half + insufficient;
    if under > 0 {
        parts.push(format!("Chưa đủ công: {under} ngày"));
    }
    if late > 0 {
        parts.push(format!("Đi muộn: {late} lần"));
    }
    parts.join(" · ")
}

/// `daysInMonthFromDateFrom`: số ngày của tháng trong `YYYY-MM-DD`.
fn days_in_month(s: &str) -> u32 {
    let year = s.get(0..4).and_then(|y| y.parse::<i32>().ok());
    let month = s.get(5..7).and_then(|m| m.parse::<u32>().ok());
    year.zip(month)
        .and_then(|(y, m)| {
            let first = NaiveDate::from_ymd_opt(y, m, 1)?;
            let next = first.checked_add_months(Months::new(1))?;
            u32::try_from((next - first).num_days()).ok()
        })
        .unwrap_or(31)
}

/// `vnHhmm`: `HH:mm` giờ Việt Nam.
fn hhmm(t: Option<Timestamp>) -> Option<String> {
    t.map(|t| to_vn(t.0).format("%H:%M").to_string())
}

/// `Math.round(x * k) / k` với x không âm.
fn round_to(x: f64, k: f64) -> f64 {
    (x * k + 0.5).floor() / k
}

/// Đơn về sớm trong kỳ: tập (nv, ngày) có đơn, tập có đơn đã duyệt, và đếm theo nhân viên (tổng, duyệt, từ chối).
struct EarlyLeave {
    any: HashSet<(i32, NaiveDate)>,
    approved: HashSet<(i32, NaiveDate)>,
    counts: HashMap<i32, (i64, i64, i64)>,
}

async fn early_leave(conn: &mut PgConnection, f: &Filters, user_id: Option<i64>) -> R<EarlyLeave> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT user_id, work_date, status FROM attendance_requests WHERE type = 'early_leave'",
    );
    if let Some(d) = f.from {
        qb.push(" AND work_date >= ").push_bind(d);
    }
    if let Some(d) = f.to {
        qb.push(" AND work_date <= ").push_bind(d);
    }
    if let Some(u) = user_id.filter(|u| *u != 0) {
        qb.push(" AND user_id = ").push_bind(i32_of(u, "user_id")?);
    }
    let query = qb.build_query_as::<(i32, DbDate, String)>();
    let rows = query.fetch_all(&mut *conn).await.map_err(db)?;
    let mut out = EarlyLeave {
        any: HashSet::new(),
        approved: HashSet::new(),
        counts: HashMap::new(),
    };
    for (user, day, status) in rows {
        let key = (user, day.0);
        out.any.insert(key);
        let c = out.counts.entry(user).or_insert((0, 0, 0));
        c.0 += 1;
        if status == "approved" {
            out.approved.insert(key);
            c.1 += 1;
        } else if status == "rejected" {
            c.2 += 1;
        }
    }
    Ok(out)
}

/// `GET /workdays-matrix`: lưới nhân viên × ngày; phạm vi `attendance.view`.
pub async fn matrix(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceDto) -> R<Matrix> {
    matrix_with(ctx, actor, q, "attendance.view").await
}

/// Như [`matrix`] nhưng phạm vi theo quyền `permission` (xuất Excel dùng `attendance.export`).
pub(crate) async fn matrix_with(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceDto, permission: &str) -> R<Matrix> {
    let owner = owner_of(ctx, actor, permission).await?;
    let f = filters(q, &owner, false)?;
    let mut conn = ctx.conn(actor.company).await?;
    let cfg = config::get_shift(&mut conn).await?;
    let late_after = hm_minutes(&cfg.late_after);

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT ar.user_id, ar.work_date, ar.check_in_at, ar.check_out_at, ar.total_hours, ar.status,
            u.full_name AS u_full_name, u.email AS u_email, e.employee_code AS e_employee_code,
            e.position AS e_position, e.department AS e_department, t.name AS team_name",
    );
    qb.push(BASE_FROM);
    qb.push(" LEFT JOIN teams t ON t.id = ");
    qb.push(RESOLVED_TEAM_ID);
    push_where(&mut qb, &f);
    qb.push(" ORDER BY ar.user_id ASC, ar.work_date ASC LIMIT ")
        .push_bind(MATRIX_RECORD_CAP);
    let query = qb.build_query_as::<MxRow>();
    let records = query.fetch_all(&mut *conn).await.map_err(db)?;
    let el = early_leave(&mut conn, &f, q.user_id).await?;
    drop(conn);

    let full_day_minutes = cfg.full_day_min_hours * 60.0;
    let mut order: Vec<i32> = Vec::new();
    let mut map: HashMap<i32, MatrixRow> = HashMap::new();
    let capped = i64::try_from(records.len()).unwrap_or(i64::MAX) >= MATRIX_RECORD_CAP;
    for r in &records {
        let row = map.entry(r.user_id).or_insert_with(|| {
            order.push(r.user_id);
            MatrixRow {
                user_id: r.user_id,
                full_name: r.u_full_name.clone(),
                email: r.u_email.clone(),
                employee_code: r.e_employee_code.clone(),
                position: r.e_position.clone(),
                department: r.e_department.clone(),
                team_name: r.team_name.clone(),
                total_work_days: JsNumber(0.0),
                total_work_days_after_approval: JsNumber(0.0),
                total_hours: JsNumber(0.0),
                present_days: 0,
                half_days: 0,
                insufficient_days: 0,
                incomplete_days: 0,
                leave_days: 0,
                maternity_days: 0,
                late_days: 0,
                total_late_minutes: 0,
                early_leave_count: 0,
                early_leave_approved: 0,
                early_leave_rejected: 0,
                early_leave_minutes: 0,
                compensated_days: 0,
                notes: String::new(),
                cells: BTreeMap::new(),
            }
        });
        let ci = r.check_in_at.map(|t| t.0);
        let co = r.check_out_at.map(|t| t.0);
        let status = display_status(&r.status, ci, co, &cfg);
        let hours = display_hours(&r.status, ci, co, r.total_hours.map(|h| h.0), &cfg);
        let late = late_of(ci, late_after);
        let day = r.work_date.0.day();
        let key = (r.user_id, r.work_date.0);
        let compensated = status == "half_day" && el.approved.contains(&key);
        if compensated {
            row.compensated_days += 1;
        }
        if let Some(h) = hours.filter(|h| el.any.contains(&key) && h * 60.0 < full_day_minutes) {
            row.early_leave_minutes += (full_day_minutes - h * 60.0 + 0.5).floor() as i64;
        }
        row.cells.insert(
            day,
            Cell {
                day,
                status: status.clone(),
                hours: hours.map(JsNumber),
                late_minutes: late,
                check_in: hhmm(r.check_in_at),
                check_out: hhmm(r.check_out_at),
                early_leave_compensated: compensated,
            },
        );
        row.total_hours = JsNumber(row.total_hours.0 + hours.unwrap_or(0.0));
        if late > 0 {
            row.late_days += 1;
            row.total_late_minutes += i64::from(late);
        }
        match status.as_str() {
            "present" => row.present_days += 1,
            "half_day" => row.half_days += 1,
            "insufficient" | "review" => row.insufficient_days += 1,
            "incomplete" => row.incomplete_days += 1,
            "leave" => row.leave_days += 1,
            "maternity" => row.maternity_days += 1,
            _ => {}
        }
    }

    let mut rows: Vec<MatrixRow> = order.into_iter().filter_map(|id| map.remove(&id)).collect();
    for row in &mut rows {
        let work_days = (row.present_days + row.leave_days + row.maternity_days) as f64 + 0.5 * row.half_days as f64;
        let after = work_days + 0.5 * row.compensated_days as f64;
        let (total, approved, rejected) = el.counts.get(&row.user_id).copied().unwrap_or((0, 0, 0));
        row.total_hours = JsNumber(round_to(row.total_hours.0, 100.0));
        row.total_work_days = JsNumber(round_to(work_days, 10.0));
        row.total_work_days_after_approval = JsNumber(round_to(after, 10.0));
        row.early_leave_count = total;
        row.early_leave_approved = approved;
        row.early_leave_rejected = rejected;
        row.notes = notes_of(row.incomplete_days, row.half_days, row.insufficient_days, row.late_days);
    }
    rows.sort_by(|a, b| {
        compare(
            a.full_name.as_deref().unwrap_or(""),
            b.full_name.as_deref().unwrap_or(""),
            Collation::Vi,
        )
    });

    let days = match (q.date_from.as_deref(), q.date_to.as_deref()) {
        (Some(from), _) => days_in_month(from),
        (None, Some(to)) => days_in_month(to),
        (None, None) => 31,
    };
    Ok(Matrix {
        date_from: q.date_from.clone(),
        date_to: q.date_to.clone(),
        days_in_month: days,
        count: rows.len(),
        capped,
        rows,
    })
}

// ───────────────────────────── dữ liệu xuất Excel (M14b) ─────────────────────────────

/// Một dòng của tệp xuất chấm công theo khoảng ngày (`GET /export`).
pub(crate) struct ExportRow {
    pub(crate) full_name: String,
    pub(crate) team_name: Option<String>,
    pub(crate) department: Option<String>,
    pub(crate) email: String,
    pub(crate) position: Option<String>,
    pub(crate) work_date: NaiveDate,
    pub(crate) check_in: Option<String>,
    pub(crate) check_out: Option<String>,
    /// Tổng giờ tính lại (trừ nghỉ trưa); `None` khi thiếu giờ vào/ra.
    pub(crate) total_hours: Option<f64>,
    /// `late_minutes` đã lưu trong bản ghi (bản TS xuất `r.late_minutes ?? 0`, không tính lại).
    pub(crate) late_minutes: i32,
    /// Trạng thái hiển thị (tính lại từ giờ chấm).
    pub(crate) status: String,
    pub(crate) in_note: String,
    pub(crate) out_note: String,
}

pub(crate) struct ExportData {
    pub(crate) rows: Vec<ExportRow>,
    /// Vượt `EXPORT_LIMIT` bản ghi (file chỉ giữ phần mới nhất).
    pub(crate) truncated: bool,
}

/// Trần số bản ghi một tệp xuất (`EXPORT_LIMIT` của bản TS).
pub(crate) const EXPORT_LIMIT: i64 = ORG_SORT_CAP;

/// `AttendanceExportService.exportToExcel` phần dữ liệu: phạm vi `attendance.export`, bộ lọc ngày/nhân viên/team/phòng ban/chức
/// danh, lấy `EXPORT_LIMIT + 1` bản ghi mới nhất rồi sắp theo sơ đồ tổ chức → ngày → id.
pub(crate) async fn export_records(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceDto) -> R<ExportData> {
    let owner = owner_of(ctx, actor, "attendance.export").await?;
    let f = filters(q, &owner, false)?;
    let mut conn = ctx.conn(actor.company).await?;
    let cfg = config::get_shift(&mut conn).await?;
    let late_after = hm_minutes(&cfg.late_after);

    let mut qb = QueryBuilder::<Postgres>::new("SELECT ");
    qb.push(cols("ar"));
    qb.push(
        ", u.id AS u_id, u.full_name AS u_full_name, u.email AS u_email, u.manager_id AS u_manager_id,
         e.id AS e_id, e.position AS e_position, e.team_id AS e_team_id, e.department AS e_department,
         jt.sort_order AS jt_sort_order, t.name AS team_name",
    );
    qb.push(BASE_FROM);
    qb.push(" LEFT JOIN job_titles jt ON jt.id = e.job_title_id LEFT JOIN teams t ON t.id = ");
    qb.push(RESOLVED_TEAM_ID);
    push_where(&mut qb, &f);
    qb.push(" ORDER BY ar.work_date DESC, ar.user_id ASC LIMIT ")
        .push_bind(EXPORT_LIMIT + 1);
    let query = qb.build_query_as::<ListRow>();
    let mut raw = query.fetch_all(&mut *conn).await.map_err(db)?;
    drop(conn);
    let truncated = i64::try_from(raw.len()).unwrap_or(i64::MAX) > EXPORT_LIMIT;
    raw.truncate(usize::try_from(EXPORT_LIMIT).unwrap_or(usize::MAX));

    let mut items: Vec<(Listed, i32)> = raw
        .into_iter()
        .map(|r| {
            let stored_late = r.rec.late_minutes.unwrap_or(0);
            (listed(r, &cfg, late_after), stored_late)
        })
        .collect();
    items.sort_by(|(a, _), (b, _)| {
        org_cmp(a, b)
            .then_with(|| a.rec.work_date.cmp(&b.rec.work_date))
            .then_with(|| a.rec.id.cmp(&b.rec.id))
    });
    let rows = items
        .into_iter()
        .map(|(l, stored_late)| {
            let e = l.user.as_ref().and_then(|u| u.employee.as_ref());
            ExportRow {
                full_name: l.user.as_ref().and_then(|u| u.full_name.clone()).unwrap_or_default(),
                team_name: e.and_then(|x| x.team_name.clone()),
                department: e.and_then(|x| x.department.clone()),
                email: l.user.as_ref().and_then(|u| u.email.clone()).unwrap_or_default(),
                position: e.map(|x| x.position.clone()),
                work_date: l.rec.work_date.0,
                check_in: hhmm(l.rec.check_in_at),
                check_out: hhmm(l.rec.check_out_at),
                total_hours: l.rec.total_hours.map(|h| h.0),
                late_minutes: stored_late,
                status: l.rec.status.clone(),
                in_note: l.rec.check_in_note.clone().unwrap_or_default(),
                out_note: l.rec.check_out_note.clone().unwrap_or_default(),
            }
        })
        .collect();
    Ok(ExportData { rows, truncated })
}

#[cfg(test)]
impl Matrix {
    pub(crate) fn empty_for_test(days_in_month: u32) -> Self {
        Self {
            date_from: None,
            date_to: None,
            days_in_month,
            count: 0,
            capped: false,
            rows: Vec::new(),
        }
    }
}

#[cfg(test)]
impl AbsentList {
    pub(crate) fn empty_for_test(date: &str) -> Self {
        Self {
            absent_date: date.to_owned(),
            absent_employees: Vec::new(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn cfg() -> ShiftConfig {
        ShiftConfig::default_config()
    }

    fn utc(h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 3, 2, h, mi, 0).unwrap()
    }

    #[test]
    fn ngay_chi_nhan_dung_dang() {
        assert_eq!(day_of("2026-06-17", "d").unwrap().to_string(), "2026-06-17");
        // 31/02 tràn sang tháng sau như `Date.UTC`.
        assert_eq!(day_of("2026-02-31", "d").unwrap().to_string(), "2026-03-03");
        assert!(day_of("2026-06-17T00:00:00Z", "d").is_err());
        assert!(day_of("2026-06", "d").is_err());
        assert!(day_of("2026-13-01", "d").is_err());
    }

    #[test]
    fn ngay_vang_sai_dang_ve_hom_nay() {
        assert_eq!(resolve_vn_date_param(Some("2026-06-17")), "2026-06-17");
        let today = vn_date(Utc::now()).to_string();
        assert_eq!(resolve_vn_date_param(Some("17/06/2026")), today);
        assert_eq!(resolve_vn_date_param(None), today);
    }

    #[test]
    fn trang_thai_hien_thi_tinh_lai() {
        // 08:00 đến 17:00 VN trừ nghỉ trưa = 7.5 giờ ⇒ nửa ngày (ngưỡng mặc định 4/8), bất kể status lưu.
        let (i, o) = (Some(utc(1, 0)), Some(utc(10, 0)));
        assert_eq!(display_status("present", i, o, &cfg()), "half_day");
        assert_eq!(display_hours("present", i, o, Some(8.0), &cfg()), Some(7.5));
        // Thiếu giờ ra ⇒ chưa hoàn tất, không có tổng giờ.
        assert_eq!(display_status("present", i, None, &cfg()), "incomplete");
        assert_eq!(display_hours("present", i, None, Some(8.0), &cfg()), None);
        // Nghỉ phép giữ nguyên trạng thái và giờ lưu.
        assert_eq!(display_status("leave", i, o, &cfg()), "leave");
        assert_eq!(display_hours("leave", i, o, Some(8.0), &cfg()), Some(8.0));
    }

    #[test]
    fn giao_phan_vi_user_id() {
        let all = OwnerIds::All;
        assert_eq!(user_filter(&all, None).unwrap(), None);
        assert_eq!(user_filter(&all, Some(0)).unwrap(), None);
        assert_eq!(user_filter(&all, Some(7)).unwrap(), Some(vec![7]));
        assert!(user_filter(&all, Some(i64::from(i32::MAX) + 1)).is_err());
        let own = OwnerIds::Ids(vec![3, 4]);
        assert_eq!(user_filter(&own, None).unwrap(), Some(vec![3, 4]));
        assert_eq!(user_filter(&own, Some(4)).unwrap(), Some(vec![4]));
        // Ngoài phạm vi ⇒ rỗng, không lộ.
        assert_eq!(user_filter(&own, Some(9)).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn so_ngay_va_ghi_chu() {
        assert_eq!(days_in_month("2026-06-01"), 30);
        assert_eq!(days_in_month("2026-02-01"), 28);
        assert_eq!(days_in_month("2028-02-10"), 29);
        assert_eq!(notes_of(0, 0, 0, 0), "");
        assert_eq!(
            notes_of(1, 2, 1, 3),
            "Thiếu vào/ra: 1 ngày · Chưa đủ công: 3 ngày · Đi muộn: 3 lần"
        );
    }

    #[test]
    fn lam_tron_nhu_math_round() {
        assert_eq!(round_to(7.125, 100.0), 7.13);
        assert_eq!(round_to(2.25, 10.0), 2.3);
        assert_eq!(hhmm(Some(Timestamp(utc(1, 5)))).as_deref(), Some("08:05"));
        assert_eq!(hhmm(None), None);
    }

    #[test]
    fn sap_theo_so_do_to_chuc() {
        assert_eq!(cmp_org_text(Some("B"), Some("A")), Some(Ordering::Greater));
        assert_eq!(cmp_org_text(None, Some("A")), Some(Ordering::Greater));
        assert_eq!(cmp_org_text(Some("A"), None), Some(Ordering::Less));
        assert_eq!(cmp_org_text(Some(" A "), Some("A")), None);
        assert_eq!(cmp_org_text(Some("  "), None), None);
    }
}
