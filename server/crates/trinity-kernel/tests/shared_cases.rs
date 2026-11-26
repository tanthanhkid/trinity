//! Bảng ca dùng chung TS ↔ Rust (K26): `server/contracts/cases/kernel.json`. Kết quả trong bảng do bản TS sinh
//! (`services/crm/src/common/helpers/kernel-cases.spec.ts`); test này chạy cùng đầu vào qua hàm Rust và so từng byte.

use std::cmp::Ordering;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use trinity_kernel::number::format_vn_number;
use trinity_kernel::phone::{normalize_phone, phone_variants};
use trinity_kernel::vi::{Collation, SQL_FOLD_FROM, SQL_FOLD_TO, compare, fold_contains, fold_vi};
use trinity_kernel::vn_time::{VnDateStyle, format_vn_date, js_iso_string, parse_vn_date_range_optional};

fn table() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contracts/cases/kernel.json");
    let text = std::fs::read_to_string(path).expect("đọc kernel.json");
    serde_json::from_str(&text).expect("kernel.json hợp lệ")
}

fn rows<'a>(t: &'a Value, key: &str) -> &'a Vec<Value> {
    t[key].as_array().unwrap_or_else(|| panic!("thiếu nhóm {key}"))
}

fn s(v: &Value) -> &str {
    v.as_str().expect("chuỗi")
}

/// Chạy mọi ca của một nhóm, gom ca lệch để báo một lần.
fn check(t: &Value, key: &str, f: impl Fn(&Value) -> Value) -> usize {
    let mut bad = Vec::new();
    let cases = rows(t, key);
    for r in cases {
        let got = f(r);
        if got != r["out"] {
            bad.push(format!("{r} → Rust {got}"));
        }
    }
    assert!(bad.is_empty(), "{key}: {} ca lệch\n{}", bad.len(), bad.join("\n"));
    cases.len()
}

#[test]
fn bang_ca_dung_chung_khop_ban_ts() {
    let t = table();
    assert_eq!(t["sql_fold"], json!({ "from": SQL_FOLD_FROM, "to": SQL_FOLD_TO }));
    let mut n = 0;
    n += check(&t, "fold_vi", |r| json!(fold_vi(s(&r["in"]))));
    n += check(&t, "fold_contains", |r| json!(fold_contains(s(&r["in"]))));
    n += check(&t, "normalize_phone", |r| json!(normalize_phone(s(&r["in"]))));
    n += check(&t, "phone_variants", |r| json!(phone_variants(s(&r["in"]))));
    n += check(
        &t,
        "parse_vn_date_range_optional",
        |r| match parse_vn_date_range_optional(r["from"].as_str(), r["to"].as_str()) {
            Ok(range) => json!({
                "from": range.from.map(js_iso_string),
                "to": range.to.map(js_iso_string),
            }),
            Err(e) => json!({ "error": e.to_string() }),
        },
    );
    n += check(&t, "format_vn_number", |r| {
        let x = match &r["in"] {
            Value::String(v) => match v.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                other => panic!("số dạng chuỗi lạ: {other}"),
            },
            v => v.as_f64().expect("số"),
        };
        json!(format_vn_number(x))
    });
    n += check(&t, "format_vn_date", |r| {
        let at: DateTime<Utc> = s(&r["at"]).parse().expect("thời điểm ISO");
        let style = match s(&r["style"]) {
            "day_month_year" => VnDateStyle::DayMonthYear,
            "day_month_year_2" => VnDateStyle::DayMonthYear2,
            "hour_minute" => VnDateStyle::HourMinute,
            "hour_minute_day_month_year_2" => VnDateStyle::HourMinuteDayMonthYear2,
            "short_date_time" => VnDateStyle::ShortDateTime,
            "iso_date" => VnDateStyle::IsoDate,
            "iso_month" => VnDateStyle::IsoMonth,
            "day_month_2" => VnDateStyle::DayMonth2,
            "month_year_2" => VnDateStyle::MonthYear2,
            other => panic!("kiểu ngày lạ: {other}"),
        };
        json!(format_vn_date(at, style))
    });
    n += check(&t, "compare", |r| {
        let collation = match s(&r["locale"]) {
            "vi" => Collation::Vi,
            "en-numeric" => Collation::EnNumeric,
            "root" => Collation::Root,
            other => panic!("locale lạ: {other}"),
        };
        json!(match compare(s(&r["a"]), s(&r["b"]), collation) {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        })
    });
    assert!(n >= 300, "bảng chỉ có {n} ca");
}
