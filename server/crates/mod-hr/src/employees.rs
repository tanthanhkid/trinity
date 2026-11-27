//! Nhân viên (M10): 12 endpoint `/api/v1/management/employees` (danh sách, chi tiết, thêm, sửa, khoá, mở khoá, xoá mềm,
//! thống kê, thống kê Team + sinh nhật, danh sách sinh nhật, xuất xlsx hai loại). Bản TS: `services/crm/src/employees`.
//!
//! - Quyền xem/xuất theo phạm vi (`employees.view`, `employees.export`) trên `user_id` của nhân viên; ghi cần
//!   `employees.manage` và, vì luôn chạm tài khoản liên kết, thêm `users.manage` phủ đúng người đó và "quyền của target ⊆
//!   quyền người gọi" (chống leo thang); không tự khoá/xoá chính mình.
//! - Giai đoạn làm việc (`employment_periods`): khoá/đổi trạng thái sang `resigned` đóng giai đoạn, mở khoá/rời `resigned`
//!   mở giai đoạn mới từ hôm nay; khoảng bị khoá KHÔNG bị tính lại vào chấm công/lương cũ (xem `mod_users::guards`).
//! - Team hiển thị của nhân viên (không phải cột `employees.team_id` thô): gán trực tiếp → chính là trưởng nhóm → quản lý
//!   là trưởng nhóm → chưa có team.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err, clippy::type_complexity)]

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Utc};
use mod_users::guards::{Actor, db, scope_err};
use serde::Serialize;
use sqlx::{AssertSqlSafe, PgConnection, Postgres, QueryBuilder};
use trinity_db::platform::Platform;
use trinity_db::types::{JsBigInt, Timestamp};
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::number::js_round;
use trinity_kernel::vi::{Collation, compare, escape_like, trim_js};
use trinity_kernel::vn_time::to_vn;
use trinity_rbac::{OwnerIds, PermissionService, RbacCache, ScopeService, push_scope};
use trinity_storage::LocalUploadsStore;

use crate::employee_dto::{BirthdayListQueryDto, HrStatsQueryDto, QueryEmployeesDto};

pub type R<T> = Result<T, AppError>;

/// Phụ thuộc của module: dựng một lần ở `serve` rồi chia sẻ.
pub struct Ctx {
    pub db: Db,
    pub platform: Platform,
    pub scopes: ScopeService,
    pub perms: PermissionService,
    pub cache: Arc<RbacCache>,
    pub uploads: LocalUploadsStore,
}

impl Ctx {
    pub async fn conn(&self, company: CompanyRef) -> R<trinity_db::TenantConn> {
        self.db
            .tenant(company)
            .await
            .map_err(AppError::internal)?
            .acquire()
            .await
            .map_err(AppError::internal)
    }

    pub async fn begin(&self, company: CompanyRef) -> R<trinity_db::TenantTx> {
        self.db
            .tenant(company)
            .await
            .map_err(AppError::internal)?
            .begin()
            .await
            .map_err(AppError::internal)
    }

    pub(crate) async fn invalidate_all(&self, company: CompanyRef) {
        self.cache
            .invalidate_users(company.id(), trinity_rbac::cache::Users::All)
            .await;
    }
}

const NOT_FOUND: &str = "Không tìm thấy nhân viên";

fn http(e: HttpError) -> AppError {
    AppError::Http(e)
}

fn nf() -> AppError {
    http(HttpError::not_found(NOT_FOUND))
}

fn i32_of(v: i64) -> R<i32> {
    i32::try_from(v).map_err(|_| http(HttpError::bad_request("ID không hợp lệ")))
}

/// `String.prototype.trim() || null`.
pub(crate) fn trimmed_or_null(v: &str) -> Option<String> {
    let t = trim_js(v);
    (!t.is_empty()).then(|| t.to_owned())
}

// ───────────────────────────── team ─────────────────────────────

#[derive(Debug, Clone)]
struct TeamInfo {
    id: i32,
    name: String,
    color: Option<String>,
    lead: Option<i32>,
    order: usize,
}

#[derive(Debug, Default)]
struct TeamCtx {
    by_id: HashMap<i32, TeamInfo>,
    by_lead: HashMap<i32, i32>,
}

impl TeamCtx {
    async fn load(conn: &mut PgConnection) -> R<Self> {
        let rows: Vec<(i32, String, Option<String>, Option<i32>)> =
            sqlx::query_as("SELECT id, name, color, team_lead_id FROM teams ORDER BY department ASC, name ASC")
                .fetch_all(conn)
                .await
                .map_err(db)?;
        let mut ctx = Self::default();
        for (i, (id, name, color, lead)) in rows.into_iter().enumerate() {
            ctx.by_id.insert(
                id,
                TeamInfo {
                    id,
                    name,
                    color,
                    lead,
                    order: i,
                },
            );
            if let Some(l) = lead {
                ctx.by_lead.entry(l).or_insert(id);
            }
        }
        Ok(ctx)
    }

    /// Gán trực tiếp → chính là trưởng nhóm → quản lý là trưởng nhóm → không có.
    fn resolve(&self, user_id: i32, manager_id: Option<i32>, team_id: Option<i32>) -> Option<&TeamInfo> {
        let tid = team_id
            .filter(|t| self.by_id.contains_key(t))
            .or_else(|| self.by_lead.get(&user_id).copied())
            .or_else(|| manager_id.and_then(|m| self.by_lead.get(&m).copied()))?;
        self.by_id.get(&tid)
    }

    fn order(&self, team: Option<i32>) -> usize {
        match team {
            None => 9999,
            Some(t) => self.by_id.get(&t).map_or(9998, |i| i.order),
        }
    }
}

/// Thứ hạng thâm niên chức vụ: Trưởng nhóm 4, Chuyên viên chính 3, Chuyên viên 2, Nhân viên 1, khác 0.
pub fn job_title_seniority_rank(name: Option<&str>) -> i32 {
    let Some(name) = name else { return 0 };
    let n = trim_js(name).to_lowercase();
    if n.contains("trưởng nhóm") || n.contains("team lead") || n.contains("trưởng") {
        4
    } else if n.contains("chuyên viên chính") || (n.contains("chuyên viên") && n.contains("chính")) {
        3
    } else if n.contains("chuyên viên") {
        2
    } else if n.contains("nhân viên") {
        1
    } else {
        0
    }
}

// ───────────────────────────── dòng nhân viên ─────────────────────────────

const SELECT: &str = "SELECT e.id, e.user_id, e.employee_code, e.position, e.department, e.gender, e.education_level, e.recruitment_source,
  e.team_id, e.salary_rule_id, e.insurance_salary, e.job_title_id, e.office_id, e.registered_device_id, e.device_registered_at,
  e.birth_date, e.id_card_number, e.id_card_issued_date, e.id_card_issued_place, e.permanent_address, e.current_address,
  e.bank_account_number, e.bank_name, e.bank_account_holder, e.status, e.joined_at, e.created_at,
  u.email, u.full_name, u.phone, u.avatar_url, u.status AS user_status, u.manager_id, m.full_name AS manager_name,
  jt.name AS job_title_name, jt.category AS job_title_category, jt.rank_code AS job_title_rank_code, jt.symbol AS job_title_symbol,
  o.name AS office_name,
  (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY ur.id LIMIT 1) AS role
FROM employees e JOIN users u ON u.id = e.user_id LEFT JOIN users m ON m.id = u.manager_id
  LEFT JOIN job_titles jt ON jt.id = e.job_title_id LEFT JOIN attendance_offices o ON o.id = e.office_id";

#[derive(Debug, sqlx::FromRow)]
struct Row {
    id: i32,
    user_id: i32,
    employee_code: Option<String>,
    position: String,
    department: Option<String>,
    gender: Option<String>,
    education_level: Option<String>,
    recruitment_source: Option<String>,
    team_id: Option<i32>,
    salary_rule_id: Option<i32>,
    insurance_salary: Option<i64>,
    job_title_id: Option<i32>,
    office_id: Option<i32>,
    registered_device_id: Option<String>,
    device_registered_at: Option<Timestamp>,
    birth_date: Option<Timestamp>,
    id_card_number: Option<String>,
    id_card_issued_date: Option<Timestamp>,
    id_card_issued_place: Option<String>,
    permanent_address: Option<String>,
    current_address: Option<String>,
    bank_account_number: Option<String>,
    bank_name: Option<String>,
    bank_account_holder: Option<String>,
    status: String,
    joined_at: Timestamp,
    created_at: Timestamp,
    email: String,
    full_name: String,
    phone: Option<String>,
    avatar_url: Option<String>,
    user_status: String,
    manager_id: Option<i32>,
    manager_name: Option<String>,
    job_title_name: Option<String>,
    job_title_category: Option<String>,
    job_title_rank_code: Option<String>,
    job_title_symbol: Option<String>,
    office_name: Option<String>,
    role: Option<String>,
}

/// Nhân viên trả về (khoá theo `mapEmployee`).
#[derive(Debug, Clone, Serialize)]
pub struct EmployeeDto {
    pub id: i32,
    pub user_id: i32,
    pub employee_code: String,
    pub full_name: String,
    pub email: String,
    pub phone: Option<String>,
    pub avatar_url: Option<String>,
    pub position: String,
    pub department: Option<String>,
    pub gender: Option<String>,
    pub education_level: Option<String>,
    pub recruitment_source: Option<String>,
    pub status: String,
    pub user_status: String,
    pub manager_id: Option<i32>,
    pub manager_name: Option<String>,
    pub team_id: Option<i32>,
    pub team_name: Option<String>,
    pub team_color: Option<String>,
    pub team_lead_id: Option<i32>,
    pub salary_rule_id: Option<i32>,
    pub insurance_salary: Option<JsBigInt>,
    pub job_title_id: Option<i32>,
    pub job_title_name: Option<String>,
    pub job_title_category: Option<String>,
    pub job_title_rank_code: Option<String>,
    pub job_title_symbol: Option<String>,
    pub office_id: Option<i32>,
    pub office_name: Option<String>,
    pub registered_device_id: Option<String>,
    pub device_registered_at: Option<Timestamp>,
    pub birth_date: Option<Timestamp>,
    pub id_card_number: Option<String>,
    pub id_card_issued_date: Option<Timestamp>,
    pub id_card_issued_place: Option<String>,
    pub permanent_address: Option<String>,
    pub current_address: Option<String>,
    pub bank_account_number: Option<String>,
    pub bank_name: Option<String>,
    pub bank_account_holder: Option<String>,
    pub joined_at: Timestamp,
    pub created_at: Timestamp,
    pub role: Option<String>,
}

fn map_employee(r: Row, teams: &TeamCtx) -> EmployeeDto {
    let team = teams.resolve(r.user_id, r.manager_id, r.team_id);
    EmployeeDto {
        employee_code: r.employee_code.unwrap_or_else(|| format!("NV{:04}", r.id)),
        id: r.id,
        user_id: r.user_id,
        full_name: r.full_name,
        email: r.email,
        phone: r.phone,
        avatar_url: r.avatar_url,
        position: r.position,
        department: r.department,
        gender: r.gender,
        education_level: r.education_level,
        recruitment_source: r.recruitment_source,
        status: r.status,
        user_status: r.user_status,
        manager_id: r.manager_id,
        manager_name: r.manager_name,
        team_id: team.map(|t| t.id),
        team_name: team.map(|t| t.name.clone()),
        team_color: team.and_then(|t| t.color.clone()),
        team_lead_id: team.and_then(|t| t.lead),
        salary_rule_id: r.salary_rule_id,
        insurance_salary: r.insurance_salary.map(JsBigInt),
        job_title_id: r.job_title_id,
        job_title_name: r.job_title_name,
        job_title_category: r.job_title_category,
        job_title_rank_code: r.job_title_rank_code,
        job_title_symbol: r.job_title_symbol,
        office_id: r.office_id,
        office_name: r.office_name,
        registered_device_id: r.registered_device_id,
        device_registered_at: r.device_registered_at,
        birth_date: r.birth_date,
        id_card_number: r.id_card_number,
        id_card_issued_date: r.id_card_issued_date,
        id_card_issued_place: r.id_card_issued_place,
        permanent_address: r.permanent_address,
        current_address: r.current_address,
        bank_account_number: r.bank_account_number,
        bank_name: r.bank_name,
        bank_account_holder: r.bank_account_holder,
        joined_at: r.joined_at,
        created_at: r.created_at,
        role: r.role,
    }
}

async fn fetch_one(conn: &mut PgConnection, id: i32) -> R<Option<Row>> {
    sqlx::query_as::<_, Row>(AssertSqlSafe(format!("{SELECT} WHERE e.id = $1")))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// Nhân viên theo id sau khi ghi (kèm team đã resolve).
pub(crate) async fn fetch_dto(ctx: &Ctx, company: CompanyRef, id: i32) -> R<EmployeeDto> {
    let mut conn = ctx.conn(company).await?;
    let row = fetch_one(&mut conn, id).await?.ok_or_else(nf)?;
    let teams = TeamCtx::load(&mut conn).await?;
    Ok(map_employee(row, &teams))
}

async fn owner_of(ctx: &Ctx, actor: &Actor, permission: &str) -> R<OwnerIds> {
    Ok(ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, permission)
        .await
        .map_err(AppError::internal)?
        .unwrap_or(OwnerIds::Ids(Vec::new())))
}

// ───────────────────────────── danh sách ─────────────────────────────

/// Toàn bộ nhân viên khớp bộ lọc + phạm vi → map → sắp xếp → lọc team (tầng ứng dụng, không phân trang). Dùng chung cho danh
/// sách và xuất file để hai nơi LUÔN cùng thứ tự.
async fn list_sorted(ctx: &Ctx, actor: &Actor, q: &QueryEmployeesDto, permission: &str) -> R<Vec<EmployeeDto>> {
    let owner = owner_of(ctx, actor, permission).await?;
    let mut qb = QueryBuilder::<Postgres>::new(SELECT);
    qb.push(" WHERE ");
    push_scope(&mut qb, &owner, &["e.user_id"]);
    qb.push(" AND e.deleted_at IS NULL AND u.deleted_at IS NULL");
    if let Some(s) = q.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.status = ").push_bind(s.to_owned());
    }
    if let Some(s) = q.position.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.position = ").push_bind(s.to_owned());
    }
    if let Some(s) = q.department.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.department = ").push_bind(s.to_owned());
    }
    match q.employment_state.as_deref() {
        Some("active") => {
            qb.push(" AND u.status = 'active'");
        }
        Some("resigned") => {
            qb.push(" AND u.status = 'locked'");
        }
        _ => {}
    }
    if let Some(term) = q.search.as_deref().map(trim_js).filter(|s| !s.is_empty()) {
        // Escape `\ % _` để từ khoá là chuỗi chữ, không phải mẫu LIKE.
        let pat = format!("%{}%", escape_like(term));
        qb.push(" AND (u.full_name ILIKE ")
            .push_bind(pat.clone())
            .push(" ESCAPE '\\' OR u.email ILIKE ")
            .push_bind(pat.clone())
            .push(" ESCAPE '\\' OR u.phone LIKE ")
            .push_bind(pat)
            .push(" ESCAPE '\\')");
    }
    let mut conn = ctx.conn(actor.company).await?;
    let rows: Vec<Row> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    let teams = TeamCtx::load(&mut conn).await?;
    let mut mapped: Vec<EmployeeDto> = rows.into_iter().map(|r| map_employee(r, &teams)).collect();
    sort_employees(&mut mapped, q, &teams);
    Ok(filter_team(mapped, q.team.as_deref()))
}

fn filter_team(v: Vec<EmployeeDto>, team: Option<&str>) -> Vec<EmployeeDto> {
    match team.filter(|t| !t.is_empty()) {
        None => v,
        Some("none") => v.into_iter().filter(|e| e.team_id.is_none()).collect(),
        Some(t) => v
            .into_iter()
            .filter(|e| e.team_id.map(|i| i.to_string()).as_deref() == Some(t))
            .collect(),
    }
}

fn vi(a: &str, b: &str) -> std::cmp::Ordering {
    compare(a, b, Collation::Vi)
}

/// Có `sort_by`: theo cột, `NULL` luôn xuống cuối; mặc định: Team (thứ tự bảng teams) → trưởng nhóm đứng đầu → thâm niên
/// chức vụ giảm dần → tên A→Z.
fn sort_employees(v: &mut [EmployeeDto], q: &QueryEmployeesDto, teams: &TeamCtx) {
    use std::cmp::Ordering;
    if let Some(field) = q.sort_by.as_deref().filter(|s| !s.is_empty()) {
        let desc = q.sort_dir.as_deref() == Some("desc");
        let dir = |o: Ordering| if desc { o.reverse() } else { o };
        v.sort_by(|a, b| {
            let (av, bv): (Option<String>, Option<String>) = match field {
                "full_name" => (Some(a.full_name.clone()), Some(b.full_name.clone())),
                "employee_code" => (Some(a.employee_code.clone()), Some(b.employee_code.clone())),
                "position" => (Some(a.position.clone()), Some(b.position.clone())),
                "department" => (a.department.clone(), b.department.clone()),
                "status" => (Some(a.status.clone()), Some(b.status.clone())),
                "joined_at" => {
                    return dir(a.joined_at.0.cmp(&b.joined_at.0));
                }
                _ => return Ordering::Equal,
            };
            match (av, bv) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(x), Some(y)) => dir(vi(&x, &y)),
            }
        });
    } else {
        v.sort_by(|a, b| {
            let (ra, rb) = (teams.order(a.team_id), teams.order(b.team_id));
            if ra != rb {
                return ra.cmp(&rb);
            }
            let lead = |e: &EmployeeDto| i32::from(!(e.team_lead_id.is_some() && Some(e.user_id) == e.team_lead_id));
            let (sa, sb) = (lead(a), lead(b));
            if sa != sb {
                return sa.cmp(&sb);
            }
            let rank =
                |e: &EmployeeDto| job_title_seniority_rank(Some(e.job_title_name.as_deref().unwrap_or(&e.position)));
            let (ja, jb) = (rank(a), rank(b));
            if ja != jb {
                return jb.cmp(&ja);
            }
            vi(&a.full_name, &b.full_name)
        });
    }
}

#[derive(Debug, Serialize)]
pub struct Pagination {
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Debug, Serialize)]
pub struct EmployeePage {
    pub data: Vec<EmployeeDto>,
    pub pagination: Pagination,
}

/// `GET /management/employees`.
pub async fn find_all(ctx: &Ctx, actor: &Actor, q: &QueryEmployeesDto) -> R<EmployeePage> {
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(25).max(1);
    let all = list_sorted(ctx, actor, q, "employees.view").await?;
    let total = i64::try_from(all.len()).unwrap_or(i64::MAX);
    let skip = usize::try_from((page - 1).saturating_mul(page_size)).unwrap_or(usize::MAX);
    let take = usize::try_from(page_size).unwrap_or(usize::MAX);
    Ok(EmployeePage {
        data: all.into_iter().skip(skip).take(take).collect(),
        pagination: Pagination {
            page,
            page_size,
            total,
            total_pages: (total + page_size - 1) / page_size,
        },
    })
}

/// Toàn bộ nhân viên (không phân trang) cho xuất xlsx, theo phạm vi `employees.export`.
pub async fn find_all_for_export(ctx: &Ctx, actor: &Actor, q: &QueryEmployeesDto) -> R<Vec<EmployeeDto>> {
    list_sorted(ctx, actor, q, "employees.export").await
}

/// `GET /management/employees/:id`: ngoài phạm vi `employees.view` ⇒ 404.
pub async fn find_by_id(ctx: &Ctx, actor: &Actor, id: i32) -> R<EmployeeDto> {
    let mut conn = ctx.conn(actor.company).await?;
    let row = fetch_one(&mut conn, id).await?.ok_or_else(nf)?;
    ctx.scopes
        .assert_in_scope(
            actor.company,
            actor.user_id,
            &actor.grants,
            "employees.view",
            &[Some(row.user_id)],
        )
        .await
        .map_err(scope_err)?;
    let teams = TeamCtx::load(&mut conn).await?;
    Ok(map_employee(row, &teams))
}

// ───────────────────────────── thống kê ─────────────────────────────

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LabelCount {
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct Stats {
    pub by_department: Vec<LabelCount>,
    pub by_gender: Vec<LabelCount>,
    pub by_education: Vec<LabelCount>,
    pub by_job_title: Vec<LabelCount>,
    pub by_status: Vec<LabelCount>,
    pub resigned_total: i64,
}

/// `GET /management/employees/stats`: đếm nhân viên chưa xoá trong phạm vi `employees.view`.
pub async fn get_stats(ctx: &Ctx, actor: &Actor) -> R<Stats> {
    let owner = owner_of(ctx, actor, "employees.view").await?;
    let mut conn = ctx.conn(actor.company).await?;
    // Nhãn gom theo biểu thức SQL; `ORDER BY 2 DESC` (số lượng giảm dần).
    async fn group(
        conn: &mut PgConnection,
        owner: &OwnerIds,
        label: &str,
        null_label: &str,
        join: &str,
    ) -> R<Vec<LabelCount>> {
        let mut qb = QueryBuilder::<Postgres>::new(format!("SELECT COALESCE({label}, "));
        qb.push_bind(null_label.to_owned());
        qb.push(format!(
            ") AS label, COUNT(*)::bigint AS count FROM employees e JOIN users u ON u.id = e.user_id {join} \
             WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL AND "
        ));
        push_scope(&mut qb, owner, &["e.user_id"]);
        qb.push(" GROUP BY 1 ORDER BY 2 DESC");
        let rows: Vec<(String, i64)> = qb.build_query_as().fetch_all(conn).await.map_err(db)?;
        Ok(rows
            .into_iter()
            .map(|(label, count)| LabelCount { label, count })
            .collect())
    }
    let by_department = group(&mut conn, &owner, "e.department", "Chưa phân loại", "").await?;
    let by_gender = group(&mut conn, &owner, "e.gender", "Chưa cập nhật", "").await?;
    let by_education = group(&mut conn, &owner, "e.education_level", "Chưa cập nhật", "").await?;
    let by_job_title = group(
        &mut conn,
        &owner,
        "jt.name",
        "Chưa gán",
        "LEFT JOIN job_titles jt ON jt.id = e.job_title_id",
    )
    .await?;
    let by_status = group(&mut conn, &owner, "e.status", "Chưa phân loại", "").await?;
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*)::bigint FROM employees e JOIN users u ON u.id = e.user_id WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'locked' AND ",
    );
    push_scope(&mut qb, &owner, &["e.user_id"]);
    let resigned_total: i64 = qb.build_query_scalar().fetch_one(&mut *conn).await.map_err(db)?;
    Ok(Stats {
        by_department,
        by_gender,
        by_education,
        by_job_title,
        by_status,
        resigned_total,
    })
}

/// Nhân viên chưa xoá trong phạm vi `permission`, lọc theo văn phòng/phòng ban/chức danh (SQL) rồi theo team (ứng dụng).
async fn load_for_stats(
    ctx: &Ctx,
    actor: &Actor,
    f: &HrStatsQueryDto,
    permission: &str,
) -> R<(Vec<EmployeeDto>, TeamCtx)> {
    let owner = owner_of(ctx, actor, permission).await?;
    let mut qb = QueryBuilder::<Postgres>::new(SELECT);
    qb.push(" WHERE ");
    push_scope(&mut qb, &owner, &["e.user_id"]);
    qb.push(" AND e.deleted_at IS NULL AND u.deleted_at IS NULL");
    if let Some(v) = f.office_id {
        qb.push(" AND e.office_id = ").push_bind(i32_of(v)?);
    }
    if let Some(v) = f.department.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND e.department = ").push_bind(v.to_owned());
    }
    if let Some(v) = f.job_title_id {
        qb.push(" AND e.job_title_id = ").push_bind(i32_of(v)?);
    }
    let mut conn = ctx.conn(actor.company).await?;
    let rows: Vec<Row> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    let teams = TeamCtx::load(&mut conn).await?;
    let mapped = rows.into_iter().map(|r| map_employee(r, &teams)).collect();
    Ok((filter_team(mapped, f.team.as_deref()), teams))
}

fn round1(n: f64) -> f64 {
    js_round(n * 10.0) / 10.0
}

fn status_bucket(s: &str) -> usize {
    match s {
        "active" => 0,
        "probation" => 1,
        "on_leave" => 2,
        "resigned" => 3,
        _ => 4,
    }
}

#[derive(Debug, Serialize)]
pub struct TeamShare {
    pub team_id: Option<i32>,
    pub team_lead_id: Option<i32>,
    pub team_name: String,
    pub color: Option<String>,
    pub count: i64,
    pub percent: f64,
}

#[derive(Debug, Serialize)]
pub struct TeamStatus {
    pub team_id: Option<i32>,
    pub team_lead_id: Option<i32>,
    pub team_name: String,
    pub color: Option<String>,
    pub active: i64,
    pub probation: i64,
    pub on_leave: i64,
    pub resigned: i64,
    pub other: i64,
}

#[derive(Debug, Serialize)]
pub struct MonthCount {
    pub month: i64,
    pub count: i64,
    pub percent: f64,
}

#[derive(Debug, Serialize)]
pub struct TeamCount {
    pub team_id: Option<i32>,
    pub team_lead_id: Option<i32>,
    pub team_name: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct HrStats {
    pub total: i64,
    pub by_team: Vec<TeamShare>,
    pub by_team_status: Vec<TeamStatus>,
    pub birthdays_by_month: Vec<MonthCount>,
    pub resigned_total: i64,
    pub resigned_by_team: Vec<TeamCount>,
    pub resigned_by_department: Vec<LabelCount>,
    pub resigned_by_job_title: Vec<LabelCount>,
}

fn group_labels(labels: Vec<String>) -> Vec<LabelCount> {
    let mut order: Vec<String> = Vec::new();
    let mut m: HashMap<String, i64> = HashMap::new();
    for l in labels {
        if !m.contains_key(&l) {
            order.push(l.clone());
        }
        *m.entry(l).or_insert(0) += 1;
    }
    let mut out: Vec<LabelCount> = order
        .into_iter()
        .map(|l| LabelCount { count: m[&l], label: l })
        .collect();
    out.sort_by_key(|l| std::cmp::Reverse(l.count)); // sort ổn định như Array.sort
    out
}

fn team_counts(items: &[EmployeeDto], teams: &TeamCtx) -> Vec<TeamCount> {
    let mut keys: Vec<Option<i32>> = Vec::new();
    let mut m: HashMap<Option<i32>, TeamCount> = HashMap::new();
    for e in items {
        m.entry(e.team_id).or_insert_with(|| {
            keys.push(e.team_id);
            TeamCount {
                team_id: e.team_id,
                team_lead_id: e.team_id.and_then(|t| teams.by_id.get(&t).and_then(|i| i.lead)),
                team_name: e.team_name.clone().unwrap_or_else(|| "Chưa có team".to_owned()),
                count: 0,
            }
        });
        if let Some(b) = m.get_mut(&e.team_id) {
            b.count += 1;
        }
    }
    let mut out: Vec<TeamCount> = keys.into_iter().filter_map(|k| m.remove(&k)).collect();
    out.sort_by_key(|t| teams.order(t.team_id));
    out
}

/// Tháng/ngày sinh theo giờ Việt Nam (`birth_date` lưu nửa đêm giờ VN dạng UTC).
fn vn_month_day(d: DateTime<Utc>) -> (u32, u32) {
    let t = to_vn(d);
    (t.month(), t.day())
}

/// `GET /management/employees/hr-stats`: số liệu NV đang làm (tài khoản chưa khoá); người đã nghỉ thống kê riêng.
pub async fn get_hr_stats(ctx: &Ctx, actor: &Actor, f: &HrStatsQueryDto) -> R<HrStats> {
    let (all, teams) = load_for_stats(ctx, actor, f, "employees.view").await?;
    let (resigned, active): (Vec<EmployeeDto>, Vec<EmployeeDto>) =
        all.into_iter().partition(|e| e.user_status == "locked");
    let total = i64::try_from(active.len()).unwrap_or(i64::MAX);
    let pct = |n: i64| {
        if total > 0 {
            round1(n as f64 / total as f64 * 100.0)
        } else {
            0.0
        }
    };

    let mut by_team_id: HashMap<Option<i32>, Vec<&EmployeeDto>> = HashMap::new();
    for e in &active {
        by_team_id.entry(e.team_id).or_default().push(e);
    }
    let mut ordered: Vec<&TeamInfo> = teams.by_id.values().collect();
    ordered.sort_by_key(|t| t.order);
    struct Bucket<'a> {
        id: Option<i32>,
        lead: Option<i32>,
        name: String,
        color: Option<String>,
        members: Vec<&'a EmployeeDto>,
    }
    let mut buckets: Vec<Bucket<'_>> = ordered
        .iter()
        .map(|t| Bucket {
            id: Some(t.id),
            lead: t.lead,
            name: t.name.clone(),
            color: t.color.clone(),
            members: by_team_id.remove(&Some(t.id)).unwrap_or_default(),
        })
        .collect();
    if let Some(none) = by_team_id.remove(&None).filter(|m| !m.is_empty()) {
        buckets.push(Bucket {
            id: None,
            lead: None,
            name: "Chưa có team".to_owned(),
            color: None,
            members: none,
        });
    }
    let by_team = buckets
        .iter()
        .map(|b| {
            let count = i64::try_from(b.members.len()).unwrap_or(0);
            TeamShare {
                team_id: b.id,
                team_lead_id: b.lead,
                team_name: b.name.clone(),
                color: b.color.clone(),
                count,
                percent: pct(count),
            }
        })
        .collect();
    let by_team_status = buckets
        .iter()
        .map(|b| {
            let mut s = [0i64; 5];
            for m in &b.members {
                s[status_bucket(&m.status)] += 1;
            }
            TeamStatus {
                team_id: b.id,
                team_lead_id: b.lead,
                team_name: b.name.clone(),
                color: b.color.clone(),
                active: s[0],
                probation: s[1],
                on_leave: s[2],
                resigned: s[3],
                other: s[4],
            }
        })
        .collect();
    let mut months = [0i64; 12];
    for e in &active {
        if let Some(b) = e.birth_date {
            let (m, _) = vn_month_day(b.0);
            if (1..=12).contains(&m) {
                months[(m - 1) as usize] += 1;
            }
        }
    }
    let birthdays_by_month = months
        .iter()
        .enumerate()
        .map(|(i, c)| MonthCount {
            month: i as i64 + 1,
            count: *c,
            percent: pct(*c),
        })
        .collect();
    Ok(HrStats {
        total,
        by_team,
        by_team_status,
        birthdays_by_month,
        resigned_total: i64::try_from(resigned.len()).unwrap_or(0),
        resigned_by_team: team_counts(&resigned, &teams),
        resigned_by_department: group_labels(
            resigned
                .iter()
                .map(|e| e.department.clone().unwrap_or_else(|| "Chưa phân loại".to_owned()))
                .collect(),
        ),
        resigned_by_job_title: group_labels(
            resigned
                .iter()
                .map(|e| e.job_title_name.clone().unwrap_or_else(|| "Chưa gán".to_owned()))
                .collect(),
        ),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct BirthdayItem {
    pub id: i32,
    pub employee_code: String,
    pub full_name: String,
    pub birth_date: Option<Timestamp>,
    pub day: u32,
    pub position: String,
    pub job_title_name: Option<String>,
    pub team_name: String,
    pub department: Option<String>,
    pub email: String,
    pub phone: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BirthdayList {
    pub month: u32,
    pub items: Vec<BirthdayItem>,
}

/// `GET /management/employees/birthdays`: sinh nhật trong THÁNG đã chọn (mặc định tháng hiện tại giờ VN), theo ngày tăng dần.
/// `permission` = `employees.view` cho danh sách, `employees.export` cho xuất file.
pub async fn get_birthday_list(
    ctx: &Ctx,
    actor: &Actor,
    q: &BirthdayListQueryDto,
    permission: &str,
) -> R<BirthdayList> {
    let month = match q.month {
        Some(m) => u32::try_from(m).map_err(|_| http(HttpError::bad_request("month không hợp lệ")))?,
        None => to_vn(Utc::now()).month(),
    };
    let (all, _) = load_for_stats(ctx, actor, &q.filters(), permission).await?;
    let mut items: Vec<BirthdayItem> = all
        .into_iter()
        .filter_map(|e| {
            let b = e.birth_date?;
            let (m, day) = vn_month_day(b.0);
            (m == month).then(|| BirthdayItem {
                id: e.id,
                employee_code: e.employee_code,
                full_name: e.full_name,
                birth_date: Some(b),
                day,
                position: e.position,
                job_title_name: e.job_title_name,
                team_name: e.team_name.unwrap_or_else(|| "Chưa có team".to_owned()),
                department: e.department,
                email: e.email,
                phone: e.phone,
            })
        })
        .collect();
    items.sort_by(|a, b| a.day.cmp(&b.day).then_with(|| vi(&a.full_name, &b.full_name)));
    Ok(BirthdayList { month, items })
}
