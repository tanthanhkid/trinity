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
use trinity_docgen::xlsx::{ReadCell, ReadSheet, XlsxError, js_number_string, read_first_sheet};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::number::js_round;
use trinity_kernel::vi::trim_js;

use super::{
    Emp, MANUAL_COLS, MONTH_MSG, Manual, PayslipRow, R, SELECT_P, UpdatePayslip, calc, calc_err, db, employee_code,
    engine_base, fetch_employees, in_scope, insurance_total, not_found_id, out_of_scope, persist, read_tax, team_order,
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
        if i > 0 && (s.len() - i).is_multiple_of(3) {
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
        self.g
            .number(row, 2, v as f64, style(true, Some(SECTION_FILL), true, true));
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

#[derive(Clone)]
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
        mcol(G_LCB, "Lương đóng BHXH", 14.0, |r| {
            Cellv::Money(r.data.insurance_base)
        }),
        col(G_LCB, "Ngày công", 9.0, |r| Cellv::Days(r.data.working_days)),
        mcol(G_LCB, "Số tiền ngày công", 14.0, |r| {
            Cellv::Money(r.data.don_gia_ngay_cong)
        }),
        mcol(G_LCB, "Thực lĩnh LCB", 14.0, |r| {
            Cellv::Money(r.data.base_salary_actual)
        }),
        col(G_LCB, "Ngày học việc", 10.0, |r| Cellv::Days(r.data.training_days)),
        mcol(G_LCB, "Lương học việc", 14.0, |r| {
            Cellv::Money(r.data.training_salary)
        }),
        mcol(G_LCB, "Phụ cấp học việc", 14.0, |r| {
            Cellv::Money(r.data.probation_allowance)
        }),
        mcol(G_LCB, "Cộng lương cơ bản", 15.0, |r| {
            Cellv::Money(r.data.cong_lcb)
        }),
        mcol(G_DS, "Doanh số", 15.0, |r| Cellv::Money(r.data.sales_personal)),
        col(G_DS, "% KPI", 9.0, |r| Cellv::Pct(r.data.kpi_percent)),
        col(G_DS, "Hệ số (%)", 9.0, |r| Cellv::Pct(r.data.bonus_rate)),
        mcol(G_DS, "Bonus", 14.0, |r| Cellv::Money(r.data.bonus_sales_personal)),
        mcol(G_DS, "Vượt mốc cá nhân", 14.0, |r| {
            Cellv::Money(r.data.bonus_milestone)
        }),
        mcol(G_DS, "Contest Team", 14.0, |r| Cellv::Money(r.data.bonus_cskh_team)),
        mcol(G_DS, "Giới thiệu ứng viên", 14.0, |r| {
            Cellv::Money(r.data.bonus_referral)
        }),
        mcol(G_DS, "Thưởng lễ", 13.0, |r| Cellv::Money(r.data.holiday_bonus)),
        mcol(G_DS, "Cộng doanh số/Thưởng", 15.0, |r| {
            Cellv::Money(r.data.cong_thuong)
        }),
        mcol(G_GT, "Đã ứng", 13.0, |r| Cellv::Money(r.data.advances)),
        mcol(G_GT, "BHXH", 13.0, |r| Cellv::Money(r.data.insurance_total)),
        mcol(G_GT, "Thuế TNCN", 13.0, |r| Cellv::Money(r.data.tax_total)),
        mcol(G_GT, "Tổng giảm trừ", 14.0, |r| {
            Cellv::Money(r.data.tong_giam_tru)
        }),
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

/// `GET /payslips/excel-list` và `POST /payslips/excel-list`: một trang, mỗi nhân viên một dòng, dòng TỔNG CỘNG;
/// `danh-sach-luong-ky-<tháng>.xlsx`. `ordered` (từ `ordered_ids`) = id phiếu theo đúng thứ tự đang hiển thị: chỉ xuất các
/// phiếu đó, theo thứ tự đó; id ngoài phạm vi `payroll.export` bị loại (không lộ phiếu người khác). Không có ⇒ xếp theo
/// nhóm quản lý rồi tên như `GET /payslips`. Không có phiếu ⇒ 404.
pub async fn export_list(
    conn: &mut PgConnection,
    month: &str,
    scope: Option<&[i32]>,
    ordered: Option<&[i32]>,
) -> R<FileOut> {
    let ordered = ordered.filter(|v| !v.is_empty());
    let mut rows = load_period(conn, month, scope, ordered).await?;
    if rows.is_empty() {
        return Err(no_slips(month));
    }
    let list: Vec<ListRow> = match ordered {
        Some(ids) => {
            // Mỗi id đúng một phiếu; id trùng lặp lại dòng như `byId.get` của bản TS, id lạ bị bỏ.
            let by_id: HashMap<i32, ListRow> = rows.iter().map(|p| (p.id, list_row(p))).collect();
            ids.iter().filter_map(|id| by_id.get(id).cloned()).collect()
        }
        None => {
            rows.sort_by(team_order);
            rows.iter().map(list_row).collect()
        }
    };
    let bytes = write_grid(&[list_sheet(&list, month)]).map_err(xlsx_err)?;
    Ok(FileOut::xlsx(bytes, format!("danh-sach-luong-ky-{month}.xlsx")))
}

fn list_row(p: &PayslipRow) -> ListRow {
    ListRow {
        code: employee_code(p.e_code.as_deref(), p.employee_id),
        department: p.e_department.clone().unwrap_or_default(),
        data: slip_data(p),
    }
}

// ---------------------------------------------------------------- PDF

const MARGIN: f64 = 40.0;
const CONTENT_W: f64 = 515.0;
const X_LABEL: f64 = 46.0;
const X_VALUE: f64 = 320.0;
/// Mép phải của vùng nội dung (`MARGIN + CONTENT_W`).
const RIGHT: f64 = MARGIN + CONTENT_W;
const ROW_H: f64 = 16.0;
const SEC_H: f64 = 19.0;
const BODY_FS: f64 = 10.5;
const PAGE_BOTTOM: f64 = 802.0;
const BLACK: u32 = 0x000000;

/// Bộ vẽ một phiếu A4: `y` là mép trên dòng kế tiếp (gốc góc trên trái), qua trang khi hết chỗ như `ensure` của bản TS.
struct PdfSlip {
    pdf: PdfBuilder,
    regular: usize,
    bold: usize,
    y: f64,
}

impl PdfSlip {
    fn ensure(&mut self, h: f64) {
        if self.y + h > PAGE_BOTTOM {
            self.pdf.add_page();
            self.y = MARGIN;
        }
    }

    fn center_title(&mut self, text: &str, size: f64) {
        self.ensure(size + 8.0);
        self.pdf
            .text_center(self.bold, size, BLACK, MARGIN, CONTENT_W, self.y, text);
        self.y += size + 8.0;
    }

    fn row(&mut self, label: &str, value: &str, bold: bool, right: bool) {
        self.ensure(ROW_H);
        let font = if bold { self.bold } else { self.regular };
        self.pdf.text(font, BODY_FS, BLACK, X_LABEL, self.y, label);
        if right {
            self.pdf.text_right(font, BODY_FS, BLACK, RIGHT, self.y, value);
        } else {
            self.pdf.text(font, BODY_FS, BLACK, X_VALUE, self.y, value);
        }
        self.y += ROW_H;
    }

    fn money_line(&mut self, label: &str, v: i64, bold: bool) {
        self.row(label, &format_vnd(v), bold, true);
    }

    fn num_line(&mut self, label: &str, v: Option<f64>) {
        let text = v.map_or_else(|| "—".to_owned(), js_number_string);
        self.row(label, &text, false, true);
    }

    fn text_line(&mut self, label: &str, value: &str) {
        self.row(label, value, false, false);
    }

    fn section(&mut self, text: &str) {
        self.ensure(SEC_H + 2.0);
        self.pdf.fill_rect(MARGIN, self.y, CONTENT_W, SEC_H, SECTION_FILL);
        self.pdf.text(self.bold, BODY_FS, BLACK, X_LABEL, self.y + 5.0, text);
        self.y += SEC_H + 3.0;
    }

    /// Dòng tiêu đề mục kèm giá trị ở cột phải (mục IV).
    fn section_money(&mut self, text: &str, v: i64) {
        self.ensure(SEC_H + 2.0);
        self.pdf.fill_rect(MARGIN, self.y, CONTENT_W, SEC_H, SECTION_FILL);
        self.pdf.text(self.bold, BODY_FS, BLACK, X_LABEL, self.y + 5.0, text);
        self.pdf
            .text_right(self.bold, BODY_FS, BLACK, RIGHT, self.y + 5.0, &format_vnd(v));
        self.y += SEC_H + 3.0;
    }
}

/// Bố cục PDF của một phiếu (đồng bộ mẫu xlsx: I/II/III/IV + Lưu ý); tách khỏi [`PdfBuilder::finish`] để test đọc lại các chuỗi
/// đã vẽ ([`PdfBuilder::texts`]) mà không cần bộ trích văn bản PDF.
fn layout_payslip(d: &SlipData) -> Result<PdfBuilder, PdfError> {
    let company = company_name();
    let mut pdf = PdfBuilder::new(&format!("Phiếu lương - {}", d.month), &company);
    let regular = pdf.add_font("Tinos", TINOS_REGULAR)?;
    let bold = pdf.add_font("TinosBold", TINOS_BOLD)?;
    let mut s = PdfSlip {
        pdf,
        regular,
        bold,
        y: MARGIN,
    };
    let (year, month) = month_parts(&d.month);

    s.center_title(&company, 13.0);
    s.text_line("Kính gửi: Quý Anh/Chị", &d.full_name);
    s.center_title(&format!("THÔNG TIN LƯƠNG THÁNG {month}/{year}"), 12.0);
    s.pdf.line(MARGIN, s.y, RIGHT, s.y, 0x999999, 1.0);
    s.y += 6.0;

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

    s.y += 6.0;
    s.ensure(72.0);
    s.pdf
        .text_wrapped(regular, 9.0, 0x444444, X_LABEL, s.y, CONTENT_W - 12.0, 10.5, NOTE_TEXT);
    Ok(s.pdf)
}

/// PDF một phiếu theo mẫu kế toán, phông Tinos nhúng (có dấu tiếng Việt, đọc lại được bằng bộ trích văn bản).
fn build_payslip_pdf(d: &SlipData) -> Result<Vec<u8>, PdfError> {
    layout_payslip(d).map(PdfBuilder::finish)
}

// ---------------------------------------------------------------- nhập xlsx: cột và đọc ô

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Số thực (ngày công, hệ số, KPI).
    Float,
    /// Số nguyên 1..=31 (ngày công chuẩn).
    Int,
    /// Chữ (ghi chú).
    Text,
    /// Tiền VND nguyên không âm.
    Money,
}

struct FieldDef {
    header: &'static str,
    field: &'static str,
    kind: Kind,
}

const fn fd(header: &'static str, field: &'static str, kind: Kind) -> FieldDef {
    FieldDef { header, field, kind }
}

/// `HEADER_TO_FIELD`: tiêu đề cột xlsx ⇒ trường của `UpdatePayslip`; thứ tự = thứ tự cột của mẫu nhập. Tên cột đồng bộ file
/// xuất (xlsx danh sách) và bảng ở giao diện; tên cột cũ không được nhận.
const FIELDS: [FieldDef; 18] = [
    fd("Ngày công", "working_days", Kind::Float),
    fd("Ngày công chuẩn", "standard_working_days", Kind::Int),
    fd("Lương cơ bản", "base_salary", Kind::Money),
    fd("Ngày học việc", "training_days", Kind::Float),
    fd("Lương học việc", "training_salary", Kind::Money),
    fd("Phụ cấp học việc", "probation_allowance", Kind::Money),
    fd("Doanh số", "sales_personal", Kind::Money),
    fd("Hệ số (%)", "bonus_rate", Kind::Float),
    fd("% KPI", "kpi_percent", Kind::Float),
    fd("Bonus", "bonus_sales_personal", Kind::Money),
    fd("Doanh số Team", "sales_team", Kind::Money),
    fd("Contest Team", "bonus_cskh_team", Kind::Money),
    fd("Vượt mốc cá nhân", "bonus_milestone", Kind::Money),
    fd("Giới thiệu ứng viên", "bonus_referral", Kind::Money),
    fd("Thưởng lễ", "holiday_bonus", Kind::Money),
    fd("Đã ứng", "advances", Kind::Money),
    fd("Thuế TNCN", "personal_income_tax", Kind::Money),
    fd("Ghi chú", "notes", Kind::Text),
];

/// Trần cột tiền: 15 chữ số (dư xa mọi mức lương thực).
const MONEY_MAX: f64 = 999_999_999_999_999.0;
const MONEY_MAX_TEXT: &str = "999,999,999,999,999";
const EMPTY_PLACEHOLDERS: [&str; 5] = ["-", "–", "—", "n/a", "na"];

/// Trần của trường số thực, khớp `@Max` của `UpdatePayslip` (`kpi_percent` còn khớp cột `Decimal(5,2)`).
fn float_max(field: &str) -> Option<f64> {
    match field {
        "working_days" | "training_days" => Some(31.0),
        "bonus_rate" => Some(100.0),
        "kpi_percent" => Some(999.99),
        _ => None,
    }
}

/// Giá trị ô thô: số hoặc chuỗi đã cắt khoảng trắng (`parseCellRaw`); ô trống, đúng/sai, ngày giờ, lỗi ⇒ `None`.
#[derive(Debug, Clone, PartialEq)]
enum Raw {
    Num(f64),
    Text(String),
}

impl Raw {
    /// `String(raw)`.
    fn text(&self) -> String {
        match self {
            Self::Num(n) => js_number_string(*n),
            Self::Text(s) => s.clone(),
        }
    }

    /// Giá trị "truthy" của JS: số 0 và NaN coi như vắng (`if (!codeRaw) continue`).
    fn truthy(&self) -> bool {
        match self {
            Self::Num(n) => *n != 0.0 && !n.is_nan(),
            Self::Text(s) => !s.is_empty(),
        }
    }
}

fn raw_of(c: &ReadCell) -> Option<Raw> {
    match c {
        ReadCell::Number(n) => Some(Raw::Num(*n)),
        ReadCell::Text(s) => Some(trim_js(s))
            .filter(|t| !t.is_empty())
            .map(|t| Raw::Text(t.to_owned())),
        _ => None,
    }
}

/// `Number(s)` của JS ở các dạng gặp trong ô: rỗng ⇒ 0, không phải số ⇒ NaN.
fn js_number(s: &str) -> f64 {
    let t = trim_js(s);
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseDecimal`: số thập phân kiểu Việt ("85,5" → 85.5; "1.234,5" → 1234.5; "1.5" → 1.5); rác ⇒ NaN.
fn parse_decimal(raw: &str) -> f64 {
    let s: String = trim_js(raw).chars().filter(|c| !c.is_whitespace()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    if s.contains(',') {
        js_number(&s.replace('.', "").replacen(',', ".", 1))
    } else {
        js_number(&s)
    }
}

/// `parseInt(s, 10)`: lấy phần nguyên ở đầu chuỗi; không có ⇒ NaN.
fn parse_int_js(s: &str) -> f64 {
    let t = trim_js(s);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    match digits.parse::<f64>() {
        Ok(v) if neg => -v,
        Ok(v) => v,
        Err(_) => f64::NAN,
    }
}

/// Giá trị đã đọc của một ô.
#[derive(Debug, Clone, PartialEq)]
enum Parsed {
    Float(f64),
    Int(i64),
    Text(String),
    /// Số nguyên VND dạng chuỗi (như `UpdatePayslip`).
    Money(String),
}

impl Parsed {
    /// `String(newVal)`.
    fn text(&self) -> String {
        match self {
            Self::Float(n) => js_number_string(*n),
            Self::Int(n) => n.to_string(),
            Self::Text(s) | Self::Money(s) => s.clone(),
        }
    }
}

/// Ô số không đọc được / âm: chỉ là dấu gạch "không có" thì bỏ qua, còn lại báo lỗi để xem trước không im lặng.
fn invalid_number(field: &str, raw: &Raw) -> Result<Option<Parsed>, String> {
    let text = raw.text();
    let text = trim_js(&text);
    if text.is_empty() || EMPTY_PLACEHOLDERS.contains(&text.to_lowercase().as_str()) {
        return Ok(None);
    }
    let shown: String = text.chars().take(40).collect();
    Err(format!("{field}: giá trị \"{shown}\" không phải số hợp lệ (không âm)"))
}

/// `parseField`: `Ok(None)` = bỏ qua ô; `Err` = lỗi của riêng dòng (gom vào `skip_reason`, không làm hỏng cả tệp).
fn parse_field(def: &FieldDef, raw: &Raw) -> Result<Option<Parsed>, String> {
    let field = def.field;
    match def.kind {
        Kind::Float => {
            let n = match raw {
                Raw::Num(n) => *n,
                Raw::Text(s) => parse_decimal(s),
            };
            if !n.is_finite() || n < 0.0 {
                return invalid_number(field, raw);
            }
            if let Some(max) = float_max(field)
                && n > max
            {
                return Err(format!(
                    "{field} vượt giới hạn cho phép (tối đa {})",
                    js_number_string(max)
                ));
            }
            Ok(Some(Parsed::Float(n)))
        }
        Kind::Int => {
            let n = match raw {
                Raw::Num(n) => *n,
                Raw::Text(s) => parse_int_js(s),
            };
            if !n.is_finite() || !(1.0..=31.0).contains(&n) {
                return Ok(None);
            }
            Ok(Some(Parsed::Int(js_round(n) as i64)))
        }
        Kind::Text => Ok(Some(raw.text()).filter(|s| !s.is_empty()).map(Parsed::Text)),
        Kind::Money => {
            let n = match raw {
                Raw::Num(n) => *n,
                Raw::Text(s) => js_number(&s.replace(',', "")),
            };
            if !n.is_finite() || n < 0.0 {
                return invalid_number(field, raw);
            }
            if n > MONEY_MAX {
                return Err(format!("{field} vượt giới hạn cho phép (tối đa {MONEY_MAX_TEXT})"));
            }
            Ok(Some(Parsed::Money((js_round(n) as i64).to_string())))
        }
    }
}

/// Một dòng dữ liệu của tệp nhập.
#[derive(Debug, Clone, PartialEq)]
struct ImportRow {
    code: String,
    name: Option<String>,
    /// Theo thứ tự cột; cột trùng trường thì cột sau thắng (giữ vị trí đầu như khoá đối tượng JS).
    fields: Vec<(&'static str, Parsed)>,
    errors: Vec<String>,
}

fn is_code_header(c: &ReadCell) -> bool {
    matches!(c, ReadCell::Text(s) if matches!(trim_js(s), "Mã NV" | "Mã nhân viên"))
}

fn has_code_header(sheet: &ReadSheet, row: usize) -> bool {
    (0..sheet.row_width(row)).any(|c| is_code_header(sheet.cell(row, c)))
}

/// `parseImportFile` trên trang tính đã đọc: dòng tiêu đề là dòng đầu (trong 5 dòng đầu) có "Mã NV"/"Mã nhân viên"; dòng
/// thiếu mã bị bỏ; không có dòng tiêu đề ⇒ rỗng.
fn parse_rows(sheet: &ReadSheet) -> Vec<ImportRow> {
    let total = sheet.rows.len();
    let Some(head) = (0..total.min(5)).find(|r| has_code_header(sheet, *r)) else {
        return Vec::new();
    };
    let mut code_col = None;
    let mut name_col = None;
    let mut by_col: Vec<(usize, &'static FieldDef)> = Vec::new();
    for c in 0..sheet.row_width(head) {
        let ReadCell::Text(h) = sheet.cell(head, c) else {
            continue;
        };
        let h = trim_js(h);
        if is_code_header(sheet.cell(head, c)) {
            code_col = Some(c);
        } else if h == "Họ tên" {
            name_col = Some(c);
        } else if let Some(def) = FIELDS.iter().find(|d| d.header == h) {
            by_col.push((c, def));
        }
    }
    let Some(code_col) = code_col else { return Vec::new() };

    let mut out = Vec::new();
    for r in head + 1..total {
        let Some(code_raw) = raw_of(sheet.cell(r, code_col)).filter(Raw::truthy) else {
            continue;
        };
        let code = trim_js(&code_raw.text()).to_owned();
        if code.is_empty() {
            continue;
        }
        let name = name_col
            .and_then(|c| raw_of(sheet.cell(r, c)))
            .filter(Raw::truthy)
            .map(|n| trim_js(&n.text()).to_owned());
        let mut fields: Vec<(&'static str, Parsed)> = Vec::new();
        let mut errors = Vec::new();
        for (c, def) in &by_col {
            let Some(raw) = raw_of(sheet.cell(r, *c)) else { continue };
            match parse_field(def, &raw) {
                Ok(Some(v)) => match fields.iter_mut().find(|(f, _)| *f == def.field) {
                    Some(slot) => slot.1 = v,
                    None => fields.push((def.field, v)),
                },
                Ok(None) => {}
                Err(msg) => errors.push(msg),
            }
        }
        out.push(ImportRow {
            code,
            name,
            fields,
            errors,
        });
    }
    out
}

/// Đọc trang tính đầu của tệp tải lên. Không có trang nào ⇒ rỗng (như `wb.worksheets[0]` không có); tệp hỏng ⇒ 400.
fn parse_import_file(bytes: &[u8]) -> R<Vec<ImportRow>> {
    match read_first_sheet(bytes) {
        Ok(sheet) => Ok(parse_rows(&sheet)),
        Err(XlsxError::NoSheet) => Ok(Vec::new()),
        Err(_) => Err(HttpError::bad_request("Tệp tải lên không phải xlsx hợp lệ").into()),
    }
}

/// `getPayslipFieldValues` + `String(v ?? '')`: giá trị đang lưu của một trường nhập, dạng chữ để so với ô.
fn current_text(m: &Manual, field: &str) -> String {
    let opt = |v: Option<f64>| v.map(js_number_string).unwrap_or_default();
    match field {
        "working_days" => opt(m.working_days),
        "standard_working_days" => m.standard_working_days.to_string(),
        "base_salary" => m.base_salary.to_string(),
        "training_days" => opt(m.training_days),
        "training_salary" => m.training_salary.to_string(),
        "probation_allowance" => m.probation_allowance.to_string(),
        "sales_personal" => m.sales_personal.to_string(),
        "bonus_rate" => opt(m.bonus_rate),
        "kpi_percent" => opt(m.kpi_percent),
        "bonus_sales_personal" => m.bonus_sales_personal.to_string(),
        "sales_team" => m.sales_team.to_string(),
        "bonus_cskh_team" => m.bonus_cskh_team.to_string(),
        "bonus_milestone" => m.bonus_milestone.to_string(),
        "bonus_referral" => m.bonus_referral.to_string(),
        "holiday_bonus" => m.holiday_bonus.to_string(),
        "advances" => m.advances.to_string(),
        "personal_income_tax" => m.personal_income_tax.to_string(),
        "notes" => m.notes.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

/// Các ô đã đọc ⇒ `UpdatePayslip` để gộp qua [`Manual::merged`] (cùng đường tính với `PATCH /payslips/:id`).
fn to_update(fields: &[(&'static str, Parsed)]) -> UpdatePayslip {
    let mut u = UpdatePayslip::default();
    for (name, v) in fields {
        match (*name, v) {
            ("working_days", Parsed::Float(n)) => u.working_days = Some(Some(*n)),
            ("training_days", Parsed::Float(n)) => u.training_days = Some(Some(*n)),
            ("bonus_rate", Parsed::Float(n)) => u.bonus_rate = Some(Some(*n)),
            ("kpi_percent", Parsed::Float(n)) => u.kpi_percent = Some(Some(*n)),
            ("standard_working_days", Parsed::Int(n)) => u.standard_working_days = Some(*n),
            ("notes", Parsed::Text(s)) => u.notes = Some(Some(s.clone())),
            (_, Parsed::Money(s)) => {
                let slot = match *name {
                    "base_salary" => &mut u.base_salary,
                    "training_salary" => &mut u.training_salary,
                    "probation_allowance" => &mut u.probation_allowance,
                    "sales_personal" => &mut u.sales_personal,
                    "bonus_sales_personal" => &mut u.bonus_sales_personal,
                    "sales_team" => &mut u.sales_team,
                    "bonus_cskh_team" => &mut u.bonus_cskh_team,
                    "bonus_milestone" => &mut u.bonus_milestone,
                    "bonus_referral" => &mut u.bonus_referral,
                    "holiday_bonus" => &mut u.holiday_bonus,
                    "advances" => &mut u.advances,
                    "personal_income_tax" => &mut u.personal_income_tax,
                    _ => continue,
                };
                *slot = Some(s.clone());
            }
            _ => {}
        }
    }
    u
}

// ---------------------------------------------------------------- mẫu nhập

/// Một dòng của mẫu nhập: nhân viên `active` kèm các khoản hiện có của phiếu tháng đó (nếu có).
struct TemplateEmp {
    code: String,
    name: String,
    current: Option<Manual>,
}

/// Ô mẫu của một trường: số, chữ hoặc để trống (`templateCellValue`).
fn template_cell(m: Option<&Manual>, def: &FieldDef) -> Option<Parsed> {
    let m = m?;
    let f = |v: Option<f64>| v.map(Parsed::Float);
    match def.field {
        "working_days" => f(m.working_days),
        "training_days" => f(m.training_days),
        "bonus_rate" => f(m.bonus_rate),
        "kpi_percent" => f(m.kpi_percent),
        "standard_working_days" => Some(Parsed::Int(i64::from(m.standard_working_days))),
        "notes" => m.notes.clone().filter(|s| !s.is_empty()).map(Parsed::Text),
        _ => Some(current_text(m, def.field))
            .filter(|t| t.parse::<i64>().is_ok())
            .map(Parsed::Money),
    }
}

fn header_style() -> Style {
    Style {
        bold: true,
        color: Some(0xFFFFFF),
        v: VAlign::Middle,
        wrap: true,
        ..bordered(true, Some(0x4472C4), HAlign::Center)
    }
}

/// `buildImportTemplate`: dòng 1 tiêu đề gộp, dòng 2 tiêu đề cột, từ dòng 3 mỗi nhân viên một dòng; cố định hai dòng đầu và
/// hai cột đầu.
fn template_sheet(emps: &[TemplateEmp], month: &str) -> GridSheet {
    let n = (2 + FIELDS.len()) as u16;
    let (year, mon) = month_parts(month);
    let mut g = GridSheet::new("Nhập phiếu lương");
    g.col_widths = [14.0, 24.0]
        .into_iter()
        .chain(FIELDS.iter().map(|d| f64::max(14.0, (len16(d.header) + 2) as f64)))
        .collect();
    g.merge(Merged {
        first_row: 0,
        first_col: 0,
        last_row: 0,
        last_col: n - 1,
        text: format!("MẪU NHẬP PHIẾU LƯƠNG — THÁNG {mon}/{year}"),
        style: Style {
            bold: true,
            font_size: 13.0,
            h: HAlign::Center,
            ..Style::default()
        },
    });
    g.row_heights.push((1, 28.0));
    g.text(1, 0, "Mã NV", header_style());
    g.text(1, 1, "Họ tên", header_style());
    for (i, d) in FIELDS.iter().enumerate() {
        g.text(1, (2 + i) as u16, d.header, header_style());
    }
    for (idx, e) in emps.iter().enumerate() {
        let r = 2 + idx as u32;
        g.text(r, 0, e.code.as_str(), text_style());
        g.text(r, 1, e.name.as_str(), text_style());
        for (i, d) in FIELDS.iter().enumerate() {
            let c = (2 + i) as u16;
            let h = if d.kind == Kind::Text {
                HAlign::General
            } else {
                HAlign::Right
            };
            let style = Style {
                num_format: (d.kind == Kind::Money).then_some(NUM_FMT),
                ..bordered(false, None, h)
            };
            match template_cell(e.current.as_ref(), d) {
                Some(Parsed::Float(v)) => g.number(r, c, v, style),
                Some(Parsed::Int(v)) => g.number(r, c, v as f64, style),
                Some(Parsed::Money(s)) => g.number(r, c, s.parse::<f64>().unwrap_or(0.0), style),
                Some(Parsed::Text(s)) => g.text(r, c, s, style),
                None => g.blank(r, c, style),
            }
        }
    }
    g.freeze = Some((2, 2));
    g
}

#[derive(Debug, sqlx::FromRow)]
struct EmpName {
    id: i32,
    employee_code: Option<String>,
    full_name: Option<String>,
}

/// Nhân viên `active` chưa xoá, kèm tên (mẫu nhập và khớp mã khi nhập).
async fn active_names(conn: &mut PgConnection, by_name: bool) -> R<Vec<EmpName>> {
    let sql = if by_name {
        "SELECT e.id, e.employee_code, u.full_name FROM employees e JOIN users u ON u.id = e.user_id \
         WHERE e.status = 'active' AND e.deleted_at IS NULL ORDER BY u.full_name ASC, e.id ASC"
    } else {
        "SELECT e.id, e.employee_code, u.full_name FROM employees e JOIN users u ON u.id = e.user_id \
         WHERE e.status = 'active' AND e.deleted_at IS NULL ORDER BY e.id ASC"
    };
    sqlx::query_as::<_, EmpName>(sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)
}

#[derive(Debug, sqlx::FromRow)]
struct ImpSlip {
    id: i32,
    employee_id: i32,
    status: String,
    #[sqlx(flatten)]
    manual: Manual,
}

/// Phiếu chưa loại của kỳ theo danh sách nhân viên; `lock` khoá dòng khi sắp ghi.
async fn period_slips(conn: &mut PgConnection, month: &str, employees: &[i32], lock: bool) -> R<HashMap<i32, ImpSlip>> {
    let sql = format!(
        "SELECT p.id, p.employee_id, p.status, {MANUAL_COLS} FROM payslips p \
         WHERE p.month = $1 AND p.deleted_at IS NULL AND p.employee_id = ANY($2){}",
        if lock { " FOR UPDATE OF p" } else { "" }
    );
    let rows = sqlx::query_as::<_, ImpSlip>(AssertSqlSafe(sql))
        .bind(month.to_owned())
        .bind(employees.to_vec())
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    Ok(rows.into_iter().map(|s| (s.employee_id, s)).collect())
}

/// `GET /payslips/import-template?month=`: `mau-nhap-phieu-luong-<tháng>.xlsx`, mọi nhân viên `active` xếp theo tên, điền sẵn
/// các khoản của phiếu tháng đó. Chỉ `payroll.manage` nên không thu hẹp theo phạm vi.
pub async fn import_template(conn: &mut PgConnection, month: &str) -> R<FileOut> {
    let emps = active_names(conn, true).await?;
    let ids: Vec<i32> = emps.iter().map(|e| e.id).collect();
    let mut slips = period_slips(conn, month, &ids, false).await?;
    let rows: Vec<TemplateEmp> = emps
        .into_iter()
        .map(|e| TemplateEmp {
            code: employee_code(e.employee_code.as_deref(), e.id),
            name: e.full_name.unwrap_or_default(),
            current: slips.remove(&e.id).map(|s| s.manual),
        })
        .collect();
    let bytes = write_grid(&[template_sheet(&rows, month)]).map_err(xlsx_err)?;
    Ok(FileOut::xlsx(bytes, format!("mau-nhap-phieu-luong-{month}.xlsx")))
}

// ---------------------------------------------------------------- nhập: xem trước / áp dụng

/// Một thay đổi: tiêu đề cột, trường, giá trị trước và sau (dạng chữ).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportChange {
    pub header: String,
    pub field: String,
    pub before: String,
    pub after: String,
}

/// Kết quả một dòng nhập (`ImportPreviewRow`); `skip_reason` vắng khi không bỏ qua.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportPreviewRow {
    pub employee_code: String,
    pub employee_name: Option<String>,
    pub payslip_id: Option<i32>,
    pub payslip_status: Option<String>,
    pub changes: Vec<ImportChange>,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

fn skipped_row(
    code: &str,
    name: Option<String>,
    slip: Option<&ImpSlip>,
    reason: impl Into<String>,
) -> ImportPreviewRow {
    ImportPreviewRow {
        employee_code: code.to_owned(),
        employee_name: name,
        payslip_id: slip.map(|s| s.id),
        payslip_status: slip.map(|s| s.status.clone()),
        changes: Vec::new(),
        skipped: true,
        skip_reason: Some(reason.into()),
    }
}

/// `POST /payslips/import/preview?month=` (multipart `file`): không ghi DB.
pub async fn preview_import(conn: &mut PgConnection, bytes: &[u8], month: &str) -> R<Vec<ImportPreviewRow>> {
    process_rows(conn, parse_import_file(bytes)?, month, false).await
}

/// `POST /payslips/import/apply?month=` (multipart `file`): ghi các phiếu có thay đổi, bỏ qua phiếu đã duyệt/đã trả. Mỗi phiếu
/// gộp ô nhập lên khoản đã lưu rồi tính lại cả phiếu như `PATCH /payslips/:id`; route bọc một giao dịch nên lỗi giữa chừng
/// hoàn tác cả lô.
pub async fn apply_import(conn: &mut PgConnection, bytes: &[u8], month: &str) -> R<Vec<ImportPreviewRow>> {
    process_rows(conn, parse_import_file(bytes)?, month, true).await
}

async fn process_rows(
    conn: &mut PgConnection,
    rows: Vec<ImportRow>,
    month: &str,
    apply: bool,
) -> R<Vec<ImportPreviewRow>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let codes: HashSet<&str> = rows.iter().map(|r| r.code.as_str()).collect();
    // Mã trùng thì nhân viên sau (id lớn hơn) thắng, như `new Map(entries)`.
    let mut by_code: HashMap<String, EmpName> = HashMap::new();
    for e in active_names(conn, false).await? {
        let code = employee_code(e.employee_code.as_deref(), e.id);
        if codes.contains(code.as_str()) {
            by_code.insert(code, e);
        }
    }
    let ids: Vec<i32> = by_code.values().map(|e| e.id).collect();
    let slips = period_slips(conn, month, &ids, apply).await?;
    let emps: HashMap<i32, Emp> = if apply {
        fetch_employees(conn, None)
            .await?
            .into_iter()
            .map(|e| (e.id, e))
            .collect()
    } else {
        HashMap::new()
    };
    let mut cfg: Option<calc::PayrollConfig> = None;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(emp) = by_code.get(&row.code) else {
            out.push(skipped_row(
                &row.code,
                row.name,
                None,
                "Không tìm thấy nhân viên với mã này",
            ));
            continue;
        };
        let name = emp.full_name.clone();
        let Some(slip) = slips.get(&emp.id) else {
            out.push(skipped_row(&row.code, name, None, "Chưa có phiếu lương tháng này"));
            continue;
        };
        if slip.status == "approved" || slip.status == "paid" {
            let reason = format!("Phiếu đã được duyệt ({}) — không thể chỉnh sửa", slip.status);
            out.push(skipped_row(&row.code, name, Some(slip), reason));
            continue;
        }
        if !row.errors.is_empty() {
            out.push(skipped_row(&row.code, name, Some(slip), row.errors.join("; ")));
            continue;
        }
        let changes: Vec<ImportChange> = row
            .fields
            .iter()
            .filter_map(|(field, v)| {
                let before = current_text(&slip.manual, field);
                let after = v.text();
                (before != after).then(|| ImportChange {
                    header: FIELDS
                        .iter()
                        .find(|d| d.field == *field)
                        .map_or(*field, |d| d.header)
                        .to_owned(),
                    field: (*field).to_owned(),
                    before,
                    after,
                })
            })
            .collect();
        if apply && !changes.is_empty() {
            let employee = emps
                .get(&emp.id)
                .ok_or_else(|| AppError::internal("không đọc được nhân viên đang làm việc để tính lại phiếu"))?;
            if cfg.is_none() {
                cfg = Some(calc::load_config(conn).await?);
            }
            let Some(cfg) = cfg.as_ref() else { continue };
            let base = engine_base(conn, employee).await?;
            let kpi_n = calc::kpi_achieved_count(conn, employee.id, month).await?;
            let manual = slip.manual.merged(&to_update(&row.fields));
            let computed =
                calc::compute_payslip(cfg, month, base, kpi_n, &employee.input(), &manual.input()).map_err(calc_err)?;
            persist(conn, slip.id, &computed, &manual).await?;
        }
        out.push(ImportPreviewRow {
            employee_code: row.code,
            employee_name: name,
            payslip_id: Some(slip.id),
            payslip_status: Some(slip.status.clone()),
            changes,
            skipped: false,
            skip_reason: None,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trinity_docgen::xlsx::read_first_sheet;

    use super::*;

    fn slip() -> SlipData {
        SlipData {
            month: "2026-03".into(),
            full_name: "Nguyễn Thị Hồng Ánh".into(),
            position: "Chuyên viên kinh doanh".into(),
            team_name: "Trần Văn Bình".into(),
            base_salary: 12_000_000,
            working_days: Some(21.5),
            don_gia_ngay_cong: 500_000,
            base_salary_actual: 10_750_000,
            training_days: None,
            training_salary: 0,
            probation_allowance: 300_000,
            cong_lcb: 11_050_000,
            sales_personal: 80_000_000,
            bonus_rate: Some(2.5),
            kpi_percent: None,
            bonus_sales_personal: 2_000_000,
            bonus_cskh_team: 100_000,
            bonus_milestone: 0,
            bonus_referral: 0,
            holiday_bonus: 0,
            cong_thuong: 2_100_000,
            advances: 1_000_000,
            insurance_base: 8_000_000,
            phu_cap_xang_xe: 4_000_000,
            insurance_total: 840_000,
            tax_total: 0,
            tong_giam_tru: 1_000_000,
            total: 12_150_000,
            bank_account_number: Some("0123456789".into()),
            bank_name: Some("Ngân hàng Á Châu".into()),
            notes: None,
        }
    }

    fn manual() -> Manual {
        Manual {
            working_days: Some(21.5),
            standard_working_days: 24,
            base_salary: 10_000_000,
            training_days: None,
            training_salary: 0,
            probation_allowance: 250_000,
            sales_personal: 50_000_000,
            bonus_rate: Some(1.25),
            kpi_percent: Some(98.5),
            bonus_sales_personal: 600_000,
            sales_team: 0,
            bonus_cskh_team: 0,
            bonus_milestone: 0,
            bonus_referral: 0,
            holiday_bonus: 0,
            advances: 500_000,
            personal_income_tax: 0,
            notes: Some("Đã chuyển khoản một phần".into()),
        }
    }

    /// Mọi ô chữ của trang tính.
    fn texts(sheet: &ReadSheet) -> Vec<String> {
        let mut v = Vec::new();
        for r in 0..sheet.rows.len() {
            for c in 0..sheet.row_width(r) {
                if let ReadCell::Text(t) = sheet.cell(r, c) {
                    v.push(t.clone());
                }
            }
        }
        v
    }

    fn message(e: AppError) -> String {
        let (_, b) = e.response(true);
        serde_json::to_string(&b.message).unwrap_or_default()
    }

    #[test]
    fn tien_dau_cham_nghin() {
        assert_eq!(format_vnd(0), "0");
        assert_eq!(format_vnd(999), "999");
        assert_eq!(format_vnd(1_000), "1.000");
        assert_eq!(format_vnd(1_234_567), "1.234.567");
        assert_eq!(format_vnd(-1_500), "-1.500");
    }

    #[test]
    fn ten_trang_tinh() {
        assert_eq!(sanitize_sheet_name(Some("A/B:C?[x]*\\"), "NV1"), "ABCx");
        assert_eq!(sanitize_sheet_name(Some("'Hồng Ánh'"), "NV1"), "Hồng Ánh");
        assert_eq!(sanitize_sheet_name(None, "NV7"), "NV7");
        assert_eq!(sanitize_sheet_name(Some("///"), "NV2"), "NV2");
        let long = "Đ".repeat(40);
        assert_eq!(sanitize_sheet_name(Some(&long), "NV1").chars().count(), 31);
    }

    #[test]
    fn body_excel_list_kiem_nhu_class_validator() {
        let ok: ListExcelInput = serde_json::from_value(json!({"month": "2026-03", "ordered_ids": [3, 1, 2]})).unwrap();
        assert!(ok.validate().is_ok());
        assert_eq!(ok.ids(), Some(vec![3, 1, 2]));
        let empty: ListExcelInput = serde_json::from_value(json!({"month": "2026-03", "ordered_ids": []})).unwrap();
        assert_eq!(empty.ids(), None);
        let none: ListExcelInput = serde_json::from_value(json!({"month": "2026-03", "ordered_ids": null})).unwrap();
        assert!(none.validate().is_ok() && none.ids().is_none());

        let bad: ListExcelInput = serde_json::from_value(json!({"month": "2026-13", "ordered_ids": [1, 2.5]})).unwrap();
        let msg = message(bad.validate().unwrap_err().into());
        assert!(msg.contains(MONTH_MSG) && msg.contains("each value in ordered_ids must be an integer number"));
        let big = json!({"month": "2026-03", "ordered_ids": [4_000_000_000_i64]});
        let huge: ListExcelInput = serde_json::from_value(big).unwrap();
        assert!(huge.validate().is_err(), "ngoài i32 không phải int4");
        let text = json!({"month": "2026-03", "ordered_ids": "x"});
        let not_array: ListExcelInput = serde_json::from_value(text).unwrap();
        assert!(message(not_array.validate().unwrap_err().into()).contains("ordered_ids must be an array"));
        let many: Vec<i32> = (1..=10_001).collect();
        let over: ListExcelInput = serde_json::from_value(json!({"month": "2026-03", "ordered_ids": many})).unwrap();
        assert!(message(over.validate().unwrap_err().into()).contains("no more than 10000"));
    }

    #[test]
    fn so_thap_phan_kieu_viet() {
        assert_eq!(parse_decimal("85,5"), 85.5);
        assert_eq!(parse_decimal("1.234,5"), 1234.5);
        assert_eq!(parse_decimal("1.5"), 1.5);
        assert_eq!(parse_decimal(" 2 1 "), 21.0);
        assert!(parse_decimal("12abc").is_nan());
        assert!(parse_decimal("").is_nan());
        assert_eq!(parse_int_js("24 ngày"), 24.0);
        assert_eq!(parse_int_js("-3"), -3.0);
        assert!(parse_int_js("abc").is_nan());
    }

    fn def(field: &str) -> &'static FieldDef {
        FIELDS.iter().find(|d| d.field == field).expect("trường có trong bảng")
    }

    #[test]
    fn doc_o_tien() {
        let m = def("advances");
        let text = |s: &str| Raw::Text(s.to_owned());
        assert_eq!(
            parse_field(m, &text("1,234,567")),
            Ok(Some(Parsed::Money("1234567".into())))
        );
        assert_eq!(
            parse_field(m, &Raw::Num(1500.5)),
            Ok(Some(Parsed::Money("1501".into())))
        );
        assert_eq!(parse_field(m, &Raw::Num(0.0)), Ok(Some(Parsed::Money("0".into()))));
        assert_eq!(parse_field(m, &text("-")), Ok(None));
        assert_eq!(parse_field(m, &text("N/A")), Ok(None));
        assert_eq!(parse_field(m, &text("—")), Ok(None));
        assert_eq!(
            parse_field(m, &text("abc")),
            Err("advances: giá trị \"abc\" không phải số hợp lệ (không âm)".to_owned())
        );
        assert!(parse_field(m, &Raw::Num(-1.0)).is_err());
        assert_eq!(
            parse_field(m, &Raw::Num(1e16)),
            Err("advances vượt giới hạn cho phép (tối đa 999,999,999,999,999)".to_owned())
        );
        // Số ≥ 1e21 (JS in "1e+21") cũng chỉ là lỗi của dòng.
        assert!(parse_field(m, &Raw::Num(1e21)).is_err());
    }

    #[test]
    fn doc_o_so_thuc_va_nguyen() {
        let text = |s: &str| Raw::Text(s.to_owned());
        assert_eq!(
            parse_field(def("working_days"), &text("21,5")),
            Ok(Some(Parsed::Float(21.5)))
        );
        assert_eq!(
            parse_field(def("kpi_percent"), &Raw::Num(1000.0)),
            Err("kpi_percent vượt giới hạn cho phép (tối đa 999.99)".to_owned())
        );
        assert_eq!(
            parse_field(def("bonus_rate"), &text("100.5")),
            Err("bonus_rate vượt giới hạn cho phép (tối đa 100)".to_owned())
        );
        assert_eq!(parse_field(def("training_days"), &text("-")), Ok(None));
        assert!(parse_field(def("training_days"), &Raw::Num(-0.5)).is_err());

        let std = def("standard_working_days");
        assert_eq!(parse_field(std, &text("24 ngày")), Ok(Some(Parsed::Int(24))));
        assert_eq!(parse_field(std, &Raw::Num(24.4)), Ok(Some(Parsed::Int(24))));
        assert_eq!(parse_field(std, &Raw::Num(32.0)), Ok(None));
        assert_eq!(parse_field(std, &Raw::Num(0.0)), Ok(None));
        assert_eq!(parse_field(std, &text("abc")), Ok(None));

        assert_eq!(
            parse_field(def("notes"), &text("ok")),
            Ok(Some(Parsed::Text("ok".into())))
        );
        assert_eq!(
            parse_field(def("notes"), &Raw::Num(0.0)),
            Ok(Some(Parsed::Text("0".into())))
        );
    }

    #[test]
    fn xlsx_mot_phieu_doc_lai_dung_dau() {
        let bytes = write_grid(&[payslip_sheet("PHIẾU LƯƠNG", &slip())]).unwrap();
        let sheet = read_first_sheet(&bytes).unwrap();
        let all = texts(&sheet);
        for want in [
            "THÔNG TIN LƯƠNG THÁNG 03/2026",
            "I/ THÔNG TIN CƠ BẢN",
            "II/ DOANH SỐ/THƯỞNG",
            "III/ TỔNG LƯƠNG & GIẢM TRỪ",
            "IV/ TỔNG THỰC NHẬN",
            "Nguyễn Thị Hồng Ánh",
            "Ngân hàng Á Châu",
        ] {
            assert!(all.iter().any(|t| t == want), "thiếu ô «{want}»");
        }
        assert!(all.iter().any(|t| t.starts_with("Lưu ý:")));
        // Lương cơ bản: nhãn ở cột B, số ở cột C.
        let row = (0..sheet.rows.len())
            .find(|r| *sheet.cell(*r, 1) == ReadCell::Text("Lương cơ bản".into()))
            .expect("dòng Lương cơ bản");
        assert_eq!(*sheet.cell(row, 2), ReadCell::Number(12_000_000.0));
        // Mục BHXH chỉ hiện khi có lương đóng BHXH.
        assert!(all.iter().any(|t| t == "Lương đóng BHXH"));
        let mut no_ins = slip();
        no_ins.insurance_base = 0;
        let sheet2 = read_first_sheet(&write_grid(&[payslip_sheet("x", &no_ins)]).unwrap()).unwrap();
        assert!(!texts(&sheet2).iter().any(|t| t == "Lương đóng BHXH"));
    }

    #[test]
    fn pdf_mot_phieu_co_dau_tieng_viet() {
        let pdf = layout_payslip(&slip()).unwrap();
        let drawn = pdf.texts().to_vec();
        assert_eq!(pdf.page_count(), 1);
        for want in [
            "THÔNG TIN LƯƠNG THÁNG 03/2026",
            "Kính gửi: Quý Anh/Chị",
            "Nguyễn Thị Hồng Ánh",
            "Chuyên viên kinh doanh",
            "12.000.000",
            "12.150.000",
            "21.5",
            "2.5%",
            "—",
            "Số tài khoản",
        ] {
            assert!(drawn.iter().any(|t| t == want), "thiếu chuỗi «{want}»: {drawn:?}");
        }
        // % KPI vắng ⇒ gạch ngang như xlsx.
        assert!(drawn.iter().any(|t| t == "% KPI"));
        let bytes = pdf.finish();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.ends_with(b"%%EOF\n") || bytes.ends_with(b"%%EOF"));
        // Phiếu thường nằm gọn một trang A4.
        assert_eq!(layout_payslip(&slip()).unwrap().page_count(), 1);
        assert!(build_payslip_pdf(&slip()).unwrap().len() > 1000);
    }

    #[test]
    fn xlsx_danh_sach_co_dong_tong_cong() {
        let mk = |code: &str, name: &str, total: i64| {
            let mut d = slip();
            d.full_name = name.into();
            d.total = total;
            ListRow {
                code: code.into(),
                department: "Kinh doanh".into(),
                data: d,
            }
        };
        let rows = [mk("NV0001", "An", 5_000_000), mk("NV0002", "Bình", 7_000_000)];
        let sheet = read_first_sheet(&write_grid(&[list_sheet(&rows, "2026-03")]).unwrap()).unwrap();
        let all = texts(&sheet);
        assert!(all.iter().any(|t| t == "DANH SÁCH LƯƠNG THÁNG 03/2026"));
        assert!(all.iter().any(|t| t == "THÔNG TIN THANH TOÁN"));
        let total_row = (0..sheet.rows.len())
            .find(|r| *sheet.cell(*r, 0) == ReadCell::Text("TỔNG CỘNG".into()))
            .expect("dòng TỔNG CỘNG");
        let at = list_columns().iter().position(|c| c.header == "Thực nhận").unwrap();
        assert_eq!(*sheet.cell(total_row, at), ReadCell::Number(12_000_000.0));
        assert_eq!(*sheet.cell(3, 1), ReadCell::Text("NV0001".into()));
        assert_eq!(*sheet.cell(4, 2), ReadCell::Text("Bình".into()));
    }

    #[test]
    fn mau_nhap_doc_nguoc_lai_dung() {
        let emps = [
            TemplateEmp {
                code: "NV0001".into(),
                name: "Lê Thị Mỹ Hạnh".into(),
                current: Some(manual()),
            },
            TemplateEmp {
                code: "NV0002".into(),
                name: "Phạm Văn Cường".into(),
                current: None,
            },
        ];
        let bytes = write_grid(&[template_sheet(&emps, "2026-03")]).unwrap();
        let sheet = read_first_sheet(&bytes).unwrap();
        assert!(
            texts(&sheet)
                .iter()
                .any(|t| t == "MẪU NHẬP PHIẾU LƯƠNG — THÁNG 03/2026")
        );
        let rows = parse_rows(&sheet);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].code, "NV0001");
        assert_eq!(rows[0].name.as_deref(), Some("Lê Thị Mỹ Hạnh"));
        assert!(rows[0].errors.is_empty());
        let get = |f: &str| rows[0].fields.iter().find(|(n, _)| *n == f).map(|(_, v)| v.clone());
        assert_eq!(get("working_days"), Some(Parsed::Float(21.5)));
        assert_eq!(get("standard_working_days"), Some(Parsed::Int(24)));
        assert_eq!(get("base_salary"), Some(Parsed::Money("10000000".into())));
        assert_eq!(get("kpi_percent"), Some(Parsed::Float(98.5)));
        assert_eq!(get("notes"), Some(Parsed::Text("Đã chuyển khoản một phần".into())));
        assert_eq!(get("training_days"), None, "ô trống không thành giá trị");
        // Điền lại đúng giá trị đang lưu thì không có thay đổi nào.
        let m = manual();
        for (f, v) in &rows[0].fields {
            assert_eq!(current_text(&m, f), v.text(), "trường {f}");
        }
        assert!(
            rows[1].fields.is_empty(),
            "nhân viên chưa có phiếu: mẫu để trống các ô nhập"
        );
    }

    #[test]
    fn doc_tep_nhap_bo_dong_thieu_ma_va_gom_loi() {
        let mut g = GridSheet::new("Nhập");
        let st = text_style();
        g.text(0, 0, "Tiêu đề bất kỳ", st.clone());
        for (c, h) in ["Mã nhân viên", "Họ tên", "Đã ứng", "Ghi chú", "Thuế TNCN", "Cột lạ"]
            .iter()
            .enumerate()
        {
            g.text(1, c as u16, *h, st.clone());
        }
        g.text(2, 0, "  NV0001  ", st.clone());
        g.text(2, 1, "An", st.clone());
        g.text(2, 2, "1,500", st.clone());
        g.text(2, 3, "ok", st.clone());
        g.text(2, 4, "x", st.clone());
        g.text(2, 5, "bỏ qua", st.clone());
        g.text(3, 1, "Không mã", st.clone());
        g.number(4, 0, 12.0, st.clone());
        g.number(4, 2, 0.0, st.clone());
        g.number(5, 0, 0.0, st);
        let rows = parse_rows(&read_first_sheet(&write_grid(&[g]).unwrap()).unwrap());
        assert_eq!(rows.len(), 2, "dòng không mã và mã 0 bị bỏ");
        assert_eq!(rows[0].code, "NV0001");
        assert_eq!(
            rows[0].fields,
            vec![
                ("advances", Parsed::Money("1500".into())),
                ("notes", Parsed::Text("ok".into()))
            ]
        );
        assert_eq!(
            rows[0].errors,
            vec!["personal_income_tax: giá trị \"x\" không phải số hợp lệ (không âm)".to_owned()]
        );
        assert_eq!(rows[1].code, "12");
        assert_eq!(rows[1].fields, vec![("advances", Parsed::Money("0".into()))]);

        // Không có cột mã ⇒ rỗng; tên cột cũ không nhận.
        let mut h = GridSheet::new("x");
        h.text(0, 0, "Họ tên", text_style());
        h.text(0, 1, "Các khoản lĩnh trước", text_style());
        h.text(1, 0, "An", text_style());
        assert!(parse_rows(&read_first_sheet(&write_grid(&[h]).unwrap()).unwrap()).is_empty());
        assert!(parse_import_file(b"khong phai xlsx").is_err());
    }

    #[test]
    fn gop_o_nhap_vao_phieu_nhu_sua_tay() {
        let fields = vec![
            ("working_days", Parsed::Float(20.0)),
            ("standard_working_days", Parsed::Int(26)),
            ("advances", Parsed::Money("300000".into())),
            ("notes", Parsed::Text("ghi chú".into())),
        ];
        let u = to_update(&fields);
        let merged = manual().merged(&u);
        assert_eq!(merged.working_days, Some(20.0));
        assert_eq!(merged.standard_working_days, 26);
        assert_eq!(merged.advances, 300_000);
        assert_eq!(merged.notes.as_deref(), Some("ghi chú"));
        // Trường không có trong tệp giữ nguyên.
        assert_eq!(merged.base_salary, 10_000_000);
        assert_eq!(merged.kpi_percent, Some(98.5));
        assert!(u.validate().is_ok());
    }

    #[test]
    fn tinh_chat_so_sanh_giu_chuoi_nhu_ts() {
        let m = manual();
        assert_eq!(current_text(&m, "working_days"), "21.5");
        assert_eq!(current_text(&m, "training_days"), "");
        assert_eq!(current_text(&m, "base_salary"), "10000000");
        assert_eq!(current_text(&m, "kpi_percent"), "98.5");
        assert_eq!(current_text(&m, "standard_working_days"), "24");
        assert_eq!(Parsed::Float(21.0).text(), "21");
        assert_eq!(Parsed::Int(24).text(), "24");
    }
}
