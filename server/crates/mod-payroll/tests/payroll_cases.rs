//! Bảng ca dùng chung TS ↔ Rust của bộ tính lương và thuế (M30a): `server/contracts/cases/payroll.json`. Kết quả do MÃ TS THẬT
//! sinh (`services/payroll/scripts/gen-payroll-cases.mjs`: cắt nguyên văn các engine và `buildPayslipData`, chạy với Prisma
//! giả); test này chạy cùng đầu vào qua Rust và so TỪNG ĐỒNG, TỪNG DÒNG của ảnh chụp (PLAN mục 10.3).
//!
//! Bảng: 700 ca bảo hiểm, 800 ca thuế (quanh ngưỡng bậc), 400 ca thành phần lương (x,5 đồng), 100 phiếu mẫu, 2.543 công
//! thức hợp lệ × 3 ngữ cảnh + 5.074 ca kiểm công thức (sinh theo văn phạm và ngẫu nhiên), 12 ca `Math.round`.

use mod_payroll::calc::{
    BracketRow, ComponentRow, EmployeeInput, InsuranceRow, ManualInput, PayrollConfig, TaxSettingRow,
    compute_components, compute_insurance, compute_payslip, compute_tax,
};
use mod_payroll::formula::{FormulaContext, FormulaError, evaluate_formula, validate_formula};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use trinity_kernel::number::js_round;

fn table() -> Value {
    let path = format!("{}/../../contracts/cases/payroll.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("đọc payroll.json")).expect("payroll.json hợp lệ")
}

/// Mảng cấu hình của ca: `"std"` ⇒ lấy bộ chuẩn ở khoá `std`.
fn rows<T: DeserializeOwned>(t: &Value, case: &Value, key: &str) -> Vec<T> {
    let v = &case[key];
    let v = if v == "std" { &t["std"][key] } else { v };
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{key}: {e}"))
}

fn i(v: &Value) -> i64 {
    v.as_i64().expect("số nguyên")
}

fn jn(v: &Value) -> f64 {
    v.as_f64().expect("số")
}

#[test]
fn bao_hiem_khop_tung_dong() {
    let t = table();
    let cases = t["insurance"].as_array().unwrap();
    for (n, c) in cases.iter().enumerate() {
        let r = compute_insurance(
            i(&c["insurance_base"]),
            c["month"].as_str().unwrap(),
            &rows::<InsuranceRow>(&t, c, "insurance"),
        )
        .unwrap();
        assert_eq!(
            json!({ "total": r.total, "snapshot": r.snapshot }),
            c["out"],
            "ca bảo hiểm #{n}: {c}"
        );
    }
    assert_eq!(cases.len(), 700);
}

#[test]
fn thue_khop_tung_dong() {
    let t = table();
    let cases = t["tax"].as_array().unwrap();
    for (n, c) in cases.iter().enumerate() {
        let r = compute_tax(
            i(&c["taxable_gross"]),
            i(&c["insurance"]),
            i(&c["dependents_count"]),
            c["month"].as_str().unwrap(),
            &rows::<TaxSettingRow>(&t, c, "tax_settings"),
            &rows::<BracketRow>(&t, c, "brackets"),
        )
        .unwrap();
        let got = json!({ "tax": r.tax, "snapshot": r.snapshot });
        assert_eq!(
            got, c["out"],
            "ca thuế #{n}: gross={} ins={} deps={} tháng {}",
            c["taxable_gross"], c["insurance"], c["dependents_count"], c["month"]
        );
    }
    assert_eq!(cases.len(), 800);
}

#[test]
fn thanh_phan_luong_khop_tung_dong() {
    let t = table();
    let cases = t["components"].as_array().unwrap();
    for (n, c) in cases.iter().enumerate() {
        let r = compute_components(
            i(&c["base_salary"]),
            c["month"].as_str().unwrap(),
            c["rank_code"].as_str(),
            &rows::<ComponentRow>(&t, c, "components"),
        )
        .unwrap();
        let got = json!({
            "allowances": r.allowances, "bonuses": r.bonuses, "deductions": r.deductions,
            "taxableEarnings": r.taxable_earnings, "snapshot": r.snapshot,
        });
        assert_eq!(got, c["out"], "ca thành phần #{n}");
    }
    assert_eq!(cases.len(), 400);
}

#[test]
fn phieu_mau_khop_tung_dong() {
    let t = table();
    let cases = t["payslip"].as_array().unwrap();
    for (n, c) in cases.iter().enumerate() {
        let cfg = PayrollConfig {
            insurance: rows(&t, &c["config"], "insurance"),
            tax_settings: rows(&t, &c["config"], "tax_settings"),
            brackets: rows(&t, &c["config"], "brackets"),
            components: rows(&t, &c["config"], "components"),
        };
        let emp: EmployeeInput = serde_json::from_value(c["emp"].clone()).unwrap();
        let manual: ManualInput = serde_json::from_value(c["manual"].clone()).unwrap();
        let achieved = usize::try_from(i(&c["kpi_achieved"])).unwrap();
        let r = compute_payslip(
            &cfg,
            c["month"].as_str().unwrap(),
            i(&c["engine_base"]),
            achieved,
            &emp,
            &manual,
        )
        .unwrap();
        let got = json!({
            "base_salary": r.base_salary, "kpi_bonus": r.kpi_bonus, "deductions": r.deductions, "total": r.total,
            "insurance_base": r.insurance_base, "base_salary_actual": r.base_salary_actual,
            "components_json": r.components_json, "insurance_json": r.insurance_json, "tax_json": r.tax_json,
        });
        assert_eq!(got, c["out"], "phiếu mẫu #{n}");
    }
    assert_eq!(cases.len(), 100);
}

fn decode(v: &Value) -> f64 {
    match v.as_str() {
        Some("NaN") => f64::NAN,
        Some(s) => s.parse().expect("số đặc biệt"),
        None => jn(v),
    }
}

#[test]
fn kiem_cong_thuc_khop_node() {
    let t = table();
    let cases = t["validate"].as_array().unwrap();
    let mut bad = Vec::new();
    for c in cases {
        let f = c["formula"].as_str().unwrap();
        if validate_formula(f) != c["out"].as_bool().unwrap() {
            bad.push(format!("{f:?}: Node {} / Rust {}", c["out"], validate_formula(f)));
        }
    }
    assert!(
        bad.is_empty(),
        "{} ca lệch:\n{}",
        bad.len(),
        bad.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(cases.len() >= 5000);
}

#[test]
fn tinh_cong_thuc_khop_node() {
    let t = table();
    let cases = t["formula"].as_array().unwrap();
    let mut bad = Vec::new();
    for c in cases {
        let f = c["formula"].as_str().unwrap();
        let ctx = FormulaContext {
            base: jn(&c["ctx"]["base"]),
            achievement_rate: jn(&c["ctx"]["achievement_rate"]),
            revenue: jn(&c["ctx"]["revenue"]),
        };
        let want = &c["out"];
        let got = evaluate_formula(f, ctx);
        let ok = match (got, want.get("value"), want.get("error").and_then(Value::as_str)) {
            (Ok(g), Some(w), _) => g == decode(w),
            (Err(FormulaError::NotFinite), _, Some("nonfinite"))
            | (Err(FormulaError::Invalid), _, Some("invalid"))
            | (Err(FormulaError::Runtime), _, Some("runtime")) => true,
            _ => false,
        };
        if !ok {
            bad.push(format!("{f:?} {ctx:?}: Node {want} / Rust {got:?}"));
        }
    }
    assert!(
        bad.is_empty(),
        "{} ca lệch:\n{}",
        bad.len(),
        bad.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(cases.len() >= 7000);
}

#[test]
fn math_round_khop_node() {
    let t = table();
    for c in t["round"].as_array().unwrap() {
        assert_eq!(js_round(jn(&c["in"])), jn(&c["out"]), "{c}");
    }
}
