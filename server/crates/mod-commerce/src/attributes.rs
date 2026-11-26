//! Kiểm và chuẩn hoá `products.attributes` theo định nghĩa thuộc tính của danh mục (M25). Hàm thuần, chuyển từ
//! `product-attributes.validator.ts`: cùng thứ tự kiểm, cùng câu lỗi 400, cùng chuyển kiểu của JS (`Number(v)`).
//!
//! Chỗ lệch có chủ đích: kiểu `date` nhận ISO 8601 và các dạng số thường gặp (`Y/M/D`, `M/D/Y`, `Y-M-D` một chữ số,
//! `Nov 5, 2026`); các dạng lạ mà `Date.parse` của V8 còn nhận (vd chuỗi `"0"` thành năm 2000) bị từ chối.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;
use trinity_kernel::json::js_number;

/// 9 kiểu thuộc tính được nhận (`ProductAttributeDef.type` là `varchar(32)`, không phải enum Postgres).
pub const ATTRIBUTE_TYPES: [&str; 9] = [
    "text",
    "number",
    "currency",
    "percent",
    "date",
    "select",
    "multiselect",
    "textarea",
    "boolean",
];

const TEXT_MAX: usize = 500;
const TEXTAREA_MAX: usize = 10_000;
/// Trần số, dưới `Number.MAX_SAFE_INTEGER`.
const NUMBER_CEILING: f64 = 1_000_000_000_000.0;

/// Phần của định nghĩa thuộc tính cần để kiểm.
#[derive(Debug, Clone)]
pub struct AttributeDef {
    pub key: String,
    pub label: String,
    pub r#type: String,
    pub options: Option<Value>,
    pub is_required: bool,
}

fn bad(msg: impl Into<String>) -> HttpError {
    HttpError::bad_request(msg.into())
}

/// `validateProductAttributes`: trả object sẽ ghi vào cột `attributes` (khoá theo thứ tự định nghĩa).
pub fn validate_product_attributes(
    defs: &[AttributeDef],
    raw: Option<&Value>,
) -> Result<Map<String, Value>, HttpError> {
    let input = normalize_input(raw)?;
    if defs.is_empty() {
        if !input.is_empty() {
            return Err(bad(
                "Sản phẩm chưa gán danh mục (hoặc danh mục chưa có thuộc tính nào) — không thể nhập attributes",
            ));
        }
        return Ok(Map::new());
    }
    for key in input.keys() {
        if !defs.iter().any(|d| &d.key == key) {
            return Err(bad(format!("Thuộc tính \"{key}\" không thuộc danh mục đã chọn")));
        }
    }
    let mut out = Map::new();
    for def in defs {
        out.insert(def.key.clone(), validate_one(def, input.get(&def.key))?);
    }
    Ok(out)
}

fn normalize_input(raw: Option<&Value>) -> Result<Map<String, Value>, HttpError> {
    match raw {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err(bad("attributes phải là object")),
    }
}

fn validate_one(def: &AttributeDef, value: Option<&Value>) -> Result<Value, HttpError> {
    let value = match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(v) => Some(v),
    };
    let Some(value) = value else {
        if def.is_required {
            return Err(bad(format!("Thuộc tính \"{}\" là bắt buộc", def.label)));
        }
        return Ok(Value::Null);
    };
    let label = def.label.as_str();
    match def.r#type.as_str() {
        "text" => string(label, value, TEXT_MAX),
        "textarea" => string(label, value, TEXTAREA_MAX),
        "number" | "currency" => number(label, value).map(num),
        "percent" => {
            let n = number(label, value)?;
            if !(0.0..=100.0).contains(&n) {
                return Err(bad(format!("Thuộc tính \"{label}\" phải trong khoảng 0-100")));
            }
            Ok(num(n))
        }
        "date" => match value {
            Value::String(s) if is_date(s) => Ok(value.clone()),
            _ => Err(bad(format!("Thuộc tính \"{label}\" phải là ngày hợp lệ (ISO 8601)"))),
        },
        "boolean" => match value {
            Value::Bool(_) => Ok(value.clone()),
            _ => Err(bad(format!("Thuộc tính \"{label}\" phải là boolean"))),
        },
        "select" => {
            let Value::String(s) = value else {
                return Err(bad(format!("Thuộc tính \"{label}\" phải là 1 lựa chọn (chuỗi)")));
            };
            if !option_values(def)?.contains(s) {
                return Err(bad(format!("Thuộc tính \"{label}\" có giá trị không hợp lệ")));
            }
            Ok(value.clone())
        }
        "multiselect" => {
            let items = match value {
                Value::Array(a) if a.iter().all(Value::is_string) => a,
                _ => return Err(bad(format!("Thuộc tính \"{label}\" phải là mảng chuỗi"))),
            };
            let allowed = option_values(def)?;
            for v in items.iter().filter_map(Value::as_str) {
                if !allowed.iter().any(|a| a == v) {
                    return Err(bad(format!("Thuộc tính \"{label}\" có giá trị \"{v}\" không hợp lệ")));
                }
            }
            Ok(value.clone())
        }
        // Định nghĩa hỏng (dữ liệu cấu hình sai): báo to, không bỏ qua.
        _ => Err(bad(format!("Danh mục cấu hình sai kiểu cho thuộc tính \"{label}\""))),
    }
}

fn string(label: &str, value: &Value, max: usize) -> Result<Value, HttpError> {
    let Value::String(s) = value else {
        return Err(bad(format!("Thuộc tính \"{label}\" phải là chuỗi")));
    };
    // `String.length` của JS đếm đơn vị UTF-16.
    if s.encode_utf16().count() > max {
        return Err(bad(format!("Thuộc tính \"{label}\" tối đa {max} ký tự")));
    }
    Ok(value.clone())
}

/// Số JSON như JS in ra: số nguyên giữ dạng nguyên (`12`, không `12.0`).
fn num(n: f64) -> Value {
    let text = js_number(n);
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

fn number(label: &str, value: &Value) -> Result<f64, HttpError> {
    let n = match value {
        Value::Bool(_) => f64::NAN,
        other => js_to_number(other),
    };
    if !n.is_finite() {
        return Err(bad(format!("Thuộc tính \"{label}\" phải là số")));
    }
    if n.abs() > NUMBER_CEILING {
        return Err(bad(format!("Thuộc tính \"{label}\" vượt trần cho phép")));
    }
    Ok(n)
}

fn option_values(def: &AttributeDef) -> Result<Vec<String>, HttpError> {
    let Some(Value::Array(opts)) = &def.options else {
        return Err(bad(format!(
            "Danh mục thiếu cấu hình lựa chọn (options) cho thuộc tính \"{}\"",
            def.label
        )));
    };
    Ok(opts
        .iter()
        .filter_map(|o| o.get("value").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

// ---------------------------------------------------------------------------------------------------------------
// Chuyển kiểu như JS

/// Khoảng trắng của `String.prototype.trim` (WhiteSpace + LineTerminator của ECMAScript).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// `Number(value)` cho giá trị JSON (NaN khi không đổi được).
pub fn js_to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_string_to_number(s),
        Value::Array(_) => js_string_to_number(&js_to_string(v)),
        Value::Object(_) => f64::NAN,
    }
}

/// `String(value)` đủ cho mảng lồng nhau (`[1,[2,3]]` → `1,2,3`).
fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn js_string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return if rest.is_empty() {
                f64::NAN
            } else {
                u128::from_str_radix(rest, radix).map_or(f64::NAN, |n| n as f64)
            };
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Chỉ dạng thập phân của JS; chữ như `inf`/`nan` mà Rust nhận thì không phải số của JS.
    if !t
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

// ---------------------------------------------------------------------------------------------------------------
// Date.parse

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// Chuỗi có phải ngày mà `Date.parse` nhận (xem ghi chú đầu tệp về phạm vi).
pub fn is_date(s: &str) -> bool {
    let t = s.trim_matches(is_js_space);
    !t.is_empty() && (iso(t) || numeric_date(t) || month_name_date(t))
}

fn digits(s: &str, min: usize, max: usize) -> Option<u32> {
    (s.len() >= min && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn valid_ymd(y: u32, m: u32, d: u32) -> bool {
    // V8 chỉ kiểm khoảng 1..31 cho ngày (30/2 vẫn nhận), không kiểm số ngày của tháng.
    let _ = y;
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

fn iso(t: &str) -> bool {
    let (date, time) = match t.find(['T', ' ']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    // Năm: 4 chữ số hoặc `±` + 6 chữ số.
    let (year, rest) = if let Some(r) = date.strip_prefix(['+', '-']) {
        if r.len() < 6 {
            return false;
        }
        (digits(&r[..6], 6, 6), &r[6..])
    } else {
        if date.len() < 4 {
            return false;
        }
        (digits(&date[..4], 4, 4), &date[4..])
    };
    let Some(y) = year else { return false };
    let parts: Vec<&str> = rest.split('-').collect();
    let ok_date = match parts.as_slice() {
        [""] => true,
        ["", m] => digits(m, 2, 2).is_some_and(|m| (1..=12).contains(&m)),
        ["", m, d] => match (digits(m, 2, 2), digits(d, 2, 2)) {
            (Some(m), Some(d)) => valid_ymd(y, m, d),
            _ => false,
        },
        _ => false,
    };
    if !ok_date {
        return false;
    }
    match time {
        None => true,
        Some(tm) => parts.len() == 3 && iso_time(tm),
    }
}

fn iso_time(t: &str) -> bool {
    let (clock, zone) = match t.find(['Z', 'z', '+', '-']) {
        Some(i) => (&t[..i], &t[i..]),
        None => (t, ""),
    };
    let zone_ok = match zone {
        "" | "Z" | "z" => true,
        z => {
            let z = &z[1..];
            let z = z.replace(':', "");
            digits(&z, 4, 4).is_some_and(|v| v / 100 < 24 && v % 100 < 60)
        }
    };
    let mut it = clock.split(':');
    let (h, m) = (
        it.next().and_then(|v| digits(v, 2, 2)),
        it.next().and_then(|v| digits(v, 2, 2)),
    );
    let (Some(h), Some(m)) = (h, m) else { return false };
    let sec = match it.next() {
        None => Some((0, None)),
        Some(s) => {
            let (whole, frac) = s.split_once('.').map_or((s, None), |(a, b)| (a, Some(b)));
            digits(whole, 2, 2).map(|w| (w, frac))
        }
    };
    let Some((sec, frac)) = sec else { return false };
    if it.next().is_some() || m > 59 || sec > 59 || h > 24 || (h == 24 && (m != 0 || sec != 0)) {
        return false;
    }
    if frac.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    zone_ok
}

/// `Y/M/D`, `Y-M-D` (một chữ số được), `M/D/Y`, có thể kèm giờ `H:mm[:ss]` sau khoảng trắng.
fn numeric_date(t: &str) -> bool {
    let (date, time) = t.split_once(' ').map_or((t, None), |(a, b)| (a, Some(b.trim())));
    if time.is_some_and(|tm| !clock_only(tm)) {
        return false;
    }
    let sep = if date.contains('/') { '/' } else { '-' };
    let p: Vec<&str> = date.split(sep).collect();
    let [a, b, c] = p.as_slice() else { return false };
    let (Some(x), Some(y), Some(z)) = (digits(a, 1, 4), digits(b, 1, 2), digits(c, 1, 4)) else {
        return false;
    };
    if a.len() >= 3 {
        valid_ymd(x, y, z)
    } else if sep == '/' {
        valid_ymd(z, x, y)
    } else {
        // `5-11-2026`: V8 đọc tháng-ngày-năm.
        c.len() >= 3 && valid_ymd(z, x, y)
    }
}

fn clock_only(t: &str) -> bool {
    let parts: Vec<&str> = t.split(':').collect();
    matches!(parts.len(), 2 | 3)
        && parts.iter().all(|p| digits(p, 1, 2).is_some())
        && digits(parts[0], 1, 2).is_some_and(|h| h <= 24)
        && parts[1..].iter().all(|p| digits(p, 1, 2).is_some_and(|v| v <= 59))
}

/// `Nov 5, 2026`, `5 Nov 2026`, `November 5 2026`.
fn month_name_date(t: &str) -> bool {
    let cleaned = t.replace(',', " ");
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    let month = |w: &str| {
        let lw = w.to_ascii_lowercase();
        lw.len() >= 3
            && MONTHS
                .iter()
                .position(|m| {
                    lw.starts_with(m)
                        && "january february march april may june july august september october november december"
                            .contains(&lw)
                })
                .is_some()
    };
    match words.as_slice() {
        [m, d, y] if month(m) => digits(d, 1, 2).is_some_and(|d| (1..=31).contains(&d)) && digits(y, 4, 4).is_some(),
        [d, m, y] if month(m) => digits(d, 1, 2).is_some_and(|d| (1..=31).contains(&d)) && digits(y, 4, 4).is_some(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn def(key: &str, ty: &str, required: bool, options: Option<Value>) -> AttributeDef {
        AttributeDef {
            key: key.into(),
            label: format!("L-{key}"),
            r#type: ty.into(),
            options,
            is_required: required,
        }
    }

    fn err(defs: &[AttributeDef], raw: Value) -> String {
        match validate_product_attributes(defs, Some(&raw))
            .unwrap_err()
            .body()
            .message
        {
            trinity_kernel::error::Message::One(m) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn so_nhu_number_cua_js() {
        for (v, want) in [
            (json!("  "), Some(0.0)),
            (json!("0x1A"), Some(26.0)),
            (json!("1e3"), Some(1000.0)),
            (json!(".5"), Some(0.5)),
            (json!("5."), Some(5.0)),
            (json!(" 5 "), Some(5.0)),
            (json!(["7"]), Some(7.0)),
            (json!([]), Some(0.0)),
            (json!("1_0"), None),
            (json!("inf"), None),
            (json!("nan"), None),
            (json!("1 2"), None),
            (json!([1, 2]), None),
            (json!({}), None),
            (json!("Infinity"), None),
            (json!("٣"), None),
        ] {
            let n = js_to_number(&v);
            match want {
                Some(w) => assert!((n - w).abs() < f64::EPSILON, "{v}: {n}"),
                None => assert!(!n.is_finite(), "{v}: {n}"),
            }
        }
    }

    #[test]
    fn ngay_nhu_date_parse() {
        for ok in [
            "2026-11-05",
            "2026",
            "2026-11",
            "2026-11-05T10:00",
            "2026-11-05T24:00",
            "2026-11-05T10:00:00Z",
            "2026-11-05T10:00:00.1234Z",
            "2026-11-05 10:00",
            "2026-11-05T10:00:00+07:00",
            "2026-11-05T10:00:00+0700",
            "+002026-11-05",
            "2026-02-30",
            "2026/11/05",
            "11/05/2026",
            "Nov 5, 2026",
            " 2026-11-05 ",
        ] {
            assert!(is_date(ok), "{ok}");
        }
        for no in [
            "2026-13-01",
            "2026-11-05T25:00",
            "2026-11-05T10",
            "20261105",
            "abc",
            "",
            "2026-11-32",
        ] {
            assert!(!is_date(no), "{no}");
        }
    }

    #[test]
    fn luat_chung() {
        let defs = [
            def("name", "text", true, None),
            def("qty", "number", false, None),
            def("pct", "percent", false, None),
            def("tone", "select", false, Some(json!([{"value":"a","label":"A"}]))),
            def(
                "multi",
                "multiselect",
                false,
                Some(json!([{"value":"a","label":"A"},{"value":"b","label":"B"}])),
            ),
        ];
        assert_eq!(
            err(&[], json!({"x": 1})),
            "Sản phẩm chưa gán danh mục (hoặc danh mục chưa có thuộc tính nào) — không thể nhập attributes"
        );
        assert_eq!(err(&defs, json!([1])), "attributes phải là object");
        assert_eq!(
            err(&defs, json!({"zzz": 1, "name": "a"})),
            "Thuộc tính \"zzz\" không thuộc danh mục đã chọn"
        );
        assert_eq!(err(&defs, json!({})), "Thuộc tính \"L-name\" là bắt buộc");
        assert_eq!(err(&defs, json!({"name": ""})), "Thuộc tính \"L-name\" là bắt buộc");
        assert_eq!(err(&defs, json!({"name": 5})), "Thuộc tính \"L-name\" phải là chuỗi");
        assert_eq!(
            err(&defs, json!({"name": "a", "qty": true})),
            "Thuộc tính \"L-qty\" phải là số"
        );
        assert_eq!(
            err(&defs, json!({"name": "a", "qty": 2e12})),
            "Thuộc tính \"L-qty\" vượt trần cho phép"
        );
        assert_eq!(
            err(&defs, json!({"name": "a", "pct": 101})),
            "Thuộc tính \"L-pct\" phải trong khoảng 0-100"
        );
        assert_eq!(
            err(&defs, json!({"name": "a", "tone": "z"})),
            "Thuộc tính \"L-tone\" có giá trị không hợp lệ"
        );
        assert_eq!(
            err(&defs, json!({"name": "a", "multi": ["a", "q"]})),
            "Thuộc tính \"L-multi\" có giá trị \"q\" không hợp lệ"
        );
        assert_eq!(
            err(&defs, json!({"name": "a", "multi": "a"})),
            "Thuộc tính \"L-multi\" phải là mảng chuỗi"
        );

        let ok = validate_product_attributes(&defs, Some(&json!({"qty": "12.50", "name": "x", "pct": 5}))).unwrap();
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"name":"x","qty":12.5,"pct":5,"tone":null,"multi":null}"#
        );
    }

    #[test]
    fn cau_hinh_hong_va_do_dai_utf16() {
        let bad_type = [def("k", "weird", false, None)];
        assert_eq!(
            err(&bad_type, json!({"k": 1})),
            "Danh mục cấu hình sai kiểu cho thuộc tính \"L-k\""
        );
        let no_opts = [def("k", "select", false, None)];
        assert_eq!(
            err(&no_opts, json!({"k": "a"})),
            "Danh mục thiếu cấu hình lựa chọn (options) cho thuộc tính \"L-k\""
        );
        // 300 emoji = 600 đơn vị UTF-16 > 500 (JS `length`), dù chỉ 300 ký tự.
        let text = [def("t", "text", false, None)];
        assert_eq!(
            err(&text, json!({"t": "😀".repeat(300)})),
            "Thuộc tính \"L-t\" tối đa 500 ký tự"
        );
    }
}
