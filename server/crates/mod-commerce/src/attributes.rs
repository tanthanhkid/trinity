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
    previous: Option<&Map<String, Value>>,
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
        let unchanged = previous.is_some_and(|p| p.get(&def.key).is_some() && p.get(&def.key) == input.get(&def.key));
        out.insert(def.key.clone(), validate_one(def, input.get(&def.key), unchanged)?);
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

/// `unchanged`: giá trị y hệt giá trị đang lưu của sản phẩm (PATCH) — kiểu `date` không kiểm lại, vì `Date.parse` của V8
/// nhận nhiều dạng lạ mà [`is_date`] không nhận hết, và một giá trị đã lưu không được làm hỏng mọi lần sửa sau.
fn validate_one(def: &AttributeDef, value: Option<&Value>, unchanged: bool) -> Result<Value, HttpError> {
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
            Value::String(s) if unchanged || is_date(s) => Ok(value.clone()),
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
            if rest.is_empty() {
                return f64::NAN;
            }
            // Cộng dồn bằng f64 như JS: chuỗi rất dài ra số lớn (hoặc vô cực), không báo lỗi tràn.
            let mut n = 0.0_f64;
            for c in rest.chars() {
                match c.to_digit(radix) {
                    Some(d) => n = n * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return n;
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
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/// Chuỗi có phải ngày mà `Date.parse` nhận. Nhận: ISO 8601 (kể cả `2026T10:00`, `2026-11T10:00`), `toUTCString`
/// (`Thu, 05 Nov 2026 10:00:00 GMT`), `Date.toString`, `Nov 5, 2026 10:00 PM`, `5 Nov 2026`, `11/5/2026 10:00:00 AM`,
/// `2026-11-5`, `5-Nov-2026`. Không nhận chuỗi lạ mà V8 còn nhận (vd `"0"`, `"Nov 5"` thiếu năm). Chuỗi không phải ASCII
/// (sau khi bỏ khoảng trắng đầu/cuối) là không hợp lệ, nên không bao giờ cắt giữa ký tự nhiều byte.
pub fn is_date(s: &str) -> bool {
    let t = s.trim_matches(is_js_space);
    t.is_ascii() && !t.is_empty() && (iso(t) || legacy(t))
}

fn digits(s: &str, min: usize, max: usize) -> Option<u32> {
    (s.len() >= min && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// V8 chỉ kiểm khoảng 1..12 cho tháng và 1..31 cho ngày (30/2 vẫn nhận).
fn valid_md(m: u32, d: u32) -> bool {
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

fn iso(t: &str) -> bool {
    let (date, time) = match t.find(['T', ' ']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    // Năm: 4 chữ số hoặc `±` + 6 chữ số.
    let rest = if let Some(r) = date.strip_prefix(['+', '-']) {
        if r.len() < 6 || digits(&r[..6], 6, 6).is_none() {
            return false;
        }
        &r[6..]
    } else {
        if date.len() < 4 || digits(&date[..4], 4, 4).is_none() {
            return false;
        }
        &date[4..]
    };
    let parts: Vec<&str> = rest.split('-').collect();
    let ok_date = match parts.as_slice() {
        [""] => true,
        ["", m] => digits(m, 2, 2).is_some_and(|m| (1..=12).contains(&m)),
        ["", m, d] => matches!((digits(m, 2, 2), digits(d, 2, 2)), (Some(m), Some(d)) if valid_md(m, d)),
        _ => false,
    };
    ok_date && time.is_none_or(iso_time)
}

fn iso_time(t: &str) -> bool {
    let (clock, zone) = match t.find(['Z', 'z', '+', '-']) {
        Some(i) => (&t[..i], &t[i..]),
        None => (t, ""),
    };
    clock_ok(clock, true) && zone_ok(zone)
}

/// `hh:mm[:ss[.fff]]`; `two`: bắt buộc hai chữ số mỗi phần (ISO).
fn clock_ok(c: &str, two: bool) -> bool {
    let (min, max) = if two { (2, 2) } else { (1, 2) };
    let mut it = c.split(':');
    let (Some(h), Some(m)) = (
        it.next().and_then(|v| digits(v, min, max)),
        it.next().and_then(|v| digits(v, min, max)),
    ) else {
        return false;
    };
    let mut sec = 0;
    if let Some(s) = it.next() {
        let (whole, frac) = s.split_once('.').map_or((s, None), |(a, b)| (a, Some(b)));
        let Some(w) = digits(whole, min, max) else { return false };
        if frac.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit())) {
            return false;
        }
        sec = w;
    }
    it.next().is_none() && m <= 59 && sec <= 59 && h <= 24 && (h < 24 || (m == 0 && sec == 0))
}

/// `""`, `Z`, `±hh:mm`, `±hhmm`, `±hh`.
fn zone_ok(z: &str) -> bool {
    if z.is_empty() || z.eq_ignore_ascii_case("z") {
        return true;
    }
    let Some(body) = z.strip_prefix(['+', '-']) else {
        return false;
    };
    let body = body.replace(':', "");
    match body.len() {
        1 | 2 => digits(&body, 1, 2).is_some_and(|h| h < 24),
        4 => digits(&body, 4, 4).is_some_and(|v| v / 100 < 24 && v % 100 < 60),
        _ => false,
    }
}

/// Số khoảng 3+ chữ số là năm.
fn is_year(s: &str) -> bool {
    digits(s, 3, 4).is_some() || digits(s, 2, 2).is_some()
}

fn month_of(w: &str) -> Option<usize> {
    let w = w.to_ascii_lowercase();
    (w.len() >= 3)
        .then(|| MONTHS.iter().position(|m| m.starts_with(&w)))
        .flatten()
}

fn is_weekday(w: &str) -> bool {
    let w = w.to_ascii_lowercase();
    w.len() >= 3 && WEEKDAYS.iter().any(|d| d.starts_with(&w))
}

/// Ngày dạng một token `a/b/c` hoặc `a-b-c`; mỗi phần là số hoặc tên tháng.
fn combined_date(tok: &str) -> bool {
    let sep = if tok.contains('/') { '/' } else { '-' };
    let p: Vec<&str> = tok.split(sep).collect();
    let [a, b, c] = p.as_slice() else { return false };
    let months: Vec<usize> = p.iter().filter_map(|x| month_of(x)).collect();
    if months.len() == 1 {
        let nums: Vec<&&str> = p.iter().filter(|x| month_of(x).is_none()).collect();
        let [x, y] = nums.as_slice() else { return false };
        let day_year = |d: &str, yr: &str| digits(d, 1, 2).is_some_and(|d| (1..=31).contains(&d)) && is_year(yr);
        return day_year(x, y) || day_year(y, x);
    }
    let (Some(x), Some(y), Some(z)) = (digits(a, 1, 4), digits(b, 1, 2), digits(c, 1, 4)) else {
        return false;
    };
    if a.len() >= 3 {
        valid_md(y, z)
    } else {
        // `M/D/Y`; `5-11-2026` V8 cũng đọc tháng-ngày-năm.
        c.len() >= 2 && valid_md(x, y) && z <= 9999
    }
}

fn legacy(t: &str) -> bool {
    // Bỏ phần chú thích trong ngoặc (`(Indochina Time)`).
    let mut plain = String::with_capacity(t.len());
    let mut depth = 0;
    for ch in t.chars() {
        match ch {
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            c if depth == 0 => plain.push(c),
            _ => {}
        }
    }
    let (mut month, mut date, mut time, mut zone, mut numeric_zone, mut meridian) =
        (false, false, false, false, false, None::<bool>);
    let mut numbers: Vec<&str> = Vec::new();
    let mut seen_value = false;
    for tok in plain
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|x| !x.is_empty())
    {
        let lower = tok.to_ascii_lowercase();
        let is_zone = lower == "z"
            || lower.starts_with("gmt")
            || lower.starts_with("utc")
            || (lower.starts_with(['+', '-'])
                && tok[1..].bytes().next().is_some_and(|b| b.is_ascii_digit())
                && !tok[1..].contains(['-', '/']));
        if is_zone {
            let z = lower.trim_start_matches("gmt").trim_start_matches("utc");
            if zone || !zone_ok(z) {
                return false;
            }
            zone = true;
            numeric_zone = tok.starts_with(['+', '-']);
        } else if tok.contains(':') {
            if time || !clock_ok(tok, false) {
                return false;
            }
            time = true;
        } else if lower == "am" || lower == "pm" {
            if meridian.is_some() {
                return false;
            }
            meridian = Some(lower == "pm");
        } else if tok.contains(['/', '-']) {
            if date || month || !numbers.is_empty() || !combined_date(tok) {
                return false;
            }
            date = true;
        } else if tok.bytes().all(|b| b.is_ascii_digit()) {
            numbers.push(tok);
            seen_value = true;
        } else if tok.bytes().all(|b| b.is_ascii_alphabetic()) {
            if let Some(_m) = month_of(tok) {
                if month || date {
                    return false;
                }
                month = true;
                seen_value = true;
            } else if is_weekday(tok) {
                // bỏ qua thứ trong tuần
            } else if seen_value {
                return false;
            }
        } else {
            return false;
        }
    }
    let date_ok = if date {
        numbers.is_empty() && !month
    } else if month {
        let day_ok = |d: &str| digits(d, 1, 2).is_some_and(|d| (1..=31).contains(&d));
        match numbers.as_slice() {
            [y] => is_year(y) || day_ok(y),
            [a, b] => (day_ok(a) && is_year(b)) || (day_ok(b) && is_year(a)),
            _ => false,
        }
    } else {
        false
    };
    // Múi giờ rời không có giờ (`Nov 5 2026 +0700`) V8 từ chối.
    if !date_ok || (numeric_zone && !time) {
        return false;
    }
    // AM/PM chỉ đi với giờ 0..12.
    if meridian.is_some() {
        let hour = plain
            .split(|c: char| c.is_whitespace() || c == ',')
            .find(|x| x.contains(':'))
            .and_then(|c| digits(c.split(':').next().unwrap_or(""), 1, 2));
        if !hour.is_some_and(|h| (0..=12).contains(&h)) {
            return false;
        }
    }
    true
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
        match validate_product_attributes(defs, Some(&raw), None)
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
            (json!("+0x1A"), None),
            (json!("-0x1A"), None),
            (json!("0b102"), None),
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
            "2026T10:00",
            "2026-11T10:00",
            "Thu, 05 Nov 2026 10:00:00 GMT",
            "Thu Nov 05 2026 10:00:00 GMT+0700 (Indochina Time)",
            "Nov 5, 2026 10:00",
            "Nov 5, 2026 10:00 PM",
            "Nov 5 26",
            "5 Nov 2026 10:00:00 +0700",
            "Thu, 05 Nov 2026",
            "11/5/2026 10:00:00 AM",
            "2026-11-05 10:00:00 UTC",
            "Foo Nov 5 2026",
            "November 5, 2026",
            "5-Nov-2026",
            "2026-Nov-5",
            "Thu, 05 Nov 2026 10:00:00 GMT+7",
            "Nov 5 2026 10:00 +07:00",
            "Nov 5 2026 GMT+0700",
            "Nov 5 26 0:30 AM",
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
    fn hex_rat_dai_la_so_lon_khong_phai_loi_so() {
        let defs = [def("n", "number", false, None)];
        // 40 chữ số hex: số hữu hạn vượt trần, không phải "không phải số".
        assert_eq!(
            err(&defs, json!({"n": format!("0x{}", "f".repeat(40))})),
            "Thuộc tính \"L-n\" vượt trần cho phép"
        );
        assert_eq!(err(&defs, json!({"n": "0x"})), "Thuộc tính \"L-n\" phải là số");
        assert_eq!(err(&defs, json!({"n": "+0x10"})), "Thuộc tính \"L-n\" phải là số");
        // Quá lớn tới vô cực (> 256 chữ số hex): giống JS, không hữu hạn.
        assert_eq!(
            err(&defs, json!({"n": format!("0x{}", "f".repeat(300))})),
            "Thuộc tính \"L-n\" phải là số"
        );
    }

    #[test]
    fn gia_tri_ngay_da_luu_khong_kiem_lai_khi_khong_doi() {
        let defs = [def("d", "date", false, None)];
        let prev: Map<String, Value> = serde_json::from_str(r#"{"d": "Nov 5 12345 10:61"}"#).unwrap();
        // Giá trị lạ đã lưu từ trước: gửi lại y nguyên thì qua; đổi sang giá trị lạ khác thì bị chặn.
        let same = json!({"d": "Nov 5 12345 10:61"});
        assert!(validate_product_attributes(&defs, Some(&same), Some(&prev)).is_ok());
        assert!(validate_product_attributes(&defs, Some(&same), None).is_err());
        let other = json!({"d": "Nov 6 12345 10:61"});
        assert!(validate_product_attributes(&defs, Some(&other), Some(&prev)).is_err());
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

        let ok =
            validate_product_attributes(&defs, Some(&json!({"qty": "12.50", "name": "x", "pct": 5})), None).unwrap();
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
