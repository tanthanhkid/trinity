//! Bộ tính lương và thuế (M30a): HÀM THUẦN chuyển từ `insurance.engine.ts`, `tax.engine.ts`,
//! `salary-components-engine.service.ts` và `buildPayslipData`/`prorateBase`/`calculateKpiBonus` của `payslips.service.ts`.
//!
//! # Bảng bước tính (PLAN mục 10.3)
//!
//! Tiền là `BigInt` ở TS ⇒ `i64` ở đây (cộng/trừ/nhân chính xác, tràn ⇒ lỗi chứ không quấn vòng). Mọi phép có tỷ lệ chạy
//! bằng số thực IEEE 754 như `Number` của JS rồi làm tròn bằng [`js_round`] (`Math.round`: nửa làm tròn về +∞, KHÔNG phải
//! `f64::round`). Tỷ lệ là `Decimal` ở DB, TS đọc bằng `Number(x.toString())` ⇒ ở đây giữ chuỗi và `parse::<f64>()`.
//!
//! | Bước | Nguồn TS | Kiểu số | Công thức | Làm tròn |
//! |---|---|---|---|---|
//! | Chọn dòng hiệu lực | 4 engine | chuỗi `YYYY-MM` | `is_active ∧ from ≤ tháng ∧ (to rỗng ∨ to ≥ tháng)` | không |
//! | Bảo hiểm: lương đóng | `cappedBase` | BigInt | `cap` rỗng hoặc ≤ 0 ⇒ nguyên lương; không thì `min(lương, cap)` | không |
//! | Bảo hiểm: tiền | `compute` | Number | `base × rate ÷ 100`; bỏ dòng nếu `rate` không hữu hạn/≤ 0, `base` ≤ 0 hoặc tiền ≤ 0 | `js_round` |
//! | Thành phần: áp dụng | `appliesTo` | chuỗi | `all`; `rank:<mã>` khớp `rank_code` khác rỗng | không |
//! | Thành phần: tiền | `computeAmount` | BigInt / Number | `fixed` ⇒ `fixed_amount ?? 0`; `percent_base` ⇒ `base × pct ÷ 100`, `pct` không hữu hạn/≤ 0 ⇒ 0; bỏ dòng ≤ 0 | `js_round` (chỉ `percent_base`) |
//! | Thành phần: cộng | `accumulateTotals` | BigInt | phụ cấp, thưởng, khấu trừ; `taxable` = phụ cấp + thưởng có `is_taxable` | không |
//! | Thuế: giảm trừ | `compute` | BigInt | `deps = max(0, NPT)`; `taxable = max(0, gross − BH − bản thân − deps × NPT)` | không |
//! | Thuế: bộ biểu | `fetchActiveBrackets` | chuỗi | chỉ bộ có `effective_from` MỚI NHẤT trong các dòng hiệu lực, theo `bracket_order` | không |
//! | Thuế: từng bậc | `applyProgressive` | BigInt / Number | `top = (upper rỗng ∨ taxable < upper) ? taxable : upper`; `portion = top − lower`, bỏ nếu ≤ 0; `portion × rate ÷ 100` | `js_round` |
//! | Phiếu: ngày công | `prorateBase` | Number | `ngày công` rỗng hoặc `chuẩn` ≤ 0 ⇒ nguyên lương; không thì `base × ngày ÷ chuẩn` | `js_round` |
//! | Phiếu: tổng lương | `buildPayslipData` | BigInt | `thực lĩnh LCB + học việc + thử việc + 5 khoản thưởng` | không |
//! | Phiếu: lương đóng BH | `buildPayslipData` | BigInt | `insurance_salary ?? (mặc định chức danh > 0 ? nó : lương cơ bản)` | không |
//! | Phiếu: khấu trừ | `buildPayslipData` | BigInt | `khấu trừ cấu hình + BH + (thuế nhập tay > 0 ? 0 : thuế hệ thống)` | không |
//! | Phiếu: thực nhận | `buildPayslipData` | BigInt | `max(0, tổng lương − khấu trừ − tạm ứng − thuế nhập tay)` | không |
//! | KPI | `calculateKpiBonus` | BigInt | `số chỉ số đạt × 500.000` | không |

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::AppError;
use trinity_kernel::number::js_round;

/// Lỗi tính toán (tràn số nguyên). Số liệu thật nhỏ hơn nhiều nên chỉ gặp với dữ liệu hỏng.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalcError;

impl std::fmt::Display for CalcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("số tiền vượt giới hạn tính toán")
    }
}

impl std::error::Error for CalcError {}

type R<T> = Result<T, CalcError>;

fn add(a: i64, b: i64) -> R<i64> {
    a.checked_add(b).ok_or(CalcError)
}

fn sub(a: i64, b: i64) -> R<i64> {
    a.checked_sub(b).ok_or(CalcError)
}

/// `BigInt(Math.round(x))`: `x` hữu hạn và nằm trong `i64`.
fn to_money(x: f64) -> R<i64> {
    if x.is_finite() && x.abs() < 9.2e18 {
        Ok(x as i64)
    } else {
        Err(CalcError)
    }
}

/// `Number(x.toString())` cho cột `Decimal`.
fn number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        0.0
    } else {
        t.parse().unwrap_or(f64::NAN)
    }
}

/// Số nguyên → `Value::Number` kiểu JS (`8`, không `8.0`); số lẻ giữ nguyên.
fn jnum(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.0e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// Dòng hiệu lực theo tháng.
fn active(is_active: bool, from: &str, to: Option<&str>, month: &str) -> bool {
    is_active && from <= month && to.is_none_or(|t| t >= month)
}

// ---------------------------------------------------------------- bảo hiểm

/// Một dòng `insurance_settings`; `employee_rate` là chuỗi `Decimal`.
#[derive(Debug, Clone, Deserialize, sqlx::FromRow)]
pub struct InsuranceRow {
    pub code: String,
    pub name: String,
    pub employee_rate: String,
    pub base_cap: Option<i64>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InsuranceResult {
    pub total: i64,
    /// `[{ code, name, rate, base, amount }]` như `insurance_json`.
    pub snapshot: Vec<Value>,
}

/// `InsuranceEngine.compute`: `rows` có thể gồm cả dòng không hiệu lực; chọn và sắp theo `sort_order` ở đây (ổn định
/// theo thứ tự đầu vào; bên đọc DB phải đưa vào theo `sort_order, id`).
pub fn compute_insurance(insurance_base: i64, month: &str, rows: &[InsuranceRow]) -> R<InsuranceResult> {
    let mut sel: Vec<&InsuranceRow> = rows
        .iter()
        .filter(|r| active(r.is_active, &r.effective_from, r.effective_to.as_deref(), month))
        .collect();
    sel.sort_by_key(|r| r.sort_order);
    let (mut total, mut snapshot) = (0_i64, Vec::new());
    for s in sel {
        let base = match s.base_cap {
            Some(cap) if cap > 0 => insurance_base.min(cap),
            _ => insurance_base,
        };
        let rate = number(&s.employee_rate);
        if !rate.is_finite() || rate <= 0.0 || base <= 0 {
            continue;
        }
        let amount = to_money(js_round(base as f64 * rate / 100.0))?;
        if amount <= 0 {
            continue;
        }
        total = add(total, amount)?;
        snapshot.push(json!({ "code": s.code, "name": s.name, "rate": jnum(rate), "base": base, "amount": amount }));
    }
    Ok(InsuranceResult { total, snapshot })
}

// ---------------------------------------------------------------- thuế

/// Một dòng `payroll_tax_settings`.
#[derive(Debug, Clone, Deserialize, sqlx::FromRow)]
pub struct TaxSettingRow {
    pub personal_deduction: i64,
    pub dependent_deduction: i64,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
}

/// Một dòng `tax_brackets`; `rate` là chuỗi `Decimal` (%).
#[derive(Debug, Clone, Deserialize, sqlx::FromRow)]
pub struct BracketRow {
    pub bracket_order: i32,
    pub lower_bound: i64,
    pub upper_bound: Option<i64>,
    pub rate: String,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaxResult {
    pub tax: i64,
    /// `None` khi chưa cấu hình giảm trừ (không tính thuế); không thì object như `tax_json`.
    pub snapshot: Option<Value>,
}

/// `TaxEngine.compute`: chưa có cấu hình giảm trừ hiệu lực ⇒ thuế 0 và không có ảnh chụp.
pub fn compute_tax(
    taxable_gross: i64,
    insurance: i64,
    dependents_count: i64,
    month: &str,
    settings: &[TaxSettingRow],
    brackets: &[BracketRow],
) -> R<TaxResult> {
    // `findFirst` orderBy effective_from desc: dòng đầu theo thứ tự đầu vào khi trùng.
    let mut cands: Vec<&TaxSettingRow> = settings
        .iter()
        .filter(|s| active(s.is_active, &s.effective_from, s.effective_to.as_deref(), month))
        .collect();
    cands.sort_by(|a, b| b.effective_from.cmp(&a.effective_from));
    let Some(setting) = cands.first() else {
        return Ok(TaxResult { tax: 0, snapshot: None });
    };
    let deps = dependents_count.max(0);
    let dep_total = setting.dependent_deduction.checked_mul(deps).ok_or(CalcError)?;
    let raw = sub(
        sub(sub(taxable_gross, insurance)?, setting.personal_deduction)?,
        dep_total,
    )?;
    let taxable_income = raw.max(0);

    // Đúng MỘT bộ biểu: `effective_from` mới nhất trong các dòng hiệu lực, theo `bracket_order`.
    let mut act: Vec<&BracketRow> = brackets
        .iter()
        .filter(|b| active(b.is_active, &b.effective_from, b.effective_to.as_deref(), month))
        .collect();
    act.sort_by(|a, b| {
        b.effective_from
            .cmp(&a.effective_from)
            .then(a.bracket_order.cmp(&b.bracket_order))
    });
    let latest = act.first().map(|b| b.effective_from.clone());
    let mut set: Vec<&BracketRow> = act
        .into_iter()
        .filter(|b| Some(&b.effective_from) == latest.as_ref())
        .collect();
    set.sort_by_key(|b| b.bracket_order);

    let (mut tax, mut lines) = (0_i64, Vec::new());
    for b in set {
        let top = match b.upper_bound {
            Some(u) if taxable_income >= u => u,
            _ => taxable_income,
        };
        let portion = sub(top, b.lower_bound)?;
        if portion <= 0 {
            continue;
        }
        let rate = number(&b.rate);
        let in_bracket = to_money(js_round(portion as f64 * rate / 100.0))?;
        tax = add(tax, in_bracket)?;
        lines.push(json!({ "rate": jnum(rate), "portion": portion, "tax": in_bracket }));
    }
    Ok(TaxResult {
        tax,
        snapshot: Some(json!({
            "taxable_gross": taxable_gross,
            "insurance": insurance,
            "personal_deduction": setting.personal_deduction,
            "dependents_count": deps,
            "dependent_deduction_total": dep_total,
            "taxable_income": taxable_income,
            "brackets": lines,
            "tax": tax,
        })),
    })
}

// ---------------------------------------------------------------- thành phần lương

/// Một dòng `salary_components`.
#[derive(Debug, Clone, Deserialize, sqlx::FromRow)]
pub struct ComponentRow {
    pub code: String,
    pub name: String,
    pub component_type: String,
    pub calc_method: String,
    pub fixed_amount: Option<i64>,
    pub percent_value: Option<String>,
    pub applies_to: String,
    pub is_taxable: bool,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentTotals {
    pub allowances: i64,
    pub bonuses: i64,
    pub deductions: i64,
    /// Phụ cấp + thưởng có `is_taxable`.
    pub taxable_earnings: i64,
    /// `[{ code, name, component_type, calc_method, amount }]` như `components_json`.
    pub snapshot: Vec<Value>,
}

fn applies_to(applies: &str, rank_code: Option<&str>) -> bool {
    if applies == "all" {
        return true;
    }
    match applies.strip_prefix("rank:") {
        Some(code) => rank_code.is_some_and(|r| !r.is_empty() && r == code),
        None => false,
    }
}

fn component_amount(c: &ComponentRow, base: i64) -> R<i64> {
    if c.calc_method == "percent_base" {
        let pct = c.percent_value.as_deref().map_or(0.0, number);
        if !pct.is_finite() || pct <= 0.0 {
            return Ok(0);
        }
        return to_money(js_round(base as f64 * pct / 100.0));
    }
    Ok(c.fixed_amount.unwrap_or(0))
}

/// `SalaryComponentsEngine.computeForEmployee`.
pub fn compute_components(
    base_salary: i64,
    month: &str,
    rank_code: Option<&str>,
    rows: &[ComponentRow],
) -> R<ComponentTotals> {
    let mut sel: Vec<&ComponentRow> = rows
        .iter()
        .filter(|r| active(r.is_active, &r.effective_from, r.effective_to.as_deref(), month))
        .collect();
    sel.sort_by_key(|r| r.sort_order);
    let mut t = ComponentTotals {
        allowances: 0,
        bonuses: 0,
        deductions: 0,
        taxable_earnings: 0,
        snapshot: Vec::new(),
    };
    for c in sel {
        if !applies_to(&c.applies_to, rank_code) {
            continue;
        }
        let amount = component_amount(c, base_salary)?;
        if amount <= 0 {
            continue;
        }
        t.snapshot.push(json!({
            "code": c.code, "name": c.name, "component_type": c.component_type, "calc_method": c.calc_method, "amount": amount,
        }));
        match c.component_type.as_str() {
            "allowance" => {
                t.allowances = add(t.allowances, amount)?;
                if c.is_taxable {
                    t.taxable_earnings = add(t.taxable_earnings, amount)?;
                }
            }
            "bonus" => {
                t.bonuses = add(t.bonuses, amount)?;
                if c.is_taxable {
                    t.taxable_earnings = add(t.taxable_earnings, amount)?;
                }
            }
            "deduction" => t.deductions = add(t.deductions, amount)?,
            _ => {}
        }
    }
    Ok(t)
}

// ---------------------------------------------------------------- phiếu lương

/// Thưởng KPI: mỗi chỉ số đạt 500.000đ (`calculateKpiBonus`).
pub fn kpi_bonus(achieved_count: usize) -> i64 {
    i64::try_from(achieved_count)
        .unwrap_or(i64::MAX)
        .saturating_mul(500_000)
}

/// `prorateBase`: lương cơ bản × ngày công ÷ ngày chuẩn.
pub fn prorate_base(base: i64, working_days: Option<f64>, standard: i64) -> R<i64> {
    match working_days {
        Some(d) if standard > 0 => to_money(js_round(base as f64 * d / standard as f64)),
        _ => Ok(base),
    }
}

/// Cấu hình lương đang có (đọc thô từ DB; chọn dòng hiệu lực ở các hàm tính).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PayrollConfig {
    pub insurance: Vec<InsuranceRow>,
    pub tax_settings: Vec<TaxSettingRow>,
    pub brackets: Vec<BracketRow>,
    pub components: Vec<ComponentRow>,
}

/// Phần nhân viên của phiếu.
#[derive(Debug, Clone, Deserialize)]
pub struct EmployeeInput {
    pub rank_code: Option<String>,
    /// `employees.insurance_salary` (`0` = miễn/thử việc).
    pub insurance_salary: Option<i64>,
    /// `jobTitle.default_insurance_salary`; vắng khoá hoặc `null` = không có mặc định (chức danh không gán cũng vậy).
    #[serde(default)]
    pub default_insurance_salary: Option<i64>,
    pub dependents_count: i64,
}

/// Các khoản nhập tay của phiếu (chỉ phần tham gia tính tiền).
#[derive(Debug, Clone, Deserialize)]
pub struct ManualInput {
    pub working_days: Option<f64>,
    pub standard_working_days: i64,
    pub base_salary: i64,
    pub training_salary: i64,
    pub probation_allowance: i64,
    pub bonus_sales_personal: i64,
    pub bonus_cskh_team: i64,
    pub bonus_milestone: i64,
    pub bonus_referral: i64,
    pub holiday_bonus: i64,
    pub advances: i64,
    pub personal_income_tax: i64,
}

/// Các cột do bộ tính điền (`buildPayslipData`).
#[derive(Debug, Clone, PartialEq)]
pub struct PayslipComputed {
    pub base_salary: i64,
    pub kpi_bonus: i64,
    pub deductions: i64,
    pub total: i64,
    pub insurance_base: i64,
    pub base_salary_actual: i64,
    pub components_json: Vec<Value>,
    pub insurance_json: Vec<Value>,
    /// `None` ⇒ `tax_json = null`.
    pub tax_json: Option<Value>,
    /// Tổng thực nhận âm bị chặn về 0 (bên gọi ghi cảnh báo).
    pub clamped: bool,
}

/// Tính phiếu: `assembleEngine` (thành phần theo `engine_base` + KPI) rồi `buildPayslipData`.
pub fn compute_payslip(
    cfg: &PayrollConfig,
    month: &str,
    engine_base: i64,
    kpi_achieved: usize,
    emp: &EmployeeInput,
    m: &ManualInput,
) -> R<PayslipComputed> {
    let config = compute_components(engine_base, month, emp.rank_code.as_deref(), &cfg.components)?;
    let base_actual = prorate_base(m.base_salary, m.working_days, m.standard_working_days)?;
    let cong_lcb = add(add(base_actual, m.training_salary)?, m.probation_allowance)?;
    let cong_thuong = [
        m.bonus_sales_personal,
        m.bonus_cskh_team,
        m.bonus_milestone,
        m.bonus_referral,
        m.holiday_bonus,
    ]
    .into_iter()
    .try_fold(0_i64, add)?;
    let tong_luong = add(cong_lcb, cong_thuong)?;

    // Lương đóng BH: override cá nhân (kể cả 0) → mặc định chức danh (> 0) → lương cơ bản.
    let insurance_base = emp
        .insurance_salary
        .or(emp.default_insurance_salary.filter(|d| *d > 0))
        .unwrap_or(m.base_salary);
    let insurance = compute_insurance(insurance_base, month, &cfg.insurance)?;
    let tax = compute_tax(
        tong_luong,
        insurance.total,
        emp.dependents_count,
        month,
        &cfg.tax_settings,
        &cfg.brackets,
    )?;

    // Thuế nhập tay (> 0) GHI ĐÈ thuế hệ thống: chỉ trừ MỘT lần (ở `raw_total`).
    let system_tax = if m.personal_income_tax > 0 { 0 } else { tax.tax };
    let deductions = add(add(config.deductions, insurance.total)?, system_tax)?;
    let raw_total = sub(sub(sub(tong_luong, deductions)?, m.advances)?, m.personal_income_tax)?;
    Ok(PayslipComputed {
        base_salary: m.base_salary,
        kpi_bonus: kpi_bonus(kpi_achieved),
        deductions,
        total: raw_total.max(0),
        insurance_base,
        base_salary_actual: base_actual,
        components_json: config.snapshot,
        insurance_json: insurance.snapshot,
        tax_json: tax.snapshot,
        clamped: raw_total < 0,
    })
}

// ---------------------------------------------------------------- đọc cấu hình từ DB

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Đọc TOÀN BỘ cấu hình lương (bảng nhỏ; việc chọn dòng hiệu lực theo tháng nằm ở các hàm `compute_*`, đúng như bản TS
/// lọc theo tháng). Thứ tự `sort_order, id` / `id` để các phép sắp ổn định chọn cùng dòng khi trùng khoá.
pub async fn load_config(conn: &mut PgConnection) -> Result<PayrollConfig, AppError> {
    let insurance = sqlx::query_as::<_, InsuranceRow>(
        "SELECT code, name, employee_rate::text AS employee_rate, base_cap, effective_from, effective_to, is_active, sort_order \
         FROM insurance_settings ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let tax_settings = sqlx::query_as::<_, TaxSettingRow>(
        "SELECT personal_deduction, dependent_deduction, effective_from, effective_to, is_active \
         FROM payroll_tax_settings ORDER BY id ASC",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let brackets = sqlx::query_as::<_, BracketRow>(
        "SELECT bracket_order, lower_bound, upper_bound, rate::text AS rate, effective_from, effective_to, is_active \
         FROM tax_brackets ORDER BY id ASC",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let components = sqlx::query_as::<_, ComponentRow>(
        "SELECT code, name, component_type, calc_method, fixed_amount, percent_value::text AS percent_value, applies_to, \
         is_taxable, effective_from, effective_to, is_active, sort_order FROM salary_components ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(PayrollConfig {
        insurance,
        tax_settings,
        brackets,
        components,
    })
}

/// Số chỉ số KPI đạt của nhân viên trong tháng (đầu vào của [`kpi_bonus`]).
pub async fn kpi_achieved_count(conn: &mut PgConnection, employee_id: i32, month: &str) -> Result<usize, AppError> {
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM kpi_results WHERE employee_id = $1 AND month = $2 AND achieved")
            .bind(employee_id)
            .bind(month)
            .fetch_one(conn)
            .await
            .map_err(db)?;
    Ok(usize::try_from(n).unwrap_or(0))
}
