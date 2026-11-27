//! Phiếu lương dạng tệp (M31, 8 route của `payslips.controller.ts`): xuất xlsx một phiếu / hàng loạt / danh sách, PDF, mẫu
//! nhập, xem trước và áp dụng nhập xlsx. Bản TS: `payslip-excel.builder.ts`, `payslip-list-excel.builder.ts`,
//! `payslip-pdf.builder.ts`, `payslip-import.helper.ts`, phần xuất/nhập của `payslips.service.ts`.
//!
//! - Con của [`super`] nên dùng được truy vấn, bộ tính và hàm ghi riêng của M30b (`SELECT_P`, `stored`, `persist`…); nhập
//!   xlsx đi cùng đường tính với `PATCH /payslips/:id` (gộp khoản nhập tay → tính lại cả phiếu), không ghi thô.
//! - Phạm vi xuất (`payroll.export`) là `Option<&[i32]>` các `user_id` chủ phiếu (`None` = tất cả); mẫu nhập và nhập xlsx chỉ
//!   mở cho `payroll.manage` nên không thu hẹp.
//! - Mọi hàm lấy `&mut PgConnection` của người gọi; nhập áp dụng ghi nhiều phiếu trên cùng kết nối nên route bọc một giao
//!   dịch (lỗi giữa chừng hoàn tác cả lô như `$transaction` của bản Node). Không hàm nào giữ hai kết nối.
//! - Tệp trả về là [`FileOut`] (byte + tên tệp + kiểu nội dung); tên tệp như `Content-Disposition` của bản TS.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{AssertSqlSafe, PgConnection, Postgres, QueryBuilder};
use trinity_docgen::grid::{GridSheet, HAlign, Merged, Style, VAlign, write_grid};
use trinity_docgen::pdf::{PdfBuilder, PdfError, TINOS_BOLD, TINOS_REGULAR};
use trinity_docgen::xlsx::{ReadCell, ReadSheet, js_number_string, read_first_sheet};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::number::js_round;
use trinity_kernel::vi::trim_js;

use super::{
    Manual, MANUAL_COLS, MONTH_MSG, PayslipRow, R, SELECT_P, UpdatePayslip, calc, calc_err, db, employee_code, engine_base,
    fetch_employees, in_scope, insurance_total, not_found_id, out_of_scope, persist, read_tax, team_order,
};
use crate::{finish, is_month, len16};

/// Kiểu nội dung xlsx.
pub const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/// Kiểu nội dung PDF.
pub const PDF_MIME: &str = "application/pdf";
/// Lỗi 400 khi route nhập không nhận được trường `file` (route kiểm, như `BadRequestException` của bản TS).
pub const MISSING_FILE: &str = "Thiếu file upload";

/// Tệp trả về cho route: nội dung, tên (`Content-Disposition: attachment; filename="…"`) và kiểu nội dung.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileOut {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub content_type: &'static str,
}

impl FileOut {
    fn xlsx(bytes: Vec<u8>, filename: String) -> Self {
        Self {
            bytes,
            filename,
            content_type: XLSX_MIME,
        }
    }
}

fn xlsx_err(e: trinity_docgen::xlsx::XlsxError) -> AppError {
    AppError::internal(e)
}

fn pdf_err(e: PdfError) -> AppError {
    AppError::internal(e)
}

// ---------------------------------------------------------------- DTO

/// Body `POST /payslips/excel-list` (`ListExcelPayslipsDto`): `month` `YYYY-MM`; `ordered_ids` (tuỳ chọn) là mảng ≤ 10000 số
/// nguyên — id phiếu theo đúng thứ tự đang hiển thị trên màn hình. Phần tử ngoài `i32` coi như không phải số nguyên (cột
/// `id` là int4).
#[derive(Debug, Clone, Deserialize)]
pub struct ListExcelInput {
    pub month: String,
    #[serde(default)]
    pub ordered_ids: Option<Value>,
}

fn int_of(v: &Value) -> Option<i32> {
    let Value::Number(n) = v else { return None };
    if let Some(i) = n.as_i64() {
        return i32::try_from(i).ok();
    }
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= f64::from(i32::MAX)).then_some(f as i32)
}

impl ListExcelInput {
    /// `@IsString @Matches` cho `month`; `@IsOptional @IsArray @ArrayMaxSize(10000) @IsInt({ each })` cho `ordered_ids`
    /// (lỗi báo theo thứ tự IsInt, ArrayMaxSize, IsArray).
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !is_month(&self.month) {
            e.push(MONTH_MSG.to_owned());
        }
        let each = "each value in ordered_ids must be an integer number";
        let max = "ordered_ids must contain no more than 10000 elements";
        match &self.ordered_ids {
            None => {}
            Some(Value::Array(a)) => {
                if a.iter().any(|v| int_of(v).is_none()) {
                    e.push(each.to_owned());
                }
                if a.len() > 10_000 {
                    e.push(max.to_owned());
                }
            }
            Some(v) => {
                if int_of(v).is_none() {
                    e.push(each.to_owned());
                }
                e.push(max.to_owned());
                e.push("ordered_ids must be an array".to_owned());
            }
        }
        finish(e)
    }

    /// `ordered_ids` đã qua `validate()`; `None` khi vắng hoặc rỗng (xuất theo thứ tự nhóm).
    pub fn ids(&self) -> Option<Vec<i32>> {
        match &self.ordered_ids {
            Some(Value::Array(a)) if !a.is_empty() => Some(a.iter().filter_map(int_of).collect()),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------- dữ liệu phiếu để xuất

/// Dữ liệu một phiếu theo mẫu kế toán (`PayslipExcelData`); tiền là số nguyên VND.
#[derive(Debug, Clone, PartialEq)]
struct SlipData {
    month: String,
    full_name: String,
    position: String,
    team_name: String,
    base_salary: i64,
    working_days: Option<f64>,
    don_gia_ngay_cong: i64,
    base_salary_actual: i64,
    training_days: Option<f64>,
    training_salary: i64,
    probation_allowance: i64,
    cong_lcb: i64,
    sales_personal: i64,
    bonus_rate: Option<f64>,
    kpi_percent: Option<f64>,
    bonus_sales_personal: i64,
    bonus_cskh_team: i64,
    bonus_milestone: i64,
    bonus_referral: i64,
    holiday_bonus: i64,
    cong_thuong: i64,
    advances: i64,
    insurance_base: i64,
    phu_cap_xang_xe: i64,
    insurance_total: i64,
    tax_total: i64,
    tong_giam_tru: i64,
    total: i64,
    bank_account_number: Option<String>,
    bank_name: Option<String>,
    notes: Option<String>,
}

/// `toExcelData`: chức danh chưa gán ⇒ "—"; team = quản lý trực tiếp (trống nếu không có).
fn slip_data(p: &PayslipRow) -> SlipData {
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
    SlipData {
        month: p.month.clone(),
        full_name: p.u_full_name.clone().unwrap_or_default(),
        position: p.jt_name.clone().unwrap_or_else(|| "—".to_owned()),
        team_name: p.manager_name.clone().unwrap_or_default(),
        base_salary: p.base_salary,
        working_days: p.working_days,
        don_gia_ngay_cong: don_gia,
        base_salary_actual: p.base_salary_actual,
        training_days: p.training_days,
        training_salary: p.training_salary,
        probation_allowance: p.probation_allowance,
        cong_lcb,
        sales_personal: p.sales_personal,
        bonus_rate: p.bonus_rate,
        kpi_percent: p.kpi_percent,
        bonus_sales_personal: p.bonus_sales_personal,
        bonus_cskh_team: p.bonus_cskh_team,
        bonus_milestone: p.bonus_milestone,
        bonus_referral: p.bonus_referral,
        holiday_bonus: p.holiday_bonus,
        cong_thuong,
        advances: p.advances,
        insurance_base: p.insurance_base,
        phu_cap_xang_xe: phu_cap,
        insurance_total: ins,
        tax_total,
        tong_giam_tru: p
            .deductions
            .saturating_add(p.advances)
            .saturating_add(p.personal_income_tax),
        total: p.total,
        bank_account_number: p.e_bank_account_number.clone(),
        bank_name: p.e_bank_name.clone(),
        notes: p.notes.clone(),
    }
}

/// Tên công ty in trên phiếu: `PAYROLL_COMPANY_NAME` (đã cắt khoảng trắng) hoặc `YOUR COMPANY`.
fn company_name() -> String {
    std::env::var("PAYROLL_COMPANY_NAME")
        .ok()
        .map(|s| trim_js(&s).to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "YOUR COMPANY".to_owned())
}

/// Khối "Lưu ý" cuối phiếu (dùng chung xlsx và PDF).
const NOTE_TEXT: &str = "Lưu ý:\n\
- Nếu có thắc mắc về ngày công liên hệ Phòng HR, còn về lương thì liên hệ Phòng Kế Toán.\n\
- \"Các khoản đã chi lĩnh trước\": số tiền Công ty đã chuyển khoản hoặc Anh/Chị đã tạm ứng trước đó.\n\
- \"TỔNG THỰC NHẬN\": số tiền còn lại kế toán chuyển khoản để tất toán kỳ lương, chậm nhất ngày 05 hàng tháng.";

const SECTION_FILL: u32 = 0xE7F3E0;
const NUM_FMT: &str = "#,##0";

/// Tiền VND dấu chấm nghìn (`formatVnd`).
fn format_vnd(v: i64) -> String {
    let s = v.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    if v < 0 { format!("-{out}") } else { out }
}

fn month_parts(month: &str) -> (&str, &str) {
    month.split_once('-').unwrap_or((month, ""))
}

// ---------------------------------------------------------------- xlsx một phiếu

fn style(bold: bool, fill: Option<u32>, right: bool, money: bool) -> Style {
    Style {
        bold,
        fill,
        h: if right { HAlign::Right } else { HAlign::General },
        num_format: money.then_some(NUM_FMT),
        ..Style::default()
    }
}

/// Bộ ghi một trang phiếu: `r` là số dòng kiểu Excel (từ 1) như biến `r` của `writePayslipSheet`; cột B = nhãn, C = giá trị.
struct Slip {
    g: GridSheet,
    r: u32,
}

impl Slip {
    fn row(&self) -> u32 {
        self.r - 1
    }

    fn label(&mut self, text: &str, bold: bool, fill: Option<u32>) {
        let row = self.row();
        self.g.text(row, 1, text, style(bold, fill, false, false));
    }

    fn title(&mut self, text: &str) {
        self.label(text, true, None);
        self.r += 1;
    }

    fn section(&mut self, text: &str) {
        self.label(text, true, Some(SECTION_FILL));
        let row = self.row();
        self.g.blank(row, 2, style(false, Some(SECTION_FILL), false, false));
        self.r += 1;
    }

    fn section_money(&mut self, text: &str, v: i64) {
        self.label(text, true, Some(SECTION_FILL));
        let row = self.row();
        self.g.number(row, 2, v as f64, style(true, Some(SECTION_FILL), true, true));
        self.r += 1;
    }

    fn money_line(&mut self, label: &str, v: i64, bold: bool) {
        self.label(label, bold, None);
        let row = self.row();
        self.g.number(row, 2, v as f64, style(bold, None, true, true));
        self.r += 1;
    }

    fn text_line(&mut self, label: &str, value: &str) {
        self.label(label, false, None);
        let row = self.row();
        self.g.text(row, 2, value, style(false, None, false, false));
        self.r += 1;
    }

    fn num_line(&mut self, label: &str, v: Option<f64>) {
        self.label(label, false, None);
        let row = self.row();
        match v {
            Some(n) => self.g.number(row, 2, n, style(false, None, true, false)),
            None => self.g.text(row, 2, "—", style(false, None, true, false)),
        }
        self.r += 1;
    }
}

fn pct_text(v: Option<f64>) -> String {
    v.map_or_else(|| "—".to_owned(), |n| format!("{}%", js_number_string(n)))
}

/// `writePayslipSheet`: bố cục mẫu I/II/III/IV + lưu ý.
fn payslip_sheet(name: &str, d: &SlipData) -> GridSheet {
    let mut s = Slip {
        g: GridSheet::new(name),
        r: 2,
    };
    s.g.col_widths = vec![3.0, 40.0, 22.0];
    let (year, month) = month_parts(&d.month);
    s.title(&company_name());
    s.text_line("Kính gửi: Quý Anh/Chị", &d.full_name);
    s.title(&format!("THÔNG TIN LƯƠNG THÁNG {month}/{year}"));

    s.section("I/ THÔNG TIN CƠ BẢN");
    s.text_line("Họ tên", &d.full_name);
    s.text_line("Vị trí", &d.position);
    s.text_line("Đơn vị/Team", &d.team_name);
    s.money_line("Lương cơ bản", d.base_salary, false);
    if d.insurance_base > 0 {
        s.money_line("Lương đóng BHXH", d.insurance_base, false);
        s.money_line("Phụ cấp xăng xe/ăn ca", d.phu_cap_xang_xe, false);
    }
    s.num_line("Ngày công thực tế", d.working_days);
    s.money_line("Số tiền ngày công", d.don_gia_ngay_cong, false);
    s.money_line("Thực lĩnh lương căn bản (1)", d.base_salary_actual, false);
    s.num_line("Ngày học việc", d.training_days);
    s.money_line("Lương học việc", d.training_salary, false);
    s.money_line("Phụ cấp học việc (2)", d.probation_allowance, false);
    s.money_line("CỘNG LCB (1+2)", d.cong_lcb, true);

    s.section("II/ DOANH SỐ/THƯỞNG");
    s.money_line("Doanh số cá nhân", d.sales_personal, false);
    s.text_line("% KPI", &pct_text(d.kpi_percent));
    s.text_line("Hệ số (%)", &pct_text(d.bonus_rate));
    s.money_line("Bonus doanh số (1)", d.bonus_sales_personal, false);
    s.money_line("Vượt mốc cá nhân (2)", d.bonus_milestone, false);
    s.money_line("Contest toàn Team (3)", d.bonus_cskh_team, false);
    s.money_line("Giới thiệu ứng viên (4)", d.bonus_referral, false);
    s.money_line("Thưởng Lễ (5)", d.holiday_bonus, false);
    s.money_line("Cộng doanh số & thưởng (1+2+3+4+5)", d.cong_thuong, true);

    s.section("III/ TỔNG LƯƠNG & GIẢM TRỪ");
    s.money_line("Các khoản đã chi lĩnh trước", d.advances, false);
    s.money_line("Trích đóng BHXH", d.insurance_total, false);
    s.money_line("Thuế TNCN", d.tax_total, false);
    s.money_line("Tổng các khoản giảm trừ", d.tong_giam_tru, true);

    s.section_money("IV/ TỔNG THỰC NHẬN", d.total);
    s.text_line("Số tài khoản", d.bank_account_number.as_deref().unwrap_or(""));
    s.text_line("Ngân hàng", d.bank_name.as_deref().unwrap_or(""));
    s.text_line("Ghi chú", d.notes.as_deref().unwrap_or(""));

    s.r += 1;
    let row = s.row();
    s.g.merge(Merged {
        first_row: row,
        first_col: 1,
        last_row: row,
        last_col: 2,
        text: NOTE_TEXT.to_owned(),
        style: Style {
            italic: true,
            font_size: 10.0,
            wrap: true,
            v: VAlign::Top,
            ..Style::default()
        },
    });
    s.g.row_heights.push((row, 70.0));
    s.g
}

/// Tên trang tính theo `sanitizeSheetName`: bỏ `[ ] : * ? / \`, bỏ nháy đơn đầu/cuối, cắt ≤ 31 ký tự, rỗng ⇒ `fallback`.
fn sanitize_sheet_name(name: Option<&str>, fallback: &str) -> String {
    let cleaned: String = name
        .unwrap_or("")
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        .collect();
    let cleaned: String = trim_js(cleaned.trim_matches('\'')).chars().take(31).collect();
    if cleaned.is_empty() {
        fallback.chars().take(31).collect()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------- truy vấn xuất

async fn load_for_export(conn: &mut PgConnection, id: i32, scope: Option<&[i32]>) -> R<PayslipRow> {
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
    Ok(row)
}

/// Phiếu chưa loại của kỳ trong phạm vi xuất, theo `id` tăng; `only` giới hạn theo danh sách id.
async fn load_period(
    conn: &mut PgConnection,
    month: &str,
    scope: Option<&[i32]>,
    only: Option<&[i32]>,
) -> R<Vec<PayslipRow>> {
    let mut qb = QueryBuilder::<Postgres>::new(SELECT_P);
    qb.push(" WHERE p.deleted_at IS NULL AND p.month = ")
        .push_bind(month.to_owned());
    if let Some(ids) = scope {
        qb.push(" AND e.user_id = ANY(").push_bind(ids.to_vec()).push(")");
    }
    if let Some(ids) = only {
        qb.push(" AND p.id = ANY(").push_bind(ids.to_vec()).push(")");
    }
    qb.push(" ORDER BY p.id ASC");
    qb.build_query_as::<PayslipRow>()
        .fetch_all(&mut *conn)
        .await
        .map_err(db)
}

fn no_slips(month: &str) -> AppError {
    HttpError::not_found(format!("Không có phiếu lương nào trong kỳ {month}")).into()
}

/// `GET /payslips/:id/excel`: `phieu-luong-<id>.xlsx`.
pub async fn export_excel(conn: &mut PgConnection, id: i32, scope: Option<&[i32]>) -> R<FileOut> {
    let p = load_for_export(conn, id, scope).await?;
    let bytes = write_grid(&[payslip_sheet("PHIẾU LƯƠNG", &slip_data(&p))]).map_err(xlsx_err)?;
    Ok(FileOut::xlsx(bytes, format!("phieu-luong-{id}.xlsx")))
}

/// `GET /payslips/:id/pdf`: `payslip-<id>.pdf`.
pub async fn export_pdf(conn: &mut PgConnection, id: i32, scope: Option<&[i32]>) -> R<FileOut> {
    let p = load_for_export(conn, id, scope).await?;
    let bytes = build_payslip_pdf(&slip_data(&p)).map_err(pdf_err)?;
    Ok(FileOut {
        bytes,
        filename: format!("payslip-{id}.pdf"),
        content_type: PDF_MIME,
    })
}

/// `GET /payslips/excel-bulk?month=`: mỗi nhân viên một trang; `phieu-luong-ky-<tháng>.xlsx`. Không có phiếu ⇒ 404.
pub async fn export_bulk(conn: &mut PgConnection, month: &str, scope: Option<&[i32]>) -> R<FileOut> {
    let rows = load_period(conn, month, scope, None).await?;
    if rows.is_empty() {
        return Err(no_slips(month));
    }
    let sheets: Vec<GridSheet> = rows
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let fallback = format!("NV{}", i + 1);
            let name = sanitize_sheet_name(Some(p.u_full_name.as_deref().unwrap_or(&fallback)), &fallback);
            payslip_sheet(&name, &slip_data(p))
        })
        .collect();
    let bytes = write_grid(&sheets).map_err(xlsx_err)?;
    Ok(FileOut::xlsx(bytes, format!("phieu-luong-ky-{month}.xlsx")))
}

// ---------------------------------------------------------------- xlsx danh sách

struct ListRow {
    code: String,
    department: String,
    data: SlipData,
}

enum Cellv {
    Index,
    Text(String),
    Money(i64),
    Pct(Option<f64>),
    Days(Option<f64>),
}

struct ListCol {
    group: &'static str,
    header: &'static str,
    width: f64,
    /// Cột tiền: được cộng ở dòng TỔNG CỘNG.
    money: bool,
    value: fn(&ListRow) -> Cellv,
}

const G_EMP: &str = "THÔNG TIN NHÂN VIÊN";
const G_LCB: &str = "LƯƠNG CƠ BẢN";
const G_DS: &str = "DOANH SỐ/THƯỞNG";
const G_GT: &str = "CÁC KHOẢN GIẢM TRỪ";
const G_TT: &str = "THÔNG TIN THANH TOÁN";
const EMP_COL_COUNT: u16 = 6;

fn col(group: &'static str, header: &'static str, width: f64, value: fn(&ListRow) -> Cellv) -> ListCol {
    ListCol {
        group,
        header,
        width,
        money: false,
        value,
    }
}

fn mcol(group: &'static str, header: &'static str, width: f64, value: fn(&ListRow) -> Cellv) -> ListCol {
    ListCol {
        money: true,
        ..col(group, header, width, value)
    }
}

/// Thứ tự và tên cột của "danh sách lương" (đồng bộ bảng FE).
fn list_columns() -> Vec<ListCol> {
    vec![
        col(G_EMP, "STT", 5.0, |_| Cellv::Index),
        col(G_EMP, "Mã nhân viên", 13.0, |r| Cellv::Text(r.code.clone())),
        col(G_EMP, "Họ tên", 22.0, |r| Cellv::Text(r.data.full_name.clone())),
        col(G_EMP, "Vị trí", 13.0, |r| Cellv::Text(r.data.position.clone())),
        col(G_EMP, "Team Lead", 18.0, |r| Cellv::Text(r.data.team_name.clone())),
        col(G_EMP, "Phòng ban", 11.0, |r| Cellv::Text(r.department.clone())),
        mcol(G_LCB, "Lương cơ bản", 14.0, |r| Cellv::Money(r.data.base_salary)),
        mcol(G_LCB, "Lương đóng BHXH", 14.0, |r| Cellv::Money(r.data.insurance_base)),
        col(G_LCB, "Ngày công", 9.0, |r| Cellv::Days(r.data.working_days)),
        mcol(G_LCB, "Số tiền ngày công", 14.0, |r| Cellv::Money(r.data.don_gia_ngay_cong)),
        mcol(G_LCB, "Thực lĩnh LCB", 14.0, |r| Cellv::Money(r.data.base_salary_actual)),
        col(G_LCB, "Ngày học việc", 10.0, |r| Cellv::Days(r.data.training_days)),
        mcol(G_LCB, "Lương học việc", 14.0, |r| Cellv::Money(r.data.training_salary)),
        mcol(G_LCB, "Phụ cấp học việc", 14.0, |r| Cellv::Money(r.data.probation_allowance)),
        mcol(G_LCB, "Cộng lương cơ bản", 15.0, |r| Cellv::Money(r.data.cong_lcb)),
        mcol(G_DS, "Doanh số", 15.0, |r| Cellv::Money(r.data.sales_personal)),
        col(G_DS, "% KPI", 9.0, |r| Cellv::Pct(r.data.kpi_percent)),
        col(G_DS, "Hệ số (%)", 9.0, |r| Cellv::Pct(r.data.bonus_rate)),
        mcol(G_DS, "Bonus", 14.0, |r| Cellv::Money(r.data.bonus_sales_personal)),
        mcol(G_DS, "Vượt mốc cá nhân", 14.0, |r| Cellv::Money(r.data.bonus_milestone)),
        mcol(G_DS, "Contest Team", 14.0, |r| Cellv::Money(r.data.bonus_cskh_team)),
        mcol(G_DS, "Giới thiệu ứng viên", 14.0, |r| Cellv::Money(r.data.bonus_referral)),
        mcol(G_DS, "Thưởng lễ", 13.0, |r| Cellv::Money(r.data.holiday_bonus)),
        mcol(G_DS, "Cộng doanh số/Thưởng", 15.0, |r| Cellv::Money(r.data.cong_thuong)),
        mcol(G_GT, "Đã ứng", 13.0, |r| Cellv::Money(r.data.advances)),
        mcol(G_GT, "BHXH", 13.0, |r| Cellv::Money(r.data.insurance_total)),
        mcol(G_GT, "Thuế TNCN", 13.0, |r| Cellv::Money(r.data.tax_total)),
        mcol(G_GT, "Tổng giảm trừ", 14.0, |r| Cellv::Money(r.data.tong_giam_tru)),
        mcol(G_TT, "Thực nhận", 15.0, |r| Cellv::Money(r.data.total)),
        col(G_TT, "Số tài khoản", 18.0, |r| {
            Cellv::Text(r.data.bank_account_number.clone().unwrap_or_default())
        }),
        col(G_TT, "Ngân hàng", 16.0, |r| {
            Cellv::Text(r.data.bank_name.clone().unwrap_or_default())
        }),
    ]
}

fn bordered(bold: bool, fill: Option<u32>, h: HAlign) -> Style {
    Style {
        bold,
        fill,
        h,
        border: true,
        ..Style::default()
    }
}

fn text_style() -> Style {
    Style {
        v: VAlign::Middle,
        wrap: true,
        ..bordered(false, None, HAlign::General)
    }
}

/// `buildPayslipsListWorkbook`: 1 trang, hai tầng tiêu đề (nhóm + cột), dữ liệu, dòng TỔNG CỘNG, lọc tự động.
fn list_sheet(rows: &[ListRow], month: &str) -> GridSheet {
    const TITLE_ROW: u32 = 0;
    const GROUP_ROW: u32 = 1;
    const HEAD_ROW: u32 = 2;
    const DATA_START: u32 = 3;
    let cols = list_columns();
    let n = cols.len() as u16;
    let mut g = GridSheet::new("DANH SÁCH LƯƠNG");
    g.col_widths = cols.iter().map(|c| c.width).collect();

    let (year, mm) = month_parts(month);
    g.merge(Merged {
        first_row: TITLE_ROW,
        first_col: 0,
        last_row: TITLE_ROW,
        last_col: n - 1,
        text: format!("DANH SÁCH LƯƠNG THÁNG {mm}/{year}"),
        style: Style {
            bold: true,
            font_size: 14.0,
            h: HAlign::Center,
            v: VAlign::Middle,
            ..Style::default()
        },
    });
    g.row_heights.push((TITLE_ROW, 24.0));

    let mut c = 0_usize;
    while c < cols.len() {
        let group = cols[c].group;
        let mut end = c;
        while end + 1 < cols.len() && cols[end + 1].group == group {
            end += 1;
        }
        g.merge(Merged {
            first_row: GROUP_ROW,
            first_col: c as u16,
            last_row: GROUP_ROW,
            last_col: end as u16,
            text: group.to_owned(),
            style: Style {
                v: VAlign::Middle,
                ..bordered(true, Some(SECTION_FILL), HAlign::Center)
            },
        });
        c = end + 1;
    }

    for (i, col) in cols.iter().enumerate() {
        g.text(
            HEAD_ROW,
            i as u16,
            col.header,
            Style {
                v: VAlign::Middle,
                wrap: true,
                ..bordered(true, Some(0xF2F2F2), HAlign::Center)
            },
        );
    }
    g.row_heights.push((HEAD_ROW, 30.0));

    for (idx, row) in rows.iter().enumerate() {
        let r = DATA_START + idx as u32;
        for (i, col) in cols.iter().enumerate() {
            let ci = i as u16;
            match (col.value)(row) {
                Cellv::Index => g.number(r, ci, (idx + 1) as f64, bordered(false, None, HAlign::Center)),
                Cellv::Money(v) => g.number(
                    r,
                    ci,
                    v as f64,
                    Style {
                        num_format: Some(NUM_FMT),
                        ..bordered(false, None, HAlign::Right)
                    },
                ),
                Cellv::Days(Some(v)) => g.number(r, ci, v, bordered(false, None, HAlign::Right)),
                Cellv::Days(None) => g.text(r, ci, "—", bordered(false, None, HAlign::Right)),
                Cellv::Pct(v) => g.text(r, ci, pct_text(v), bordered(false, None, HAlign::Right)),
                Cellv::Text(s) if s.is_empty() => g.blank(r, ci, text_style()),
                Cellv::Text(s) => g.text(r, ci, s, text_style()),
            }
        }
    }

    let total_row = DATA_START + rows.len() as u32;
    g.merge(Merged {
        first_row: total_row,
        first_col: 0,
        last_row: total_row,
        last_col: EMP_COL_COUNT - 1,
        text: "TỔNG CỘNG".to_owned(),
        style: Style {
            v: VAlign::Middle,
            ..bordered(true, Some(0xFFF3CD), HAlign::Center)
        },
    });
    for (i, col) in cols.iter().enumerate().skip(usize::from(EMP_COL_COUNT)) {
        let ci = i as u16;
        let total_style = bordered(true, Some(0xFFF3CD), HAlign::General);
        if col.money {
            let sum = rows.iter().fold(0_i64, |acc, row| match (col.value)(row) {
                Cellv::Money(v) => acc.saturating_add(v),
                _ => acc,
            });
            g.number(
                total_row,
                ci,
                sum as f64,
                Style {
                    num_format: Some(NUM_FMT),
                    h: HAlign::Right,
                    ..total_style
                },
            );
        } else {
            g.blank(total_row, ci, total_style);
        }
    }

    if !rows.is_empty() {
        g.autofilter = Some((HEAD_ROW, 0, DATA_START + rows.len() as u32 - 1, n - 1));
    }
    g.freeze = Some((DATA_START, EMP_COL_COUNT));
    g
}
