//! Tuyển dụng (M12): 10 endpoint `/api/v1/management/recruitment/*`. Bản TS: `services/crm/src/recruitment`.
//! (`GET /reports/marketing/recruitment-overview` thuộc module báo cáo.)
//!
//! | Quyền | Endpoint | Hàm |
//! |---|---|---|
//! | `recruitment.view` | `GET /candidates`, `GET /stats`, `GET /positions`, `GET /recruiters` | [`list_candidates`], [`stats`], [`list_positions`], [`list_recruiters`] |
//! | `recruitment.manage` | `POST /candidates`, `PATCH/DELETE /candidates/:id` | [`create_candidate`], [`update_candidate`], [`remove_candidate`] |
//! | `recruitment.manage` | `POST /positions`, `PATCH/DELETE /positions/:id` | [`create_position`], [`update_position`], [`remove_position`] |
//!
//! Dữ liệu vào đã qua bộ kiểm chung K15 ([`validate`], DTO trong `contracts/dto/schema.json`, đối chiếu `ValidationPipe`
//! thật bằng golden): hàm nhận thân đã kiểm dạng `Map` (khoá không gửi = không đổi; `null` = xoá cột nếu cột cho phép).
//! `search` dùng `ILIKE '%…%'` KHÔNG thoát `%` và `_`: Prisma `contains` cũng không thoát (đã đo: `?search=%` khớp mọi dòng).
//!
//! Khác bản Node đã biết: thứ tự khoá của `by_source`/`by_stage`/… theo chữ cái (Node theo thứ tự `GROUP BY`, không xác
//! định); ngày bộ lọc `date_from`/`date_to` không đọc được ra ngày ⇒ 400 (Node lỗi DB 500).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, NaiveDate, Utc};
use http::Method;
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{PgConnection, QueryBuilder, Row};
use trinity_db::types::{DbDate, Timestamp};
use trinity_http::router::{Access, RouteSpec};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::{OkIdBody, db};

pub const STAGES: [&str; 6] = ["applied", "sent_manager", "interview", "test", "offer", "hired"];

// ---- Kiểm dữ liệu vào (bộ chung K15) -----------------------------------------------------------------------------

/// Kiểm thân/query theo DTO `name` (strict): trả `Map` đã chuyển kiểu, đã bỏ khoá không khai báo.
pub fn validate(name: &str, v: &Value) -> Result<Map<String, Value>, AppError> {
    match validate_value(name, v, Mode::Strict)? {
        Value::Object(m) => Ok(m),
        _ => Ok(Map::new()),
    }
}

// ---- Dòng trả về --------------------------------------------------------------------------------------------------

/// Như `mapCandidate`: thứ tự khoá, ngày cắt `YYYY-MM-DD`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CandidateRow {
    pub id: i32,
    pub full_name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub position: Option<String>,
    pub department: Option<String>,
    pub source: Option<String>,
    pub stage: String,
    pub decision: String,
    pub recruitment_type: String,
    pub applied_date: Option<String>,
    pub cost: Option<i32>,
    pub note: Option<String>,
    pub gender: Option<String>,
    pub interview_date: Option<String>,
    pub interview_time: Option<String>,
    pub recruiter_id: Option<i32>,
    pub recruiter_name: Option<String>,
    pub created_at: Timestamp,
}

/// Như `mapPosition`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PositionRow {
    pub id: i32,
    pub job_code: String,
    pub department: String,
    pub team: Option<String>,
    pub position_title: String,
    pub headcount: i32,
    pub recruiter_id: Option<i32>,
    pub recruiter_name: Option<String>,
    pub opened_date: Option<String>,
    pub expected_start_date: Option<String>,
    pub description: Option<String>,
    pub requirements: Option<String>,
    pub recruitment_cost: Option<i32>,
    pub status: String,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pagination {
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub total_pages: i64,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CandidateList {
    pub data: Vec<CandidateRow>,
    pub pagination: Pagination,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PositionList {
    pub data: Vec<PositionRow>,
    pub pagination: Pagination,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Recruiter {
    pub id: i32,
    pub full_name: String,
    pub email: String,
}

fn day(d: Option<DbDate>) -> Option<String> {
    d.map(|d| d.0.format("%Y-%m-%d").to_string())
}

fn s(m: &Map<String, Value>, k: &str) -> Option<String> {
    m.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// Cột `int4` từ thân đã kiểm: ngoài khoảng ⇒ 400 (không lưu NULL, không xoá giá trị cũ; Node để lỗi DB thành 500).
fn int4(m: &Map<String, Value>, k: &str) -> Result<Option<i32>, AppError> {
    match m.get(k).and_then(Value::as_i64) {
        None => Ok(None),
        Some(v) => i32::try_from(v)
            .map(Some)
            .map_err(|_| HttpError::bad_request(format!("{k} phải nhỏ hơn hoặc bằng {}", i32::MAX)).into()),
    }
}

fn n(m: &Map<String, Value>, k: &str) -> Option<i64> {
    m.get(k).and_then(Value::as_i64)
}

/// Chuỗi khác rỗng (`if (dto.stage)` của Node: rỗng là falsy).
fn truthy(m: &Map<String, Value>, k: &str) -> Option<String> {
    s(m, k).filter(|v| !v.is_empty())
}

/// `new Date(str)` của V8 cho mọi chuỗi mà `@IsDateString` (validator.js `isISO8601`) cho qua và V8 đọc được: `YYYY`,
/// `YYYY-MM`, `YYYY-MM-DD` (UTC), `…T` hoặc dấu cách rồi `hh:mm[:ss[.fff…]]` kèm `Z`, `±hh:mm` hoặc `±hhmm` (không múi giờ =
/// giờ máy chủ, chạy `TZ=UTC`). Như V8: ngày 1 đến 31 ở mọi tháng (`2026-02-30` thành `2026-03-02`), `24:00` là nửa đêm hôm sau,
/// phần thập phân cắt ở mili giây. Dạng V8 không đọc được (tuần ISO, ngày thứ tự, `YYYYMMDD`, `T01` thiếu phút…) ⇒ `None`
/// (Node: `Invalid Date`, Prisma lỗi 500). Đối chiếu bằng `tests/fixtures/dates.json` sinh từ `new Date()` thật.
pub fn parse_instant(v: &str) -> Option<DateTime<Utc>> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)? ?$",
        )
        .expect("regex hợp lệ")
    });
    let c = RE.captures(v)?;
    let num = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().unwrap_or(0));
    let year = i32::try_from(num(1)?).ok()?;
    let month = u32::try_from(num(2).unwrap_or(1)).ok()?;
    let day = u32::try_from(num(3).unwrap_or(1)).ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (h, mi, sec) = (num(4).unwrap_or(0), num(5).unwrap_or(0), num(6).unwrap_or(0));
    let ms = c.get(7).map_or(0, |m| {
        format!("{:0<3}", &m.as_str()[..m.as_str().len().min(3)])
            .parse::<i64>()
            .unwrap_or(0)
    });
    if mi > 59 || sec > 59 || h > 24 || (h == 24 && (mi, sec, ms) != (0, 0, 0)) {
        return None;
    }
    let offset_min = match c.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(z) => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits: String = z[1..].chars().filter(char::is_ascii_digit).collect();
            let (oh, om) = (digits[..2].parse::<i64>().ok()?, digits[2..].parse::<i64>().ok()?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 60 + om)
        }
    };
    let date = NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(chrono::Days::new(u64::from(day - 1)))?;
    let local =
        date.and_time(chrono::NaiveTime::MIN) + chrono::Duration::milliseconds(((h * 60 + mi) * 60 + sec) * 1000 + ms);
    Some((local - chrono::Duration::minutes(offset_min)).and_utc())
}

fn invalid_date(field: &str) -> AppError {
    HttpError::bad_request(format!("{field} không phải ngày hợp lệ")).into()
}

/// Ngày lưu vào cột `date`: phần ngày UTC của thời điểm (Prisma ghi `DateTime` vào `@db.Date` như vậy).
fn date_col(m: &Map<String, Value>, k: &str) -> Result<Option<NaiveDate>, AppError> {
    match m.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) => parse_instant(v)
            .map(|d| Some(d.date_naive()))
            .ok_or_else(|| invalid_date(k)),
    }
}

fn not_found_candidate() -> AppError {
    HttpError::not_found("Không tìm thấy ứng viên").into()
}

fn not_found_position() -> AppError {
    HttpError::not_found("Không tìm thấy vị trí tuyển dụng").into()
}

async fn recruiter_names(
    conn: &mut PgConnection,
    ids: &[Option<i32>],
) -> Result<std::collections::HashMap<i32, String>, AppError> {
    let mut distinct: Vec<i32> = ids.iter().flatten().copied().collect();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.is_empty() {
        return Ok(Default::default());
    }
    let rows = sqlx::query("SELECT id, full_name FROM users WHERE id = ANY($1)")
        .bind(&distinct)
        .fetch_all(conn)
        .await
        .map_err(db)?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get::<i32, _>("id").map_err(db)?,
                r.try_get::<String, _>("full_name").map_err(db)?,
            ))
        })
        .collect()
}

fn pagination(total: i64, page: i64, page_size: i64, returned: usize) -> Pagination {
    Pagination {
        total,
        page,
        page_size,
        total_pages: ((total + page_size - 1) / page_size).max(1),
        has_more: (page - 1)
            .saturating_mul(page_size)
            .saturating_add(i64::try_from(returned).unwrap_or(i64::MAX))
            < total,
    }
}

fn paging(q: &Map<String, Value>) -> (i64, i64) {
    let page = n(q, "page").unwrap_or(1).max(1);
    let size = n(q, "page_size").unwrap_or(25).clamp(1, 100);
    (page, size)
}

macro_rules! candidate_cols {
    () => {
        "id, full_name, phone, email, position, department, source, stage, decision, recruitment_type, applied_date, cost, note, \
         gender, interview_date, interview_time, recruiter_id, created_at"
    };
}
macro_rules! position_cols {
    () => {
        "id, job_code, department, team, position_title, headcount, recruiter_id, opened_date, expected_start_date, description, \
         requirements, recruitment_cost, status, created_at"
    };
}

fn candidate(
    r: &sqlx::postgres::PgRow,
    names: &std::collections::HashMap<i32, String>,
) -> Result<CandidateRow, AppError> {
    let g = |c: &str| -> Result<Option<String>, AppError> { r.try_get(c).map_err(db) };
    let rid: Option<i32> = r.try_get("recruiter_id").map_err(db)?;
    Ok(CandidateRow {
        id: r.try_get("id").map_err(db)?,
        full_name: r.try_get("full_name").map_err(db)?,
        phone: g("phone")?,
        email: g("email")?,
        position: g("position")?,
        department: g("department")?,
        source: g("source")?,
        stage: r.try_get("stage").map_err(db)?,
        decision: r.try_get("decision").map_err(db)?,
        recruitment_type: r.try_get("recruitment_type").map_err(db)?,
        applied_date: day(r.try_get("applied_date").map_err(db)?),
        cost: r.try_get("cost").map_err(db)?,
        note: g("note")?,
        gender: g("gender")?,
        interview_date: day(r.try_get("interview_date").map_err(db)?),
        interview_time: g("interview_time")?,
        recruiter_id: rid,
        recruiter_name: rid.and_then(|i| names.get(&i).cloned()),
        created_at: r.try_get("created_at").map_err(db)?,
    })
}

fn position(
    r: &sqlx::postgres::PgRow,
    names: &std::collections::HashMap<i32, String>,
) -> Result<PositionRow, AppError> {
    let g = |c: &str| -> Result<Option<String>, AppError> { r.try_get(c).map_err(db) };
    let rid: Option<i32> = r.try_get("recruiter_id").map_err(db)?;
    Ok(PositionRow {
        id: r.try_get("id").map_err(db)?,
        job_code: r.try_get("job_code").map_err(db)?,
        department: r.try_get("department").map_err(db)?,
        team: g("team")?,
        position_title: r.try_get("position_title").map_err(db)?,
        headcount: r.try_get("headcount").map_err(db)?,
        recruiter_id: rid,
        recruiter_name: rid.and_then(|i| names.get(&i).cloned()),
        opened_date: day(r.try_get("opened_date").map_err(db)?),
        expected_start_date: day(r.try_get("expected_start_date").map_err(db)?),
        description: g("description")?,
        requirements: g("requirements")?,
        recruitment_cost: r.try_get("recruitment_cost").map_err(db)?,
        status: r.try_get("status").map_err(db)?,
        created_at: r.try_get("created_at").map_err(db)?,
    })
}

// ---- Ứng viên -----------------------------------------------------------------------------------------------------

const CANDIDATE_SORT: [&str; 6] = ["full_name", "applied_date", "cost", "stage", "decision", "source"];

fn candidate_filters(qb: &mut QueryBuilder<sqlx::Postgres>, q: &Map<String, Value>) {
    qb.push(" WHERE TRUE");
    for k in ["stage", "source", "decision", "recruitment_type"] {
        if let Some(v) = truthy(q, k) {
            qb.push(format!(" AND {k} = ")).push_bind(v);
        }
    }
    if let Some(t) = search_term(q) {
        let pat = format!("%{t}%");
        qb.push(" AND (full_name ILIKE ").push_bind(pat.clone());
        qb.push(" OR phone ILIKE ").push_bind(pat.clone());
        qb.push(" OR email ILIKE ").push_bind(pat).push(")");
    }
}

/// `dto.search?.trim()` khác rỗng (trim kiểu JS).
fn search_term(q: &Map<String, Value>) -> Option<String> {
    s(q, "search")
        .map(|v| trinity_kernel::vi::trim_js(&v).to_owned())
        .filter(|v| !v.is_empty())
}

fn order_by(q: &Map<String, Value>, allowed: &[&str], default: &str) -> String {
    match s(q, "sort_by").filter(|f| allowed.contains(&f.as_str())) {
        Some(f) => format!(
            "{f} {} NULLS LAST, id DESC",
            if s(q, "sort_dir").as_deref() == Some("asc") {
                "ASC"
            } else {
                "DESC"
            }
        ),
        None => default.to_owned(),
    }
}

/// `GET /candidates`.
pub async fn list_candidates(conn: &mut PgConnection, q: &Map<String, Value>) -> Result<CandidateList, AppError> {
    let (page, size) = paging(q);
    let mut count = QueryBuilder::new("SELECT count(*) FROM recruitment_candidates");
    candidate_filters(&mut count, q);
    let total: i64 = count.build_query_scalar().fetch_one(&mut *conn).await.map_err(db)?;
    let mut qb = QueryBuilder::new(concat!("SELECT ", candidate_cols!(), " FROM recruitment_candidates"));
    candidate_filters(&mut qb, q);
    qb.push(format!(
        " ORDER BY {}",
        order_by(q, &CANDIDATE_SORT, "applied_date DESC NULLS LAST, id DESC")
    ));
    qb.push(" LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind((page - 1).saturating_mul(size));
    let rows = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let ids: Vec<Option<i32>> = rows.iter().map(|r| r.try_get("recruiter_id").unwrap_or(None)).collect();
    let names = recruiter_names(conn, &ids).await?;
    let data = rows
        .iter()
        .map(|r| candidate(r, &names))
        .collect::<Result<Vec<_>, _>>()?;
    let pagination = pagination(total, page, size, data.len());
    Ok(CandidateList { data, pagination })
}

async fn candidate_by_id(conn: &mut PgConnection, id: i32) -> Result<CandidateRow, AppError> {
    let r = sqlx::query(concat!(
        "SELECT ",
        candidate_cols!(),
        " FROM recruitment_candidates WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let rid: Option<i32> = r.try_get("recruiter_id").map_err(db)?;
    let names = recruiter_names(conn, &[rid]).await?;
    candidate(&r, &names)
}

/// `POST /candidates` (201). Mặc định: `stage = applied`, `decision = pending`, `recruitment_type = external`.
pub async fn create_candidate(
    conn: &mut PgConnection,
    dto: &Map<String, Value>,
    created_by: i32,
) -> Result<CandidateRow, AppError> {
    let applied = date_col(dto, "applied_date")?;
    let interview = date_col(dto, "interview_date")?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO recruitment_candidates (full_name, phone, email, position, department, source, stage, decision, recruitment_type, \
            applied_date, cost, note, gender, interview_date, interview_time, recruiter_id, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'applied'), COALESCE($8, 'pending'), COALESCE($9, 'external'), $10, $11, $12, $13, $14, $15, $16, $17, now()) \
         RETURNING id",
    )
    .bind(s(dto, "full_name"))
    .bind(s(dto, "phone"))
    .bind(s(dto, "email"))
    .bind(s(dto, "position"))
    .bind(s(dto, "department"))
    .bind(s(dto, "source"))
    .bind(s(dto, "stage"))
    .bind(s(dto, "decision"))
    .bind(s(dto, "recruitment_type"))
    .bind(applied)
    .bind(int4(dto, "cost")?)
    .bind(s(dto, "note"))
    .bind(s(dto, "gender"))
    .bind(interview)
    .bind(s(dto, "interview_time"))
    .bind(int4(dto, "recruiter_id")?)
    .bind(created_by)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    candidate_by_id(conn, id).await
}

/// Thêm `col = $n` vào câu UPDATE khi thân có khoá `key` (kể cả `null` ⇒ đặt NULL).
fn set_text(
    qb: &mut QueryBuilder<sqlx::Postgres>,
    first: &mut bool,
    dto: &Map<String, Value>,
    key: &str,
    empty_is_null: bool,
) {
    if let Some(v) = dto.get(key) {
        qb.push(if std::mem::take(first) { " SET " } else { ", " })
            .push(format!("{key} = "));
        let val = v
            .as_str()
            .map(str::to_owned)
            .filter(|x| !(empty_is_null && x.is_empty()));
        qb.push_bind(val);
    }
}

fn set_int(
    qb: &mut QueryBuilder<sqlx::Postgres>,
    first: &mut bool,
    dto: &Map<String, Value>,
    key: &str,
) -> Result<(), AppError> {
    if dto.contains_key(key) {
        let v = int4(dto, key)?;
        qb.push(if std::mem::take(first) { " SET " } else { ", " })
            .push(format!("{key} = "));
        qb.push_bind(v);
    }
    Ok(())
}

fn set_date(
    qb: &mut QueryBuilder<sqlx::Postgres>,
    first: &mut bool,
    dto: &Map<String, Value>,
    key: &str,
) -> Result<(), AppError> {
    if dto.contains_key(key) {
        let d = date_col(dto, key)?;
        qb.push(if std::mem::take(first) { " SET " } else { ", " })
            .push(format!("{key} = "));
        qb.push_bind(d);
    }
    Ok(())
}

/// `PATCH /candidates/:id`: chỉ cột có trong thân; `null` ở cột cho phép NULL đặt NULL.
pub async fn update_candidate(
    conn: &mut PgConnection,
    id: i32,
    dto: &Map<String, Value>,
) -> Result<CandidateRow, AppError> {
    ensure_candidate(conn, id).await?;
    let mut qb = QueryBuilder::new("UPDATE recruitment_candidates");
    let mut first = true;
    for k in [
        "full_name",
        "phone",
        "email",
        "position",
        "department",
        "source",
        "stage",
        "decision",
        "recruitment_type",
        "note",
        "gender",
        "interview_time",
    ] {
        set_text(&mut qb, &mut first, dto, k, false);
    }
    set_date(&mut qb, &mut first, dto, "applied_date")?;
    set_date(&mut qb, &mut first, dto, "interview_date")?;
    set_int(&mut qb, &mut first, dto, "cost")?;
    set_int(&mut qb, &mut first, dto, "recruiter_id")?;
    qb.push(if std::mem::take(&mut first) { " SET " } else { ", " })
        .push("updated_at = now() WHERE id = ")
        .push_bind(id);
    qb.build().execute(&mut *conn).await.map_err(db)?;
    candidate_by_id(conn, id).await
}

async fn ensure_candidate(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let found: Option<i32> = sqlx::query_scalar("SELECT id FROM recruitment_candidates WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    found.map(|_| ()).ok_or_else(not_found_candidate)
}

/// `DELETE /candidates/:id` ⇒ `{ ok: true, id }`.
pub async fn remove_candidate(conn: &mut PgConnection, id: i32) -> Result<OkIdBody, AppError> {
    ensure_candidate(conn, id).await?;
    sqlx::query("DELETE FROM recruitment_candidates WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(OkIdBody { ok: true, id })
}

/// Phản hồi `GET /stats`, thứ tự khoá như bản Node (khoá bên trong các bảng đếm theo chữ cái).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Stats {
    pub total: i64,
    pub total_cost: i64,
    pub by_source: Map<String, Value>,
    pub by_stage: Map<String, Value>,
    pub by_decision: Map<String, Value>,
    pub by_type: Map<String, Value>,
    pub by_month: Vec<Value>,
}

// ---- Thống kê -----------------------------------------------------------------------------------------------------

/// `GET /stats`: `date_from`/`date_to` lọc theo `applied_date` (so với thời điểm đọc từ chuỗi ISO, như `new Date(...)`).
pub async fn stats(conn: &mut PgConnection, q: &Map<String, Value>) -> Result<Stats, AppError> {
    let from = s(q, "date_from")
        .filter(|v| !v.is_empty())
        .map(|v| parse_instant(&v).ok_or_else(|| invalid_date("date_from")))
        .transpose()?;
    let to = s(q, "date_to")
        .filter(|v| !v.is_empty())
        .map(|v| parse_instant(&v).ok_or_else(|| invalid_date("date_to")))
        .transpose()?;
    let filter = |qb: &mut QueryBuilder<sqlx::Postgres>| {
        qb.push(" WHERE TRUE");
        if let Some(f) = from {
            qb.push(" AND applied_date >= ").push_bind(f.naive_utc());
        }
        if let Some(t) = to {
            qb.push(" AND applied_date <= ").push_bind(t.naive_utc());
        }
    };
    let mut qb = QueryBuilder::new(
        "SELECT count(*)::bigint AS total, COALESCE(sum(cost), 0)::bigint AS cost FROM recruitment_candidates",
    );
    filter(&mut qb);
    let r = qb.build().fetch_one(&mut *conn).await.map_err(db)?;
    let total: i64 = r.try_get("total").map_err(db)?;
    let total_cost: i64 = r.try_get("cost").map_err(db)?;

    let group = |col: &'static str| {
        let mut qb = QueryBuilder::new(format!(
            "SELECT {col} AS k, count(*)::bigint AS c FROM recruitment_candidates"
        ));
        filter(&mut qb);
        qb.push(format!(" GROUP BY {col} ORDER BY {col}"));
        qb
    };
    let mut maps = Vec::new();
    for col in ["source", "stage", "decision", "recruitment_type"] {
        let rows = group(col).build().fetch_all(&mut *conn).await.map_err(db)?;
        let mut m = Map::new();
        let mut internal_external = (0_i64, 0_i64);
        for row in &rows {
            let k: Option<String> = row.try_get("k").map_err(db)?;
            let c: i64 = row.try_get("c").map_err(db)?;
            if col == "recruitment_type" {
                match k.as_deref() {
                    Some("internal") => internal_external.0 = c,
                    Some("external") => internal_external.1 = c,
                    _ => {}
                }
            } else {
                m.insert(k.unwrap_or_else(|| "Không rõ".to_owned()), Value::from(c));
            }
        }
        if col == "recruitment_type" {
            m.insert("internal".into(), internal_external.0.into());
            m.insert("external".into(), internal_external.1.into());
        }
        maps.push(m);
    }
    let mut mq = QueryBuilder::new(
        "SELECT to_char(applied_date, 'YYYY-MM') AS month, count(*)::bigint AS c FROM recruitment_candidates",
    );
    filter(&mut mq);
    mq.push(" AND applied_date IS NOT NULL GROUP BY 1 ORDER BY 1");
    let months: Vec<Value> = mq
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        .iter()
        .map(|r| Ok(serde_json::json!({"month": r.try_get::<String, _>("month").map_err(db)?, "count": r.try_get::<i64, _>("c").map_err(db)?})))
        .collect::<Result<_, AppError>>()?;
    let mut it = maps.into_iter();
    let (by_source, by_stage, by_decision, by_type) = (
        it.next().unwrap_or_default(),
        it.next().unwrap_or_default(),
        it.next().unwrap_or_default(),
        it.next().unwrap_or_default(),
    );
    Ok(Stats {
        total,
        total_cost,
        by_source,
        by_stage,
        by_decision,
        by_type,
        by_month: months,
    })
}

// ---- Vị trí tuyển dụng --------------------------------------------------------------------------------------------

const POSITION_SORT: [&str; 7] = [
    "job_code",
    "department",
    "position_title",
    "headcount",
    "opened_date",
    "recruitment_cost",
    "status",
];

fn position_filters(qb: &mut QueryBuilder<sqlx::Postgres>, q: &Map<String, Value>) {
    qb.push(" WHERE TRUE");
    for k in ["status", "department"] {
        if let Some(v) = truthy(q, k) {
            qb.push(format!(" AND {k} = ")).push_bind(v);
        }
    }
    if let Some(t) = search_term(q) {
        let pat = format!("%{t}%");
        qb.push(" AND (job_code ILIKE ").push_bind(pat.clone());
        qb.push(" OR position_title ILIKE ").push_bind(pat.clone());
        qb.push(" OR team ILIKE ").push_bind(pat).push(")");
    }
}

/// `GET /positions`.
pub async fn list_positions(conn: &mut PgConnection, q: &Map<String, Value>) -> Result<PositionList, AppError> {
    let (page, size) = paging(q);
    let mut count = QueryBuilder::new("SELECT count(*) FROM recruitment_positions");
    position_filters(&mut count, q);
    let total: i64 = count.build_query_scalar().fetch_one(&mut *conn).await.map_err(db)?;
    let mut qb = QueryBuilder::new(concat!("SELECT ", position_cols!(), " FROM recruitment_positions"));
    position_filters(&mut qb, q);
    qb.push(format!(
        " ORDER BY {}",
        order_by(q, &POSITION_SORT, "opened_date DESC NULLS LAST, id DESC")
    ));
    qb.push(" LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind((page - 1).saturating_mul(size));
    let rows = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let ids: Vec<Option<i32>> = rows.iter().map(|r| r.try_get("recruiter_id").unwrap_or(None)).collect();
    let names = recruiter_names(conn, &ids).await?;
    let data = rows
        .iter()
        .map(|r| position(r, &names))
        .collect::<Result<Vec<_>, _>>()?;
    let pagination = pagination(total, page, size, data.len());
    Ok(PositionList { data, pagination })
}

async fn position_by_id(conn: &mut PgConnection, id: i32) -> Result<PositionRow, AppError> {
    let r = sqlx::query(concat!(
        "SELECT ",
        position_cols!(),
        " FROM recruitment_positions WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let rid: Option<i32> = r.try_get("recruiter_id").map_err(db)?;
    let names = recruiter_names(conn, &[rid]).await?;
    position(&r, &names)
}

/// `POST /positions` (201). `status` mặc định `open`.
pub async fn create_position(
    conn: &mut PgConnection,
    dto: &Map<String, Value>,
    created_by: i32,
) -> Result<PositionRow, AppError> {
    let opened = date_col(dto, "opened_date")?;
    let expected = date_col(dto, "expected_start_date")?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO recruitment_positions (job_code, department, team, position_title, headcount, recruiter_id, opened_date, \
            expected_start_date, description, requirements, recruitment_cost, status, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, 'open'), $13, now()) RETURNING id",
    )
    .bind(s(dto, "job_code"))
    .bind(s(dto, "department"))
    .bind(s(dto, "team"))
    .bind(s(dto, "position_title"))
    .bind(int4(dto, "headcount")?)
    .bind(int4(dto, "recruiter_id")?)
    .bind(opened)
    .bind(expected)
    .bind(s(dto, "description"))
    .bind(s(dto, "requirements"))
    .bind(int4(dto, "recruitment_cost")?)
    .bind(s(dto, "status"))
    .bind(created_by)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    position_by_id(conn, id).await
}

async fn ensure_position(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let found: Option<i32> = sqlx::query_scalar("SELECT id FROM recruitment_positions WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    found.map(|_| ()).ok_or_else(not_found_position)
}

/// `PATCH /positions/:id`: `team`, `description`, `requirements` rỗng ⇒ NULL (`|| null` của Node); `recruiter_id: null` xoá.
pub async fn update_position(
    conn: &mut PgConnection,
    id: i32,
    dto: &Map<String, Value>,
) -> Result<PositionRow, AppError> {
    ensure_position(conn, id).await?;
    let mut qb = QueryBuilder::new("UPDATE recruitment_positions");
    let mut first = true;
    for k in ["job_code", "department", "position_title", "status"] {
        set_text(&mut qb, &mut first, dto, k, false);
    }
    for k in ["team", "description", "requirements"] {
        set_text(&mut qb, &mut first, dto, k, true);
    }
    set_int(&mut qb, &mut first, dto, "headcount")?;
    set_int(&mut qb, &mut first, dto, "recruiter_id")?;
    set_int(&mut qb, &mut first, dto, "recruitment_cost")?;
    set_date(&mut qb, &mut first, dto, "opened_date")?;
    set_date(&mut qb, &mut first, dto, "expected_start_date")?;
    qb.push(if std::mem::take(&mut first) { " SET " } else { ", " })
        .push("updated_at = now() WHERE id = ")
        .push_bind(id);
    qb.build().execute(&mut *conn).await.map_err(db)?;
    position_by_id(conn, id).await
}

/// `DELETE /positions/:id` ⇒ `{ ok: true, id }`.
pub async fn remove_position(conn: &mut PgConnection, id: i32) -> Result<OkIdBody, AppError> {
    ensure_position(conn, id).await?;
    sqlx::query("DELETE FROM recruitment_positions WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(OkIdBody { ok: true, id })
}

// ---- Người tuyển dụng phụ trách -----------------------------------------------------------------------------------

/// `GET /recruiters`: người dùng còn hoạt động giữ quyền `recruitment.manage` (vai trò hệ thống "Quản trị" có mọi quyền nên
/// luôn được tính), theo tên.
pub async fn list_recruiters(conn: &mut PgConnection) -> Result<Vec<Recruiter>, AppError> {
    let rows = sqlx::query(
        "SELECT u.id, u.full_name, u.email FROM users u \
         WHERE u.deleted_at IS NULL AND u.status = 'active' AND EXISTS ( \
           SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id \
            WHERE ur.user_id = u.id AND (r.is_system OR EXISTS ( \
              SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = 'recruitment.manage'))) \
         ORDER BY u.full_name ASC",
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    rows.iter()
        .map(|r| {
            Ok(Recruiter {
                id: r.try_get("id").map_err(db)?,
                full_name: r.try_get("full_name").map_err(db)?,
                email: r.try_get("email").map_err(db)?,
            })
        })
        .collect()
}

// ---- Bảng route (K14) ---------------------------------------------------------------------------------------------

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 10 route của `RecruitmentController`; so với `contracts/routes.json` ở test cuối file.
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["recruitment.view"]);
    let manage = Access::Can(&["recruitment.manage"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/management/recruitment/stats", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/recruitment/candidates", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/management/recruitment/candidates", manage).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/management/recruitment/candidates/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/recruitment/candidates/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/management/recruitment/recruiters", view).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/management/recruitment/positions", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/management/recruitment/positions", manage).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/management/recruitment/positions/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/management/recruitment/positions/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 10);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 10);
    }
}
