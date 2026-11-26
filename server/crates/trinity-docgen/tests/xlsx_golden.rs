//! K29 — golden xlsx dùng chung với bản Node (exceljs). Bảng mẫu: `server/contracts/cases/xlsx.json`; phía TS:
//! `services/crm/src/common/helpers/__tests__/docgen-xlsx-golden.spec.ts`.
//! - Rust ghi bảng mẫu, đọc lại ⇒ khớp `expected` (giá trị + loại ô; định dạng số/ngày kiểm ở phía TS bằng exceljs).
//! - Đọc `fixtures/exceljs.xlsx` (tệp exceljs ghi) ⇒ khớp `expected`.
//! - `fixtures/rust.xlsx` (tệp Rust ghi, phía TS đọc bằng exceljs) phải trùng nội dung với lần ghi hiện tại.
//!   Ghi lại: `UPDATE_XLSX_FIXTURE=1 cargo test -p trinity-docgen --test xlsx_golden`.

use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};
use trinity_docgen::xlsx::{Cell, Column, NumFormat, ReadCell, SheetSpec, read_first_sheet, write_xlsx};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn cases() -> Value {
    serde_json::from_str(&std::fs::read_to_string(root().join("server/contracts/cases/xlsx.json")).unwrap()).unwrap()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn cell(v: &Value) -> Cell {
    let Some(o) = v.as_object() else { return Cell::Empty };
    if let Some(s) = o.get("s").and_then(Value::as_str) {
        return Cell::text(s);
    }
    if let Some(n) = o.get("n").and_then(Value::as_f64) {
        let f = match o.get("fmt").and_then(Value::as_str) {
            Some("int") => NumFormat::Integer,
            Some("dec2") => NumFormat::Decimal2,
            _ => NumFormat::General,
        };
        return Cell::Number(n, f);
    }
    if let Some(b) = o.get("b").and_then(Value::as_bool) {
        return Cell::Bool(b);
    }
    if let Some(d) = o.get("d").and_then(Value::as_str) {
        return Cell::Date(NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap());
    }
    if let Some(t) = o.get("dt").and_then(Value::as_str) {
        return Cell::DateTime(t.parse::<DateTime<Utc>>().unwrap());
    }
    panic!("ô mẫu lạ: {v}");
}

fn spec(c: &Value) -> SheetSpec {
    SheetSpec {
        name: c["sheet"].as_str().unwrap().to_owned(),
        title: Some(c["title"].as_str().unwrap().to_owned()),
        subtitle: Some(c["subtitle"].as_str().unwrap().to_owned()),
        columns: c["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| Column::new(x[0].as_str().unwrap(), x[1].as_f64().unwrap()))
            .collect(),
        rows: c["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_array().unwrap().iter().map(cell).collect())
            .collect(),
    }
}

/// Nội dung đọc được theo dạng `expected` (bỏ `f`: calamine không trả chuỗi định dạng, chỉ biết ô là ngày).
fn dump(bytes: &[u8]) -> Value {
    let sheet = read_first_sheet(bytes).unwrap();
    Value::Array(
        sheet
            .rows
            .iter()
            .map(|r| {
                Value::Array(
                    r.iter()
                        .map(|c| match c {
                            ReadCell::Empty => Value::Null,
                            ReadCell::Text(s) => json!({ "t": "s", "v": s }),
                            ReadCell::Number(n) => {
                                if n.fract() == 0.0 && n.abs() < 9e15 {
                                    json!({ "t": "n", "v": *n as i64 })
                                } else {
                                    json!({ "t": "n", "v": n })
                                }
                            }
                            ReadCell::Bool(b) => json!({ "t": "b", "v": b }),
                            ReadCell::DateTime(t) => {
                                json!({ "t": "d", "v": t.format("%Y-%m-%d %H:%M:%S").to_string() })
                            }
                            ReadCell::Error(e) => json!({ "t": "e", "v": e }),
                        })
                        .collect(),
                )
            })
            .collect(),
    )
}

fn without_formats(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(without_formats).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| *k != "f")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn rust_ghi_roi_doc_lai_khop_mau() {
    let c = cases();
    let bytes = write_xlsx(&[spec(&c)]).unwrap();
    if std::env::var("UPDATE_XLSX_FIXTURE").as_deref() == Ok("1") {
        std::fs::write(fixture("rust.xlsx"), &bytes).unwrap();
    }
    assert_eq!(dump(&bytes), without_formats(&c["expected"]));
    // Tệp Rust ghi đã lưu (phía TS đọc bằng exceljs) phải còn trùng nội dung với lần ghi hiện tại.
    let saved = std::fs::read(fixture("rust.xlsx")).expect("có tests/fixtures/rust.xlsx");
    assert_eq!(
        dump(&saved),
        dump(&bytes),
        "rust.xlsx cũ — ghi lại bằng UPDATE_XLSX_FIXTURE=1"
    );
}

#[test]
fn doc_tep_exceljs_ghi() {
    let bytes = std::fs::read(fixture("exceljs.xlsx")).unwrap();
    assert_eq!(dump(&bytes), without_formats(&cases()["expected"]));
}

#[test]
fn tep_hong_bao_loi_ro() {
    let err = read_first_sheet(b"khong phai xlsx").unwrap_err();
    assert!(err.to_string().contains("không phải xlsx"), "{err}");
}

/// Tệp mẫu hiện có của bản Node: mẫu nhập phiếu lương (`buildImportTemplate` của
/// `services/payroll/src/payslips/payslip-import.helper.ts`, tháng 11/2026, 2 nhân viên) — chỗ nhập xlsx duy nhất.
#[test]
fn doc_mau_nhap_phieu_luong_cua_ban_node() {
    let sheet = read_first_sheet(&std::fs::read(fixture("payslip-template.xlsx")).unwrap()).unwrap();
    assert_eq!(sheet.name, "Nhập phiếu lương");
    let title = sheet.cell(0, 0).as_trimmed_text().unwrap();
    assert!(
        title.starts_with("MẪU NHẬP PHIẾU LƯƠNG") && title.contains("11/2026"),
        "{title}"
    );
    let header: Vec<String> = sheet.rows[1]
        .iter()
        .map(|c| c.as_trimmed_text().unwrap_or_default())
        .collect();
    assert_eq!(&header[..3], ["Mã NV", "Họ tên", "Ngày công"]);
    let col = |name: &str| {
        header
            .iter()
            .position(|h| h == name)
            .unwrap_or_else(|| panic!("thiếu cột {name}"))
    };
    assert_eq!(sheet.cell(2, 0).as_trimmed_text().as_deref(), Some("NV001"));
    assert_eq!(sheet.cell(2, 1).as_trimmed_text().as_deref(), Some("Nguyễn Văn Ánh"));
    assert_eq!(sheet.cell(2, col("Lương cơ bản")), &ReadCell::Number(12_000_000.0));
    assert_eq!(sheet.cell(2, col("Ngày công")), &ReadCell::Number(22.5));
    assert_eq!(sheet.cell(3, 1).as_trimmed_text().as_deref(), Some("Lê Thị Đào"));
    assert_eq!(sheet.cell(3, col("Lương cơ bản")), &ReadCell::Empty);
}
