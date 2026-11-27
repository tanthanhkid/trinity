//! Hợp đồng lao động và hồ sơ mẫu hợp đồng (M11): 13 endpoint `/api/v1/management/contracts*`. Bản TS:
//! `services/crm/src/contracts`. Chỉ tải lên và tải xuống tệp (không sinh tài liệu).
//!
//! - Danh sách liệt kê THEO NHÂN VIÊN (mọi nhân viên, kể cả "chưa có hợp đồng"), mỗi dòng đính kèm hợp đồng mới nhất; phạm
//!   vi `contracts.view` tính trên `user_id` của nhân viên. Thống kê dùng lại đúng phép map của danh sách.
//! - Tệp hợp đồng: PDF/JPG/PNG/WEBP; mẫu: PDF/Word/Excel; mỗi tệp ≤ 20 MB; tải xuống đúng byte đã tải lên (đi qua backend).
//!   Khoá lưu trữ nằm ở `file_url` (hợp đồng) và `storage_key` (mẫu).
//! - Ghi DB lỗi sau khi đã tải tệp lên ⇒ xoá tệp vừa tải (không mồ côi); thay/xoá tệp cũ làm best-effort sau khi DB đã đổi.
//!
//! Ghi (`POST/PATCH/DELETE`, tệp, mẫu) chỉ cần `contracts.manage`, KHÔNG kiểm phạm vi `contracts.view` theo nhân viên: đúng bản TS
//! (chỉ các đường đọc kiểm phạm vi).
//!
//! Khác bản TS có chủ đích: ô `search` thoát `\ % _` (Node dùng `contains` không thoát); xoá tệp cũ chạy ngay trong request
//! (best-effort, lỗi chỉ ghi log) thay vì nền.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err, clippy::type_complexity)]

use std::collections::{HashMap, HashSet};

use axum::body::Body;
use bytes::Bytes;
use chrono::{DateTime, Datelike, Duration, Utc};
use mod_users::guards::{Actor, db, scope_err};
use serde::Serialize;
use sqlx::{AssertSqlSafe, PgConnection, Postgres, QueryBuilder};
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::{Collation, compare, escape_like, trim_js};
use trinity_kernel::vn_time::vn_date;
use trinity_rbac::{OwnerIds, push_scope};
use trinity_storage::{LocalDiskDriver, S3Driver, StorageError};

use crate::contract_dto::{CreateContractDto, QueryContractStatsDto, QueryContractsDto, UpdateContractDto};
use crate::employees::{Ctx, R};
use crate::teams::{self, TeamFilterRow};

/// Ngưỡng cảnh báo "sắp hết hạn": còn ≤ 30 ngày.
pub const EXPIRY_WARNING_DAYS: i64 = 30;
pub const FILE_MAX_BYTES: usize = 20 * 1024 * 1024;
pub const CONTRACT_FILE_MIME: [&str; 4] = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
pub const CONTRACT_FILE_MIME_ERROR: &str = "Chỉ chấp nhận file PDF, JPG, PNG hoặc WEBP.";
pub const TEMPLATE_MIME: [&str; 5] = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
pub const TEMPLATE_MIME_ERROR: &str = "Chỉ chấp nhận file PDF, Word (.doc/.docx) hoặc Excel (.xls/.xlsx).";

const DAY_MS: i64 = 86_400_000;

fn http(e: HttpError) -> AppError {
    AppError::Http(e)
}

fn nf_contract() -> AppError {
    http(HttpError::not_found("Không tìm thấy hợp đồng"))
}

// ───────────────────────────── kho tệp ─────────────────────────────

/// Kho tệp của hợp đồng: đĩa cục bộ hoặc S3/MinIO (cùng khoá).
pub enum ContractStore {
    Local(LocalDiskDriver),
    S3(S3Driver),
}

/// Một tệp đọc ra để trả về trình duyệt.
pub struct Download {
    pub body: Body,
    pub content_type: String,
    pub content_length: Option<u64>,
}

impl ContractStore {
    pub async fn put(&self, key: &str, body: Bytes, content_type: &str) -> Result<(), StorageError> {
        match self {
            Self::Local(d) => d.upload(key, &body, content_type).await.map(drop),
            Self::S3(d) => d.upload(key, body, content_type).await.map(drop),
        }
    }

    pub async fn remove(&self, key: &str) {
        let r = match self {
            Self::Local(d) => d.delete(key).await,
            Self::S3(d) => d.delete(key).await,
        };
        if let Err(e) = r {
            tracing::warn!("Xoá tệp hợp đồng {key} lỗi: {e}");
        }
    }

    async fn get(&self, key: &str) -> Result<Download, StorageError> {
        match self {
            Self::Local(d) => {
                let o = d.get(key).await?;
                Ok(Download {
                    body: Body::from_stream(tokio_util::io::ReaderStream::new(o.file)),
                    content_type: o.content_type,
                    content_length: Some(o.size),
                })
            }
            Self::S3(d) => {
                let o = d.get(key).await?;
                Ok(Download {
                    body: Body::from_stream(o.stream),
                    content_type: o.content_type,
                    content_length: Some(o.size),
                })
            }
        }
    }
}

fn store_err(e: StorageError, what: &str) -> AppError {
    match e {
        StorageError::NotFound(_) => http(HttpError::not_found(format!("Không tìm thấy {what}"))),
        other => AppError::internal(other),
    }
}

/// Phụ thuộc của route hợp đồng: ngữ cảnh chung của module nhân sự cộng kho tệp.
pub struct ContractsCtx {
    pub ctx: std::sync::Arc<Ctx>,
    pub store: ContractStore,
}

// ───────────────────────────── tên tệp ─────────────────────────────

/// `decodeMultipartFilename`: bỏ ký tự điều khiển, `/` và `\` (thành `_`) rồi cắt khoảng trắng. Tên từ axum đã là UTF-8 đúng
/// (bản Node phải sửa mojibake do busboy giải Latin-1), nên không cần đảo mã ở đây.
pub fn decode_multipart_filename(raw: Option<&str>) -> String {
    let raw = raw.unwrap_or("");
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || c == '/' || c == '\\' {
                '_'
            } else {
                c
            }
        })
        .collect();
    trim_js(&cleaned).to_owned()
}

/// `repairMojibakeText`: tên đã lưu từ lúc chưa sửa mojibake (toàn ký tự ≤ 0xFF, là byte UTF-8 bị đọc thành Latin-1) được
/// giải lại; tên UTF-8 đúng (có ký tự > 0xFF) hoặc giải ra UTF-8 sai thì giữ nguyên. Idempotent.
pub fn repair_mojibake_text(raw: &str) -> String {
    if raw.chars().any(|c| u32::from(c) > 0xFF) {
        return raw.to_owned();
    }
    let bytes: Vec<u8> = raw.chars().map(|c| c as u8).collect();
    match String::from_utf8(bytes) {
        Ok(s) if !s.contains('\u{FFFD}') => s,
        _ => raw.to_owned(),
    }
}

/// `name.replace(/[^a-zA-Z0-9._-]/g, '_')`: regex không cờ `u` nên ký tự ngoài BMP (2 đơn vị UTF-16) thành `__`.
fn safe_name(name: &str) -> String {
    name.chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
            std::iter::repeat_n(if keep { c } else { '_' }, if keep { 1 } else { c.len_utf16() })
        })
        .collect()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ───────────────────────────── trạng thái hợp đồng ─────────────────────────────

/// `computeContractStatus`: `(trạng thái, số ngày còn lại)`; `no_contract` do nơi gọi gán, không bao giờ trả ở đây.
pub fn compute_status(end: Option<DateTime<Utc>>, terminated: bool, now: DateTime<Utc>) -> (&'static str, Option<i64>) {
    if terminated {
        return ("terminated", None);
    }
    let Some(end) = end else { return ("active", None) };
    let diff = (end - now).num_milliseconds();
    // So mốc thời gian trước khi làm tròn: ceil(-0.33) = -0 sẽ lọt nhánh "expiring".
    if diff < 0 {
        return ("expired", Some((-1).min(ceil_div(diff, DAY_MS))));
    }
    let days = ceil_div(diff, DAY_MS);
    if days <= EXPIRY_WARNING_DAYS {
        ("expiring", Some(days))
    } else {
        ("active", Some(days))
    }
}

fn ceil_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b) + i64::from(a.rem_euclid(b) != 0)
}

/// `new Date(str)` cho mọi dạng `@IsDateString` (dùng lại bộ phân tích của M10: `YYYY`, `YYYY-MM`, giờ, `Z`, `±HHmm`, dấu cách).
fn parse_date(s: &str) -> R<DateTime<Utc>> {
    crate::employees_write::instant(s)
}

// ───────────────────────────── hợp đồng một dòng ─────────────────────────────

#[derive(Debug, sqlx::FromRow)]
struct ContractRow {
    id: i32,
    employee_id: i32,
    contract_type: String,
    signed_date: Timestamp,
    end_date: Option<Timestamp>,
    file_url: Option<String>,
    notes: Option<String>,
    is_terminated: bool,
    terminated_at: Option<Timestamp>,
    created_at: Timestamp,
    updated_at: Timestamp,
    e_id: i32,
    e_code: Option<String>,
    e_position: String,
    e_department: Option<String>,
    e_gender: Option<String>,
    u_name: Option<String>,
    u_email: Option<String>,
    u_avatar: Option<String>,
    jt_name: Option<String>,
}

const CONTRACT_SELECT: &str =
    "SELECT c.id, c.employee_id, c.contract_type, c.signed_date, c.end_date, c.file_url, c.notes,
  c.is_terminated, c.terminated_at, c.created_at, c.updated_at,
  e.id AS e_id, e.employee_code AS e_code, e.position AS e_position, e.department AS e_department, e.gender AS e_gender,
  u.full_name AS u_name, u.email AS u_email, u.avatar_url AS u_avatar, jt.name AS jt_name
FROM employee_contracts c JOIN employees e ON e.id = c.employee_id LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN job_titles jt ON jt.id = e.job_title_id";

#[derive(Debug, Serialize)]
pub struct ContractEmployee {
    pub id: i32,
    pub employee_code: String,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub position: String,
    pub department: Option<String>,
    pub gender: Option<String>,
    pub job_title_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Contract {
    pub id: i32,
    pub contract_type: String,
    pub signed_date: Timestamp,
    pub end_date: Option<Timestamp>,
    pub file_url: Option<String>,
    pub notes: Option<String>,
    pub is_terminated: bool,
    pub terminated_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub status: &'static str,
    pub days_remaining: Option<i64>,
    pub employee: ContractEmployee,
}

fn map_contract(r: ContractRow, now: DateTime<Utc>) -> Contract {
    let (status, days_remaining) = compute_status(r.end_date.map(|t| t.0), r.is_terminated, now);
    Contract {
        id: r.id,
        contract_type: r.contract_type,
        signed_date: r.signed_date,
        end_date: r.end_date,
        file_url: r.file_url,
        notes: r.notes,
        is_terminated: r.is_terminated,
        terminated_at: r.terminated_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        status,
        days_remaining,
        employee: ContractEmployee {
            id: r.e_id,
            employee_code: r.e_code.unwrap_or_else(|| format!("NV{:04}", r.e_id)),
            full_name: r.u_name,
            email: r.u_email,
            avatar_url: r.u_avatar,
            position: r.e_position,
            department: r.e_department,
            gender: r.e_gender,
            job_title_name: r.jt_name,
        },
    }
}

async fn load_contract(conn: &mut PgConnection, id: i32) -> R<Option<ContractRow>> {
    sqlx::query_as::<_, ContractRow>(AssertSqlSafe(format!("{CONTRACT_SELECT} WHERE c.id = $1")))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

async fn view_scope(ctx: &Ctx, actor: &Actor) -> R<OwnerIds> {
    Ok(ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "contracts.view")
        .await
        .map_err(AppError::internal)?
        .unwrap_or(OwnerIds::Ids(Vec::new())))
}

/// Hợp đồng ngoài phạm vi `contracts.view` ⇒ 404 (chủ = `user_id` của nhân viên; nhân viên không còn ⇒ không ai phủ).
async fn assert_in_scope(ctx: &Ctx, conn: &mut PgConnection, actor: &Actor, employee_id: i32) -> R<()> {
    let user_id: Option<i32> = sqlx::query_scalar("SELECT user_id FROM employees WHERE id = $1")
        .bind(employee_id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    ctx.scopes
        .assert_in_scope(
            actor.company,
            actor.user_id,
            &actor.grants,
            "contracts.view",
            &[user_id],
        )
        .await
        .map_err(scope_err)
}

// ───────────────────────────── dòng theo nhân viên (danh sách + thống kê) ─────────────────────────────

#[derive(Debug, sqlx::FromRow)]
struct EmpRow {
    id: i32,
    user_id: i32,
    employee_code: Option<String>,
    position: String,
    department: Option<String>,
    gender: Option<String>,
    status: String,
    team_id: Option<i32>,
    u_name: Option<String>,
    u_email: Option<String>,
    u_avatar: Option<String>,
    u_manager_id: Option<i32>,
    u_status: Option<String>,
    m_name: Option<String>,
    jt_name: Option<String>,
    c_id: Option<i32>,
    c_type: Option<String>,
    c_signed: Option<Timestamp>,
    c_end: Option<Timestamp>,
    c_file: Option<String>,
    c_notes: Option<String>,
    c_terminated: Option<bool>,
    c_terminated_at: Option<Timestamp>,
    c_created: Option<Timestamp>,
    c_updated: Option<Timestamp>,
}

const EMP_SELECT: &str = "SELECT e.id, e.user_id, e.employee_code, e.position, e.department, e.gender, e.status, e.team_id,
  u.full_name AS u_name, u.email AS u_email, u.avatar_url AS u_avatar, u.manager_id AS u_manager_id, u.status AS u_status,
  m.full_name AS m_name, jt.name AS jt_name,
  c.id AS c_id, c.contract_type AS c_type, c.signed_date AS c_signed, c.end_date AS c_end, c.file_url AS c_file,
  c.notes AS c_notes, c.is_terminated AS c_terminated, c.terminated_at AS c_terminated_at, c.created_at AS c_created,
  c.updated_at AS c_updated
FROM employees e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users m ON m.id = u.manager_id
  LEFT JOIN job_titles jt ON jt.id = e.job_title_id
  LEFT JOIN LATERAL (SELECT x.id, x.contract_type, x.signed_date, x.end_date, x.file_url, x.notes, x.is_terminated, x.terminated_at, x.created_at, x.updated_at FROM employee_contracts x WHERE x.employee_id = e.id ORDER BY x.signed_date DESC, x.id DESC LIMIT 1) c ON TRUE";

#[derive(Debug, Serialize)]
pub struct RowEmployee {
    pub id: i32,
    pub user_id: i32,
    pub employee_code: String,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub position: String,
    pub department: Option<String>,
    pub gender: Option<String>,
    pub team_lead_name: Option<String>,
    pub team_lead_id: Option<i32>,
    pub job_title_name: Option<String>,
    pub employment_status: &'static str,
}

/// Dòng danh sách: một nhân viên + hợp đồng mới nhất (phẳng, trường hợp đồng có thể `null` = "Chưa có hợp đồng").
#[derive(Debug, Serialize)]
pub struct ContractRowOut {
    pub id: Option<i32>,
    pub contract_type: Option<String>,
    pub signed_date: Option<Timestamp>,
    pub end_date: Option<Timestamp>,
    pub file_url: Option<String>,
    pub notes: Option<String>,
    pub is_terminated: bool,
    pub terminated_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
    pub status: &'static str,
    pub days_remaining: Option<i64>,
    pub employee: RowEmployee,
}

/// Team hiển thị: chính NV là trưởng nhóm của một team, hoặc quản lý của NV là trưởng nhóm; không thì không có.
fn derive_team(
    user_id: i32,
    own_name: &str,
    manager_id: Option<i32>,
    manager_name: Option<&str>,
    leads: &HashSet<i32>,
) -> (Option<i32>, Option<String>) {
    if leads.contains(&user_id) {
        return (Some(user_id), Some(own_name.to_owned()));
    }
    if let Some(m) = manager_id.filter(|m| leads.contains(m)) {
        return (Some(m), manager_name.map(str::to_owned));
    }
    (None, None)
}

fn map_emp(e: &EmpRow, leads: &HashSet<i32>, now: DateTime<Utc>) -> ContractRowOut {
    let has = e.c_id.is_some();
    let (status, days_remaining) = if has {
        compute_status(e.c_end.map(|t| t.0), e.c_terminated.unwrap_or(false), now)
    } else {
        ("no_contract", None)
    };
    // nghỉ việc = employees.status = 'resigned' HOẶC tài khoản bị khoá.
    let resigned = e.status == "resigned" || e.u_status.as_deref() == Some("locked");
    let (lead_id, lead_name) = derive_team(
        e.user_id,
        e.u_name.as_deref().unwrap_or(""),
        e.u_manager_id,
        e.m_name.as_deref(),
        leads,
    );
    ContractRowOut {
        id: e.c_id,
        contract_type: e.c_type.clone(),
        signed_date: e.c_signed,
        end_date: e.c_end,
        file_url: e.c_file.clone(),
        notes: e.c_notes.clone(),
        is_terminated: e.c_terminated.unwrap_or(false),
        terminated_at: e.c_terminated_at,
        created_at: e.c_created,
        updated_at: e.c_updated,
        status,
        days_remaining,
        employee: RowEmployee {
            id: e.id,
            user_id: e.user_id,
            employee_code: e.employee_code.clone().unwrap_or_else(|| format!("NV{:04}", e.id)),
            full_name: e.u_name.clone(),
            email: e.u_email.clone(),
            avatar_url: e.u_avatar.clone(),
            position: e.position.clone(),
            department: e.department.clone(),
            gender: e.gender.clone(),
            team_lead_name: lead_name,
            team_lead_id: lead_id,
            job_title_name: e.jt_name.clone(),
            employment_status: if resigned { "resigned" } else { "working" },
        },
    }
}

fn lead_set(teams: &[TeamFilterRow]) -> HashSet<i32> {
    teams.iter().filter_map(|t| t.team_lead_id).collect()
}

fn employment_filter(qb: &mut QueryBuilder<Postgres>, v: Option<&str>) {
    match v {
        Some("resigned") => {
            qb.push(" AND (e.status = 'resigned' OR u.status = 'locked')");
        }
        Some("working") => {
            qb.push(" AND e.status <> 'resigned' AND u.status <> 'locked'");
        }
        _ => {}
    }
}

fn contract_cond(status: &str, now: DateTime<Utc>) -> Option<(&'static str, Vec<DateTime<Utc>>)> {
    let warn = now + Duration::days(EXPIRY_WARNING_DAYS);
    Some(match status {
        "terminated" => ("x.is_terminated", vec![]),
        "active" => (
            "NOT x.is_terminated AND (x.end_date IS NULL OR x.end_date > $)",
            vec![warn],
        ),
        "expiring" => (
            "NOT x.is_terminated AND x.end_date >= $ AND x.end_date <= $",
            vec![now, warn],
        ),
        "expired" => ("NOT x.is_terminated AND x.end_date < $", vec![now]),
        _ => return None,
    })
}

// ───────────────────────────── sắp xếp danh sách ─────────────────────────────

fn team_rank(lead: Option<i32>, rank: &HashMap<i32, usize>) -> usize {
    match lead {
        None => 999_999,
        Some(l) => rank.get(&l).copied().unwrap_or(500_000),
    }
}

fn vi(a: &str, b: &str) -> std::cmp::Ordering {
    compare(a, b, Collation::Vi)
}

fn compare_by_team(a: &ContractRowOut, b: &ContractRowOut, rank: &HashMap<i32, usize>) -> std::cmp::Ordering {
    let (ra, rb) = (
        team_rank(a.employee.team_lead_id, rank),
        team_rank(b.employee.team_lead_id, rank),
    );
    if ra != rb {
        return ra.cmp(&rb);
    }
    let (la, lb) = (
        a.employee.team_lead_id.unwrap_or(0),
        b.employee.team_lead_id.unwrap_or(0),
    );
    if la != lb {
        return la.cmp(&lb);
    }
    let lead = |e: &RowEmployee| i32::from(Some(e.user_id) != e.team_lead_id);
    let (sa, sb) = (lead(&a.employee), lead(&b.employee));
    if sa != sb {
        return sa.cmp(&sb);
    }
    vi(
        a.employee.full_name.as_deref().unwrap_or(""),
        b.employee.full_name.as_deref().unwrap_or(""),
    )
}

fn sort_rows(rows: &mut [ContractRowOut], field: &str, desc: bool) {
    use std::cmp::Ordering;
    enum V {
        S(String),
        N(i64),
    }
    let dir = |o: Ordering| if desc { o.reverse() } else { o };
    rows.sort_by(|a, b| {
        let pick = |r: &ContractRowOut| -> Option<V> {
            match field {
                "full_name" => r.employee.full_name.clone().map(V::S),
                "employee_code" => Some(V::S(r.employee.employee_code.clone())),
                "signed_date" => r.signed_date.map(|t| V::N(t.0.timestamp_millis())),
                "end_date" => r.end_date.map(|t| V::N(t.0.timestamp_millis())),
                "days_remaining" => r.days_remaining.map(V::N),
                "status" => Some(V::S(r.status.to_owned())),
                "contract_type" => r.contract_type.clone().map(V::S),
                "department" => r.employee.department.clone().map(V::S),
                _ => None,
            }
        };
        if !matches!(
            field,
            "full_name"
                | "employee_code"
                | "signed_date"
                | "end_date"
                | "days_remaining"
                | "status"
                | "contract_type"
                | "department"
        ) {
            return Ordering::Equal;
        }
        // Giá trị rỗng luôn xuống cuối, bất kể hướng sắp.
        match (pick(a), pick(b)) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(V::N(x)), Some(V::N(y))) => dir(x.cmp(&y)),
            (Some(V::S(x)), Some(V::S(y))) => dir(vi(&x, &y)),
            _ => Ordering::Equal,
        }
    });
}

// ───────────────────────────── danh sách ─────────────────────────────

#[derive(Debug, Serialize)]
pub struct Pagination {
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Debug, Serialize)]
pub struct ContractPage {
    pub data: Vec<ContractRowOut>,
    pub pagination: Pagination,
}

/// `GET /management/contracts`.
pub async fn find_all(ctx: &Ctx, actor: &Actor, q: &QueryContractsDto, now: DateTime<Utc>) -> R<ContractPage> {
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(25).clamp(1, 200);
    let owner = view_scope(ctx, actor).await?;

    let mut qb = QueryBuilder::<Postgres>::new(EMP_SELECT);
    qb.push(" WHERE ");
    push_scope(&mut qb, &owner, &["e.user_id"]);
    qb.push(" AND e.deleted_at IS NULL");
    if let Some(s) = q.department.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.department = ").push_bind(s.to_owned());
    }
    if let Some(s) = q.position.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.position = ").push_bind(s.to_owned());
    }
    employment_filter(&mut qb, q.employment_status.as_deref());
    if let Some(term) = q.search.as_deref().map(trim_js).filter(|s| !s.is_empty()) {
        let pat = format!("%{}%", escape_like(term));
        qb.push(" AND (e.employee_code ILIKE ")
            .push_bind(pat.clone())
            .push(" ESCAPE '\\' OR u.full_name ILIKE ")
            .push_bind(pat.clone())
            .push(" ESCAPE '\\' OR u.email ILIKE ")
            .push_bind(pat)
            .push(" ESCAPE '\\'");
        if let Ok(id) = term.parse::<f64>()
            && id.fract() == 0.0
            && id > 0.0
            && id <= f64::from(i32::MAX)
        {
            qb.push(" OR e.id = ").push_bind(id as i32);
        }
        qb.push(")");
    }
    let no_contract = q.status.as_deref() == Some("no_contract");
    // `some` + `none` mâu thuẫn ⇒ bỏ lọc loại khi đang lọc "chưa có hợp đồng".
    if let Some(t) = q.contract_type.as_deref().filter(|s| !s.is_empty() && !no_contract) {
        qb.push(" AND EXISTS (SELECT 1 FROM employee_contracts x WHERE x.employee_id = e.id AND x.contract_type = ")
            .push_bind(t.to_owned())
            .push(")");
    }
    if no_contract {
        qb.push(" AND NOT EXISTS (SELECT 1 FROM employee_contracts x WHERE x.employee_id = e.id)");
    } else if let Some((cond, args)) = q.status.as_deref().and_then(|s| contract_cond(s, now)) {
        qb.push(" AND EXISTS (SELECT 1 FROM employee_contracts x WHERE x.employee_id = e.id AND ");
        let mut parts = cond.split('$');
        qb.push(parts.next().unwrap_or(""));
        for (a, rest) in args.into_iter().zip(parts) {
            qb.push_bind(a).push(rest);
        }
        qb.push(")");
    }

    let mut conn = ctx.conn(actor.company).await?;
    let all: Vec<EmpRow> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    let teams = teams::list_for_filter(&mut conn, false).await?;
    let rank: HashMap<i32, usize> = teams.iter().enumerate().fold(HashMap::new(), |mut m, (i, t)| {
        if let Some(l) = t.team_lead_id {
            m.entry(l).or_insert(i);
        }
        m
    });
    let leads = lead_set(&teams);
    let mut mapped: Vec<ContractRowOut> = all.iter().map(|e| map_emp(e, &leads, now)).collect();
    match q.sort_by.as_deref().filter(|s| !s.is_empty()) {
        Some(field) => sort_rows(&mut mapped, field, q.sort_dir.as_deref() == Some("desc")),
        None => mapped.sort_by(|a, b| compare_by_team(a, b, &rank)),
    }

    // Lọc theo team CHÍNH THỨC (id bảng `teams`): gán trực tiếp → chính NV là trưởng nhóm → quản lý là trưởng nhóm.
    if let Some(team) = q.team.as_deref().filter(|s| !s.is_empty()) {
        let all_teams: Vec<(i32, Option<i32>)> = sqlx::query_as("SELECT id, team_lead_id FROM teams")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
        let ids: HashSet<i32> = all_teams.iter().map(|t| t.0).collect();
        let mut by_lead: HashMap<i32, i32> = HashMap::new();
        for (id, lead) in &all_teams {
            if let Some(l) = lead {
                by_lead.entry(*l).or_insert(*id);
            }
        }
        let formal: HashMap<i32, Option<i32>> = all
            .iter()
            .map(|e| {
                let t = e
                    .team_id
                    .filter(|t| ids.contains(t))
                    .or_else(|| by_lead.get(&e.user_id).copied())
                    .or_else(|| e.u_manager_id.and_then(|m| by_lead.get(&m).copied()));
                (e.id, t)
            })
            .collect();
        mapped.retain(|m| {
            formal
                .get(&m.employee.id)
                .copied()
                .flatten()
                .map(|t| t.to_string())
                .as_deref()
                == Some(team)
        });
    }

    let total = i64::try_from(mapped.len()).unwrap_or(i64::MAX);
    // `page` rất lớn: nhân bão hoà rồi vượt số dòng ⇒ trang rỗng (không tràn số).
    let skip = usize::try_from((page - 1).saturating_mul(page_size)).unwrap_or(usize::MAX);
    let take = usize::try_from(page_size).unwrap_or(25);
    let data: Vec<ContractRowOut> = mapped.into_iter().skip(skip).take(take).collect();
    Ok(ContractPage {
        data,
        pagination: Pagination {
            page,
            page_size,
            total,
            total_pages: total.saturating_add(page_size - 1) / page_size,
        },
    })
}

// ───────────────────────────── chi tiết, tạo, sửa, xoá ─────────────────────────────

/// `GET /management/contracts/:id`: ngoài phạm vi `contracts.view` ⇒ 404.
pub async fn find_by_id(ctx: &Ctx, actor: &Actor, id: i32, now: DateTime<Utc>) -> R<Contract> {
    let mut conn = ctx.conn(actor.company).await?;
    let row = load_contract(&mut conn, id).await?.ok_or_else(nf_contract)?;
    assert_in_scope(ctx, &mut conn, actor, row.employee_id).await?;
    Ok(map_contract(row, now))
}

/// `POST /management/contracts`: nhân viên phải tồn tại; tệp CHỈ đặt qua upload (`file_url` của body bị bỏ).
pub async fn create(ctx: &Ctx, actor: &Actor, dto: &CreateContractDto, now: DateTime<Utc>) -> R<Contract> {
    let mut conn = ctx.conn(actor.company).await?;
    let emp_id = i32::try_from(dto.employee_id).ok();
    let exists: Option<i32> = match emp_id {
        Some(id) => sqlx::query_scalar("SELECT id FROM employees WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?,
        None => None,
    };
    let Some(employee_id) = exists else {
        return Err(http(HttpError::not_found("Không tìm thấy nhân viên")));
    };
    let terminated = dto.is_terminated.unwrap_or(false);
    let signed = parse_date(&dto.signed_date)?;
    let end = dto
        .end_date
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(parse_date)
        .transpose()?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO employee_contracts (employee_id, contract_type, signed_date, end_date, file_url, notes, is_terminated, terminated_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, CASE WHEN $6 THEN now() ELSE NULL END, now()) RETURNING id",
    )
    .bind(employee_id)
    .bind(dto.contract_type.as_deref().unwrap_or("hdld_1"))
    .bind(signed)
    .bind(end)
    .bind(&dto.notes)
    .bind(terminated)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let row = load_contract(&mut conn, id).await?.ok_or_else(nf_contract)?;
    Ok(map_contract(row, now))
}

/// `PATCH /management/contracts/:id`: không đổi được nhân viên; chuyển sang chấm dứt ghi `terminated_at`, bỏ chấm dứt xoá nó.
pub async fn update(ctx: &Ctx, actor: &Actor, id: i32, dto: &UpdateContractDto, now: DateTime<Utc>) -> R<Contract> {
    let mut tx = ctx.begin(actor.company).await?;
    let existing: Option<bool> =
        sqlx::query_scalar("SELECT is_terminated FROM employee_contracts WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    let Some(was_terminated) = existing else {
        return Err(nf_contract());
    };
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE employee_contracts SET updated_at = now()");
    if let Some(t) = &dto.contract_type {
        qb.push(", contract_type = ").push_bind(t.clone());
    }
    if let Some(s) = &dto.signed_date {
        qb.push(", signed_date = ").push_bind(parse_date(s)?);
    }
    if let Some(e) = &dto.end_date {
        let v = e.as_deref().filter(|s| !s.is_empty()).map(parse_date).transpose()?;
        qb.push(", end_date = ").push_bind(v);
    }
    if let Some(n) = &dto.notes {
        qb.push(", notes = ").push_bind(n.clone());
    }
    if let Some(t) = dto.is_terminated {
        qb.push(", is_terminated = ").push_bind(t);
        if t && !was_terminated {
            qb.push(", terminated_at = now()");
        } else if !t {
            qb.push(", terminated_at = NULL");
        }
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.build().execute(&mut *tx).await.map_err(db)?;
    let row = load_contract(&mut tx, id).await?.ok_or_else(nf_contract)?;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(map_contract(row, now))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Ok1 {
    pub ok: bool,
}

/// `DELETE /management/contracts/:id`: xoá cả tệp đính kèm (dữ liệu cá nhân) để không mồ côi.
pub async fn remove(cc: &ContractsCtx, actor: &Actor, id: i32) -> R<Ok1> {
    let mut conn = cc.ctx.conn(actor.company).await?;
    let file: Option<Option<String>> = sqlx::query_scalar("SELECT file_url FROM employee_contracts WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some(file) = file else { return Err(nf_contract()) };
    sqlx::query("DELETE FROM employee_contracts WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    if let Some(key) = file {
        cc.store.remove(&key).await;
    }
    Ok(Ok1 { ok: true })
}

// ───────────────────────────── tệp hợp đồng ─────────────────────────────

/// Tệp người dùng tải lên (đã qua kiểm loại và cỡ).
pub struct Upload {
    pub file_name: Option<String>,
    pub mime: String,
    pub data: Bytes,
}

/// `POST /management/contracts/:id/file`: lưu tệp, ghi khoá vào `file_url`; DB lỗi ⇒ xoá tệp vừa tải; thay tệp ⇒ xoá tệp cũ.
pub async fn upload_file(cc: &ContractsCtx, actor: &Actor, id: i32, file: Upload, now: DateTime<Utc>) -> R<Contract> {
    let mut conn = cc.ctx.conn(actor.company).await?;
    let existing: Option<(i32, Option<String>)> =
        sqlx::query_as("SELECT employee_id, file_url FROM employee_contracts WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((employee_id, _)) = existing else {
        return Err(nf_contract());
    };
    let decoded = decode_multipart_filename(file.file_name.as_deref());
    let safe = safe_name(if decoded.is_empty() { "hop-dong" } else { &decoded });
    let key = format!("contracts/{employee_id}/{id}/{}_{safe}", now.timestamp_millis());
    cc.store
        .put(&key, file.data, &file.mime)
        .await
        .map_err(AppError::internal)?;
    // Khoá cũ lấy NGAY trong câu UPDATE (không dùng giá trị đọc trước đó, có thể đã đổi nếu hai lượt tải song song).
    let upd: Result<Option<Option<String>>, sqlx::Error> = sqlx::query_scalar(
        "WITH old AS (SELECT id, file_url FROM employee_contracts WHERE id = $1 FOR UPDATE)
         UPDATE employee_contracts c SET file_url = $2, updated_at = now() FROM old WHERE c.id = old.id RETURNING old.file_url",
    )
    .bind(id)
    .bind(&key)
    .fetch_optional(&mut *conn)
    .await;
    let replaced = match upd {
        Ok(Some(old)) => old,
        Ok(None) => {
            cc.store.remove(&key).await;
            return Err(nf_contract());
        }
        Err(e) => {
            cc.store.remove(&key).await;
            return Err(db(e));
        }
    };
    if let Some(old) = replaced.filter(|o| *o != key) {
        cc.store.remove(&old).await;
    }
    let row = load_contract(&mut conn, id).await?.ok_or_else(nf_contract)?;
    Ok(map_contract(row, now))
}

/// Tên hiển thị khi tải: phần cuối của khoá, bỏ tiền tố `<số>_`.
fn display_name(key: &str) -> String {
    let base = key.rsplit('/').next().unwrap_or("hop-dong");
    let digits = base.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && base.as_bytes().get(digits) == Some(&b'_') {
        base[digits + 1..].to_owned()
    } else {
        base.to_owned()
    }
}

/// Tệp trả về cho trình duyệt: nội dung, loại, cỡ, tên.
pub struct FileOut {
    pub download: Download,
    pub file_name: String,
    pub content_type: String,
}

/// `GET /management/contracts/:id/file`: stream qua backend; ngoài phạm vi ⇒ 404; chưa có tệp ⇒ 404.
pub async fn stream_file(cc: &ContractsCtx, actor: &Actor, id: i32) -> R<FileOut> {
    let mut conn = cc.ctx.conn(actor.company).await?;
    let row: Option<(i32, Option<String>)> =
        sqlx::query_as("SELECT employee_id, file_url FROM employee_contracts WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((employee_id, file)) = row else {
        return Err(nf_contract());
    };
    assert_in_scope(&cc.ctx, &mut conn, actor, employee_id).await?;
    let Some(key) = file else {
        return Err(http(HttpError::not_found("Hợp đồng chưa có file đính kèm")));
    };
    let download = cc.store.get(&key).await.map_err(|e| store_err(e, "tệp hợp đồng"))?;
    let content_type = download.content_type.clone();
    Ok(FileOut {
        file_name: display_name(&key),
        content_type,
        download,
    })
}

/// `DELETE /management/contracts/:id/file`.
pub async fn remove_file(cc: &ContractsCtx, actor: &Actor, id: i32, now: DateTime<Utc>) -> R<Contract> {
    let mut conn = cc.ctx.conn(actor.company).await?;
    // Đổi DB trước (lấy khoá cũ ngay trong câu lệnh), xoá object sau: lỗi giữa chừng chỉ để lại object mồ côi, không để
    // `file_url` trỏ vào tệp đã mất.
    let old: Option<Option<String>> = sqlx::query_scalar(
        "WITH old AS (SELECT id, file_url FROM employee_contracts WHERE id = $1 FOR UPDATE)
         UPDATE employee_contracts c SET file_url = NULL, updated_at = now() FROM old WHERE c.id = old.id RETURNING old.file_url",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let Some(old) = old else { return Err(nf_contract()) };
    if let Some(key) = old {
        cc.store.remove(&key).await;
    }
    let row = load_contract(&mut conn, id).await?.ok_or_else(nf_contract)?;
    Ok(map_contract(row, now))
}

// ───────────────────────────── hồ sơ mẫu ─────────────────────────────

#[derive(Debug, sqlx::FromRow)]
struct TemplateRow {
    id: i32,
    name: String,
    storage_key: String,
    mime: String,
    size: i32,
    uploaded_by: Option<i32>,
    created_at: Timestamp,
}

#[derive(Debug, Serialize)]
pub struct Template {
    pub id: i32,
    pub name: String,
    pub mime: String,
    pub size: i32,
    pub uploaded_by: Option<i32>,
    pub created_at: Timestamp,
}

fn map_template(t: TemplateRow) -> Template {
    Template {
        id: t.id,
        // Sửa mojibake cho tên mẫu cũ (idempotent).
        name: repair_mojibake_text(&t.name),
        mime: t.mime,
        size: t.size,
        uploaded_by: t.uploaded_by,
        created_at: t.created_at,
    }
}

const TEMPLATE_COLS: &str = "id, name, storage_key, mime, size, uploaded_by, created_at";

/// `GET /management/contracts/templates`: mới nhất trước.
pub async fn list_templates(ctx: &Ctx, actor: &Actor) -> R<Vec<Template>> {
    let mut conn = ctx.conn(actor.company).await?;
    let rows: Vec<TemplateRow> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {TEMPLATE_COLS} FROM contract_templates ORDER BY created_at DESC, id DESC"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(map_template).collect())
}

/// `POST /management/contracts/templates`: tệp mẫu chung, không gắn nhân viên. DB lỗi ⇒ xoá tệp vừa tải.
pub async fn upload_template(
    cc: &ContractsCtx,
    actor: &Actor,
    file: Upload,
    display: Option<&str>,
    now: DateTime<Utc>,
) -> R<Template> {
    let decoded = decode_multipart_filename(file.file_name.as_deref());
    let safe = safe_name(if decoded.is_empty() { "mau-hop-dong" } else { &decoded });
    let key = format!("contract-templates/{}_{safe}", now.timestamp_millis());
    let name = display
        .map(trim_js)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| (!decoded.is_empty()).then(|| decoded.clone()))
        .unwrap_or_else(|| safe.clone());
    let size = i32::try_from(file.data.len()).unwrap_or(i32::MAX);
    cc.store
        .put(&key, file.data, &file.mime)
        .await
        .map_err(AppError::internal)?;
    let mut conn = cc.ctx.conn(actor.company).await?;
    let row: Result<TemplateRow, sqlx::Error> = sqlx::query_as(AssertSqlSafe(format!(
        "INSERT INTO contract_templates (name, storage_key, mime, size, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING {TEMPLATE_COLS}"
    )))
    .bind(&name)
    .bind(&key)
    .bind(&file.mime)
    .bind(size)
    .bind(actor.user_id)
    .fetch_one(&mut *conn)
    .await;
    match row {
        Ok(r) => Ok(map_template(r)),
        Err(e) => {
            cc.store.remove(&key).await;
            Err(db(e))
        }
    }
}

/// `GET /management/contracts/templates/:tid/file`: stream qua backend.
pub async fn stream_template(cc: &ContractsCtx, actor: &Actor, id: i32) -> R<FileOut> {
    let mut conn = cc.ctx.conn(actor.company).await?;
    let row: Option<TemplateRow> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {TEMPLATE_COLS} FROM contract_templates WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let Some(t) = row else {
        return Err(http(HttpError::not_found("Không tìm thấy hồ sơ mẫu")));
    };
    let download = cc
        .store
        .get(&t.storage_key)
        .await
        .map_err(|e| store_err(e, "tệp mẫu"))?;
    let content_type = if t.mime.is_empty() {
        download.content_type.clone()
    } else {
        t.mime.clone()
    };
    Ok(FileOut {
        file_name: repair_mojibake_text(&t.name),
        content_type,
        download,
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct OkId {
    pub ok: bool,
    pub id: i32,
}

/// `DELETE /management/contracts/templates/:tid`.
pub async fn delete_template(cc: &ContractsCtx, actor: &Actor, id: i32) -> R<OkId> {
    let mut conn = cc.ctx.conn(actor.company).await?;
    let key: Option<String> = sqlx::query_scalar("SELECT storage_key FROM contract_templates WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some(key) = key else {
        return Err(http(HttpError::not_found("Không tìm thấy hồ sơ mẫu")));
    };
    sqlx::query("DELETE FROM contract_templates WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    cc.store.remove(&key).await;
    Ok(OkId { ok: true, id })
}

// ───────────────────────────── thống kê ─────────────────────────────

#[derive(Debug, Serialize)]
pub struct Bucket {
    pub key: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct TeamBucket {
    pub team_lead_id: Option<i32>,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct MonthBucket {
    pub month: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct ContractStats {
    pub total: i64,
    pub by_status: Vec<Bucket>,
    pub by_type: Vec<Bucket>,
    pub by_employment: Vec<Bucket>,
    pub by_team: Vec<TeamBucket>,
    pub signed_by_month: Vec<MonthBucket>,
    pub expiring_3m: Vec<Bucket>,
}

const STATUS_LABEL: [(&str, &str); 5] = [
    ("active", "Đang hiệu lực"),
    ("expiring", "Sắp hết hạn"),
    ("expired", "Hết hạn"),
    ("terminated", "Đã chấm dứt"),
    ("no_contract", "Chưa có HĐ"),
];
const CURRENT_TYPE_KEYS: [&str; 4] = ["hdld_vo_thoi_han", "hdld_1", "hdld_2", "hdld_3"];
const TYPE_LABEL: [(&str, &str); 8] = [
    ("hdld_vo_thoi_han", "HĐLĐ vô thời hạn"),
    ("hdld_1", "HĐLĐ 1"),
    ("hdld_2", "HĐLĐ 2"),
    ("hdld_3", "HĐLĐ 3"),
    ("thu_viec", "Thử việc"),
    ("chinh_thuc", "Chính thức"),
    ("co_thoi_han", "Có thời hạn"),
    ("khong_thoi_han", "Không thời hạn"),
];

fn bucket(key: &str, label: &str, count: i64) -> Bucket {
    Bucket {
        key: key.to_owned(),
        label: label.to_owned(),
        count,
    }
}

/// `GET /management/contracts/stats`: dùng lại phép map của danh sách nên trạng thái, loại HĐ và team khớp 100%.
pub async fn get_stats(ctx: &Ctx, actor: &Actor, q: &QueryContractStatsDto, now: DateTime<Utc>) -> R<ContractStats> {
    let owner = view_scope(ctx, actor).await?;
    let mut qb = QueryBuilder::<Postgres>::new(EMP_SELECT);
    qb.push(" WHERE ");
    push_scope(&mut qb, &owner, &["e.user_id"]);
    qb.push(" AND e.deleted_at IS NULL");
    if let Some(s) = q.department.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.department = ").push_bind(s.to_owned());
    }
    employment_filter(&mut qb, q.employment_status.as_deref());
    let mut conn = ctx.conn(actor.company).await?;
    let all: Vec<EmpRow> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    let teams = teams::list_for_filter(&mut conn, false).await?;
    let leads = lead_set(&teams);
    let mut rows: Vec<ContractRowOut> = all.iter().map(|e| map_emp(e, &leads, now)).collect();

    // `team` ở thống kê là team_lead_id (trường dẫn xuất), khác bộ lọc của danh sách.
    if let Some(team) = q.team.as_deref().filter(|s| !s.is_empty()) {
        rows.retain(|r| r.employee.team_lead_id.map(|t| t.to_string()).as_deref() == Some(team));
    }
    // Khoảng ngày theo `signed_date`; nhân viên chưa có hợp đồng không khớp khoảng ngày. `signed_date` lưu nửa đêm VN theo
    // UTC nên cộng 7 giờ trước khi so với mốc ngày thuần.
    if q.date_from.is_some() || q.date_to.is_some() {
        let from = q
            .date_from
            .as_deref()
            .map(parse_date)
            .transpose()?
            .map(|d| d.timestamp_millis());
        let to = q
            .date_to
            .as_deref()
            .map(parse_date)
            .transpose()?
            .map(|d| d.timestamp_millis() + DAY_MS - 1);
        rows.retain(|r| {
            let Some(s) = r.signed_date else { return false };
            let vn = s.0.timestamp_millis() + 7 * 3_600_000;
            from.is_none_or(|f| vn >= f) && to.is_none_or(|t| vn <= t)
        });
    }

    let mut status_count: HashMap<&str, i64> = HashMap::new();
    let mut type_count: HashMap<String, i64> = HashMap::new();
    let mut month_count: HashMap<String, i64> = HashMap::new();
    let (mut working, mut resigned) = (0_i64, 0_i64);
    let (mut exp1, mut exp2, mut exp3) = (0_i64, 0_i64, 0_i64);
    // Team: nạp sẵn MỌI team chính thức (đếm 0) để team mới tạo hiện ngay; khoá theo `team_lead_id` hoặc `none`.
    let mut team_order: Vec<String> = Vec::new();
    let mut team_map: HashMap<String, TeamBucket> = HashMap::new();
    for t in &teams {
        let k = t.team_lead_id.map_or_else(|| "null".to_owned(), |l| l.to_string());
        if !team_map.contains_key(&k) {
            team_order.push(k.clone());
        }
        team_map.insert(
            k,
            TeamBucket {
                team_lead_id: t.team_lead_id,
                label: t.name.clone(),
                count: 0,
            },
        );
    }
    let official: HashMap<i32, &str> = teams
        .iter()
        .filter_map(|t| t.team_lead_id.map(|l| (l, t.name.as_str())))
        .collect();
    for r in &rows {
        *status_count.entry(r.status).or_insert(0) += 1;
        *type_count
            .entry(r.contract_type.clone().unwrap_or_else(|| "none".to_owned()))
            .or_insert(0) += 1;
        if r.employee.employment_status == "resigned" {
            resigned += 1;
        } else {
            working += 1;
        }
        let key = r
            .employee
            .team_lead_id
            .map_or_else(|| "none".to_owned(), |l| l.to_string());
        if let Some(b) = team_map.get_mut(&key) {
            b.count += 1;
        } else {
            let label = r
                .employee
                .team_lead_id
                .and_then(|l| official.get(&l).map(|n| (*n).to_owned()))
                .or_else(|| r.employee.team_lead_name.clone())
                .unwrap_or_else(|| "Chưa có team".to_owned());
            team_order.push(key.clone());
            team_map.insert(
                key,
                TeamBucket {
                    team_lead_id: r.employee.team_lead_id,
                    label,
                    count: 1,
                },
            );
        }
        if let Some(s) = r.signed_date {
            // `signed_date` lưu nửa đêm VN theo UTC ⇒ +7 giờ để ra đúng tháng giờ VN.
            let vn = s.0 + Duration::hours(7);
            *month_count
                .entry(format!("{}-{:02}", vn.year(), vn.month()))
                .or_insert(0) += 1;
        }
        if let Some(d) = r.days_remaining.filter(|d| *d > 0 && *d <= 90) {
            if d <= 30 {
                exp1 += 1;
            } else if d <= 60 {
                exp2 += 1;
            } else {
                exp3 += 1;
            }
        }
    }

    let by_status = STATUS_LABEL
        .iter()
        .map(|(k, l)| bucket(k, l, status_count.get(k).copied().unwrap_or(0)))
        .collect();
    let mut by_type: Vec<Bucket> = TYPE_LABEL
        .iter()
        .filter(|(k, _)| CURRENT_TYPE_KEYS.contains(k) || type_count.get(*k).copied().unwrap_or(0) > 0)
        .map(|(k, l)| bucket(k, l, type_count.get(*k).copied().unwrap_or(0)))
        .collect();
    by_type.push(bucket(
        "none",
        "Chưa có HĐ",
        type_count.get("none").copied().unwrap_or(0),
    ));
    let by_employment = vec![
        bucket("working", "Đang làm việc", working),
        bucket("resigned", "Đã nghỉ", resigned),
    ];
    // Team chính thức trước (theo thứ tự Cài đặt), nhóm không khớp đứng sau, "Chưa có team" luôn cuối; sắp ổn định.
    let rank: HashMap<i32, usize> = teams.iter().enumerate().fold(HashMap::new(), |mut m, (i, t)| {
        if let Some(l) = t.team_lead_id {
            m.entry(l).or_insert(i);
        }
        m
    });
    let mut by_team: Vec<TeamBucket> = team_order.into_iter().filter_map(|k| team_map.remove(&k)).collect();
    by_team.sort_by_key(|t| match t.team_lead_id {
        None => usize::MAX,
        Some(l) => rank.get(&l).copied().unwrap_or(100_000),
    });

    // 12 tháng gần nhất (giờ VN), gồm tháng hiện tại.
    let today = vn_date(now);
    let mut signed_by_month = Vec::with_capacity(12);
    for i in (0..12).rev() {
        let months = i64::from(today.year()) * 12 + i64::from(today.month0()) - i;
        let (y, m0) = (months.div_euclid(12), months.rem_euclid(12));
        let ym = format!("{y}-{:02}", m0 + 1);
        let count = month_count.get(&ym).copied().unwrap_or(0);
        signed_by_month.push(MonthBucket { month: ym, count });
    }
    let expiring_3m = vec![
        bucket("m1", "Còn ≤ 1 tháng", exp1),
        bucket("m2", "Còn 1–2 tháng", exp2),
        bucket("m3", "Còn 2–3 tháng", exp3),
    ];
    Ok(ContractStats {
        total: i64::try_from(rows.len()).unwrap_or(i64::MAX),
        by_status,
        by_type,
        by_employment,
        by_team,
        signed_by_month,
        expiring_3m,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn trang_thai_hop_dong() {
        let now = t("2026-11-27T00:00:00Z");
        assert_eq!(compute_status(None, true, now), ("terminated", None));
        assert_eq!(compute_status(None, false, now), ("active", None));
        assert_eq!(
            compute_status(Some(t("2026-11-26T12:00:00Z")), false, now),
            ("expired", Some(-1))
        );
        assert_eq!(
            compute_status(Some(t("2026-11-20T00:00:00Z")), false, now),
            ("expired", Some(-7))
        );
        assert_eq!(
            compute_status(Some(t("2026-12-27T00:00:00Z")), false, now),
            ("expiring", Some(30))
        );
        assert_eq!(
            compute_status(Some(t("2026-12-27T00:00:01Z")), false, now),
            ("active", Some(31))
        );
        assert_eq!(compute_status(Some(now), false, now), ("expiring", Some(0)));
    }

    #[test]
    fn ten_tep() {
        assert_eq!(decode_multipart_filename(Some(" a/b\\c\r\nd.pdf ")), "a_b_c__d.pdf");
        assert_eq!(decode_multipart_filename(None), "");
        assert_eq!(safe_name("Hợp đồng 😀.pdf"), "H_p___ng___.pdf");
        assert_eq!(display_name("contracts/1/2/1700000000000_hop-dong.pdf"), "hop-dong.pdf");
        assert_eq!(display_name("contracts/1/2/abc.pdf"), "abc.pdf");
        assert_eq!(
            encode_uri_component("Hợp đồng (1).pdf"),
            "H%E1%BB%A3p%20%C4%91%E1%BB%93ng%20(1).pdf"
        );
        // Mojibake: "Lê Thị" đọc như Latin-1 ⇒ giải lại; tên UTF-8 đúng giữ nguyên.
        assert_eq!(repair_mojibake_text("LÃª Thá»\u{8b}"), "Lê Thị");
        assert_eq!(repair_mojibake_text("Lê Thị"), "Lê Thị");
        assert_eq!(repair_mojibake_text("LÃª"), "Lê");
    }

    #[test]
    fn so_sanh_ngay_va_chia_tran() {
        assert_eq!(ceil_div(1, DAY_MS), 1);
        assert_eq!(ceil_div(-1, DAY_MS), 0);
        assert_eq!(ceil_div(-DAY_MS - 1, DAY_MS), -1);
        assert!(parse_date("2026-01-01").is_ok() && parse_date("2026-01-01T10:00:00+07:00").is_ok());
        assert!(parse_date("hôm qua").is_err());
    }
}
