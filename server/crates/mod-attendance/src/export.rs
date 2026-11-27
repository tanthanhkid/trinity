//! Xuất xlsx chấm công (M14b): 8 endpoint `GET /api/v1/management/attendance/*export*`, thay năm service của `services/crm/src/attendance`
//! (`attendance-export`, `attendance-matrix-export`, `attendance-absent-export`, `attendance-stats-export`). Ghi tệp bằng
//! `trinity_docgen::xlsx` (K29); nội dung ô, thứ tự cột, độ rộng, tên trang giống bản TS.
//!
//! | Route | Hàm | Quyền (phạm vi) |
//! |---|---|---|
//! | `GET /export` | [`records_xlsx`] | `attendance.export` |
//! | `GET /workdays-matrix/export` | [`matrix_xlsx`] | `attendance.export` |
//! | `GET /absent-export` | [`absent_xlsx`] | `attendance.export` (phạm vi dữ liệu `attendance.view`) |
//! | `GET /stats/export-by-team`, `/export-by-department` | [`by_team_xlsx`], [`by_department_xlsx`] | như trên, hai trang |
//! | `GET /stats/export-top-absent`, `/export-top-late-early`, `/export-by-gender` | [`top_absent_xlsx`], [`top_late_early_xlsx`], [`by_gender_xlsx`] | như trên |
//!
//! Khác biệt có chủ ý so với tệp Node (bộ ghi chung chưa hỗ trợ): không tô nền ô, không căn phải số, không cố định 5 cột trái
//! của bảng công; có một dòng trống giữa dòng phụ và tiêu đề cột (quy ước K29, như xuất nhân viên ở M10).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{Datelike, Days, NaiveDate, Utc};
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use trinity_docgen::xlsx::{Cell, Column, NumFormat, SheetSpec, js_number_string, write_xlsx};
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::vn_date;

use crate::R;
use crate::dto::QueryAttendanceExportDto;
use crate::records::{self, AbsentList, EXPORT_LIMIT, ExportData, Matrix};
use crate::requests::parse_work_date;
use crate::stats::{self, DisciplineOut, EmployeeSummary, OverviewExport, QueryAttendanceStatsDto};

const COL_MIN_WIDTH: usize = 10;
const STATS_COL_MIN_WIDTH: usize = 8;
const COL_MAX_WIDTH: usize = 50;

fn write(sheets: &[SheetSpec]) -> R<Vec<u8>> {
    write_xlsx(sheets).map_err(AppError::internal)
}

// ───────────────────────────── ô và độ rộng ─────────────────────────────

/// Số không định dạng (Excel "General") như `cell.value = number` của exceljs.
fn num(n: f64) -> Cell {
    Cell::Number(n, NumFormat::General)
}

fn int(n: impl Into<i64>) -> Cell {
    num(n.into() as f64)
}

fn stt(i: usize) -> Cell {
    int(i64::try_from(i + 1).unwrap_or(0))
}

fn txt(v: Option<&str>) -> Cell {
    Cell::text(v.unwrap_or_default())
}

/// `String(v).length` (đơn vị UTF-16) của một ô.
fn cell_len(c: &Cell) -> usize {
    match c {
        Cell::Text(t) => t.encode_utf16().count(),
        Cell::Number(n, _) => js_number_string(*n).len(),
        _ => 0,
    }
}

/// Độ rộng tự khớp: dài nhất (tiêu đề cột, dữ liệu) + 2, kẹp trong `[min, COL_MAX_WIDTH]`.
fn autofit(headers: &[&str], rows: &[Vec<Cell>], min: usize) -> Vec<Column> {
    headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let longest = rows
                .iter()
                .map(|r| r.get(i).map_or(0, cell_len))
                .max()
                .unwrap_or(0)
                .max(h.encode_utf16().count());
            Column::new(*h, (longest + 2).clamp(min, COL_MAX_WIDTH) as f64)
        })
        .collect()
}

fn table(
    name: &str,
    title: &str,
    subtitle: String,
    headers: &[&str],
    rows: Vec<Vec<Cell>>,
    min_width: usize,
) -> SheetSpec {
    SheetSpec {
        name: name.to_owned(),
        title: Some(title.to_owned()),
        subtitle: Some(subtitle),
        columns: autofit(headers, &rows, min_width),
        rows,
    }
}

/// `YYYY-MM-DD` → `DD/MM/YYYY` bằng cách tách chuỗi (`displayVnDate`, không parse ngày); thiếu phần thì giữ nguyên.
fn display_vn_date(s: &str) -> String {
    let mut p = s.split('-');
    match (p.next(), p.next(), p.next()) {
        (Some(y), Some(m), Some(d)) if !y.is_empty() && !m.is_empty() && !d.is_empty() => format!("{d}/{m}/{y}"),
        _ => s.to_owned(),
    }
}

/// `formatWorkDate(parseDateToUtcMidnight(s))`: ngày tràn tháng như `Date.UTC`.
fn work_date_label(s: &str) -> String {
    parse_work_date(s).map_or_else(|| s.to_owned(), |d| d.format("%d/%m/%Y").to_string())
}

/// `Number.prototype.toFixed(1)` của JS: số nằm đúng giữa hai mức (`x.25`, `x.75`) làm tròn lên, Rust mặc định làm tròn chẵn.
fn to_fixed1(x: f64) -> String {
    let q = x * 4.0;
    if x >= 0.0 && q.fract() == 0.0 && (q as i64) % 2 != 0 {
        format!("{:.1}", x + 0.05)
    } else {
        format!("{x:.1}")
    }
}

// ───────────────────────────── sổ chấm công theo khoảng ngày ─────────────────────────────

/// Nhãn trạng thái (khớp `STATUS_LABEL` của màn hình chi tiết).
fn status_label(s: &str) -> &str {
    match s {
        "present" | "late" => "Đủ công",
        "half_day" => "Nửa ngày",
        "insufficient" => "Chưa đủ nửa ngày",
        "incomplete" => "Chưa đủ vào/ra",
        "absent" => "Vắng",
        "leave" => "Nghỉ phép",
        "maternity" => "Thai sản",
        "review" => "Xem xét",
        other => other,
    }
}

const RECORD_HEADERS: [&str; 13] = [
    "Họ tên",
    "Team",
    "Phòng ban",
    "Email",
    "Chức danh",
    "Ngày",
    "Giờ vào",
    "Giờ ra",
    "Tổng giờ",
    "Đi muộn (phút)",
    "Trạng thái",
    "Ghi chú vào",
    "Ghi chú ra",
];

/// `rangeLabel`: khoảng ngày (cả hai đầu mới hiện) + tổng bản ghi + cảnh báo khi bị cắt.
fn range_label(q: &QueryAttendanceExportDto, count: usize, truncated: bool) -> String {
    let from = q.date_from.as_deref().map(work_date_label);
    let to = q.date_to.as_deref().map(work_date_label);
    let range = match (from, to) {
        (Some(f), Some(t)) if f == t => f,
        (Some(f), Some(t)) => format!("{f} - {t}"),
        _ => "Tất cả".to_owned(),
    };
    let limit = EXPORT_LIMIT.to_string();
    let limit = format!("{}.{}", &limit[..limit.len() - 3], &limit[limit.len() - 3..]);
    let warn = if truncated {
        format!(
            " · ⚠ vượt {limit} bản ghi, file chỉ chứa {limit} bản ghi MỚI NHẤT — thu hẹp khoảng thời gian để xem đầy đủ"
        )
    } else {
        String::new()
    };
    format!("Khoảng thời gian: {range} · Tổng {count} bản ghi{warn}")
}

fn records_sheet(data: &ExportData, q: &QueryAttendanceExportDto) -> SheetSpec {
    let rows: Vec<Vec<Cell>> = data
        .rows
        .iter()
        .map(|r| {
            vec![
                Cell::text(&r.full_name),
                txt(r.team_name.as_deref()),
                txt(r.department.as_deref()),
                Cell::text(&r.email),
                txt(r.position.as_deref()),
                Cell::text(r.work_date.format("%d/%m/%Y").to_string()),
                txt(r.check_in.as_deref()),
                txt(r.check_out.as_deref()),
                r.total_hours.map_or_else(|| Cell::text(""), num),
                int(r.late_minutes),
                Cell::text(status_label(&r.status)),
                Cell::text(&r.in_note),
                Cell::text(&r.out_note),
            ]
        })
        .collect();
    table(
        "Chấm công",
        "BÁO CÁO CHẤM CÔNG",
        range_label(q, rows.len(), data.truncated),
        &RECORD_HEADERS,
        rows,
        COL_MIN_WIDTH,
    )
}

/// `GET /export`: xlsx chấm công theo khoảng ngày (`attendance.export`).
pub async fn records_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceExportDto) -> R<Vec<u8>> {
    let data = records::export_records(ctx, actor, &q.to_query()).await?;
    tracing::info!(
        "Exporting {} attendance records (from={} to={})",
        data.rows.len(),
        q.date_from.as_deref().unwrap_or("-"),
        q.date_to.as_deref().unwrap_or("-")
    );
    write(&[records_sheet(&data, q)])
}

/// Tên file `cham-cong-<ngày UTC>.xlsx`.
pub fn records_filename() -> String {
    format!("cham-cong-{}.xlsx", Utc::now().format("%Y-%m-%d"))
}

// ───────────────────────────── bảng chấm công tháng ─────────────────────────────

const MATRIX_FIXED: usize = 5;
const MATRIX_DAY_WIDTH: f64 = 5.0;
const DOW_VN: [&str; 7] = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const SUMMARY_HEADERS: [&str; 13] = [
    "Tổng công",
    "Công sau duyệt",
    "Tổng giờ",
    "Đủ công",
    "Chưa đủ",
    "Nghỉ phép",
    "Thai sản",
    "Đi muộn",
    "Lần về sớm",
    "Phút về sớm",
    "Đơn duyệt",
    "Đơn từ chối",
    "Ghi chú",
];
const SUMMARY_WIDTHS: [f64; 13] = [10.0, 13.0, 10.0, 8.0, 8.0, 10.0, 10.0, 9.0, 10.0, 11.0, 9.0, 10.0, 30.0];

/// `formatHm`: giờ → `H:MM` (`8.5` → `8:30`); phút làm tròn như `Math.round`.
fn format_hm(hours: Option<f64>) -> String {
    let Some(h) = hours else { return String::new() };
    let whole = h.floor();
    let m = ((h - whole) * 60.0 + 0.5).floor() as i64;
    format!("{}:{m:02}", whole as i64)
}

/// `cellDisplayText`: chữ trong ô ngày của bảng công.
fn day_text(status: &str, hours: Option<f64>) -> String {
    match status {
        "present" | "leave" | "maternity" => "8:00".to_owned(),
        "half_day" | "insufficient" | "review" => format_hm(hours),
        "incomplete" => "???".to_owned(),
        _ => "·".to_owned(),
    }
}

/// `formatDateStr`: `YYYY-MM-DD` → `DD/MM/YYYY` bằng tách chuỗi; trống ⇒ rỗng.
fn date_str(s: Option<&str>) -> String {
    match s.filter(|s| !s.is_empty()) {
        None => String::new(),
        Some(s) => {
            let mut p = s.split('-');
            let (y, m, d) = (p.next().unwrap_or(""), p.next().unwrap_or(""), p.next().unwrap_or(""));
            format!("{d}/{m}/{y}")
        }
    }
}

/// Năm/tháng của tiêu đề thứ trong tuần: từ `date_from`, mặc định tháng hiện tại giờ VN.
fn matrix_month(date_from: Option<&str>) -> (i32, u32) {
    if let Some(f) = date_from.filter(|s| !s.is_empty()) {
        let mut p = f.split('-').map(|x| x.parse::<i32>().ok());
        if let (Some(Some(y)), Some(Some(m))) = (p.next(), p.next()) {
            return (y, u32::try_from(m).unwrap_or(1));
        }
    }
    let today = vn_date(Utc::now());
    (today.year(), today.month())
}

/// Thứ trong tuần của ngày `d` (ngày vượt số ngày trong tháng tràn sang tháng sau như `Date.UTC`).
fn weekday_label(year: i32, month: u32, d: u32) -> &'static str {
    NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|first| first.checked_add_days(Days::new(u64::from(d.saturating_sub(1)))))
        .map_or(DOW_VN[0], |date| DOW_VN[date.weekday().num_days_from_sunday() as usize])
}

fn matrix_sheet(m: &Matrix, q: &QueryAttendanceExportDto) -> SheetSpec {
    let days = m.days_in_month;
    let (year, month) = matrix_month(q.date_from.as_deref());

    let from = date_str(q.date_from.as_deref());
    let to = date_str(q.date_to.as_deref());
    let range = if !from.is_empty() && !to.is_empty() {
        format!("{from} – {to}")
    } else if !from.is_empty() {
        from
    } else if !to.is_empty() {
        to
    } else {
        "Tất cả".to_owned()
    };

    let mut name_len = "Họ tên".encode_utf16().count();
    let mut rows: Vec<Vec<Cell>> = Vec::with_capacity(m.rows.len());
    for (idx, r) in m.rows.iter().enumerate() {
        let name = r.full_name.clone().unwrap_or_default();
        name_len = name_len.max(name.encode_utf16().count());
        let mut row = vec![
            stt(idx),
            Cell::text(r.employee_code.clone().unwrap_or_else(|| format!("NV{:04}", r.user_id))),
            Cell::text(name),
            txt(r.team_name.as_deref()),
            txt(r.position.as_deref()),
        ];
        for d in 1..=days {
            let text = r
                .cells
                .get(&d)
                .map_or_else(|| "·".to_owned(), |c| day_text(&c.status, c.hours.map(|h| h.0)));
            row.push(Cell::text(text));
        }
        row.push(Cell::text(js_number_string(r.total_work_days.0)));
        row.push(Cell::text(js_number_string(r.total_work_days_after_approval.0)));
        row.push(Cell::text(to_fixed1(r.total_hours.0)));
        row.push(int(r.present_days));
        row.push(int(r.half_days + r.insufficient_days));
        row.push(int(r.leave_days));
        row.push(int(r.maternity_days));
        row.push(int(r.late_days));
        row.push(int(r.early_leave_count));
        row.push(int(r.early_leave_minutes));
        row.push(int(r.early_leave_approved));
        row.push(int(r.early_leave_rejected));
        row.push(Cell::text(&r.notes));
        rows.push(row);
    }

    let mut columns: Vec<Column> = Vec::with_capacity(MATRIX_FIXED + days as usize + SUMMARY_HEADERS.len());
    columns.push(Column::new("STT", 6.0));
    columns.push(Column::new("Mã NV", 10.0));
    columns.push(Column::new("Họ tên", (name_len + 2).clamp(8, 40) as f64));
    columns.push(Column::new("Team", 14.0));
    columns.push(Column::new("Chức danh", 16.0));
    for d in 1..=days {
        columns.push(Column::new(
            format!("{d}\n{}", weekday_label(year, month, d)),
            MATRIX_DAY_WIDTH,
        ));
    }
    for (h, w) in SUMMARY_HEADERS.iter().zip(SUMMARY_WIDTHS) {
        columns.push(Column::new(*h, w));
    }
    SheetSpec {
        name: "Bảng công".to_owned(),
        title: Some("BẢNG CHẤM CÔNG THÁNG".to_owned()),
        subtitle: Some(format!("Khoảng thời gian: {range} · Tổng {} nhân viên", m.count)),
        columns,
        rows,
    }
}

/// `GET /workdays-matrix/export`: lưới nhân viên × ngày (`attendance.export`).
pub async fn matrix_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceExportDto) -> R<Vec<u8>> {
    let m = records::matrix_with(ctx, actor, &q.to_query(), "attendance.export").await?;
    tracing::info!(
        "Exporting matrix {} NV x {} ngay (from={} to={})",
        m.count,
        m.days_in_month,
        q.date_from.as_deref().unwrap_or("-"),
        q.date_to.as_deref().unwrap_or("-")
    );
    write(&[matrix_sheet(&m, q)])
}

/// Tên file `bang-cong-<ngày UTC>.xlsx`.
pub fn matrix_filename() -> String {
    format!("bang-cong-{}.xlsx", Utc::now().format("%Y-%m-%d"))
}

// ───────────────────────────── nhân viên vắng trong ngày ─────────────────────────────

const ABSENT_HEADERS: [&str; 10] = [
    "STT",
    "Mã NV",
    "Họ tên",
    "SĐT",
    "Email",
    "Team",
    "Chức danh",
    "Bộ phận",
    "Giới tính",
    "Văn phòng",
];

fn gender_label(g: Option<&str>) -> &'static str {
    match g {
        Some("M") => "Nam",
        Some("F") => "Nữ",
        _ => "",
    }
}

fn absent_sheet(list: &AbsentList) -> SheetSpec {
    let rows: Vec<Vec<Cell>> = list
        .absent_employees
        .iter()
        .enumerate()
        .map(|(i, r)| {
            vec![
                stt(i),
                txt(r.employee_code.as_deref()),
                txt(r.full_name.as_deref()),
                txt(r.phone.as_deref()),
                txt(r.email.as_deref()),
                txt(r.team_name.as_deref()),
                txt(r.position.as_deref()),
                txt(r.department.as_deref()),
                Cell::text(gender_label(r.gender.as_deref())),
                txt(r.office_name.as_deref()),
            ]
        })
        .collect();
    table(
        "NV chưa chấm công",
        "DANH SÁCH NHÂN VIÊN CHƯA CHẤM CÔNG",
        format!(
            "Ngày: {} · Tổng {} nhân viên vắng",
            display_vn_date(&list.absent_date),
            rows.len()
        ),
        &ABSENT_HEADERS,
        rows,
        STATS_COL_MIN_WIDTH,
    )
}

/// `GET /absent-export`: xlsx và ngày đã chọn (để đặt tên file `nv-chua-cham-cong_<ngày>.xlsx`).
pub async fn absent_xlsx(
    ctx: &Ctx,
    actor: &Actor,
    date: Option<&str>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> R<(Vec<u8>, String)> {
    let list = records::absent(ctx, actor, date, sort_by, sort_dir).await?;
    tracing::info!(
        "Exporting {} absent employees for {}",
        list.absent_employees.len(),
        list.absent_date
    );
    let bytes = write(&[absent_sheet(&list)])?;
    Ok((bytes, list.absent_date))
}

// ───────────────────────────── thống kê theo team / phòng ban ─────────────────────────────

const TEAM_HEADERS: [&str; 10] = [
    "STT",
    "Team",
    "Tổng NV",
    "Đã chấm công",
    "Có mặt",
    "Đi muộn",
    "Chưa đủ công",
    "Vắng",
    "Tỷ lệ chấm công (%)",
    "Tổng phút muộn",
];

const DEPT_HEADERS: [&str; 11] = [
    "STT",
    "Phòng ban",
    "Trưởng phòng",
    "Tổng NV",
    "Đã chấm công",
    "Có mặt",
    "Đi muộn",
    "Chưa đủ công",
    "Vắng",
    "Tỷ lệ chấm công (%)",
    "Tổng phút muộn",
];

const EMP_HEADERS: [&str; 12] = [
    "STT",
    "Mã NV",
    "Họ tên",
    "Phòng ban",
    "Team",
    "Văn phòng",
    "Ngày đã chấm",
    "Ngày đủ công",
    "Ngày thiếu công",
    "Ngày đi muộn",
    "Tổng phút muộn",
    "Ngày nghỉ phép",
];

fn counts_cells(c: &stats::Counts) -> Vec<Cell> {
    vec![
        int(c.headcount),
        int(c.checked_in_people),
        int(c.present_people),
        int(c.late_people),
        int(c.insufficient_people),
        int(c.absent_people),
        num(c.attendance_rate),
        int(c.total_late_minutes),
    ]
}

fn employee_rows(list: &[EmployeeSummary]) -> Vec<Vec<Cell>> {
    list.iter()
        .enumerate()
        .map(|(i, r)| {
            vec![
                stt(i),
                txt(r.employee_code.as_deref()),
                txt(r.full_name.as_deref()),
                txt(r.department.as_deref()),
                txt(r.team_name.as_deref()),
                txt(r.office_name.as_deref()),
                int(r.checked_in_days),
                int(r.full_days),
                int(r.insufficient_days),
                int(r.late_days),
                int(r.total_late_minutes),
                int(r.leave_days),
            ]
        })
        .collect()
}

fn range_subtitle(from: &str, to: &str, count: usize, unit: &str) -> String {
    format!(
        "Từ {} đến {} · {count} {unit}",
        display_vn_date(from),
        display_vn_date(to)
    )
}

fn employee_sheet(o: &OverviewExport) -> SheetSpec {
    table(
        "Chi tiết nhân viên",
        "CHI TIẾT NHÂN VIÊN THEO BỘ LỌC",
        range_subtitle(&o.from_str, &o.to_str, o.employees.len(), "nhân viên"),
        &EMP_HEADERS,
        employee_rows(&o.employees),
        STATS_COL_MIN_WIDTH,
    )
}

fn team_sheets(o: &OverviewExport) -> Vec<SheetSpec> {
    let rows: Vec<Vec<Cell>> = o
        .teams
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let mut row = vec![stt(i), Cell::text(&r.team_name)];
            row.extend(counts_cells(&r.counts));
            row
        })
        .collect();
    let overview = table(
        "Tổng quan theo Team",
        "THỐNG KÊ CHẤM CÔNG THEO TEAM",
        range_subtitle(&o.from_str, &o.to_str, rows.len(), "Team"),
        &TEAM_HEADERS,
        rows,
        STATS_COL_MIN_WIDTH,
    );
    vec![overview, employee_sheet(o)]
}

fn department_sheets(o: &OverviewExport) -> Vec<SheetSpec> {
    let rows: Vec<Vec<Cell>> = o
        .departments
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let mut row = vec![stt(i), Cell::text(&r.department), txt(r.head_name.as_deref())];
            row.extend(counts_cells(&r.counts));
            row
        })
        .collect();
    let overview = table(
        "Tổng quan phòng ban",
        "THỐNG KÊ CHẤM CÔNG THEO PHÒNG BAN",
        range_subtitle(&o.from_str, &o.to_str, rows.len(), "phòng ban"),
        &DEPT_HEADERS,
        rows,
        STATS_COL_MIN_WIDTH,
    );
    vec![overview, employee_sheet(o)]
}

/// `GET /stats/export-by-team`: hai trang "Tổng quan theo Team" và "Chi tiết nhân viên".
pub async fn by_team_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<Vec<u8>> {
    let o = stats::export_overview(ctx, actor, q, false).await?;
    tracing::info!(
        "Exporting {} team rows + {} employees (2 sheets)",
        o.teams.len(),
        o.employees.len()
    );
    write(&team_sheets(&o))
}

/// `GET /stats/export-by-department`: hai trang "Tổng quan phòng ban" và "Chi tiết nhân viên".
pub async fn by_department_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<Vec<u8>> {
    let o = stats::export_overview(ctx, actor, q, true).await?;
    tracing::info!(
        "Exporting {} department rows + {} employees (2 sheets)",
        o.departments.len(),
        o.employees.len()
    );
    write(&department_sheets(&o))
}

// ───────────────────────────── kỷ luật: top nghỉ, top muộn/sớm, giới tính ─────────────────────────────

const TOP_ABSENT_HEADERS: [&str; 8] = [
    "STT",
    "Mã NV",
    "Họ tên",
    "Team",
    "Chức vụ",
    "Tổng ngày nghỉ",
    "Tổng số lần nghỉ",
    "Tỷ lệ nghỉ (%)",
];

const TOP_LATE_EARLY_HEADERS: [&str; 10] = [
    "STT",
    "Mã NV",
    "Họ tên",
    "Team",
    "Chức vụ",
    "Phút đi muộn",
    "Phút về sớm",
    "Phút vi phạm",
    "Số lần đi muộn",
    "Số lần về sớm",
];

const GENDER_HEADERS: [&str; 7] = [
    "Giới tính",
    "Tổng nhân sự",
    "Tổng ngày nghỉ",
    "Tổng lần đi muộn",
    "Tổng lần về sớm",
    "Tỷ lệ đủ công (%)",
    "Tỷ lệ thiếu công (%)",
];

fn discipline_subtitle(d: &DisciplineOut, count: String) -> String {
    format!(
        "Từ {} đến {} · {} ngày làm việc · {count}",
        display_vn_date(&d.date_from),
        display_vn_date(&d.date_to),
        d.total_workdays
    )
}

fn top_absent_sheet(d: &DisciplineOut) -> SheetSpec {
    let rows: Vec<Vec<Cell>> = d
        .top_absent
        .iter()
        .enumerate()
        .map(|(i, r)| {
            vec![
                stt(i),
                txt(r.employee_code.as_deref()),
                txt(r.full_name.as_deref()),
                Cell::text(&r.team_name),
                txt(r.position.as_deref()),
                int(r.absent_days),
                int(r.absent_occurrences),
                num(r.absent_rate),
            ]
        })
        .collect();
    table(
        "Top nghỉ nhiều",
        "TOP NHÂN VIÊN NGHỈ NHIỀU NHẤT",
        discipline_subtitle(d, format!("{} nhân viên", rows.len())),
        &TOP_ABSENT_HEADERS,
        rows,
        STATS_COL_MIN_WIDTH,
    )
}

fn top_late_early_sheet(d: &DisciplineOut) -> SheetSpec {
    let rows: Vec<Vec<Cell>> = d
        .top_violation
        .iter()
        .enumerate()
        .map(|(i, r)| {
            vec![
                stt(i),
                txt(r.employee_code.as_deref()),
                txt(r.full_name.as_deref()),
                Cell::text(&r.team_name),
                txt(r.position.as_deref()),
                int(r.late_minutes),
                int(r.early_minutes),
                int(r.violation_minutes),
                int(r.late_count),
                int(r.early_count),
            ]
        })
        .collect();
    table(
        "Top đi muộn-về sớm",
        "TOP NHÂN VIÊN ĐI MUỘN / VỀ SỚM NHIỀU NHẤT",
        discipline_subtitle(d, format!("{} nhân viên", rows.len())),
        &TOP_LATE_EARLY_HEADERS,
        rows,
        STATS_COL_MIN_WIDTH,
    )
}

fn gender_sheet(d: &DisciplineOut) -> SheetSpec {
    let rows: Vec<Vec<Cell>> = d
        .by_gender
        .iter()
        .map(|r| {
            vec![
                Cell::text(r.gender_label),
                int(r.headcount),
                int(r.total_absent_days),
                int(r.total_late_count),
                int(r.total_early_count),
                num(r.full_attendance_rate),
                num(r.insufficient_rate),
            ]
        })
        .collect();
    table(
        "Theo giới tính",
        "SO SÁNH CHẤM CÔNG THEO GIỚI TÍNH",
        discipline_subtitle(d, format!("{} nhóm", rows.len())),
        &GENDER_HEADERS,
        rows,
        STATS_COL_MIN_WIDTH,
    )
}

/// `GET /stats/export-top-absent`.
pub async fn top_absent_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<Vec<u8>> {
    let d = stats::discipline(ctx, actor, q).await?;
    write(&[top_absent_sheet(&d)])
}

/// `GET /stats/export-top-late-early`.
pub async fn top_late_early_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<Vec<u8>> {
    let d = stats::discipline(ctx, actor, q).await?;
    write(&[top_late_early_sheet(&d)])
}

/// `GET /stats/export-by-gender`.
pub async fn by_gender_xlsx(ctx: &Ctx, actor: &Actor, q: &QueryAttendanceStatsDto) -> R<Vec<u8>> {
    let d = stats::discipline(ctx, actor, q).await?;
    write(&[gender_sheet(&d)])
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::records::ExportRow;
    use trinity_docgen::xlsx::{ReadCell, read_first_sheet};

    #[test]
    fn to_fixed_lam_tron_nhu_js() {
        assert_eq!(to_fixed1(8.25), "8.3");
        assert_eq!(to_fixed1(7.75), "7.8");
        assert_eq!(to_fixed1(0.15), "0.1");
        assert_eq!(to_fixed1(7.5), "7.5");
        assert_eq!(to_fixed1(0.0), "0.0");
        assert_eq!(to_fixed1(8.04), "8.0");
    }

    #[test]
    fn gio_dang_h_mm() {
        assert_eq!(format_hm(Some(8.5)), "8:30");
        assert_eq!(format_hm(Some(4.0)), "4:00");
        assert_eq!(format_hm(Some(7.05)), "7:03");
        assert_eq!(format_hm(None), "");
        assert_eq!(day_text("present", None), "8:00");
        assert_eq!(day_text("half_day", Some(4.5)), "4:30");
        assert_eq!(day_text("incomplete", None), "???");
        assert_eq!(day_text("absent", None), "·");
    }

    #[test]
    fn nhan_trang_thai_va_ngay() {
        assert_eq!(status_label("late"), "Đủ công");
        assert_eq!(status_label("half_day"), "Nửa ngày");
        assert_eq!(status_label("la"), "la");
        assert_eq!(display_vn_date("2026-06-17"), "17/06/2026");
        assert_eq!(display_vn_date("khong-ngay"), "khong-ngay");
        assert_eq!(date_str(Some("2026-06-01")), "01/06/2026");
        assert_eq!(date_str(None), "");
        assert_eq!(work_date_label("2026-02-31"), "03/03/2026");
        assert_eq!(weekday_label(2026, 6, 1), "T2");
        assert_eq!(weekday_label(2026, 6, 7), "CN");
        assert_eq!(gender_label(Some("F")), "Nữ");
        assert_eq!(gender_label(Some("unknown")), "");
    }

    #[test]
    fn nhan_khoang_ngay() {
        let q = |f: Option<&str>, t: Option<&str>| QueryAttendanceExportDto {
            date_from: f.map(str::to_owned),
            date_to: t.map(str::to_owned),
            ..QueryAttendanceExportDto::default()
        };
        assert_eq!(
            range_label(&q(Some("2026-06-01"), Some("2026-06-30")), 3, false),
            "Khoảng thời gian: 01/06/2026 - 30/06/2026 · Tổng 3 bản ghi"
        );
        assert_eq!(
            range_label(&q(Some("2026-06-01"), Some("2026-06-01")), 0, false),
            "Khoảng thời gian: 01/06/2026 · Tổng 0 bản ghi"
        );
        assert_eq!(
            range_label(&q(Some("2026-06-01"), None), 1, false),
            "Khoảng thời gian: Tất cả · Tổng 1 bản ghi"
        );
        assert!(range_label(&q(None, None), 20_000, true).ends_with(
            " · ⚠ vượt 20.000 bản ghi, file chỉ chứa 20.000 bản ghi MỚI NHẤT — thu hẹp khoảng thời gian để xem đầy đủ"
        ));
    }

    #[test]
    fn do_rong_tu_khop() {
        let rows = vec![vec![Cell::text("a"), int(1_234_567)]];
        let cols = autofit(&["Ngắn", "Một tiêu đề khá dài"], &rows, 10);
        assert_eq!(cols[0].width, 10.0);
        assert_eq!(cols[1].width, 21.0);
        let long = vec![vec![Cell::text("x".repeat(80))]];
        assert_eq!(autofit(&["A"], &long, 8)[0].width, 50.0);
    }

    fn sample_row() -> ExportRow {
        ExportRow {
            full_name: "Nguyễn A".to_owned(),
            team_name: None,
            department: Some("Kinh doanh".to_owned()),
            email: "a@example.vn".to_owned(),
            position: Some("Sale".to_owned()),
            work_date: NaiveDate::from_ymd_opt(2026, 6, 2).unwrap(),
            check_in: Some("08:00".to_owned()),
            check_out: None,
            total_hours: None,
            late_minutes: 5,
            status: "incomplete".to_owned(),
            in_note: String::new(),
            out_note: String::new(),
        }
    }

    #[test]
    fn xlsx_so_chinh_theo_o() {
        let data = ExportData {
            rows: vec![sample_row()],
            truncated: false,
        };
        let q = QueryAttendanceExportDto {
            date_from: Some("2026-06-01".to_owned()),
            date_to: Some("2026-06-30".to_owned()),
            ..QueryAttendanceExportDto::default()
        };
        let bytes = write(&[records_sheet(&data, &q)]).unwrap();
        let s = read_first_sheet(&bytes).unwrap();
        assert_eq!(s.name, "Chấm công");
        assert_eq!(s.cell(0, 0).as_trimmed_text().as_deref(), Some("BÁO CÁO CHẤM CÔNG"));
        // Hàng 0 tiêu đề, 1 dòng phụ, 2 trống (K29), 3 tiêu đề cột, 4 dữ liệu.
        assert_eq!(s.cell(3, 0).as_trimmed_text().as_deref(), Some("Họ tên"));
        assert_eq!(s.cell(4, 0).as_trimmed_text().as_deref(), Some("Nguyễn A"));
        assert_eq!(s.cell(4, 5), &ReadCell::Text("02/06/2026".to_owned()));
        assert_eq!(s.cell(4, 6), &ReadCell::Text("08:00".to_owned()));
        assert_eq!(s.cell(4, 9), &ReadCell::Number(5.0));
        assert_eq!(s.cell(4, 10).as_trimmed_text().as_deref(), Some("Chưa đủ vào/ra"));
    }

    #[test]
    fn xlsx_bang_cong_co_cot_ngay_va_tong_ket() {
        let m = Matrix::empty_for_test(30);
        let q = QueryAttendanceExportDto {
            date_from: Some("2026-06-01".to_owned()),
            date_to: Some("2026-06-30".to_owned()),
            ..QueryAttendanceExportDto::default()
        };
        let sheet = matrix_sheet(&m, &q);
        assert_eq!(sheet.columns.len(), 5 + 30 + 13);
        assert_eq!(sheet.columns[5].header, "1\nT2");
        assert_eq!(sheet.columns[11].header, "7\nCN");
        assert_eq!(sheet.columns[35].header, "Tổng công");
        assert_eq!(sheet.columns[47].header, "Ghi chú");
        assert_eq!(
            sheet.subtitle.as_deref(),
            Some("Khoảng thời gian: 01/06/2026 – 30/06/2026 · Tổng 0 nhân viên")
        );
    }

    #[test]
    fn xlsx_vang_dung_tieu_de() {
        let list = AbsentList::empty_for_test("2026-06-17");
        let sheet = absent_sheet(&list);
        assert_eq!(sheet.name, "NV chưa chấm công");
        assert_eq!(
            sheet.subtitle.as_deref(),
            Some("Ngày: 17/06/2026 · Tổng 0 nhân viên vắng")
        );
        assert_eq!(sheet.columns.len(), 10);
    }
}
