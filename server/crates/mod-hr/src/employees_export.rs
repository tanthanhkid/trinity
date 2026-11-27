//! Xuất xlsx nhân viên (M10): danh sách (`employees.export`, bộ lọc + sắp xếp đang chọn) và sinh nhật theo tháng. Bản TS:
//! `employee-list-export.service.ts`, `employee-birthday-export.service.ts`. Nội dung ô, thứ tự cột và độ rộng giống bản
//! TS; ô bắt đầu bằng `= + - @` được chống chèn công thức ở `trinity_docgen::xlsx`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use mod_users::guards::Actor;
use trinity_db::types::Timestamp;
use trinity_docgen::xlsx::{Cell, Column, SheetSpec, write_xlsx};
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::{VnDateStyle, format_vn_date};

use crate::employee_dto::{BirthdayListQueryDto, QueryEmployeesDto};
use crate::employees::{BirthdayItem, Ctx, EmployeeDto, R, find_all_for_export, get_birthday_list};

const COL_MIN_WIDTH: usize = 10;
const COL_MAX_WIDTH: usize = 50;

fn date(d: Option<Timestamp>) -> String {
    d.map(|t| format_vn_date(t.0, VnDateStyle::DayMonthYear2))
        .unwrap_or_default()
}

fn label(map: &[(&str, &str)], v: Option<&str>) -> String {
    v.map(|v| map.iter().find(|(k, _)| *k == v).map_or(v, |(_, l)| l).to_owned())
        .unwrap_or_default()
}

const STATUS: &[(&str, &str)] = &[
    ("unclassified", "Chưa phân loại"),
    ("active", "Đang làm việc"),
    ("probation", "Thử việc"),
    ("waiting", "Chờ vào làm"),
    ("on_leave", "Tạm nghỉ"),
    ("resigned", "Nghỉ việc"),
];
const GENDER: &[(&str, &str)] = &[("M", "Nam"), ("F", "Nữ")];
const EDUCATION: &[(&str, &str)] = &[
    ("dai_hoc_tro_len", "Đại học trở lên"),
    ("cao_dang", "Cao đẳng"),
    ("trung_cap", "Trung cấp"),
    ("thpt_12", "THPT (12/12)"),
    ("thcs", "THCS"),
    ("khac", "Khác"),
];
const RECRUITMENT: &[(&str, &str)] = &[("hr", "HR tuyển"), ("internal", "Nội bộ giới thiệu")];
const ROLE: &[(&str, &str)] = &[
    ("super_admin", "Quản trị viên"),
    ("hr", "Hành chính nhân sự"),
    ("team_lead", "Trưởng nhóm"),
    ("sale", "Nhân viên sale"),
    ("accountant", "Kế toán"),
    ("marketing", "Marketing"),
];

const LIST_HEADERS: [&str; 24] = [
    "STT",
    "Mã NV",
    "Họ tên",
    "Email",
    "Số điện thoại",
    "Chức vụ",
    "Phòng ban",
    "Team",
    "Giới tính",
    "Vai trò hệ thống",
    "Trạng thái",
    "Ngày vào làm",
    "Trình độ học vấn",
    "Nguồn tuyển dụng",
    "Ngày sinh",
    "Số CCCD",
    "Ngày cấp CCCD",
    "Nơi cấp CCCD",
    "Hộ khẩu thường trú",
    "Chỗ ở hiện tại",
    "Số tài khoản",
    "Tên ngân hàng",
    "Tên chủ tài khoản",
    "Ngày tạo",
];

fn width(header: &str, col: usize, rows: &[Vec<Cell>]) -> f64 {
    let longest = rows
        .iter()
        .map(|r| match &r[col] {
            Cell::Text(t) => t.encode_utf16().count(),
            Cell::Number(n, _) => format!("{n}").len(),
            _ => 0,
        })
        .max()
        .unwrap_or(0)
        .max(header.encode_utf16().count());
    (longest + 2).clamp(COL_MIN_WIDTH, COL_MAX_WIDTH) as f64
}

fn sheet(name: &str, title: String, subtitle: Option<String>, headers: &[&str], rows: Vec<Vec<Cell>>) -> SheetSpec {
    SheetSpec {
        name: name.to_owned(),
        title: Some(title),
        subtitle,
        columns: headers
            .iter()
            .enumerate()
            .map(|(i, h)| Column::new(*h, width(h, i, &rows)))
            .collect(),
        rows,
    }
}

fn t(v: Option<&str>) -> Cell {
    Cell::text(v.unwrap_or_default())
}

fn list_row(i: usize, r: &EmployeeDto) -> Vec<Cell> {
    // Tài khoản bị khoá hiển thị là "Nghỉ việc" bất kể trạng thái hồ sơ.
    let status = if r.user_status == "locked" {
        "resigned"
    } else {
        r.status.as_str()
    };
    vec![
        Cell::int(i64::try_from(i + 1).unwrap_or(0)),
        Cell::text(&r.employee_code),
        Cell::text(&r.full_name),
        Cell::text(&r.email),
        t(r.phone.as_deref()),
        Cell::text(&r.position),
        t(r.department.as_deref()),
        t(r.team_name.as_deref()),
        Cell::text(label(GENDER, r.gender.as_deref())),
        Cell::text(label(ROLE, r.role.as_deref())),
        Cell::text(label(STATUS, Some(status))),
        Cell::text(date(Some(r.joined_at))),
        Cell::text(label(EDUCATION, r.education_level.as_deref())),
        Cell::text(label(RECRUITMENT, r.recruitment_source.as_deref())),
        Cell::text(date(r.birth_date)),
        t(r.id_card_number.as_deref()),
        Cell::text(date(r.id_card_issued_date)),
        t(r.id_card_issued_place.as_deref()),
        t(r.permanent_address.as_deref()),
        t(r.current_address.as_deref()),
        t(r.bank_account_number.as_deref()),
        t(r.bank_name.as_deref()),
        t(r.bank_account_holder.as_deref()),
        Cell::text(date(Some(r.created_at))),
    ]
}

/// `GET /management/employees/export`: tên file `danh-sach-nhan-vien.xlsx`.
pub async fn export_list(ctx: &Ctx, actor: &Actor, q: &QueryEmployeesDto) -> R<Vec<u8>> {
    let rows = find_all_for_export(ctx, actor, q).await?;
    tracing::info!("Exporting {} employee rows", rows.len());
    let cells: Vec<Vec<Cell>> = rows.iter().enumerate().map(|(i, r)| list_row(i, r)).collect();
    let s = sheet(
        "Nhân viên",
        format!("DANH SÁCH NHÂN VIÊN · Tổng {} nhân viên", rows.len()),
        None,
        &LIST_HEADERS,
        cells,
    );
    write_xlsx(&[s]).map_err(AppError::internal)
}

const BIRTHDAY_HEADERS: [&str; 9] = [
    "STT",
    "Mã NV",
    "Họ tên",
    "Ngày sinh",
    "Chức vụ",
    "Team",
    "Phòng ban",
    "Email",
    "SĐT",
];

fn birthday_row(i: usize, r: &BirthdayItem) -> Vec<Cell> {
    vec![
        Cell::int(i64::try_from(i + 1).unwrap_or(0)),
        Cell::text(&r.employee_code),
        Cell::text(&r.full_name),
        Cell::text(date(r.birth_date)),
        Cell::text(r.job_title_name.as_deref().unwrap_or(&r.position)),
        Cell::text(&r.team_name),
        t(r.department.as_deref()),
        Cell::text(&r.email),
        t(r.phone.as_deref()),
    ]
}

/// `GET /management/employees/birthdays/export`: bytes và tháng (tên file `danh-sach-sinh-nhat[-thang-N].xlsx`, `N` chỉ khi
/// request truyền `month`).
pub async fn export_birthdays(ctx: &Ctx, actor: &Actor, q: &BirthdayListQueryDto) -> R<Vec<u8>> {
    let list = get_birthday_list(ctx, actor, q, "employees.export").await?;
    tracing::info!("Exporting {} birthday rows (month={})", list.items.len(), list.month);
    let cells: Vec<Vec<Cell>> = list.items.iter().enumerate().map(|(i, r)| birthday_row(i, r)).collect();
    let s = sheet(
        "Sinh nhật",
        "DANH SÁCH SINH NHẬT NHÂN VIÊN".to_owned(),
        Some(format!("Tháng {} · Tổng {} nhân viên", list.month, list.items.len())),
        &BIRTHDAY_HEADERS,
        cells,
    );
    write_xlsx(&[s]).map_err(AppError::internal)
}

/// Tên file xuất sinh nhật.
pub fn birthday_filename(month: Option<i64>) -> String {
    match month {
        Some(m) if m != 0 => format!("danh-sach-sinh-nhat-thang-{m}.xlsx"),
        _ => "danh-sach-sinh-nhat.xlsx".to_owned(),
    }
}
