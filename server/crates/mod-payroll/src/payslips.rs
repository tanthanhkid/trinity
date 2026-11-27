//! Phiếu lương (9 endpoint `/payslips` không trả tệp). Bản TS: `payslips.controller.ts`, `payslips.service.ts`. Các route
//! xuất/nhập tệp, PDF thuộc M31. Bộ tính tiền dùng lại [`crate::calc`] (M30a), module này chỉ đọc/ghi DB và ghép luồng.
//!
//! - Phạm vi xem/duyệt là `Option<&[i32]>` các `user_id` chủ phiếu (`None` = tất cả); tầng route đổi từ `OwnerIds` của
//!   `trinity-rbac` sang kiểu này (module không phụ thuộc `trinity-rbac`). Phiếu ngoài phạm vi theo id ⇒ 404 "Không tìm thấy".
//! - Duyệt 2 bước: `draft`/`pending_tl` cần `payroll.approve_team` (trong phạm vi), `pending_accountant` cần
//!   `payroll.approve_final`; không tự duyệt phiếu của mình. Hàm duyệt chạy trên giao dịch của người gọi; thông báo "phiếu
//!   đã duyệt" ghi qua cổng K36 ([`trinity_db::outbox::create_notification`]) trong SAVEPOINT (lỗi thông báo không làm mất
//!   việc duyệt, chỉ trả về ở [`Approved::notify_error`] để route ghi log) và phát `NOTIFY bell` khi commit nên tiến trình
//!   khác đẩy được socket tới người nhận; socket của tiến trình này do bên gọi đẩy từ [`Approved::notifications`] sau commit.
//! - Hàm ghi lấy `&mut PgConnection` (route bọc giao dịch); không hàm nào giữ hai kết nối cùng lúc.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, PgConnection, Postgres, QueryBuilder};
use trinity_db::TenantTx;
use trinity_db::outbox::{CreatedNotification, NewNotification, create_notification};
use trinity_db::pg_error::app_error;
use trinity_db::types::{JsonValue, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::json::js_json;
use trinity_kernel::number::{format_vn_number, js_round};
use trinity_kernel::vi::{Collation, compare};

use crate::calc::{self, EmployeeInput, ManualInput, PayrollConfig, PayslipComputed};
use crate::{dec, finish, frange, is_in, is_month, len16, range, set, set_num, some_nullable};

type R<T> = Result<T, AppError>;

const MONTH_MSG: &str = "month phải có định dạng YYYY-MM";
const STATUSES: [&str; 5] = ["draft", "pending_tl", "pending_accountant", "approved", "paid"];
const INT4_MAX: i64 = 2_147_483_647;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn calc_err(e: calc::CalcError) -> AppError {
    AppError::internal(e)
}

fn not_found_id(id: i32) -> AppError {
    HttpError::not_found(format!("Phieu luong #{id} khong ton tai")).into()
}

fn out_of_scope() -> AppError {
    HttpError::not_found("Không tìm thấy").into()
}

fn in_scope(scope: Option<&[i32]>, user_id: i32) -> bool {
    scope.is_none_or(|ids| ids.contains(&user_id))
}

fn id_range(field: &str, v: i64, out: &mut Vec<String>) {
    range(field, v, Some(1), Some(INT4_MAX), out);
}

// ---------------------------------------------------------------- DTO

/// Query `GET /payslips` (`QueryPayslipsDto`): `month` `YYYY-MM`, `team_id` ≥ 1, `status` một trong năm trạng thái.
#[derive(Debug, Clone, Deserialize)]
pub struct QueryPayslips {
    pub month: String,
    #[serde(default)]
    pub team_id: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
}

impl QueryPayslips {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        if let Some(t) = self.team_id {
            id_range("team_id", t, &mut e);
        }
        if let Some(s) = &self.status {
            is_in("status", s, &STATUSES, &mut e);
        }
        finish(e)
    }
}

/// Query `GET /payslips/addable` (`BulkExcelPayslipsDto`): chỉ `month`.
#[derive(Debug, Clone, Deserialize)]
pub struct MonthQuery {
    pub month: String,
}

impl MonthQuery {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        finish(e)
    }
}

/// Query `GET /payslips/me`: `month` tuỳ chọn, không kiểm (như `@Query('month')` trần của bản TS).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MineQuery {
    #[serde(default)]
    pub month: Option<String>,
}

/// Body `POST /payslips/generate` (`GeneratePayslipsDto`): `month`, `employee_ids` mỗi phần tử ≥ 1.
#[derive(Debug, Clone, Deserialize)]
pub struct GenerateInput {
    pub month: String,
    #[serde(default)]
    pub employee_ids: Option<Vec<i64>>,
}

impl GenerateInput {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        for id in self.employee_ids.iter().flatten() {
            id_range("each value in employee_ids", *id, &mut e);
        }
        finish(e)
    }

    /// `employee_ids` đã qua `validate()` (mọi phần tử nằm trong `i32`).
    pub fn ids(&self) -> Option<Vec<i32>> {
        self.employee_ids
            .as_ref()
            .map(|v| v.iter().filter_map(|i| i32::try_from(*i).ok()).collect())
    }
}

/// Body `POST /payslips/add-to-period` (`AddToPeriodDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct AddToPeriodInput {
    pub month: String,
    pub employee_id: i64,
}

impl AddToPeriodInput {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        id_range("employee_id", self.employee_id, &mut e);
        finish(e)
    }
}

/// Body `PATCH /payslips/:id/approve` (`ApprovePayslipDto`): `action` `approve|reject`, `notes` ≤ 500.
#[derive(Debug, Clone, Deserialize)]
pub struct ApproveInput {
    pub action: String,
    #[serde(default)]
    pub notes: Option<String>,
}

impl ApproveInput {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.action != "approve" && self.action != "reject" {
            e.push("action phải là \"approve\" hoặc \"reject\"".to_owned());
        }
        if self.notes.as_deref().is_some_and(|n| len16(n) > 500) {
            e.push("notes must be shorter than or equal to 500 characters".to_owned());
        }
        finish(e)
    }
}

/// Body `PATCH /payslips/:id` (`UpdatePayslipDto`). Tiền là chuỗi `^\d{1,15}$`; `null` ở trường tiền / `standard_working_days`
/// = bỏ qua (`@IsOptional`); `working_days`, `training_days`, `bonus_rate`, `kpi_percent`, `notes` nhận `null` (xoá).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdatePayslip {
    #[serde(default, deserialize_with = "some_nullable")]
    pub working_days: Option<Option<f64>>,
    #[serde(default)]
    pub standard_working_days: Option<i64>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub training_days: Option<Option<f64>>,
    #[serde(default)]
    pub base_salary: Option<String>,
    #[serde(default)]
    pub training_salary: Option<String>,
    #[serde(default)]
    pub probation_allowance: Option<String>,
    #[serde(default)]
    pub sales_personal: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub bonus_rate: Option<Option<f64>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub kpi_percent: Option<Option<f64>>,
    #[serde(default)]
    pub bonus_sales_personal: Option<String>,
    #[serde(default)]
    pub sales_team: Option<String>,
    #[serde(default)]
    pub bonus_cskh_team: Option<String>,
    #[serde(default)]
    pub bonus_milestone: Option<String>,
    #[serde(default)]
    pub bonus_referral: Option<String>,
    #[serde(default)]
    pub holiday_bonus: Option<String>,
    #[serde(default)]
    pub advances: Option<String>,
    #[serde(default)]
    pub personal_income_tax: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub notes: Option<Option<String>>,
}

/// `@IsNumber({ maxDecimalPlaces })` đếm chữ số sau dấu chấm của `String(v)`; dạng mũ của JS (`< 1e-6`) không có dấu chấm.
fn decimals(v: f64) -> usize {
    if v != 0.0 && v.abs() < 1e-6 {
        return 0;
    }
    dec(v).split_once('.').map_or(0, |(_, f)| f.len())
}

/// `@IsNumber({ maxDecimalPlaces }) @Min @Max`: Max báo trước, rồi Min, rồi IsNumber.
fn number_field(field: &str, v: f64, places: usize, min: f64, max: f64, out: &mut Vec<String>) {
    frange(field, v, Some(min), Some(max), out);
    if !v.is_finite() || decimals(v) > places {
        out.push(format!(
            "{field} must be a number conforming to the specified constraints"
        ));
    }
}

fn is_money(s: &str) -> bool {
    (1..=15).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

impl UpdatePayslip {
    fn money(&self) -> [(&'static str, &Option<String>); 12] {
        [
            ("base_salary", &self.base_salary),
            ("training_salary", &self.training_salary),
            ("probation_allowance", &self.probation_allowance),
            ("sales_personal", &self.sales_personal),
            ("bonus_sales_personal", &self.bonus_sales_personal),
            ("sales_team", &self.sales_team),
            ("bonus_cskh_team", &self.bonus_cskh_team),
            ("bonus_milestone", &self.bonus_milestone),
            ("bonus_referral", &self.bonus_referral),
            ("holiday_bonus", &self.holiday_bonus),
            ("advances", &self.advances),
            ("personal_income_tax", &self.personal_income_tax),
        ]
    }

    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(Some(v)) = self.working_days {
            number_field("working_days", v, 1, 0.0, 31.0, &mut e);
        }
        if let Some(v) = self.standard_working_days {
            range("standard_working_days", v, Some(1), Some(31), &mut e);
        }
        if let Some(Some(v)) = self.training_days {
            number_field("training_days", v, 1, 0.0, 31.0, &mut e);
        }
        for (name, v) in self.money() {
            if v.as_deref().is_some_and(|s| !is_money(s)) {
                e.push(format!("{name} phải là số nguyên không âm (VNĐ)"));
            }
        }
        if let Some(Some(v)) = self.bonus_rate {
            number_field("bonus_rate", v, 4, 0.0, 100.0, &mut e);
        }
        if let Some(Some(v)) = self.kpi_percent {
            number_field("kpi_percent", v, 2, 0.0, 999.99, &mut e);
        }
        if let Some(Some(n)) = &self.notes
            && len16(n) > 2000
        {
            e.push("notes must be shorter than or equal to 2000 characters".to_owned());
        }
        finish(e)
    }
}

// ---------------------------------------------------------------- đọc

/// Một dòng phiếu kèm nhân viên (khớp `payslipFieldsSelect` + `employeeListSelect`).
#[derive(Debug, sqlx::FromRow)]
struct PayslipRow {
    id: i32,
    employee_id: i32,
    month: String,
    base_salary: i64,
    kpi_bonus: i64,
    deductions: i64,
    total: i64,
    components_json: Option<JsonValue>,
    insurance_json: Option<JsonValue>,
    insurance_base: i64,
    tax_json: Option<JsonValue>,
    working_days: Option<f64>,
    standard_working_days: i32,
    base_salary_actual: i64,
    training_days: Option<f64>,
    training_salary: i64,
    probation_allowance: i64,
    sales_personal: i64,
    bonus_rate: Option<f64>,
    kpi_percent: Option<f64>,
    bonus_sales_personal: i64,
    sales_team: i64,
    bonus_cskh_team: i64,
    bonus_milestone: i64,
    bonus_referral: i64,
    holiday_bonus: i64,
    advances: i64,
    personal_income_tax: i64,
    notes: Option<String>,
    status: String,
    tl_approved_by: Option<i32>,
    tl_approved_at: Option<Timestamp>,
    approved_by: Option<i32>,
    approved_at: Option<Timestamp>,
    created_at: Timestamp,
    updated_at: Timestamp,
    e_user_id: i32,
    e_position: String,
    e_code: Option<String>,
    e_team_id: Option<i32>,
    e_bank_account_number: Option<String>,
    e_bank_name: Option<String>,
    e_department: Option<String>,
    e_office_id: Option<i32>,
    office_name: Option<String>,
    u_full_name: Option<String>,
    u_email: String,
    manager_id: Option<i32>,
    manager_name: Option<String>,
    jt_category: Option<String>,
    jt_name: Option<String>,
    jt_standard_target: Option<i64>,
}

const SELECT_P: &str = "SELECT p.id, p.employee_id, p.month, p.base_salary, p.kpi_bonus, p.deductions, p.total, \
 p.components_json, p.insurance_json, p.insurance_base, p.tax_json, p.working_days::float8 AS working_days, \
 p.standard_working_days, p.base_salary_actual, p.training_days::float8 AS training_days, p.training_salary, \
 p.probation_allowance, p.sales_personal, p.bonus_rate::float8 AS bonus_rate, p.kpi_percent::float8 AS kpi_percent, \
 p.bonus_sales_personal, p.sales_team, p.bonus_cskh_team, p.bonus_milestone, p.bonus_referral, p.holiday_bonus, \
 p.advances, p.personal_income_tax, p.notes, p.status, p.tl_approved_by, p.tl_approved_at, p.approved_by, p.approved_at, \
 p.created_at, p.updated_at, \
 e.user_id AS e_user_id, e.position AS e_position, e.employee_code AS e_code, e.team_id AS e_team_id, \
 e.bank_account_number AS e_bank_account_number, e.bank_name AS e_bank_name, e.department AS e_department, \
 e.office_id AS e_office_id, o.name AS office_name, u.full_name AS u_full_name, u.email AS u_email, \
 u.manager_id AS manager_id, m.full_name AS manager_name, jt.category AS jt_category, jt.name AS jt_name, \
 jt.standard_target AS jt_standard_target \
 FROM payslips p JOIN employees e ON e.id = p.employee_id JOIN users u ON u.id = e.user_id \
 LEFT JOIN users m ON m.id = u.manager_id LEFT JOIN attendance_offices o ON o.id = e.office_id \
 LEFT JOIN job_titles jt ON jt.id = e.job_title_id";

/// Số nguyên như `Value::Number` của JS (`23`, không `23.0`).
fn jnum(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.0e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

fn jopt(x: Option<f64>) -> Value {
    x.map_or(Value::Null, jnum)
}

/// `BigInt(Math.round(Number(v)))` của `sumInsurance`/`readTax`: số hoặc chuỗi số hữu hạn; khác ⇒ bỏ qua.
fn money_of(v: &Value) -> Option<i64> {
    let x = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().ok()? }
        }
        _ => return None,
    };
    let r = js_round(x);
    (r.is_finite() && r.abs() < 9.2e18).then_some(r as i64)
}

fn insurance_total(j: Option<&Value>) -> i64 {
    let Some(Value::Array(items)) = j else { return 0 };
    items
        .iter()
        .filter_map(|i| i.get("amount").and_then(money_of))
        .fold(0_i64, i64::saturating_add)
}

fn read_tax(j: Option<&Value>) -> i64 {
    match j {
        Some(Value::Object(m)) => m.get("tax").and_then(money_of).unwrap_or(0),
        _ => 0,
    }
}

/// `computeBonusSuggestion`: `bonus_rate` là phần trăm.
pub fn bonus_suggestion(sales_personal: i64, rate: Option<f64>) -> i64 {
    match rate {
        Some(r) if r > 0.0 => js_round(sales_personal as f64 * r / 100.0) as i64,
        _ => 0,
    }
}

/// Mã NV hiển thị: mã nhập tay, không có thì `NV` + id đệm 0 đủ 4 chữ số.
pub fn employee_code(code: Option<&str>, id: i32) -> String {
    code.map_or_else(|| format!("NV{id:04}"), str::to_owned)
}

fn serialize(p: &PayslipRow) -> Value {
    let ins = insurance_total(p.insurance_json.as_ref().map(|j| &j.0));
    let tax_total = if p.personal_income_tax > 0 {
        p.personal_income_tax
    } else {
        read_tax(p.tax_json.as_ref().map(|j| &j.0))
    };
    let cong_lcb = p
        .base_salary_actual
        .saturating_add(p.training_salary)
        .saturating_add(p.probation_allowance);
    let cong_thuong = [
        p.bonus_sales_personal,
        p.bonus_cskh_team,
        p.bonus_milestone,
        p.bonus_referral,
        p.holiday_bonus,
    ]
    .into_iter()
    .fold(0_i64, i64::saturating_add);
    let tong_luong = cong_lcb.saturating_add(cong_thuong);
    let tong_giam_tru = p
        .deductions
        .saturating_add(p.advances)
        .saturating_add(p.personal_income_tax);
    let phu_cap = if p.insurance_base > 0 && p.base_salary > p.insurance_base {
        p.base_salary - p.insurance_base
    } else {
        0
    };
    let don_gia = if p.standard_working_days > 0 {
        js_round(p.base_salary as f64 / f64::from(p.standard_working_days)) as i64
    } else {
        0
    };
    let suggested = bonus_suggestion(p.sales_personal, p.bonus_rate);
    let manager = match p.manager_id {
        Some(id) => json!({ "id": id, "full_name": p.manager_name }),
        None => Value::Null,
    };
    let has_title = p.jt_name.is_some();
    let employee = json!({
        "id": p.employee_id,
        "user_id": p.e_user_id,
        "position": p.e_position,
        "employee_code": employee_code(p.e_code.as_deref(), p.employee_id),
        "team_id": p.e_team_id,
        "user": { "full_name": p.u_full_name, "email": p.u_email, "manager": manager },
        "bank_account_number": p.e_bank_account_number,
        "bank_name": p.e_bank_name,
        "department": p.e_department,
        "office_id": p.e_office_id,
        "team_lead_id": p.manager_id,
        "team_name": p.manager_name,
        "office_name": p.office_name,
        "job_title_name": if has_title { json!(p.jt_name) } else { Value::Null },
        "job_title_category": if has_title { json!(p.jt_category) } else { Value::Null },
        "standard_target": if has_title { json!(p.jt_standard_target.map(|t| t.to_string())) } else { Value::Null },
    });
    json!({
        "id": p.id,
        "employee_id": p.employee_id,
        "month": p.month,
        "base_salary": p.base_salary.to_string(),
        "kpi_bonus": p.kpi_bonus.to_string(),
        "deductions": p.deductions.to_string(),
        "total": p.total.to_string(),
        "components_json": p.components_json,
        "insurance_json": p.insurance_json,
        "tax_json": p.tax_json,
        "working_days": jopt(p.working_days),
        "standard_working_days": p.standard_working_days,
        "base_salary_actual": p.base_salary_actual.to_string(),
        "training_days": jopt(p.training_days),
        "training_salary": p.training_salary.to_string(),
        "probation_allowance": p.probation_allowance.to_string(),
        "sales_personal": p.sales_personal.to_string(),
        "bonus_rate": jopt(p.bonus_rate),
        "kpi_percent": jopt(p.kpi_percent),
        "bonus_sales_personal": p.bonus_sales_personal.to_string(),
        "sales_team": p.sales_team.to_string(),
        "bonus_cskh_team": p.bonus_cskh_team.to_string(),
        "bonus_milestone": p.bonus_milestone.to_string(),
        "bonus_referral": p.bonus_referral.to_string(),
        "holiday_bonus": p.holiday_bonus.to_string(),
        "advances": p.advances.to_string(),
        "personal_income_tax": p.personal_income_tax.to_string(),
        "notes": p.notes,
        "cong_lcb": cong_lcb.to_string(),
        "cong_thuong": cong_thuong.to_string(),
        "tong_luong": tong_luong.to_string(),
        "insurance_total": ins.to_string(),
        "insurance_base": p.insurance_base.to_string(),
        "phu_cap_xang_xe": phu_cap.to_string(),
        "tax_total": tax_total.to_string(),
        "tong_giam_tru": tong_giam_tru.to_string(),
        "don_gia_ngay_cong": don_gia.to_string(),
        "bonus_sales_personal_suggested": suggested.to_string(),
        "status": p.status,
        "tl_approved_by": p.tl_approved_by,
        "tl_approved_at": p.tl_approved_at,
        "approved_by": p.approved_by,
        "approved_at": p.approved_at,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "employee": employee,
    })
}

fn vi(a: &str, b: &str) -> Ordering {
    compare(a, b, Collation::Vi)
}

/// Thứ tự danh sách: nhóm theo quản lý trực tiếp (không quản lý xuống cuối), trưởng nhóm đứng đầu nhóm, rồi tên (vi).
fn team_order(a: &PayslipRow, b: &PayslipRow) -> Ordering {
    let rank = |p: &PayslipRow| if p.manager_id.is_none() { 999 } else { 0 };
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    let (la, lb) = (a.manager_id.unwrap_or(0), b.manager_id.unwrap_or(0));
    if la != lb {
        return la.cmp(&lb);
    }
    let head = |p: &PayslipRow| i32::from(Some(p.e_user_id) != p.manager_id);
    let (sa, sb) = (head(a), head(b));
    if sa != sb {
        return sa.cmp(&sb);
    }
    vi(
        a.u_full_name.as_deref().unwrap_or(""),
        b.u_full_name.as_deref().unwrap_or(""),
    )
}

/// `GET /payslips?month=&team_id=&status=`: phiếu chưa loại khỏi kỳ trong phạm vi `payroll.view`. `team_id` chỉ có tác dụng
/// khi phạm vi là tất cả (như bản TS).
pub async fn find_all(conn: &mut PgConnection, q: &QueryPayslips, scope: Option<&[i32]>) -> R<Vec<Value>> {
    let mut qb = QueryBuilder::<Postgres>::new(SELECT_P);
    qb.push(" WHERE p.deleted_at IS NULL AND p.month = ")
        .push_bind(q.month.clone());
    if let Some(ids) = scope {
        qb.push(" AND e.user_id = ANY(").push_bind(ids.to_vec()).push(")");
    }
    if let Some(s) = q.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND p.status = ").push_bind(s.to_owned());
    }
    if scope.is_none()
        && let Some(t) = q.team_id.and_then(|t| i32::try_from(t).ok())
    {
        qb.push(" AND e.team_id = ").push_bind(t);
    }
    qb.push(" ORDER BY p.id ASC");
    let mut rows: Vec<PayslipRow> = qb
        .build_query_as::<PayslipRow>()
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    rows.sort_by(team_order);
    Ok(rows.iter().map(serialize).collect())
}

/// `GET /payslips/:id`: phiếu đã loại khỏi kỳ coi như không có (404); ngoài phạm vi ⇒ 404.
pub async fn find_by_id(conn: &mut PgConnection, id: i32, scope: Option<&[i32]>) -> R<Value> {
    let mut qb = QueryBuilder::<Postgres>::new(SELECT_P);
    qb.push(" WHERE p.deleted_at IS NULL AND p.id = ").push_bind(id);
    let row = qb
        .build_query_as::<PayslipRow>()
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or_else(|| not_found_id(id))?;
    if !in_scope(scope, row.e_user_id) {
        return Err(out_of_scope());
    }
    Ok(serialize(&row))
}

/// `GET /payslips/me?month=`: phiếu của CHÍNH người gọi (chỉ cần đăng nhập), mới nhất trước.
pub async fn find_mine(conn: &mut PgConnection, user_id: i32, month: Option<&str>) -> R<Vec<Value>> {
    let mut qb = QueryBuilder::<Postgres>::new(SELECT_P);
    qb.push(" WHERE p.deleted_at IS NULL AND e.user_id = ")
        .push_bind(user_id);
    if let Some(m) = month.filter(|m| !m.is_empty()) {
        qb.push(" AND p.month = ").push_bind(m.to_owned());
    }
    qb.push(" ORDER BY p.month DESC, p.id ASC");
    let rows: Vec<PayslipRow> = qb
        .build_query_as::<PayslipRow>()
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    Ok(rows.iter().map(serialize).collect())
}

#[derive(Debug, sqlx::FromRow)]
struct AddableRow {
    id: i32,
    employee_code: Option<String>,
    user_id: i32,
    full_name: Option<String>,
    email: String,
    manager_id: Option<i32>,
    manager_name: Option<String>,
    job_title_name: Option<String>,
}

/// `GET /payslips/addable?month=`: nhân viên `active` chưa có phiếu (chưa loại) trong tháng, xếp theo tên (vi).
pub async fn list_addable(conn: &mut PgConnection, month: &str) -> R<Vec<Value>> {
    let mut rows: Vec<AddableRow> = sqlx::query_as::<_, AddableRow>(
        "SELECT e.id, e.employee_code, e.user_id, u.full_name, u.email, u.manager_id, m.full_name AS manager_name, \
         jt.name AS job_title_name \
         FROM employees e JOIN users u ON u.id = e.user_id LEFT JOIN users m ON m.id = u.manager_id \
         LEFT JOIN job_titles jt ON jt.id = e.job_title_id \
         WHERE e.status = 'active' \
           AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.employee_id = e.id AND p.month = $1 AND p.deleted_at IS NULL) \
         ORDER BY e.id ASC",
    )
    .bind(month)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    rows.sort_by(|a, b| {
        vi(
            a.full_name.as_deref().unwrap_or(""),
            b.full_name.as_deref().unwrap_or(""),
        )
    });
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "employee_id": r.id,
                "employee_code": employee_code(r.employee_code.as_deref(), r.id),
                "user_id": r.user_id,
                "full_name": r.full_name,
                "email": r.email,
                "job_title_name": r.job_title_name,
                "team_name": r.manager_name,
                "team_lead_id": r.manager_id,
            })
        })
        .collect())
}

// ---------------------------------------------------------------- tính phiếu

/// Các khoản nhập tay đã resolve (cột thật của `payslips`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Manual {
    pub working_days: Option<f64>,
    pub standard_working_days: i32,
    pub base_salary: i64,
    pub training_days: Option<f64>,
    pub training_salary: i64,
    pub probation_allowance: i64,
    pub sales_personal: i64,
    pub bonus_rate: Option<f64>,
    pub kpi_percent: Option<f64>,
    pub bonus_sales_personal: i64,
    pub sales_team: i64,
    pub bonus_cskh_team: i64,
    pub bonus_milestone: i64,
    pub bonus_referral: i64,
    pub holiday_bonus: i64,
    pub advances: i64,
    pub personal_income_tax: i64,
    pub notes: Option<String>,
}

const MANUAL_COLS: &str = "p.working_days::float8 AS working_days, p.standard_working_days, p.base_salary, \
 p.training_days::float8 AS training_days, p.training_salary, p.probation_allowance, p.sales_personal, \
 p.bonus_rate::float8 AS bonus_rate, p.kpi_percent::float8 AS kpi_percent, p.bonus_sales_personal, p.sales_team, \
 p.bonus_cskh_team, p.bonus_milestone, p.bonus_referral, p.holiday_bonus, p.advances, p.personal_income_tax, p.notes";

impl Manual {
    fn input(&self) -> ManualInput {
        ManualInput {
            working_days: self.working_days,
            standard_working_days: i64::from(self.standard_working_days),
            base_salary: self.base_salary,
            training_salary: self.training_salary,
            probation_allowance: self.probation_allowance,
            bonus_sales_personal: self.bonus_sales_personal,
            bonus_cskh_team: self.bonus_cskh_team,
            bonus_milestone: self.bonus_milestone,
            bonus_referral: self.bonus_referral,
            holiday_bonus: self.holiday_bonus,
            advances: self.advances,
            personal_income_tax: self.personal_income_tax,
        }
    }

    /// `mergeManualFields`: trường vắng (hoặc `null` ở trường tiền) giữ giá trị đã lưu; `null` ở trường nhận `null` là xoá.
    pub fn merged(&self, d: &UpdatePayslip) -> Self {
        let money = |v: &Option<String>, cur: i64| v.as_deref().and_then(|s| s.parse::<i64>().ok()).unwrap_or(cur);
        Self {
            working_days: d.working_days.unwrap_or(self.working_days),
            standard_working_days: d
                .standard_working_days
                .and_then(|v| i32::try_from(v).ok())
                .unwrap_or(self.standard_working_days),
            base_salary: money(&d.base_salary, self.base_salary),
            training_days: d.training_days.unwrap_or(self.training_days),
            training_salary: money(&d.training_salary, self.training_salary),
            probation_allowance: money(&d.probation_allowance, self.probation_allowance),
            sales_personal: money(&d.sales_personal, self.sales_personal),
            bonus_rate: d.bonus_rate.unwrap_or(self.bonus_rate),
            kpi_percent: d.kpi_percent.unwrap_or(self.kpi_percent),
            bonus_sales_personal: money(&d.bonus_sales_personal, self.bonus_sales_personal),
            sales_team: money(&d.sales_team, self.sales_team),
            bonus_cskh_team: money(&d.bonus_cskh_team, self.bonus_cskh_team),
            bonus_milestone: money(&d.bonus_milestone, self.bonus_milestone),
            bonus_referral: money(&d.bonus_referral, self.bonus_referral),
            holiday_bonus: money(&d.holiday_bonus, self.holiday_bonus),
            advances: money(&d.advances, self.advances),
            personal_income_tax: money(&d.personal_income_tax, self.personal_income_tax),
            notes: d.notes.clone().unwrap_or_else(|| self.notes.clone()),
        }
    }
}

/// Nhân viên tối thiểu để tính phiếu (`EmpForCompute`).
#[derive(Debug, Clone, sqlx::FromRow)]
struct Emp {
    id: i32,
    user_id: i32,
    salary_rule_id: Option<i32>,
    job_title_id: Option<i32>,
    insurance_salary: Option<i64>,
    dependents_count: i32,
    jt_base_salary: Option<i64>,
    jt_rank_code: Option<String>,
    jt_default_insurance_salary: Option<i64>,
}

impl Emp {
    fn input(&self) -> EmployeeInput {
        EmployeeInput {
            rank_code: self.jt_rank_code.clone(),
            insurance_salary: self.insurance_salary,
            default_insurance_salary: self.jt_default_insurance_salary,
            dependents_count: i64::from(self.dependents_count),
        }
    }
}

const EMP_SELECT: &str = "SELECT e.id, e.user_id, e.salary_rule_id, e.job_title_id, e.insurance_salary, \
 e.dependents_count, jt.base_salary AS jt_base_salary, jt.rank_code AS jt_rank_code, \
 jt.default_insurance_salary AS jt_default_insurance_salary \
 FROM employees e LEFT JOIN job_titles jt ON jt.id = e.job_title_id";

/// `fetchEmployees`: nhân viên `active` chưa xoá, lọc theo `ids` nếu có (mảng rỗng = tất cả).
async fn fetch_employees(conn: &mut PgConnection, ids: Option<&[i32]>) -> R<Vec<Emp>> {
    let mut qb = QueryBuilder::<Postgres>::new(EMP_SELECT);
    qb.push(" WHERE e.status = 'active' AND e.deleted_at IS NULL");
    if let Some(ids) = ids.filter(|v| !v.is_empty()) {
        qb.push(" AND e.id = ANY(").push_bind(ids.to_vec()).push(")");
    }
    qb.push(" ORDER BY e.id ASC");
    qb.build_query_as::<Emp>().fetch_all(&mut *conn).await.map_err(db)
}

/// Nhân viên của phiếu theo id, KHÔNG lọc trạng thái (như `include: { employee }` của `update`).
async fn fetch_employee_any(conn: &mut PgConnection, employee_id: i32) -> R<Option<Emp>> {
    let mut qb = QueryBuilder::<Postgres>::new(EMP_SELECT);
    qb.push(" WHERE e.id = ").push_bind(employee_id);
    qb.build_query_as::<Emp>().fetch_optional(&mut *conn).await.map_err(db)
}

/// Lương cơ bản của `assembleEngine`: chức danh (nếu > 0), rồi dòng `base` của bảng lương (số tiền khác 0, dòng sau thắng).
async fn engine_base(conn: &mut PgConnection, emp: &Emp) -> R<i64> {
    let mut base = 0_i64;
    if emp.job_title_id.is_some()
        && let Some(b) = emp.jt_base_salary.filter(|b| *b > 0)
    {
        base = b;
    }
    if let Some(rule) = emp.salary_rule_id {
        let details: Vec<(String, Option<i64>)> = sqlx::query_as(
            "SELECT component, amount FROM salary_rule_details WHERE salary_rule_id = $1 ORDER BY \"order\" ASC, id ASC",
        )
        .bind(rule)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        for (component, amount) in details {
            if component == "base"
                && let Some(a) = amount.filter(|a| *a != 0)
            {
                base = a;
            }
        }
    }
    Ok(base)
}

/// Ngày công từ chấm công: ngày có check-in trong tháng (`half_day` = 0,5); không có dữ liệu ⇒ `None`.
async fn attendance_days(conn: &mut PgConnection, user_id: i32, month: &str) -> R<Option<f64>> {
    let (y, m) = month.split_once('-').unwrap_or(("0", "0"));
    let (y, m): (i32, u32) = (y.parse().unwrap_or(0), m.parse().unwrap_or(0));
    if y == 0 || m == 0 {
        return Ok(None);
    }
    let from = format!("{y:04}-{m:02}-01");
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let to = format!("{ny:04}-{nm:02}-01");
    let (n, days): (i64, f64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN status = 'half_day' THEN 0.5 ELSE 1 END), 0)::float8 \
         FROM attendance_records WHERE user_id = $1 AND work_date >= $2::text::date AND work_date < $3::text::date \
         AND check_in_at IS NOT NULL",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    Ok((n > 0).then_some(days))
}

/// Ghi các cột do bộ tính điền + các khoản nhập tay của phiếu `id` (như `prisma.payslip.update`: luôn đặt `updated_at`).
async fn persist(conn: &mut PgConnection, id: i32, c: &PayslipComputed, m: &Manual) -> R<()> {
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE payslips SET updated_at = now()");
    set(&mut qb, "base_salary", c.base_salary);
    set(&mut qb, "kpi_bonus", c.kpi_bonus);
    set(&mut qb, "deductions", c.deductions);
    set(&mut qb, "total", c.total);
    qb.push(", components_json = ")
        .push_bind(js_json(&Value::Array(c.components_json.clone())))
        .push("::text::jsonb");
    qb.push(", insurance_json = ")
        .push_bind(js_json(&Value::Array(c.insurance_json.clone())))
        .push("::text::jsonb");
    qb.push(", tax_json = ")
        .push_bind(c.tax_json.as_ref().map(js_json))
        .push("::text::jsonb");
    set(&mut qb, "insurance_base", c.insurance_base);
    set_num(&mut qb, "working_days", m.working_days);
    set(&mut qb, "standard_working_days", m.standard_working_days);
    set(&mut qb, "base_salary_actual", c.base_salary_actual);
    set_num(&mut qb, "training_days", m.training_days);
    set(&mut qb, "training_salary", m.training_salary);
    set(&mut qb, "probation_allowance", m.probation_allowance);
    set(&mut qb, "sales_personal", m.sales_personal);
    set_num(&mut qb, "bonus_rate", m.bonus_rate);
    set_num(&mut qb, "kpi_percent", m.kpi_percent);
    set(&mut qb, "bonus_sales_personal", m.bonus_sales_personal);
    set(&mut qb, "sales_team", m.sales_team);
    set(&mut qb, "bonus_cskh_team", m.bonus_cskh_team);
    set(&mut qb, "bonus_milestone", m.bonus_milestone);
    set(&mut qb, "bonus_referral", m.bonus_referral);
    set(&mut qb, "holiday_bonus", m.holiday_bonus);
    set(&mut qb, "advances", m.advances);
    set(&mut qb, "personal_income_tax", m.personal_income_tax);
    set(&mut qb, "notes", m.notes.clone());
    qb.push(" WHERE id = ").push_bind(id);
    qb.build().execute(&mut *conn).await.map_err(db)?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct Stored {
    id: i32,
    status: String,
    deleted: bool,
    #[sqlx(flatten)]
    manual: Manual,
}

/// Phiếu theo id (`by_id`) hoặc theo `(employee_id, month)`, khoá dòng để hai lượt tính/sửa chạy lần lượt.
async fn stored(conn: &mut PgConnection, id_or_employee: i32, month: Option<&str>) -> R<Option<Stored>> {
    let where_sql = if month.is_some() {
        "p.employee_id = $1 AND p.month = $2"
    } else {
        "p.id = $1"
    };
    let sql = format!(
        "SELECT p.id, p.status, (p.deleted_at IS NOT NULL) AS deleted, {MANUAL_COLS} FROM payslips p \
         WHERE {where_sql} FOR UPDATE OF p"
    );
    let q = sqlx::query_as::<_, Stored>(AssertSqlSafe(sql)).bind(id_or_employee);
    let q = match month {
        Some(m) => q.bind(m.to_owned()),
        None => q,
    };
    q.fetch_optional(&mut *conn).await.map_err(db)
}

/// `generateForEmployee`: `true` = đã tạo/làm mới, `false` = bỏ qua (đã loại khỏi kỳ hoặc không còn là nháp).
async fn generate_for(conn: &mut PgConnection, cfg: &PayrollConfig, emp: &Emp, month: &str) -> R<bool> {
    let existing = stored(conn, emp.id, Some(month)).await?;
    if let Some(e) = &existing
        && (e.deleted || e.status != "draft")
    {
        return Ok(false);
    }
    let base = engine_base(conn, emp).await?;
    let kpi_n = calc::kpi_achieved_count(conn, emp.id, month).await?;
    let manual = match &existing {
        Some(e) => e.manual.clone(),
        None => {
            let totals = calc::compute_components(base, month, emp.jt_rank_code.as_deref(), &cfg.components)
                .map_err(calc_err)?;
            Manual {
                working_days: attendance_days(conn, emp.user_id, month).await?,
                standard_working_days: 24,
                base_salary: base,
                training_days: None,
                training_salary: 0,
                probation_allowance: totals.allowances,
                sales_personal: 0,
                bonus_rate: None,
                kpi_percent: None,
                bonus_sales_personal: 0,
                sales_team: 0,
                bonus_cskh_team: totals.bonuses,
                bonus_milestone: calc::kpi_bonus(kpi_n),
                bonus_referral: 0,
                holiday_bonus: 0,
                advances: 0,
                personal_income_tax: 0,
                notes: None,
            }
        }
    };
    let computed = calc::compute_payslip(cfg, month, base, kpi_n, &emp.input(), &manual.input()).map_err(calc_err)?;
    let id = match existing {
        Some(e) => e.id,
        None => sqlx::query_scalar::<_, i32>(
            "INSERT INTO payslips (employee_id, month, status, updated_at) VALUES ($1, $2, 'draft', now()) RETURNING id",
        )
        .bind(emp.id)
        .bind(month)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?,
    };
    persist(conn, id, &computed, &manual).await?;
    Ok(true)
}

/// Kết quả `POST /payslips/generate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Generated {
    pub generated: u32,
    pub skipped: u32,
}

/// `POST /payslips/generate`: tính phiếu từ KPI + bảng lương cho nhân viên `active` (hoặc theo `employee_ids`). Phiếu mới
/// được điền sẵn từ cấu hình; phiếu nháp đã có giữ các khoản kế toán đã nhập và chỉ tính lại; phiếu đã loại khỏi kỳ hoặc
/// đã gửi duyệt/duyệt thì bỏ qua.
pub async fn generate(conn: &mut PgConnection, input: &GenerateInput) -> R<Generated> {
    let ids = input.ids();
    let employees = fetch_employees(conn, ids.as_deref()).await?;
    let cfg = calc::load_config(conn).await?;
    let mut out = Generated {
        generated: 0,
        skipped: 0,
    };
    for emp in &employees {
        if generate_for(conn, &cfg, emp, &input.month).await? {
            out.generated += 1;
        } else {
            out.skipped += 1;
        }
    }
    Ok(out)
}

const NOT_ACTIVE: &str = "Nhân viên không tồn tại hoặc không ở trạng thái đang làm việc";

/// `POST /payslips/add-to-period`: khôi phục phiếu đã loại hoặc tạo phiếu mới cho một nhân viên `active`; trả phiếu như
/// `GET /payslips/:id` (theo phạm vi `payroll.view` của người gọi).
pub async fn add_to_period(conn: &mut PgConnection, input: &AddToPeriodInput, view_scope: Option<&[i32]>) -> R<Value> {
    let employee_id = i32::try_from(input.employee_id).map_err(|_| HttpError::bad_request(NOT_ACTIVE))?;
    let emps = fetch_employees(conn, Some(&[employee_id])).await?;
    let Some(emp) = emps.into_iter().find(|e| e.id == employee_id) else {
        return Err(HttpError::bad_request(NOT_ACTIVE).into());
    };
    if let Some(e) = stored(conn, employee_id, Some(&input.month)).await? {
        if !e.deleted {
            return Err(HttpError::bad_request("Nhân viên đã có trong kỳ lương này").into());
        }
        sqlx::query("UPDATE payslips SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1")
            .bind(e.id)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        return find_by_id(conn, e.id, view_scope).await;
    }
    let cfg = calc::load_config(conn).await?;
    generate_for(conn, &cfg, &emp, &input.month).await?;
    let created: Option<i32> = sqlx::query_scalar("SELECT id FROM payslips WHERE employee_id = $1 AND month = $2")
        .bind(employee_id)
        .bind(&input.month)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let id = created.ok_or_else(|| HttpError::bad_request("Không thể tạo phiếu lương cho nhân viên này"))?;
    find_by_id(conn, id, view_scope).await
}

/// `PATCH /payslips/:id`: kế toán nhập tay/sửa; phiếu đã duyệt/đã trả không sửa được (400). Tính lại cả phiếu rồi trả như
/// `GET /payslips/:id`.
pub async fn update(conn: &mut PgConnection, id: i32, dto: &UpdatePayslip, view_scope: Option<&[i32]>) -> R<Value> {
    let existing = stored(conn, id, None).await?;
    let Some(existing) = existing.filter(|e| !e.deleted) else {
        return Err(not_found_id(id));
    };
    if existing.status == "approved" || existing.status == "paid" {
        return Err(HttpError::bad_request(
            "Phiếu lương đã duyệt/đã trả không thể sửa. Vui lòng trả phiếu về nháp trước khi sửa.",
        )
        .into());
    }
    let (employee_id, month): (i32, String) = sqlx::query_as("SELECT employee_id, month FROM payslips WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let emp = fetch_employee_any(conn, employee_id)
        .await?
        .ok_or_else(|| not_found_id(id))?;
    let cfg = calc::load_config(conn).await?;
    let base = engine_base(conn, &emp).await?;
    let kpi_n = calc::kpi_achieved_count(conn, emp.id, &month).await?;
    let manual = existing.manual.merged(dto);
    let computed = calc::compute_payslip(&cfg, &month, base, kpi_n, &emp.input(), &manual.input()).map_err(calc_err)?;
    persist(conn, id, &computed, &manual).await?;
    find_by_id(conn, id, view_scope).await
}

/// `DELETE /payslips/:id`: loại khỏi kỳ (xoá mềm). Phiếu đã duyệt/đã trả chỉ người có `payroll.approve_final` được loại.
pub async fn remove_from_period(conn: &mut PgConnection, id: i32, actor: i32, can_approve_final: bool) -> R<Value> {
    let row: Option<(String, bool, String, i32)> = sqlx::query_as(
        "SELECT status, (deleted_at IS NOT NULL), month, employee_id FROM payslips WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let Some((status, _, month, employee_id)) = row.filter(|r| !r.1) else {
        return Err(HttpError::not_found(format!("Phiếu lương #{id} không tồn tại")).into());
    };
    if (status == "approved" || status == "paid") && !can_approve_final {
        return Err(
            HttpError::forbidden("Phiếu lương đã duyệt — chỉ người có quyền duyệt bước 2 được loại khỏi kỳ").into(),
        );
    }
    sqlx::query("UPDATE payslips SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(actor)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(
        json!({ "id": id, "month": month, "employee_id": employee_id, "message": "Đã loại nhân viên khỏi kỳ lương này" }),
    )
}

// ---------------------------------------------------------------- duyệt

/// Người duyệt: quyền nào giữ (router đã kiểm `CanAny`) và phạm vi của `payroll.approve_team`.
#[derive(Debug, Clone)]
pub struct Approver {
    pub user_id: i32,
    pub can_team: bool,
    pub can_final: bool,
    /// `user_id` chủ phiếu thuộc phạm vi `payroll.approve_team` (`None` = tất cả).
    pub team_scope: Option<Vec<i32>>,
}

/// Kết quả `PATCH /payslips/:id/approve`. `notifications` và `notify_error` KHÔNG vào JSON: bên gọi đẩy socket nội bộ sau
/// commit và ghi log lỗi thông báo (nếu có).
#[derive(Debug, Clone, Serialize)]
pub struct Approved {
    pub id: i32,
    pub status: String,
    pub message: String,
    #[serde(skip)]
    pub notifications: Vec<CreatedNotification>,
    #[serde(skip)]
    pub notify_error: Option<String>,
}

impl Approved {
    fn new(id: i32, status: &str) -> Self {
        Self {
            id,
            status: status.to_owned(),
            message: status_message(status).to_owned(),
            notifications: Vec::new(),
            notify_error: None,
        }
    }
}

#[derive(Debug, sqlx::FromRow)]
struct ApprovalRow {
    status: String,
    deleted: bool,
    month: String,
    total: i64,
    user_id: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Team,
    Final,
}

/// `assertApprovalPermission`: quyền theo trạng thái hiện tại. `allow_draft` = đang duyệt (từ chối không nhận `draft`).
fn assert_step(status: &str, a: &Approver, owner_user: i32, allow_draft: bool) -> Result<Step, AppError> {
    if status == "pending_accountant" {
        if !a.can_final {
            return Err(HttpError::forbidden("Chỉ người có quyền duyệt bước 2 được thao tác").into());
        }
        return Ok(Step::Final);
    }
    if status == "pending_tl" || (allow_draft && status == "draft") {
        if !a.can_team {
            return Err(HttpError::forbidden("Chỉ người có quyền duyệt bước 1 được thao tác").into());
        }
        if !in_scope(a.team_scope.as_deref(), owner_user) {
            return Err(out_of_scope());
        }
        return Ok(Step::Team);
    }
    Err(HttpError::conflict("Phiếu lương không ở bước chờ duyệt").into())
}

fn status_message(status: &str) -> &'static str {
    match status {
        "draft" => "Phiếu lương đã bị từ chối, chuyển về nháp",
        "pending_tl" => "Phiếu lương chờ Team Lead duyệt",
        "pending_accountant" => "Team Lead đã duyệt, chờ Kế toán duyệt",
        _ => "Phiếu lương đã được duyệt",
    }
}

/// `PATCH /payslips/:id/approve`: `reject` đưa phiếu đang chờ về nháp; `approve` bước 1 ⇒ `pending_accountant`, bước 2 ⇒
/// `approved` kèm thông báo cho người nhận. Không tự duyệt phiếu của mình (403). Bên gọi commit `tx`.
pub async fn approve(tx: &mut TenantTx, id: i32, input: &ApproveInput, who: &Approver) -> R<Approved> {
    let row: Option<ApprovalRow> = sqlx::query_as(
        "SELECT p.status, (p.deleted_at IS NOT NULL) AS deleted, p.month, p.total, e.user_id \
         FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.id = $1 FOR UPDATE OF p",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let Some(row) = row.filter(|r| !r.deleted) else {
        return Err(not_found_id(id));
    };
    if input.action == "reject" {
        assert_step(&row.status, who, row.user_id, false)?;
        sqlx::query(
            "UPDATE payslips SET status = 'draft', tl_approved_by = NULL, tl_approved_at = NULL, approved_by = NULL, \
             approved_at = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        return Ok(Approved::new(id, "draft"));
    }
    let step = assert_step(&row.status, who, row.user_id, true)?;
    if row.user_id == who.user_id {
        return Err(HttpError::forbidden("Không thể tự duyệt phiếu lương của mình").into());
    }
    if step == Step::Team {
        sqlx::query(
            "UPDATE payslips SET status = 'pending_accountant', tl_approved_by = $2, tl_approved_at = now(), \
             updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(who.user_id)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        return Ok(Approved::new(id, "pending_accountant"));
    }
    sqlx::query(
        "UPDATE payslips SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(who.user_id)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    let item = NewNotification {
        recipient_id: row.user_id,
        event_type: "payslip.approved".to_owned(),
        title: "Phiếu lương đã duyệt".to_owned(),
        body: format!(
            "Phiếu lương tháng {}: {} VNĐ",
            row.month,
            format_vn_number(row.total as f64)
        ),
        action_url: None,
    };
    let mut out = Approved::new(id, "approved");
    match notify_in_savepoint(tx, &item).await {
        Ok(created) => out.notifications = created,
        Err(e) => out.notify_error = Some(e),
    }
    Ok(out)
}

/// Thông báo KHÔNG được làm hỏng việc duyệt: chạy trong SAVEPOINT, lỗi thì rollback to savepoint và trả lỗi dạng chữ.
async fn notify_in_savepoint(tx: &mut TenantTx, item: &NewNotification) -> Result<Vec<CreatedNotification>, String> {
    if let Err(e) = sqlx::query("SAVEPOINT payslip_notify").execute(&mut **tx).await {
        return Err(e.to_string());
    }
    match create_notification(tx, std::slice::from_ref(item)).await {
        Ok(created) => {
            let _ = sqlx::query("RELEASE SAVEPOINT payslip_notify").execute(&mut **tx).await;
            Ok(created)
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK TO SAVEPOINT payslip_notify")
                .execute(&mut **tx)
                .await;
            let _ = sqlx::query("RELEASE SAVEPOINT payslip_notify").execute(&mut **tx).await;
            Err(format!(
                "Gửi thông báo phiếu lương đã duyệt cho người dùng {} lỗi: {e}",
                item.recipient_id
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approver(team: bool, fin: bool, scope: Option<Vec<i32>>) -> Approver {
        Approver {
            user_id: 1,
            can_team: team,
            can_final: fin,
            team_scope: scope,
        }
    }

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

    #[test]
    fn query_va_body_kiem_nhu_class_validator() {
        let q = QueryPayslips {
            month: "2026-13".into(),
            team_id: Some(0),
            status: Some("x".into()),
        };
        assert_eq!(
            msgs(q.validate()),
            [
                MONTH_MSG,
                "team_id must not be less than 1",
                "status must be one of the following values: draft, pending_tl, pending_accountant, approved, paid"
            ]
        );
        let q = QueryPayslips {
            month: "2026-12".into(),
            team_id: Some(2_147_483_648),
            status: None,
        };
        assert_eq!(msgs(q.validate()), ["team_id must not be greater than 2147483647"]);
        let g = GenerateInput {
            month: "2026-01".into(),
            employee_ids: Some(vec![1, 0, 3_000_000_000]),
        };
        assert_eq!(msgs(g.validate()).len(), 2);
        let a = ApproveInput {
            action: "x".into(),
            notes: Some("a".repeat(501)),
        };
        assert_eq!(msgs(a.validate()).len(), 2);
    }

    #[test]
    fn sua_phieu_kiem_tien_ngay_cong_va_thap_phan() {
        let d: UpdatePayslip = serde_json::from_value(json!({
            "working_days": 31.5, "standard_working_days": 0, "base_salary": "-1", "advances": "1234567890123456",
            "bonus_rate": 0.12345, "kpi_percent": 1000, "notes": null
        }))
        .unwrap();
        let m = msgs(d.validate());
        assert!(m.contains(&"working_days must not be greater than 31".to_owned()));
        assert!(m.contains(&"standard_working_days must not be less than 1".to_owned()));
        assert!(m.contains(&"base_salary phải là số nguyên không âm (VNĐ)".to_owned()));
        assert!(m.contains(&"advances phải là số nguyên không âm (VNĐ)".to_owned()));
        assert!(m.contains(&"bonus_rate must be a number conforming to the specified constraints".to_owned()));
        assert!(m.contains(&"kpi_percent must not be greater than 999.99".to_owned()));
        let ok: UpdatePayslip =
            serde_json::from_value(json!({"working_days": null, "bonus_rate": 0.4, "base_salary": "15000000"}))
                .unwrap();
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn null_xoa_hoac_giu_nguyen() {
        let cur = Manual {
            working_days: Some(20.0),
            standard_working_days: 24,
            base_salary: 10,
            training_days: Some(2.0),
            training_salary: 0,
            probation_allowance: 0,
            sales_personal: 0,
            bonus_rate: Some(0.4),
            kpi_percent: None,
            bonus_sales_personal: 0,
            sales_team: 0,
            bonus_cskh_team: 0,
            bonus_milestone: 0,
            bonus_referral: 0,
            holiday_bonus: 0,
            advances: 5,
            personal_income_tax: 0,
            notes: Some("x".into()),
        };
        let d: UpdatePayslip = serde_json::from_value(json!({
            "working_days": null, "base_salary": null, "advances": "7", "notes": null, "standard_working_days": null
        }))
        .unwrap();
        let m = cur.merged(&d);
        assert_eq!(
            (
                m.working_days,
                m.base_salary,
                m.advances,
                m.notes,
                m.standard_working_days,
                m.bonus_rate
            ),
            (None, 10, 7, None, 24, Some(0.4))
        );
        assert_eq!(cur.merged(&UpdatePayslip::default()), cur);
    }

    #[test]
    fn buoc_duyet_theo_quyen_va_trang_thai() {
        let code = |r: Result<Step, AppError>| match r {
            Ok(_) => 200,
            Err(e) => e.response(true).0,
        };
        assert_eq!(
            code(assert_step("pending_accountant", &approver(true, false, None), 5, true)),
            403
        );
        assert_eq!(
            assert_step("pending_accountant", &approver(false, true, None), 5, true).ok(),
            Some(Step::Final)
        );
        assert_eq!(
            code(assert_step("pending_tl", &approver(false, true, None), 5, true)),
            403
        );
        assert_eq!(
            code(assert_step(
                "pending_tl",
                &approver(true, false, Some(vec![9])),
                5,
                true
            )),
            404
        );
        assert_eq!(
            assert_step("draft", &approver(true, false, Some(vec![5])), 5, true).ok(),
            Some(Step::Team)
        );
        // Từ chối không nhận `draft`; `approved`/`paid` luôn 409.
        assert_eq!(code(assert_step("draft", &approver(true, true, None), 5, false)), 409);
        assert_eq!(code(assert_step("approved", &approver(true, true, None), 5, true)), 409);
        assert_eq!(code(assert_step("paid", &approver(true, true, None), 5, false)), 409);
    }

    #[test]
    fn so_lieu_dan_xuat() {
        assert_eq!(employee_code(None, 27), "NV0027");
        assert_eq!(employee_code(Some("A1"), 27), "A1");
        assert_eq!(bonus_suggestion(100_000_000, Some(0.4)), 400_000);
        assert_eq!(bonus_suggestion(100, Some(0.0)), 0);
        assert_eq!(bonus_suggestion(100, None), 0);
        let ins = json!([{"amount": 1600000}, {"amount": "300000.4"}, {"amount": "abc"}, {"x": 1}]);
        assert_eq!(insurance_total(Some(&ins)), 1_900_000);
        assert_eq!(insurance_total(None), 0);
        assert_eq!(read_tax(Some(&json!({"tax": 250.5}))), 251);
        assert_eq!(read_tax(Some(&json!([1]))), 0);
        assert_eq!(jnum(23.0), json!(23));
        assert_eq!(jnum(23.5), json!(23.5));
    }
}
