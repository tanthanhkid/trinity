//! Đọc và ghi xlsx dùng chung cho các chỗ xuất/nhập (K29).
//!
//! Ghi bằng `rust_xlsxwriter`, đọc bằng `calamine`. Bố cục giống các tệp bản Node đang xuất bằng `exceljs`: (tuỳ chọn)
//! dòng tiêu đề gộp ô + dòng phụ, dòng tiêu đề cột in đậm nền xanh, dữ liệu, cố định dòng tiêu đề cột.
//!
//! Định dạng ô:
//! - số: [`NumFormat`] (`#,##0` như `NUM_FMT` của bản Node, hoặc 2 chữ số thập phân);
//! - ngày: ô kiểu ngày Excel với định dạng `dd/mm/yyyy`; ngày giờ: giờ Việt Nam (UTC+7, không có giờ mùa hè) với
//!   `dd/mm/yyyy hh:mm` — cùng cách đọc của `vnDate`/`vnDateTime` (`custom-objects/csv-format.ts`);
//! - chuỗi: chống chèn công thức như `csvCell` — ô bắt đầu bằng `=`, `+`, `-`, `@`, tab, CR hoặc LF được thêm `'` và
//!   luôn ghi kiểu chuỗi (không bao giờ ghi công thức).

use std::io::{Cursor, Read};

use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, Timelike, Utc};
use rust_xlsxwriter::{Color, ExcelDateTime, Format, FormatAlign, FormatBorder, Workbook, Worksheet};

/// Định dạng ô ngày (giống chuỗi ngày bản Node xuất: `dd/mm/yyyy`).
pub const DATE_FORMAT: &str = "dd/mm/yyyy";
/// Định dạng ô ngày giờ (giờ Việt Nam).
pub const DATETIME_FORMAT: &str = "dd/mm/yyyy hh:mm";
/// Giới hạn dòng của một trang tính Excel.
pub const MAX_ROWS: usize = 1_048_576;
/// Giới hạn cột của một trang tính Excel (XFD).
pub const MAX_COLS: usize = 16_384;
/// Trần số mục trong tệp xlsx (một tệp bình thường chỉ có vài chục mục).
pub const MAX_READ_ENTRIES: usize = 2_000;
/// Trần dung lượng sau giải nén của một mục (byte).
pub const MAX_READ_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Trần tổng dung lượng sau giải nén của mọi mục (byte).
pub const MAX_READ_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
/// Trần số dòng của trang tính khi đọc.
pub const MAX_READ_ROWS: usize = 200_000;
/// Trần tổng số ô (kể cả ô trống đệm trong dòng) giữ lại khi đọc một trang tính.
pub const MAX_READ_CELLS: usize = 2_000_000;

#[derive(Debug, thiserror::Error)]
pub enum XlsxError {
    #[error("ghi xlsx lỗi: {0}")]
    Write(#[from] rust_xlsxwriter::XlsxError),
    #[error("tệp không phải xlsx đọc được: {0}")]
    Read(String),
    #[error("tệp xlsx không có trang tính nào")]
    NoSheet,
    #[error("quá {MAX_ROWS} dòng trong một trang tính")]
    TooManyRows,
    #[error("quá {MAX_COLS} cột trong một trang tính")]
    TooManyColumns,
    #[error("tệp xlsx có quá nhiều mục (tối đa {MAX_READ_ENTRIES})")]
    TooManyEntries,
    #[error("tệp xlsx quá lớn sau khi giải nén")]
    TooLarge,
    #[error("trang tính quá lớn: tối đa {MAX_READ_ROWS} dòng và {MAX_READ_CELLS} ô")]
    SheetTooLarge,
}

impl XlsxError {
    /// Mã HTTP gợi ý cho chỗ gọi: lỗi do tệp người dùng gửi ⇒ 4xx; lỗi ghi ⇒ 500.
    pub fn http_status(&self) -> u16 {
        match self {
            Self::TooLarge | Self::TooManyEntries | Self::SheetTooLarge => 413,
            Self::Read(_) | Self::NoSheet | Self::TooManyRows | Self::TooManyColumns => 400,
            Self::Write(_) => 500,
        }
    }
}

/// Định dạng số của ô.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NumFormat {
    /// Không định dạng (Excel "General").
    #[default]
    General,
    /// Số nguyên có dấu tách nghìn: `#,##0` (tiền, lương, số lượng).
    Integer,
    /// Hai chữ số thập phân: `#,##0.00`.
    Decimal2,
}

impl NumFormat {
    pub fn code(self) -> Option<&'static str> {
        match self {
            Self::General => None,
            Self::Integer => Some("#,##0"),
            Self::Decimal2 => Some("#,##0.00"),
        }
    }
}

/// Giá trị một ô khi ghi.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    /// Chuỗi — được làm sạch chống chèn công thức khi ghi ([`safe_text`]).
    Text(String),
    Number(f64, NumFormat),
    Bool(bool),
    /// Ngày lịch (không giờ), vd ngày sinh, ngày công.
    Date(NaiveDate),
    /// Thời điểm; ghi theo giờ Việt Nam.
    DateTime(DateTime<Utc>),
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }
    pub fn int(n: i64) -> Self {
        // Số trong bảng xuất không vượt 2^53 (tiền VND, số đếm) nên chuyển f64 không mất chính xác.
        Self::Number(n as f64, NumFormat::Integer)
    }
}

/// Một cột: nhãn tiêu đề và độ rộng (đơn vị ký tự như `width` của exceljs).
#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub header: String,
    pub width: f64,
}

impl Column {
    pub fn new(header: impl Into<String>, width: f64) -> Self {
        Self {
            header: header.into(),
            width,
        }
    }
}

/// Một trang tính cần ghi.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SheetSpec {
    pub name: String,
    /// Dòng 1: tiêu đề in đậm, gộp ô qua mọi cột.
    pub title: Option<String>,
    /// Dòng ngay dưới tiêu đề: mô tả nghiêng (khoảng ngày, số dòng…), gộp ô.
    pub subtitle: Option<String>,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
}

/// Ký tự mở đầu khiến Excel/LibreOffice hiểu ô là công thức (như `csvCell` của bản Node, thêm LF).
const FORMULA_LEAD: [char; 7] = ['=', '+', '-', '@', '\t', '\r', '\n'];

/// Chuỗi an toàn để đặt vào ô: bắt đầu bằng ký tự công thức thì thêm `'` ở đầu.
pub fn safe_text(s: &str) -> std::borrow::Cow<'_, str> {
    if s.starts_with(FORMULA_LEAD) {
        std::borrow::Cow::Owned(format!("'{s}"))
    } else {
        std::borrow::Cow::Borrowed(s)
    }
}

const VN_OFFSET_SECS: i32 = 7 * 3600;

fn vn(dt: &DateTime<Utc>) -> NaiveDateTime {
    let offset = FixedOffset::east_opt(VN_OFFSET_SECS).expect("UTC+7 hợp lệ");
    dt.with_timezone(&offset).naive_local()
}

/// Năm Excel ghi được kiểu ngày (hệ 1900): 1900–9999. Ngoài khoảng đó ô được ghi dạng chuỗi `dd/mm/yyyy`.
fn in_excel_range(d: NaiveDate) -> bool {
    (1900..=9999).contains(&d.year())
}

fn excel_date(d: NaiveDate) -> Result<ExcelDateTime, XlsxError> {
    Ok(ExcelDateTime::from_ymd(
        d.year() as u16,
        d.month() as u8,
        d.day() as u8,
    )?)
}

fn excel_datetime(t: NaiveDateTime) -> Result<ExcelDateTime, XlsxError> {
    Ok(excel_date(t.date())?.and_hms(t.hour() as u16, t.minute() as u8, f64::from(t.second()))?)
}

struct Formats {
    title: Format,
    subtitle: Format,
    header: Format,
    text: Format,
    date: Format,
    datetime: Format,
    general: Format,
    integer: Format,
    decimal2: Format,
}

impl Formats {
    fn new() -> Self {
        let body = Format::new()
            .set_border(FormatBorder::Thin)
            .set_border_color(Color::RGB(0xD9D9D9));
        Self {
            title: Format::new()
                .set_bold()
                .set_font_size(14)
                .set_align(FormatAlign::Center)
                .set_align(FormatAlign::VerticalCenter),
            subtitle: Format::new()
                .set_italic()
                .set_font_color(Color::RGB(0x666666))
                .set_align(FormatAlign::Center),
            header: Format::new()
                .set_bold()
                .set_font_color(Color::White)
                .set_background_color(Color::RGB(0x2563EB))
                .set_align(FormatAlign::Center)
                .set_align(FormatAlign::VerticalCenter)
                .set_text_wrap()
                .set_border(FormatBorder::Thin),
            text: body.clone().set_text_wrap().set_align(FormatAlign::Top),
            date: body.clone().set_num_format(DATE_FORMAT),
            datetime: body.clone().set_num_format(DATETIME_FORMAT),
            general: body.clone(),
            integer: body.clone().set_num_format("#,##0"),
            decimal2: body.set_num_format("#,##0.00"),
        }
    }

    fn number(&self, f: NumFormat) -> &Format {
        match f {
            NumFormat::General => &self.general,
            NumFormat::Integer => &self.integer,
            NumFormat::Decimal2 => &self.decimal2,
        }
    }
}

fn write_cell(ws: &mut Worksheet, row: u32, col: u16, cell: &Cell, f: &Formats) -> Result<(), XlsxError> {
    match cell {
        Cell::Empty => {
            ws.write_blank(row, col, &f.general)?;
        }
        Cell::Text(s) => {
            ws.write_string_with_format(row, col, safe_text(s).as_ref(), &f.text)?;
        }
        Cell::Number(n, fmt) => {
            if n.is_finite() {
                ws.write_number_with_format(row, col, *n, f.number(*fmt))?;
            } else {
                ws.write_blank(row, col, &f.general)?;
            }
        }
        Cell::Bool(b) => {
            ws.write_boolean_with_format(row, col, *b, &f.general)?;
        }
        Cell::Date(d) if in_excel_range(*d) => {
            ws.write_datetime_with_format(row, col, excel_date(*d)?, &f.date)?;
        }
        Cell::Date(d) => {
            ws.write_string_with_format(row, col, d.format("%d/%m/%Y").to_string(), &f.text)?;
        }
        Cell::DateTime(t) => {
            let local = vn(t);
            if in_excel_range(local.date()) {
                ws.write_datetime_with_format(row, col, excel_datetime(local)?, &f.datetime)?;
            } else {
                ws.write_string_with_format(row, col, local.format("%d/%m/%Y %H:%M").to_string(), &f.text)?;
            }
        }
    }
    Ok(())
}

/// Ghi một hoặc nhiều trang tính thành tệp xlsx (byte).
pub fn write_xlsx(sheets: &[SheetSpec]) -> Result<Vec<u8>, XlsxError> {
    let f = Formats::new();
    let mut wb = Workbook::new();
    let mut used: Vec<String> = Vec::new();
    for spec in sheets {
        if spec.columns.len() > MAX_COLS || spec.rows.iter().any(|r| r.len() > MAX_COLS) {
            return Err(XlsxError::TooManyColumns);
        }
        let name = unique_sheet_name(&spec.name, &used);
        used.push(name.clone());
        let ws = wb.add_worksheet();
        ws.set_name(name)?;
        let last_col = (spec.columns.len().max(1) - 1) as u16;
        let mut row: u32 = 0;
        for (text, fmt) in [(&spec.title, &f.title), (&spec.subtitle, &f.subtitle)] {
            if let Some(t) = text {
                if last_col > 0 {
                    ws.merge_range(row, 0, row, last_col, safe_text(t).as_ref(), fmt)?;
                } else {
                    ws.write_string_with_format(row, 0, safe_text(t).as_ref(), fmt)?;
                }
                row += 1;
            }
        }
        if spec.title.is_some() || spec.subtitle.is_some() {
            row += 1; // dòng trống trước tiêu đề cột, như bản Node
        }
        if spec.rows.len() + row as usize + 1 > MAX_ROWS {
            return Err(XlsxError::TooManyRows);
        }
        for (c, col) in spec.columns.iter().enumerate() {
            let c = c as u16;
            ws.write_string_with_format(row, c, safe_text(&col.header).as_ref(), &f.header)?;
            ws.set_column_width(c, col.width)?;
        }
        if !spec.columns.is_empty() {
            ws.set_freeze_panes(row + 1, 0)?;
        }
        for data in &spec.rows {
            row += 1;
            for (c, cell) in data.iter().enumerate() {
                write_cell(ws, row, c as u16, cell, &f)?;
            }
        }
    }
    if sheets.is_empty() {
        wb.add_worksheet();
    }
    Ok(wb.save_to_buffer()?)
}

/// Tên trang tính hợp lệ cho Excel: bỏ `[]:*?/\`, bỏ nháy `'` ở đầu/cuối, tối đa 31 ký tự, tránh tên dành riêng
/// "History"; trống ⇒ "Sheet1".
fn sheet_name(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        .collect();
    let s = s.trim().trim_matches('\'').trim();
    let s: String = s.chars().take(31).collect();
    if s.is_empty() {
        "Sheet1".to_owned()
    } else if s.eq_ignore_ascii_case("history") {
        format!("{s} (1)")
    } else {
        s
    }
}

/// Tên không trùng (không phân biệt hoa thường) với các trang đã có: thêm " (2)", " (3)"… vẫn trong 31 ký tự.
pub(crate) fn unique_sheet_name(name: &str, used: &[String]) -> String {
    let base = sheet_name(name);
    let taken = |n: &str| used.iter().any(|u| u.to_lowercase() == n.to_lowercase());
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|i| {
            let suffix = format!(" ({i})");
            let head: String = base.chars().take(31 - suffix.chars().count()).collect();
            format!("{head}{suffix}")
        })
        .find(|n| !taken(n))
        .expect("luôn tìm được tên trống")
}

/// Giá trị một ô khi đọc.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadCell {
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
    /// Ô có định dạng ngày/giờ: giá trị đúng như hiển thị trong Excel (không đổi múi giờ).
    DateTime(NaiveDateTime),
    /// Ô lỗi của Excel (`#DIV/0!`…).
    Error(String),
}

impl ReadCell {
    /// Như `parseCellRaw` của bản Node: chuỗi đã cắt khoảng trắng (rỗng ⇒ `None`), số ⇒ chuỗi số như `String(n)` của
    /// JS; ô đúng/sai, ngày giờ, lỗi, trống ⇒ `None`.
    pub fn as_trimmed_text(&self) -> Option<String> {
        match self {
            Self::Text(s) => Some(s.trim()).filter(|t| !t.is_empty()).map(str::to_owned),
            Self::Number(n) => Some(js_number_string(*n)),
            Self::Bool(_) | Self::DateTime(_) | Self::Empty | Self::Error(_) => None,
        }
    }
}

/// Số như `String(n)` của JS: dạng thường, dạng mũ khi |n| ≥ 1e21 hoặc < 1e-6 (`1e+21`, `1.5e-7`), `-0` ⇒ `0`.
pub fn js_number_string(n: f64) -> String {
    if n == 0.0 {
        return "0".to_owned();
    }
    if !n.is_finite() {
        return if n.is_nan() {
            "NaN"
        } else if n > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    if (1e-6..1e21).contains(&n.abs()) {
        return format!("{n}");
    }
    let e = format!("{n:e}");
    match e.split_once('e') {
        Some((m, exp)) if !exp.starts_with('-') => format!("{m}e+{exp}"),
        _ => e,
    }
}

/// Một trang tính đã đọc. Dòng/cột tính từ ô A1; để không cấp phát cho vùng trống, dòng không lưu các cột trống chung
/// ở đầu (trước `col_offset`) và bỏ ô trống ở cuối — đọc qua [`ReadSheet::cell`].
#[derive(Debug, Clone, PartialEq)]
pub struct ReadSheet {
    pub name: String,
    /// Chỉ số cột (từ 0, tính từ cột A) của phần tử đầu mỗi dòng trong `rows`.
    pub col_offset: usize,
    pub rows: Vec<Vec<ReadCell>>,
}

impl ReadSheet {
    /// Ô theo chỉ số dòng/cột từ 0 (tính từ A1); ngoài vùng có dữ liệu ⇒ [`ReadCell::Empty`].
    pub fn cell(&self, row: usize, col: usize) -> &ReadCell {
        col.checked_sub(self.col_offset)
            .and_then(|c| self.rows.get(row).and_then(|r| r.get(c)))
            .unwrap_or(&ReadCell::Empty)
    }

    /// Số cột tính từ cột A của dòng (tới ô cuối có dữ liệu); dòng trống ⇒ 0.
    pub fn row_width(&self, row: usize) -> usize {
        self.rows
            .get(row)
            .map_or(0, |r| if r.is_empty() { 0 } else { self.col_offset + r.len() })
    }
}

/// Làm tròn tới giây (ô ngày giờ Excel lưu số thực).
fn round_second(t: NaiveDateTime) -> NaiveDateTime {
    let base = t.with_nanosecond(0).unwrap_or(t);
    if t.nanosecond() >= 500_000_000 {
        base + chrono::Duration::seconds(1)
    } else {
        base
    }
}

/// Ngày giờ ISO trong ô (tệp ghi ngày dạng ISO): có/không phần giây lẻ, có múi giờ thì lấy giờ địa phương ghi trong chuỗi.
fn parse_iso(s: &str) -> Option<NaiveDateTime> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t.naive_local());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, f) {
            return Some(t);
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .map(|d| d.and_time(chrono::NaiveTime::MIN))
}

fn read_cell(d: &Data) -> ReadCell {
    match d {
        Data::Empty => ReadCell::Empty,
        Data::String(s) => ReadCell::Text(s.clone()),
        Data::Int(i) => ReadCell::Number(*i as f64),
        Data::Float(f) => ReadCell::Number(*f),
        Data::Bool(b) => ReadCell::Bool(*b),
        // `as_datetime` của calamine xử lý cả hệ ngày 1904 và lỗi năm nhuận 1900 của Excel.
        Data::DateTime(t) if t.is_datetime() => t
            .as_datetime()
            .map_or(ReadCell::Number(t.as_f64()), |v| ReadCell::DateTime(round_second(v))),
        Data::DateTime(t) => ReadCell::Number(t.as_f64()),
        Data::DateTimeIso(s) => {
            parse_iso(s).map_or_else(|| ReadCell::Text(s.clone()), |v| ReadCell::DateTime(round_second(v)))
        }
        Data::DurationIso(s) => ReadCell::Text(s.clone()),
        Data::Error(e) => ReadCell::Error(e.to_string()),
    }
}

type Book<'a> = Xlsx<Cursor<&'a [u8]>>;

/// Kiểm kích thước sau giải nén theo luồng: mỗi mục đọc tới trần rồi dừng, không tin kích thước khai trong tiêu đề.
fn check_archive(bytes: &[u8]) -> Result<(), XlsxError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| XlsxError::Read(e.to_string()))?;
    if zip.len() > MAX_READ_ENTRIES {
        return Err(XlsxError::TooManyEntries);
    }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| XlsxError::Read(e.to_string()))?;
        if entry.size() > MAX_READ_ENTRY_BYTES {
            return Err(XlsxError::TooLarge);
        }
        let room = MAX_READ_ENTRY_BYTES.min(MAX_READ_TOTAL_BYTES - total);
        let mut limited = entry.take(room + 1);
        let n = std::io::copy(&mut limited, &mut std::io::sink()).map_err(|e| XlsxError::Read(e.to_string()))?;
        if n > room {
            return Err(XlsxError::TooLarge);
        }
        total += n;
    }
    Ok(())
}

fn open(bytes: &[u8]) -> Result<Book<'_>, XlsxError> {
    check_archive(bytes)?;
    open_workbook_from_rs(Cursor::new(bytes)).map_err(|e: calamine::XlsxError| XlsxError::Read(e.to_string()))
}

fn read_sheet(wb: &mut Book<'_>, name: String) -> Result<ReadSheet, XlsxError> {
    // Đọc theo luồng từng ô, dựng thưa: không để calamine cấp phát vùng chữ nhật đặc theo ô xa nhất.
    let mut reader = wb
        .worksheet_cells_reader(&name)
        .map_err(|e| XlsxError::Read(e.to_string()))?;
    let mut rows: Vec<Vec<ReadCell>> = Vec::new();
    let mut slots: usize = 0;
    let mut min_col = usize::MAX;
    while let Some(cell) = reader.next_cell().map_err(|e| XlsxError::Read(e.to_string()))? {
        let (r, c) = cell.get_position();
        let (r, c) = (r as usize, c as usize);
        let value = read_cell(&Data::from(cell.get_value().clone()));
        if value == ReadCell::Empty {
            continue;
        }
        if r >= MAX_READ_ROWS {
            return Err(XlsxError::SheetTooLarge);
        }
        if c >= MAX_COLS {
            return Err(XlsxError::TooManyColumns);
        }
        if rows.len() <= r {
            rows.resize_with(r + 1, Vec::new);
        }
        let row = &mut rows[r];
        if row.len() <= c {
            slots += c + 1 - row.len();
            if slots > MAX_READ_CELLS {
                return Err(XlsxError::SheetTooLarge);
            }
            row.resize(c + 1, ReadCell::Empty);
        }
        row[c] = value;
        min_col = min_col.min(c);
    }
    while rows.last().is_some_and(Vec::is_empty) {
        rows.pop();
    }
    // Bỏ các cột trống chung ở đầu mọi dòng.
    let lead = if min_col == usize::MAX { 0 } else { min_col };
    for r in &mut rows {
        if !r.is_empty() {
            r.drain(..lead.min(r.len()));
        }
        r.shrink_to_fit();
    }
    rows.shrink_to_fit();
    Ok(ReadSheet {
        name,
        col_offset: lead,
        rows,
    })
}

/// Đọc mọi trang tính của tệp xlsx. Công thức đọc theo giá trị đã lưu (như `result` của exceljs), chữ nhiều kiểu
/// (rich text) nối thành một chuỗi, ô phụ của vùng gộp là trống.
pub fn read_xlsx(bytes: &[u8]) -> Result<Vec<ReadSheet>, XlsxError> {
    let mut wb = open(bytes)?;
    let names = wb.sheet_names();
    if names.is_empty() {
        return Err(XlsxError::NoSheet);
    }
    names.into_iter().map(|n| read_sheet(&mut wb, n)).collect()
}

/// Đọc riêng trang tính đầu tiên, không giải mã các trang khác (các chỗ nhập chỉ đọc `wb.worksheets[0]` như bản Node).
pub fn read_first_sheet(bytes: &[u8]) -> Result<ReadSheet, XlsxError> {
    let mut wb = open(bytes)?;
    let name = wb.sheet_names().into_iter().next().ok_or(XlsxError::NoSheet)?;
    read_sheet(&mut wb, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chong_chen_cong_thuc() {
        for s in ["=1+1", "+84", "-5", "@SUM(A1)", "\tx", "\rx", "\nx"] {
            assert_eq!(safe_text(s), format!("'{s}"));
        }
        for s in ["Bình thường", "", "84 =", "'đã có"] {
            assert_eq!(safe_text(s), s);
        }
    }

    #[test]
    fn so_ngay_excel() {
        assert_eq!(js_number_string(1_234_567.0), "1234567");
        assert_eq!(js_number_string(85.5), "85.5");
        assert_eq!(js_number_string(-0.0), "0");
        assert_eq!(js_number_string(1e21), "1e+21");
        assert_eq!(js_number_string(1.5e-7), "1.5e-7");
        assert_eq!(js_number_string(1e20), "100000000000000000000");
        assert_eq!(sheet_name("Bảng [1]: a/b?"), "Bảng 1 ab");
        assert_eq!(sheet_name("'Báo cáo'"), "Báo cáo");
        assert_eq!(sheet_name("History"), "History (1)");
        let used = vec!["Khách".to_owned(), "khách (2)".to_owned()];
        assert_eq!(unique_sheet_name("Khách", &used), "Khách (3)");
        assert_eq!(
            unique_sheet_name(&"x".repeat(40), &["x".repeat(31)]).chars().count(),
            31
        );
        assert_eq!(
            parse_iso("2026-11-26T09:05:00.250+07:00").unwrap().to_string(),
            "2026-11-26 09:05:00.250"
        );
        assert_eq!(
            parse_iso("2026-11-26T09:05:00.5").unwrap().to_string(),
            "2026-11-26 09:05:00.500"
        );
        assert_eq!(
            round_second(parse_iso("2026-11-26T09:05:00.5").unwrap()).to_string(),
            "2026-11-26 09:05:01"
        );
    }

    /// Tệp zip tự dựng chứa một mục lớn nén được rất tốt.
    fn zip_with(entries: &[(&str, usize)]) -> Vec<u8> {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, len) in entries {
            w.start_file(*name, opts).unwrap();
            let chunk = vec![b'a'; 1 << 20];
            let mut left = *len;
            while left > 0 {
                let n = left.min(chunk.len());
                w.write_all(&chunk[..n]).unwrap();
                left -= n;
            }
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn tran_giai_nen_mot_muc() {
        let bytes = zip_with(&[("xl/big.xml", MAX_READ_ENTRY_BYTES as usize + 1)]);
        assert!(bytes.len() < 1_000_000, "tệp nén phải nhỏ");
        assert!(matches!(read_xlsx(&bytes), Err(XlsxError::TooLarge)));
        assert_eq!(XlsxError::TooLarge.http_status(), 413);
    }

    #[test]
    fn tran_giai_nen_tong() {
        let each = MAX_READ_ENTRY_BYTES as usize;
        let bytes = zip_with(&[("a.xml", each), ("b.xml", each), ("c.xml", each), ("d.xml", each)]);
        assert!(matches!(read_first_sheet(&bytes), Err(XlsxError::TooLarge)));
    }

    #[test]
    fn tran_so_muc() {
        let names: Vec<String> = (0..=MAX_READ_ENTRIES).map(|i| format!("f{i}.xml")).collect();
        let entries: Vec<(&str, usize)> = names.iter().map(|n| (n.as_str(), 1)).collect();
        assert!(matches!(
            read_xlsx(&zip_with(&entries)),
            Err(XlsxError::TooManyEntries)
        ));
    }

    #[test]
    fn tran_trang_tinh_o_xa() {
        // Ô duy nhất ở dòng cuối: không được cấp phát vùng đặc, nhưng vượt trần dòng ⇒ lỗi rõ ràng.
        let mut wb = Workbook::new();
        wb.add_worksheet().write_string(MAX_READ_ROWS as u32, 0, "x").unwrap();
        let bytes = wb.save_to_buffer().unwrap();
        assert!(matches!(read_xlsx(&bytes), Err(XlsxError::SheetTooLarge)));
    }

    #[test]
    fn tep_binh_thuong_van_doc_duoc() {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.write_string(2, 3, "a").unwrap();
        ws.write_number(3, 5, 7.0).unwrap();
        let sheets = read_xlsx(&wb.save_to_buffer().unwrap()).unwrap();
        assert_eq!(sheets[0].cell(2, 3), &ReadCell::Text("a".into()));
        assert_eq!(sheets[0].cell(3, 5), &ReadCell::Number(7.0));
        assert_eq!(sheets[0].col_offset, 3);
    }
}
