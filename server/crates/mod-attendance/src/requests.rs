//! Đơn chấm công (M14a): `POST/GET /management/attendance/requests`, `POST /requests/:id/approve|reject`. Bản TS:
//! `AttendanceService.createRequest/listRequests/approveRequest/rejectRequest`.
//!
//! - Ngày của đơn là ngày lịch Việt Nam (`work_date`); giờ đề nghị `HH:MM` giờ VN đổi sang UTC bằng `vn_to_utc`.
//! - Phạm vi xem/duyệt lấy từ `ScopeService` TRƯỚC khi lấy kết nối (không giữ hai kết nối cùng lúc); đơn ngoài phạm vi ⇒ 404.
//! - Thông báo cho người duyệt chạy trong savepoint: lỗi chỉ ghi log, đơn vẫn được tạo.
//! - Duyệt đơn quên chấm công/nghỉ phép ghi `attendance_records` trong CÙNG giao dịch với việc đổi trạng thái đơn.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Datelike, Days, Months, NaiveDate, NaiveTime, Utc};
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use serde::Serialize;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::TenantTx;
use trinity_db::outbox::{NewNotification, create_notification};
use trinity_db::types::{DbDate, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;
use trinity_kernel::vn_time::vn_to_utc;
use trinity_rbac::{OwnerIds, push_scope};

use crate::check::{calc_status, hm_minutes, late_minutes, total_hours};
use crate::dto::{CreateAttendanceRequestDto, QueryAttendanceRequestsDto, RejectRequestDto};
use crate::{R, config, db};

/// Số giờ của một ngày công đủ (nghỉ phép/thai sản).
const STANDARD_WORK_HOURS: f64 = 8.0;
const NOT_FOUND: &str = "Không tìm thấy đơn chấm công.";

fn bad(msg: impl Into<String>) -> AppError {
    AppError::Http(HttpError::bad_request(msg.into()))
}

fn not_found() -> AppError {
    AppError::Http(HttpError::not_found(NOT_FOUND))
}

/// `ATTENDANCE_REQUEST_TYPE_LABEL`.
fn type_label(kind: &str) -> &'static str {
    match kind {
        "forgot_check_in" => "Quên check-in",
        "forgot_check_out" => "Quên check-out",
        "late_arrival" => "Đi muộn",
        "early_leave" => "Về sớm",
        "leave" => "Nghỉ phép",
        "maternity" => "Nghỉ thai sản",
        _ => "Đơn chấm công",
    }
}

/// `AttendanceRequestDto` của bản TS (`mapRequest`).
#[derive(Debug, Clone, Serialize)]
pub struct RequestDto {
    pub id: i32,
    pub user_id: i32,
    pub user_name: String,
    /// `YYYY-MM-DD`.
    pub work_date: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub requested_check_in: Option<String>,
    pub requested_check_out: Option<String>,
    pub reason: String,
    pub status: String,
    pub reviewed_by: Option<i32>,
    pub reviewer_name: Option<String>,
    pub reviewed_at: Option<Timestamp>,
    pub review_note: Option<String>,
    pub created_at: Timestamp,
    pub team_name: Option<String>,
}

/// Kết quả `GET /requests`.
#[derive(Debug, Serialize)]
pub struct RequestPage {
    pub data: Vec<RequestDto>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct ReqRow {
    id: i32,
    user_id: i32,
    work_date: DbDate,
    kind: String,
    requested_check_in: Option<String>,
    requested_check_out: Option<String>,
    reason: String,
    status: String,
    reviewed_by: Option<i32>,
    reviewed_at: Option<Timestamp>,
    review_note: Option<String>,
    created_at: Timestamp,
}

const REQ_COLS: &str = "id, user_id, work_date, type AS kind, requested_check_in, requested_check_out, reason, status, \
    reviewed_by, reviewed_at, review_note, created_at";

impl ReqRow {
    fn into_dto(self, user_name: String, reviewer_name: Option<String>, team_name: Option<String>) -> RequestDto {
        RequestDto {
            id: self.id,
            user_id: self.user_id,
            user_name,
            work_date: self.work_date.0.to_string(),
            kind: self.kind,
            requested_check_in: self.requested_check_in,
            requested_check_out: self.requested_check_out,
            reason: self.reason,
            status: self.status,
            reviewed_by: self.reviewed_by,
            reviewer_name,
            reviewed_at: self.reviewed_at,
            review_note: self.review_note,
            created_at: self.created_at,
            team_name,
        }
    }
}

/// `full_name ?? email`.
async fn display_name(conn: &mut PgConnection, id: i32) -> R<Option<String>> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT full_name, email FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    Ok(row.and_then(|(full, email)| full.or(email)))
}

/// Phạm vi theo quyền `permission`; không có phạm vi ⇒ rỗng (đóng, không mở rộng).
async fn owner_of(ctx: &Ctx, actor: &Actor, permission: &str) -> R<OwnerIds> {
    Ok(ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, permission)
        .await
        .map_err(AppError::internal)?
        .unwrap_or(OwnerIds::Ids(Vec::new())))
}

fn in_scope(owner: &OwnerIds, user_id: i32) -> bool {
    match owner {
        OwnerIds::All => true,
        OwnerIds::Ids(ids) => ids.contains(&user_id),
    }
}

/// `Date.UTC(y, m - 1, d)`: ngày vượt số ngày của tháng tràn sang tháng sau như V8 (regex chỉ kiểm dạng chữ số).
pub fn parse_work_date(s: &str) -> Option<NaiveDate> {
    let p = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok());
    let (y, m, d) = (p(0..4)?, p(5..7)?, p(8..10)?);
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(i32::try_from(y).ok()?, m, 1)?;
    first.checked_add_days(Days::new(u64::from(d - 1)))
}

/// Giờ `HH:MM` giờ VN trên ngày `day` sang UTC (`vnTimeToInstant`).
fn vn_instant(day: NaiveDate, hm: &str) -> R<DateTime<Utc>> {
    let t =
        NaiveTime::parse_from_str(hm, "%H:%M").map_err(|_| AppError::internal(format!("giờ không hợp lệ: {hm}")))?;
    Ok(vn_to_utc(day, t))
}

// ───────────────────────────── tạo đơn ─────────────────────────────

/// Đơn quên chấm công và đơn đi muộn/về sớm bị chặn theo hạn mức tháng (0 = không giới hạn); đơn bị từ chối không tính.
async fn assert_monthly_limit(conn: &mut PgConnection, user_id: i32, kind: &str, day: NaiveDate) -> R<()> {
    let forgot = kind == "forgot_check_in" || kind == "forgot_check_out";
    let late_early = kind == "late_arrival" || kind == "early_leave";
    if !forgot && !late_early {
        return Ok(());
    }
    let cfg = config::get_request_config(conn).await?;
    let limit = if forgot {
        cfg.monthly_forgot_limit
    } else {
        cfg.monthly_late_early_limit
    };
    if limit <= 0 {
        return Ok(());
    }
    let types: &[&str] = if forgot {
        &["forgot_check_in", "forgot_check_out"]
    } else {
        &["late_arrival", "early_leave"]
    };
    let first = day.with_day(1).unwrap_or(day);
    let next = first
        .checked_add_months(Months::new(1))
        .ok_or_else(|| bad("Ngày không hợp lệ"))?;
    let used: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attendance_requests WHERE user_id = $1 AND type = ANY($2) AND status IN ('pending', 'approved')
           AND work_date >= $3 AND work_date < $4",
    )
    .bind(user_id)
    .bind(types)
    .bind(first)
    .bind(next)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    if used >= limit {
        let label = first.format("%m/%Y");
        let what = if forgot {
            "quên chấm công"
        } else {
            "đi trễ/về sớm"
        };
        return Err(bad(format!(
            "Bạn đã dùng hết {limit} lần {what} của tháng {label}. Vui lòng liên hệ quản lý/nhân sự."
        )));
    }
    Ok(())
}

/// `findUserIdsWithPermission`: vai trò hệ thống có mọi quyền, cộng vai trò được cấp quyền đó.
async fn roster_with_permission(conn: &mut PgConnection, permission: &str) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT DISTINCT ur.user_id FROM user_roles ur
         JOIN users u ON u.id = ur.user_id AND u.status = 'active' AND u.deleted_at IS NULL
         WHERE ur.role_id IN (SELECT r.id FROM roles r WHERE r.is_system OR EXISTS (SELECT 1 FROM role_permissions g WHERE g.role_id = r.id AND g.permission = $1))
         ORDER BY ur.user_id",
    )
    .bind(permission)
    .fetch_all(conn)
    .await
}

/// Dựng thông báo gửi người giữ `attendance.manage` (rỗng nếu không có ai).
async fn build_notifications(
    tx: &mut TenantTx,
    kind: &str,
    work_date: &str,
    user_name: &str,
    reason: &str,
) -> Result<Vec<NewNotification>, sqlx::Error> {
    let recipients = roster_with_permission(tx, "attendance.manage").await?;
    let mut parts = work_date.split('-');
    let date_label = match (parts.next(), parts.next(), parts.next()) {
        (Some(y), Some(m), Some(d)) if !y.is_empty() && !m.is_empty() && !d.is_empty() => format!("{d}/{m}/{y}"),
        _ => work_date.to_owned(),
    };
    let preview: String = trim_js(reason).chars().take(100).collect();
    Ok(recipients
        .into_iter()
        .map(|recipient_id| NewNotification {
            recipient_id,
            event_type: "attendance.request.created".to_owned(),
            title: format!("Đơn chấm công mới • {}", type_label(kind)),
            body: format!("{user_name} — ngày {date_label}: {preview}"),
            action_url: Some("/management/workdays".to_owned()),
        })
        .collect())
}

/// Chạy một câu lệnh savepoint; `true` nếu thành công.
async fn savepoint(tx: &mut TenantTx, sql: &'static str) -> bool {
    sqlx::query(sql).execute(&mut **tx).await.is_ok()
}

/// Thông báo cho người duyệt trong savepoint: lỗi chỉ ghi log, không làm hỏng việc tạo đơn.
async fn notify_created(
    tx: &mut TenantTx,
    request_id: i32,
    kind: &str,
    work_date: &str,
    user_name: &str,
    reason: &str,
) {
    if !savepoint(tx, "SAVEPOINT att_notify").await {
        return;
    }
    let outcome = match build_notifications(tx, kind, work_date, user_name, reason).await {
        Ok(items) if items.is_empty() => Ok(()),
        Ok(items) => create_notification(tx, &items)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = outcome {
        tracing::warn!("notifyAttendanceRequestCreated failed for request {request_id}: {e}");
        savepoint(tx, "ROLLBACK TO SAVEPOINT att_notify").await;
    }
    savepoint(tx, "RELEASE SAVEPOINT att_notify").await;
}

/// `POST /requests` (201): nhân viên gửi đơn của chính mình.
pub async fn create(ctx: &Ctx, actor: &Actor, dto: &CreateAttendanceRequestDto) -> R<RequestDto> {
    if dto.kind == "forgot_check_in" && dto.requested_check_in.is_none() {
        return Err(bad(
            "Vui lòng nhập giờ check-in đề nghị (requested_check_in) cho đơn quên check-in.",
        ));
    }
    if dto.kind == "forgot_check_out" && dto.requested_check_out.is_none() {
        return Err(bad(
            "Vui lòng nhập giờ check-out đề nghị (requested_check_out) cho đơn quên check-out.",
        ));
    }
    let day = parse_work_date(&dto.work_date).ok_or_else(|| bad("work_date phải có định dạng YYYY-MM-DD"))?;
    let mut tx = ctx.begin(actor.company).await?;
    let conn: &mut PgConnection = &mut tx;
    assert_monthly_limit(conn, actor.user_id, &dto.kind, day).await?;
    let row: ReqRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO attendance_requests (user_id, work_date, type, requested_check_in, requested_check_out, reason, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', now()) RETURNING {REQ_COLS}"
    )))
    .bind(actor.user_id)
    .bind(day)
    .bind(&dto.kind)
    .bind(dto.requested_check_in.as_deref())
    .bind(dto.requested_check_out.as_deref())
    .bind(&dto.reason)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let user_name = display_name(conn, actor.user_id)
        .await?
        .unwrap_or_else(|| actor.user_id.to_string());
    let shown = row.work_date.0.to_string();
    notify_created(&mut tx, row.id, &dto.kind, &shown, &user_name, &dto.reason).await;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(row.into_dto(user_name, None, None))
}

// ───────────────────────────── danh sách ─────────────────────────────

/// Team CHÍNH THỨC: `employees.team_id` → NV là trưởng nhóm → quản lý là trưởng nhóm (alias `e`, `u`).
const RESOLVED_TEAM_ID: &str = "COALESCE(e.team_id,
    (SELECT tl.id FROM teams tl WHERE tl.team_lead_id = u.id ORDER BY tl.id LIMIT 1),
    (SELECT tm.id FROM teams tm WHERE tm.team_lead_id = u.manager_id ORDER BY tm.id LIMIT 1))";

const FROM: &str =
    " FROM attendance_requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN employees e ON e.user_id = r.user_id";

fn i32_of(v: i64, name: &str) -> R<i32> {
    i32::try_from(v).map_err(|_| bad(format!("{name} không hợp lệ")))
}

fn push_filters(
    qb: &mut QueryBuilder<Postgres>,
    owner: &OwnerIds,
    q: &QueryAttendanceRequestsDto,
    team: Option<i32>,
    job_title: Option<i32>,
) {
    qb.push(" WHERE ");
    push_scope(qb, owner, &["r.user_id"]);
    if let Some(s) = q.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND r.status = ").push_bind(s.to_owned());
    }
    if let Some(d) = q.department.as_deref().map(trim_js).filter(|d| !d.is_empty()) {
        qb.push(" AND e.department = ").push_bind(d.to_owned());
    }
    if let Some(j) = job_title {
        qb.push(" AND e.job_title_id = ").push_bind(j);
    }
    if let Some(t) = team {
        qb.push(format!(" AND {RESOLVED_TEAM_ID} = ")).push_bind(t);
    }
}

#[derive(Debug, sqlx::FromRow)]
struct ListRow {
    #[sqlx(flatten)]
    req: ReqRow,
    user_full_name: Option<String>,
    user_email: Option<String>,
    reviewer_full_name: Option<String>,
    reviewer_email: Option<String>,
    team_name: Option<String>,
}

/// `GET /requests`: phạm vi `attendance.view`; lọc theo trạng thái, phòng ban, chức danh, team (3 tầng).
pub async fn list(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceRequestsDto) -> R<RequestPage> {
    let team = q
        .team_id
        .filter(|t| *t != 0)
        .map(|t| i32_of(t, "team_id"))
        .transpose()?;
    let job_title = q
        .job_title_id
        .filter(|j| *j != 0)
        .map(|j| i32_of(j, "job_title_id"))
        .transpose()?;
    let page = q.page.unwrap_or(1).max(1);
    // Giao diện quản trị gửi page_size=1000 để tải hết rồi lọc phía client: tối đa 2000 đơn.
    let page_size = q.page_size.unwrap_or(20).clamp(1, 2000);
    let skip = (page - 1).saturating_mul(page_size);
    let owner = owner_of(ctx, actor, "attendance.view").await?;
    let mut conn = ctx.conn(actor.company).await?;

    let mut cq = QueryBuilder::<Postgres>::new("SELECT count(*)");
    cq.push(FROM);
    push_filters(&mut cq, &owner, q, team, job_title);
    let count = cq.build_query_scalar::<i64>();
    let total = count.fetch_one(&mut *conn).await.map_err(db)?;

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT r.id, r.user_id, r.work_date, r.type AS kind, r.requested_check_in, r.requested_check_out, r.reason, r.status,
            r.reviewed_by, r.reviewed_at, r.review_note, r.created_at,
            u.full_name AS user_full_name, u.email AS user_email, rv.full_name AS reviewer_full_name, rv.email AS reviewer_email,
            t.name AS team_name",
    );
    qb.push(FROM);
    qb.push(" LEFT JOIN users rv ON rv.id = r.reviewed_by LEFT JOIN teams t ON t.id = ");
    qb.push(RESOLVED_TEAM_ID);
    push_filters(&mut qb, &owner, q, team, job_title);
    qb.push(" ORDER BY r.created_at DESC, r.id DESC LIMIT ");
    qb.push_bind(page_size);
    qb.push(" OFFSET ");
    qb.push_bind(skip);
    let query = qb.build_query_as::<ListRow>();
    let rows = query.fetch_all(&mut *conn).await.map_err(db)?;

    let data = rows
        .into_iter()
        .map(|r| {
            let user_name = r
                .user_full_name
                .or(r.user_email)
                .unwrap_or_else(|| r.req.user_id.to_string());
            let reviewer = r.reviewer_full_name.or(r.reviewer_email);
            r.req.into_dto(user_name, reviewer, r.team_name)
        })
        .collect();
    Ok(RequestPage {
        data,
        total,
        page,
        page_size,
    })
}

// ───────────────────────────── duyệt / từ chối ─────────────────────────────

async fn lock_pending(conn: &mut PgConnection, owner: &OwnerIds, id: i32) -> R<ReqRow> {
    let row: Option<ReqRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {REQ_COLS} FROM attendance_requests WHERE id = $1 FOR UPDATE"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    let visible = row.filter(|r| in_scope(owner, r.user_id));
    let req = visible.ok_or_else(not_found)?;
    if req.status != "pending" {
        return Err(bad(format!("Đơn đã được xử lý (trạng thái: {}).", req.status)));
    }
    Ok(req)
}

const EXISTING_SQL: &str =
    "SELECT check_in_at, check_out_at FROM attendance_records WHERE user_id = $1 AND work_date = $2";

/// Bản ghi chấm công sau khi duyệt đơn quên chấm công: giờ mới, số phút muộn, tổng giờ, trạng thái.
async fn apply_forgot(conn: &mut PgConnection, req: &ReqRow, employee_id: Option<i32>) -> R<()> {
    let day = req.work_date.0;
    let shift = config::get_shift(conn).await?;
    let cfg = config::get_request_config(conn).await?;
    let existing: Option<(Option<Timestamp>, Option<Timestamp>)> = sqlx::query_as(EXISTING_SQL)
        .bind(req.user_id)
        .bind(day)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let (cur_in, cur_out) = existing.map_or((None, None), |(i, o)| (i.map(|t| t.0), o.map(|t| t.0)));
    let new_in = if req.kind == "forgot_check_in" {
        let hm = req.requested_check_in.as_deref().unwrap_or(&cfg.default_check_in);
        Some(vn_instant(day, hm)?)
    } else {
        cur_in
    };
    let new_out = if req.kind == "forgot_check_out" {
        let hm = req.requested_check_out.as_deref().unwrap_or(&cfg.default_check_out);
        Some(vn_instant(day, hm)?)
    } else {
        cur_out
    };
    let late = new_in.map_or(0, |t| late_minutes(t, hm_minutes(&shift.late_after)));
    let hours = match (new_in, new_out) {
        (Some(i), Some(o)) => total_hours(i, o, &shift),
        _ => None,
    };
    let status = match (new_in, new_out) {
        (Some(_), Some(_)) => calc_status(hours.unwrap_or(0.0), &shift),
        _ => "incomplete",
    };
    sqlx::query(
        "INSERT INTO attendance_records (user_id, employee_id, work_date, check_in_at, check_out_at, late_minutes, total_hours, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_id, work_date) DO UPDATE SET check_in_at = EXCLUDED.check_in_at, check_out_at = EXCLUDED.check_out_at,
            late_minutes = EXCLUDED.late_minutes, total_hours = COALESCE(EXCLUDED.total_hours, attendance_records.total_hours),
            status = EXCLUDED.status, updated_at = now()",
    )
    .bind(req.user_id)
    .bind(employee_id)
    .bind(day)
    .bind(new_in)
    .bind(new_out)
    .bind(late)
    .bind(hours)
    .bind(status)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Nghỉ phép/thai sản là ngày công đủ: giờ chuẩn của cấu hình đơn, 8 giờ, không muộn; trạng thái giữ nguyên loại đơn.
async fn apply_leave(conn: &mut PgConnection, req: &ReqRow, employee_id: Option<i32>) -> R<()> {
    let day = req.work_date.0;
    let cfg = config::get_request_config(conn).await?;
    let check_in = vn_instant(day, &cfg.default_check_in)?;
    let check_out = vn_instant(day, &cfg.default_check_out)?;
    sqlx::query(
        "INSERT INTO attendance_records (user_id, employee_id, work_date, check_in_at, check_out_at, total_hours, late_minutes, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, now())
         ON CONFLICT (user_id, work_date) DO UPDATE SET check_in_at = EXCLUDED.check_in_at, check_out_at = EXCLUDED.check_out_at,
            total_hours = EXCLUDED.total_hours, late_minutes = 0, status = EXCLUDED.status, updated_at = now()",
    )
    .bind(req.user_id)
    .bind(employee_id)
    .bind(day)
    .bind(check_in)
    .bind(check_out)
    .bind(STANDARD_WORK_HOURS)
    .bind(&req.kind)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Ghi `attendance_records` theo loại đơn (đi muộn/về sớm không đụng tới bản ghi).
async fn apply_effect(conn: &mut PgConnection, req: &ReqRow) -> R<()> {
    let employee_id: Option<i32> = sqlx::query_scalar("SELECT id FROM employees WHERE user_id = $1")
        .bind(req.user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    match req.kind.as_str() {
        "forgot_check_in" | "forgot_check_out" => apply_forgot(conn, req, employee_id).await,
        "leave" | "maternity" => apply_leave(conn, req, employee_id).await,
        _ => Ok(()),
    }
}

/// `POST /requests/:id/approve` (201): phạm vi `attendance.manage`.
pub async fn approve(ctx: &Ctx, actor: &Actor, id: i32) -> R<RequestDto> {
    let owner = owner_of(ctx, actor, "attendance.manage").await?;
    let mut tx = ctx.begin(actor.company).await?;
    let conn: &mut PgConnection = &mut tx;
    let req = lock_pending(conn, &owner, id).await?;
    let updated: ReqRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE attendance_requests SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
         WHERE id = $1 RETURNING {REQ_COLS}"
    )))
    .bind(id)
    .bind(actor.user_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    apply_effect(conn, &req).await?;
    let dto = with_names(conn, updated, actor.user_id).await?;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(dto)
}

/// `POST /requests/:id/reject` (201): phạm vi `attendance.manage`.
pub async fn reject(ctx: &Ctx, actor: &Actor, id: i32, dto: &RejectRequestDto) -> R<RequestDto> {
    let owner = owner_of(ctx, actor, "attendance.manage").await?;
    let mut tx = ctx.begin(actor.company).await?;
    let conn: &mut PgConnection = &mut tx;
    lock_pending(conn, &owner, id).await?;
    let updated: ReqRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE attendance_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now()
         WHERE id = $1 RETURNING {REQ_COLS}"
    )))
    .bind(id)
    .bind(actor.user_id)
    .bind(dto.review_note.as_deref())
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let out = with_names(conn, updated, actor.user_id).await?;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(out)
}

/// Tên người gửi (`full_name ?? email ?? id`) và người duyệt (`full_name ?? email ?? null`); không có tên đội.
async fn with_names(conn: &mut PgConnection, row: ReqRow, reviewer: i32) -> R<RequestDto> {
    let requester = display_name(conn, row.user_id)
        .await?
        .unwrap_or_else(|| row.user_id.to_string());
    let reviewer_name = display_name(conn, reviewer).await?;
    Ok(row.into_dto(requester, reviewer_name, None))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn ngay_don_tran_nhu_v8() {
        assert_eq!(parse_work_date("2026-06-17").unwrap().to_string(), "2026-06-17");
        // 31/02 tràn sang tháng sau như `Date.UTC`.
        assert_eq!(parse_work_date("2026-02-31").unwrap().to_string(), "2026-03-03");
        assert_eq!(parse_work_date("2026-12-32").unwrap().to_string(), "2027-01-01");
        assert!(parse_work_date("2026-13-01").is_none());
        assert!(parse_work_date("2026-06-00").is_none());
    }

    #[test]
    fn nhan_loai_don() {
        assert_eq!(type_label("leave"), "Nghỉ phép");
        assert_eq!(type_label("khac"), "Đơn chấm công");
    }

    #[test]
    fn pham_vi_dong_khi_rong() {
        assert!(in_scope(&OwnerIds::All, 1));
        assert!(!in_scope(&OwnerIds::Ids(Vec::new()), 1));
        assert!(in_scope(&OwnerIds::Ids(vec![1, 2]), 2));
    }
}
