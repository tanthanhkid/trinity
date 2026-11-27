//! Ghi xlsx theo lưới tự do (ô đặt theo toạ độ, gộp ô, tô nền, độ cao dòng, cố định ô, lọc tự động) cho các tệp mà
//! [`crate::xlsx::write_xlsx`] (bảng một dòng tiêu đề) không biểu diễn được: phiếu lương theo mẫu kế toán, danh sách lương
//! hai tầng tiêu đề, mẫu nhập phiếu lương (M31). Toạ độ tính từ 0 (ô A1 = dòng 0, cột 0). Mọi ô dùng phông Times New Roman
//! như các bản dựng `exceljs` của bản Node; chuỗi qua [`crate::xlsx::safe_text`] (chống chèn công thức).

use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};

use crate::xlsx::{XlsxError, safe_text, unique_sheet_name};

/// Căn ngang.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HAlign {
    #[default]
    General,
    Left,
    Center,
    Right,
}

/// Căn dọc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VAlign {
    #[default]
    Bottom,
    Top,
    Middle,
}

/// Kiểu ô: phông, nền, căn lề, viền, định dạng số.
#[derive(Debug, Clone, PartialEq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub font_size: f64,
    /// Màu chữ RGB (`0xRRGGBB`); `None` = mặc định.
    pub color: Option<u32>,
    /// Màu nền RGB; `None` = không tô.
    pub fill: Option<u32>,
    pub h: HAlign,
    pub v: VAlign,
    pub wrap: bool,
    /// Viền mảnh bốn cạnh.
    pub border: bool,
    /// Mã định dạng số, vd `#,##0`.
    pub num_format: Option<&'static str>,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            bold: false,
            italic: false,
            font_size: 11.0,
            color: None,
            fill: None,
            h: HAlign::General,
            v: VAlign::Bottom,
            wrap: false,
            border: false,
            num_format: None,
        }
    }
}

impl Style {
    fn format(&self) -> Format {
        let mut f = Format::new()
            .set_font_name("Times New Roman")
            .set_font_size(self.font_size);
        if self.bold {
            f = f.set_bold();
        }
        if self.italic {
            f = f.set_italic();
        }
        if let Some(c) = self.color {
            f = f.set_font_color(Color::RGB(c));
        }
        if let Some(c) = self.fill {
            f = f.set_background_color(Color::RGB(c));
        }
        f = match self.h {
            HAlign::General => f,
            HAlign::Left => f.set_align(FormatAlign::Left),
            HAlign::Center => f.set_align(FormatAlign::Center),
            HAlign::Right => f.set_align(FormatAlign::Right),
        };
        f = match self.v {
            VAlign::Bottom => f,
            VAlign::Top => f.set_align(FormatAlign::Top),
            VAlign::Middle => f.set_align(FormatAlign::VerticalCenter),
        };
        if self.wrap {
            f = f.set_text_wrap();
        }
        if self.border {
            f = f.set_border(FormatBorder::Thin);
        }
        if let Some(n) = self.num_format {
            f = f.set_num_format(n);
        }
        f
    }
}

/// Giá trị ô.
#[derive(Debug, Clone, PartialEq)]
pub enum GridValue {
    /// Ô chỉ có kiểu (nền, viền), không có giá trị.
    Blank,
    Text(String),
    Number(f64),
}

/// Một ô theo toạ độ.
#[derive(Debug, Clone, PartialEq)]
pub struct GridCell {
    pub row: u32,
    pub col: u16,
    pub value: GridValue,
    pub style: Style,
}

/// Vùng gộp ô; giá trị và kiểu của ô trên-trái áp cho cả vùng.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub first_row: u32,
    pub first_col: u16,
    pub last_row: u32,
    pub last_col: u16,
    pub text: String,
    pub style: Style,
}

/// Một trang tính.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GridSheet {
    pub name: String,
    /// Độ rộng cột từ cột A (ký tự); cột ngoài danh sách giữ mặc định.
    pub col_widths: Vec<f64>,
    /// `(dòng, chiều cao)` tính bằng point.
    pub row_heights: Vec<(u32, f64)>,
    pub cells: Vec<GridCell>,
    pub merged: Vec<Merged>,
    /// `(số dòng, số cột)` bị cố định ở đầu/trái.
    pub freeze: Option<(u32, u16)>,
    /// `(dòng đầu, cột đầu, dòng cuối, cột cuối)` của vùng lọc tự động.
    pub autofilter: Option<(u32, u16, u32, u16)>,
}

impl GridSheet {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }

    pub fn text(&mut self, row: u32, col: u16, text: impl Into<String>, style: Style) {
        self.cells.push(GridCell {
            row,
            col,
            value: GridValue::Text(text.into()),
            style,
        });
    }

    pub fn number(&mut self, row: u32, col: u16, n: f64, style: Style) {
        self.cells.push(GridCell {
            row,
            col,
            value: GridValue::Number(n),
            style,
        });
    }

    pub fn blank(&mut self, row: u32, col: u16, style: Style) {
        self.cells.push(GridCell {
            row,
            col,
            value: GridValue::Blank,
            style,
        });
    }

    pub fn merge(&mut self, m: Merged) {
        self.merged.push(m);
    }
}

/// Ghi một hoặc nhiều trang tính thành tệp xlsx (byte). Tên trang được làm sạch và không trùng nhau.
pub fn write_grid(sheets: &[GridSheet]) -> Result<Vec<u8>, XlsxError> {
    let mut wb = Workbook::new();
    let mut used: Vec<String> = Vec::new();
    for spec in sheets {
        let name = unique_sheet_name(&spec.name, &used);
        used.push(name.clone());
        let ws = wb.add_worksheet();
        ws.set_name(name)?;
        for (i, w) in spec.col_widths.iter().enumerate() {
            ws.set_column_width(i as u16, *w)?;
        }
        for (r, h) in &spec.row_heights {
            ws.set_row_height(*r, *h)?;
        }
        for c in &spec.cells {
            let f = c.style.format();
            match &c.value {
                GridValue::Blank => {
                    ws.write_blank(c.row, c.col, &f)?;
                }
                GridValue::Text(s) => {
                    ws.write_string_with_format(c.row, c.col, safe_text(s).as_ref(), &f)?;
                }
                GridValue::Number(n) if n.is_finite() => {
                    ws.write_number_with_format(c.row, c.col, *n, &f)?;
                }
                GridValue::Number(_) => {
                    ws.write_blank(c.row, c.col, &f)?;
                }
            }
        }
        for m in &spec.merged {
            let f = m.style.format();
            ws.merge_range(
                m.first_row,
                m.first_col,
                m.last_row,
                m.last_col,
                safe_text(&m.text).as_ref(),
                &f,
            )?;
        }
        if let Some((r, c)) = spec.freeze {
            ws.set_freeze_panes(r, c)?;
        }
        if let Some((r0, c0, r1, c1)) = spec.autofilter {
            ws.autofilter(r0, c0, r1, c1)?;
        }
    }
    if sheets.is_empty() {
        wb.add_worksheet();
    }
    Ok(wb.save_to_buffer()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xlsx::{ReadCell, read_xlsx};

    #[test]
    fn ghi_o_theo_toa_do_va_doc_lai() {
        let mut s = GridSheet::new("Phiếu");
        s.col_widths = vec![3.0, 40.0, 22.0];
        s.text(1, 1, "Họ tên", Style::default());
        s.number(
            1,
            2,
            1_234_567.0,
            Style {
                num_format: Some("#,##0"),
                h: HAlign::Right,
                ..Style::default()
            },
        );
        s.merge(Merged {
            first_row: 3,
            first_col: 1,
            last_row: 3,
            last_col: 2,
            text: "Lưu ý".to_owned(),
            style: Style {
                wrap: true,
                ..Style::default()
            },
        });
        s.row_heights.push((3, 70.0));
        s.freeze = Some((1, 1));
        let bytes = write_grid(&[s]).unwrap();
        let sheets = read_xlsx(&bytes).unwrap();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name, "Phiếu");
        assert_eq!(sheets[0].cell(1, 1), &ReadCell::Text("Họ tên".to_owned()));
        assert_eq!(sheets[0].cell(1, 2), &ReadCell::Number(1_234_567.0));
        assert_eq!(sheets[0].cell(3, 1), &ReadCell::Text("Lưu ý".to_owned()));
    }

    #[test]
    fn ten_trang_khong_trung() {
        let bytes = write_grid(&[GridSheet::new("A"), GridSheet::new("a")]).unwrap();
        let names: Vec<String> = read_xlsx(&bytes).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["A", "a (2)"]);
    }
}
