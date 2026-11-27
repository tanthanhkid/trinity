//! K29 — ca biên của đọc/ghi xlsx.

use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};
use rust_xlsxwriter::{Format, Workbook};
use trinity_docgen::xlsx::{Cell, Column, ReadCell, SheetSpec, XlsxError, read_first_sheet, read_xlsx, write_xlsx};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(manifest_dir()).join("tests/fixtures").join(name)
}

fn dt(s: &str) -> chrono::NaiveDateTime {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
}

#[test]
fn he_ngay_1904_va_chi_doc_trang_dau() {
    // Tệp exceljs ghi với `date1904 = true` (2026-11-26 09:05), có 2 trang.
    let bytes = std::fs::read(fixture("date1904.xlsx")).unwrap();
    let first = read_first_sheet(&bytes).unwrap();
    assert_eq!(first.name, "Hệ 1904");
    assert_eq!(first.cell(0, 0), &ReadCell::DateTime(dt("2026-11-26 09:05:00")));
    assert_eq!(read_xlsx(&bytes).unwrap().len(), 2);
}

#[test]
fn loi_nam_nhuan_1900_cua_excel() {
    // Excel coi 1900 là năm nhuận: số 59 = 28/02/1900, 61 = 01/03/1900 (60 là ngày 29/02/1900 không có thật).
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    let f = Format::new().set_num_format("dd/mm/yyyy");
    ws.write_number_with_format(0, 0, 59.0, &f).unwrap();
    ws.write_number_with_format(0, 1, 61.0, &f).unwrap();
    ws.write_number_with_format(0, 2, 1.0, &f).unwrap();
    let s = read_first_sheet(&wb.save_to_buffer().unwrap()).unwrap();
    assert_eq!(s.cell(0, 0), &ReadCell::DateTime(dt("1900-02-28 00:00:00")));
    assert_eq!(s.cell(0, 1), &ReadCell::DateTime(dt("1900-03-01 00:00:00")));
    assert_eq!(s.cell(0, 2), &ReadCell::DateTime(dt("1900-01-01 00:00:00")));
}

#[test]
fn o_xa_khong_lam_phinh_bo_nho() {
    // Ô duy nhất mỗi dòng ở cột 15000: không lưu 15000 ô trống mỗi dòng, vẫn đọc đúng vị trí từ A1.
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    for r in 0..200u32 {
        ws.write_string(r, 15_000, "x").unwrap();
    }
    let s = read_first_sheet(&wb.save_to_buffer().unwrap()).unwrap();
    assert_eq!(s.col_offset, 15_000);
    assert!(s.rows.iter().all(|r| r.len() == 1 && r.capacity() == 1));
    assert_eq!(s.cell(199, 15_000), &ReadCell::Text("x".into()));
    assert_eq!(s.cell(0, 0), &ReadCell::Empty);
    assert_eq!(s.row_width(0), 15_001);
}

#[test]
fn ngay_ngoai_khoang_excel_ghi_dang_chuoi_va_ten_trang() {
    let spec = |name: &str| SheetSpec {
        name: name.into(),
        columns: vec![Column::new("Ngày", 12.0), Column::new("Lúc", 18.0)],
        rows: vec![vec![
            Cell::Date(NaiveDate::from_ymd_opt(1899, 12, 31).unwrap()),
            Cell::DateTime("1850-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap()),
        ]],
        ..SheetSpec::default()
    };
    let bytes = write_xlsx(&[spec("'Báo cáo'"), spec("báo cáo"), spec("History")]).unwrap();
    let sheets = read_xlsx(&bytes).unwrap();
    let names: Vec<&str> = sheets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Báo cáo", "báo cáo (2)", "History (1)"]);
    assert_eq!(sheets[0].cell(1, 0), &ReadCell::Text("31/12/1899".into()));
    assert_eq!(sheets[0].cell(1, 1), &ReadCell::Text("01/01/1850 07:00".into()));
}

#[test]
fn qua_so_cot_bao_loi() {
    let spec = SheetSpec {
        rows: vec![vec![Cell::Empty; 16_385]],
        ..SheetSpec::default()
    };
    assert!(matches!(write_xlsx(&[spec]), Err(XlsxError::TooManyColumns)));
}

#[test]
fn as_trimmed_text_nhu_parse_cell_raw() {
    assert_eq!(
        ReadCell::Text("  NV01 ".into()).as_trimmed_text().as_deref(),
        Some("NV01")
    );
    assert_eq!(ReadCell::Text("   ".into()).as_trimmed_text(), None);
    assert_eq!(ReadCell::Number(85.5).as_trimmed_text().as_deref(), Some("85.5"));
    assert_eq!(ReadCell::Bool(true).as_trimmed_text(), None);
    assert_eq!(ReadCell::DateTime(dt("2026-11-26 00:00:00")).as_trimmed_text(), None);
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
