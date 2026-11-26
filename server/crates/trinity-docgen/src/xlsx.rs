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

use std::io::Cursor;

use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, Timelike, Utc};
use rust_xlsxwriter::{Color, ExcelDateTime, Format, FormatAlign, FormatBorder, Workbook, Worksheet};

/// Định dạng ô ngày (giống chuỗi ngày bản Node xuất: `dd/mm/yyyy`).
pub const DATE_FORMAT: &str = "dd/mm/yyyy";
/// Định dạng ô ngày giờ (giờ Việt Nam).
pub const DATETIME_FORMAT: &str = "dd/mm/yyyy hh:mm";
/// Giới hạn dòng của một trang tính Excel.
pub const MAX_ROWS: usize = 1_048_576;

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

fn excel_date(d: NaiveDate) -> Result<ExcelDateTime, XlsxError> {
    let y = u16::try_from(d.year()).map_err(|_| XlsxError::Read(format!("năm ngoài phạm vi: {d}")))?;
    Ok(ExcelDateTime::from_ymd(y, d.month() as u8, d.day() as u8)?)
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
        Cell::Date(d) => {
            ws.write_datetime_with_format(row, col, excel_date(*d)?, &f.date)?;
        }
        Cell::DateTime(t) => {
            ws.write_datetime_with_format(row, col, excel_datetime(vn(t))?, &f.datetime)?;
        }
    }
    Ok(())
}

/// Ghi một hoặc nhiều trang tính thành tệp xlsx (byte).
pub fn write_xlsx(sheets: &[SheetSpec]) -> Result<Vec<u8>, XlsxError> {
    let f = Formats::new();
    let mut wb = Workbook::new();
    for spec in sheets {
        let ws = wb.add_worksheet();
        if !spec.name.is_empty() {
            ws.set_name(sheet_name(&spec.name))?;
        }
        let last_col = u16::try_from(spec.columns.len().max(1) - 1).map_err(|_| XlsxError::TooManyRows)?;
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

/// Tên trang tính hợp lệ: bỏ `[]:*?/\`, tối đa 31 ký tự.
fn sheet_name(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        .take(31)
        .collect();
    if s.trim().is_empty() { "Sheet1".to_owned() } else { s }
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
    /// Giá trị dạng chuỗi đã cắt khoảng trắng (như `parseCellRaw` của bản Node); ô trống ⇒ `None`.
    pub fn as_trimmed_text(&self) -> Option<String> {
        let s = match self {
            Self::Text(s) => s.trim().to_owned(),
            Self::Number(n) => format_number(*n),
            Self::Bool(b) => b.to_string(),
            Self::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S").to_string(),
            Self::Empty | Self::Error(_) => String::new(),
        };
        (!s.is_empty()).then_some(s)
    }
}

/// Số như `String(n)` của JS cho số nguyên và số thập phân thường gặp.
fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Một trang tính đã đọc: tên và các dòng (dòng 0 = dòng 1 của Excel); ô cuối dòng trống không được cắt.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadSheet {
    pub name: String,
    pub rows: Vec<Vec<ReadCell>>,
}

impl ReadSheet {
    /// Ô theo chỉ số dòng/cột từ 0; ngoài vùng có dữ liệu ⇒ [`ReadCell::Empty`].
    pub fn cell(&self, row: usize, col: usize) -> &ReadCell {
        self.rows.get(row).and_then(|r| r.get(col)).unwrap_or(&ReadCell::Empty)
    }
}

const EXCEL_EPOCH_DAYS_TO_UNIX: f64 = 25_569.0;

/// Số ngày Excel (hệ 1900) → ngày giờ, làm tròn tới giây.
fn serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    let secs = ((serial - EXCEL_EPOCH_DAYS_TO_UNIX) * 86_400.0).round();
    if !secs.is_finite() {
        return None;
    }
    DateTime::from_timestamp(secs as i64, 0).map(|d| d.naive_utc())
}

fn read_cell(d: &Data) -> ReadCell {
    match d {
        Data::Empty => ReadCell::Empty,
        Data::String(s) => ReadCell::Text(s.clone()),
        Data::Int(i) => ReadCell::Number(*i as f64),
        Data::Float(f) => ReadCell::Number(*f),
        Data::Bool(b) => ReadCell::Bool(*b),
        Data::DateTime(t) => serial_to_datetime(t.as_f64()).map_or(ReadCell::Number(t.as_f64()), ReadCell::DateTime),
        Data::DateTimeIso(s) => NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| NaiveDate::parse_from_str(s, "%Y-%m-%d").map(|d| d.and_time(chrono::NaiveTime::MIN)))
            .map_or_else(|_| ReadCell::Text(s.clone()), ReadCell::DateTime),
        Data::DurationIso(s) => ReadCell::Text(s.clone()),
        Data::Error(e) => ReadCell::Error(e.to_string()),
    }
}

/// Đọc mọi trang tính của tệp xlsx. Công thức đọc theo giá trị đã lưu (như `result` của exceljs), chữ nhiều kiểu
/// (rich text) nối thành một chuỗi. Vị trí dòng/cột tính từ ô A1 (dòng trống ở đầu được giữ).
pub fn read_xlsx(bytes: &[u8]) -> Result<Vec<ReadSheet>, XlsxError> {
    let mut wb: Xlsx<Cursor<&[u8]>> =
        open_workbook_from_rs(Cursor::new(bytes)).map_err(|e: calamine::XlsxError| XlsxError::Read(e.to_string()))?;
    let names = wb.sheet_names();
    if names.is_empty() {
        return Err(XlsxError::NoSheet);
    }
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let range = wb.worksheet_range(&name).map_err(|e| XlsxError::Read(e.to_string()))?;
        let (r0, c0) = range.start().map_or((0, 0), |(r, c)| (r as usize, c as usize));
        let mut rows: Vec<Vec<ReadCell>> = vec![Vec::new(); r0];
        for r in range.rows() {
            let mut cells = vec![ReadCell::Empty; c0];
            cells.extend(r.iter().map(read_cell));
            while cells.last() == Some(&ReadCell::Empty) {
                cells.pop();
            }
            rows.push(cells);
        }
        while rows.last().is_some_and(Vec::is_empty) {
            rows.pop();
        }
        out.push(ReadSheet { name, rows });
    }
    Ok(out)
}

/// Đọc trang tính đầu tiên (các chỗ nhập chỉ đọc trang đầu, như `wb.worksheets[0]` của bản Node).
pub fn read_first_sheet(bytes: &[u8]) -> Result<ReadSheet, XlsxError> {
    read_xlsx(bytes)?.into_iter().next().ok_or(XlsxError::NoSheet)
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
        let t = serial_to_datetime(46_352.378_472_222_22).unwrap();
        assert_eq!(t.to_string(), "2026-11-26 09:05:00");
        assert_eq!(format_number(1_234_567.0), "1234567");
        assert_eq!(format_number(85.5), "85.5");
        assert_eq!(sheet_name("Bảng [1]: a/b?"), "Bảng 1 ab");
    }
}
