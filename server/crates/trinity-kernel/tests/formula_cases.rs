//! Bảng ca dùng chung TS ↔ Rust của bộ công thức bảng tuỳ biến (M57): `server/contracts/cases/formula.json`. Kết quả do
//! bản TS sinh (`services/crm/src/custom-objects/__tests__/formula-cases.spec.ts`); test này chạy cùng đầu vào qua Rust.

use serde_json::Value;
use trinity_kernel::formula::{RefKind, Val, check_formula, collect_refs, evaluate_formula, parse_formula};
use trinity_kernel::number::js_round;

fn table() -> Value {
    let path = format!("{}/../../contracts/cases/formula.json", manifest_dir());
    serde_json::from_str(&std::fs::read_to_string(path).expect("đọc formula.json")).expect("formula.json hợp lệ")
}

/// Kiểu trường cố định của bảng (khớp `KINDS` trong spec TS).
fn ref_kind(k: &str) -> Option<RefKind> {
    match k {
        "gia_goc" | "uu_dai" | "so_buoi" | "don_gia" | "so_luong" => Some(RefKind::Num),
        "bat_dau" | "ket_thuc" | "ngay_sinh" => Some(RefKind::Date),
        _ => None,
    }
}

fn val(v: &Value) -> Option<Val> {
    match v {
        Value::Number(n) => n.as_f64().map(Val::Num),
        Value::String(s) => Some(Val::Str(s.clone())),
        _ => None,
    }
}

fn num_of(v: &Value) -> f64 {
    match v.as_str() {
        Some("-0") => -0.0,
        Some(s) => s.parse().expect("số đặc biệt"),
        None => v.as_f64().expect("số"),
    }
}

fn same(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

fn run(expr: &str, vals: &Value) -> Value {
    let result = parse_formula(expr).and_then(|ast| {
        check_formula(&ast, &ref_kind)?;
        Ok(evaluate_formula(&ast, &|k| vals.get(k).and_then(val)))
    });
    match result {
        Ok(v) => serde_json::json!({ "value": v }),
        Err(e) => serde_json::json!({ "error": e.0 }),
    }
}

/// So kết quả theo giá trị số (JSON ghi -0 thành 0 và số nguyên/số thực cùng một giá trị).
fn same_out(got: &Value, want: &Value) -> bool {
    match (got.get("value"), want.get("value")) {
        (Some(a), Some(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => x == y,
            (None, None) => a.is_null() && b.is_null(),
            _ => false,
        },
        _ => got == want,
    }
}

#[test]
fn bang_ca_cong_thuc_khop_ban_ts() {
    let t = table();
    let rows = t["formula"].as_array().expect("nhóm formula");
    assert!(rows.len() >= 300, "bảng chỉ có {} ca", rows.len());
    let bad: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            let got = run(r["expr"].as_str().expect("expr"), &r["vals"]);
            (!same_out(&got, &r["out"])).then(|| format!("{} {} → Rust {got}, TS {}", r["expr"], r["vals"], r["out"]))
        })
        .collect();
    assert!(bad.is_empty(), "formula: {} ca lệch\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn js_round_khop_math_round() {
    let t = table();
    for r in t["js_round"].as_array().expect("nhóm js_round") {
        let got = js_round(num_of(&r["in"]));
        let want = num_of(&r["out"]);
        assert!(
            same(got, want) && got.is_sign_negative() == want.is_sign_negative(),
            "{r} → Rust {got}"
        );
    }
}

#[test]
fn collect_refs_khop() {
    let t = table();
    for r in t["collect_refs"].as_array().expect("nhóm collect_refs") {
        let got: Vec<String> = collect_refs(&parse_formula(r["expr"].as_str().expect("expr")).expect("hợp lệ"))
            .into_iter()
            .collect();
        assert_eq!(serde_json::json!(got), r["out"], "{r}");
    }
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
