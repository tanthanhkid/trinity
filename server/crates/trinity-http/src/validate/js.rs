//! Giá trị kiểu JavaScript và các phép chuyển của JS mà class-transformer/class-validator dựa vào (`Number()`,
//! `String()`, `parseInt()`, `===`). Kiểm dữ liệu chạy trên giá trị JSON thô *trước* khi thành struct Rust, vì
//! class-validator báo lỗi kiểu ("must be a string") như một câu lỗi bình thường chứ không phải lỗi phân tích.

use serde_json::{Map, Number, Value};

/// Giá trị JS. Đối tượng giữ thứ tự khoá như JS (`Object.keys`).
#[derive(Debug, Clone, PartialEq)]
pub enum JsVal {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsVal>),
    Obj(Vec<(String, JsVal)>),
}

impl JsVal {
    pub fn from_json(v: &Value) -> JsVal {
        match v {
            Value::Null => JsVal::Null,
            Value::Bool(b) => JsVal::Bool(*b),
            Value::Number(n) => JsVal::Num(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => JsVal::Str(s.clone()),
            Value::Array(a) => JsVal::Arr(a.iter().map(JsVal::from_json).collect()),
            Value::Object(o) => JsVal::Obj(o.iter().map(|(k, v)| (k.clone(), JsVal::from_json(v))).collect()),
        }
    }

    /// Giải mã dạng JSON mở rộng của tệp hợp đồng (`{"$undefined":true}`, `{"$number":"NaN"}`).
    pub fn from_contract(v: &Value) -> JsVal {
        if let Value::Object(o) = v {
            if o.len() == 1 && o.get("$undefined") == Some(&Value::Bool(true)) {
                return JsVal::Undefined;
            }
            if let (1, Some(Value::String(n))) = (o.len(), o.get("$number")) {
                return JsVal::Num(match n.as_str() {
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ => f64::NAN,
                });
            }
            return JsVal::Obj(o.iter().map(|(k, v)| (k.clone(), JsVal::from_contract(v))).collect());
        }
        if let Value::Array(a) = v {
            return JsVal::Arr(a.iter().map(JsVal::from_contract).collect());
        }
        JsVal::from_json(v)
    }

    /// Mã hoá ngược của [`JsVal::from_contract`] (so với golden).
    pub fn to_contract(&self) -> Value {
        match self {
            JsVal::Undefined => serde_json::json!({ "$undefined": true }),
            JsVal::Num(n) if !n.is_finite() => serde_json::json!({ "$number": number_to_string(*n) }),
            JsVal::Arr(a) => Value::Array(a.iter().map(JsVal::to_contract).collect()),
            JsVal::Obj(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), v.to_contract())).collect()),
            other => other.to_json().unwrap_or(Value::Null),
        }
    }

    /// `JSON.stringify` rồi `JSON.parse`: `undefined` trong đối tượng bị bỏ, trong mảng thành `null`; NaN/±Infinity
    /// thành `null`. `None` khi chính giá trị là `undefined`.
    pub fn to_json(&self) -> Option<Value> {
        Some(match self {
            JsVal::Undefined => return None,
            JsVal::Null => Value::Null,
            JsVal::Bool(b) => Value::Bool(*b),
            JsVal::Num(n) => num_json(*n),
            JsVal::Str(s) => Value::String(s.clone()),
            JsVal::Arr(a) => Value::Array(a.iter().map(|v| v.to_json().unwrap_or(Value::Null)).collect()),
            JsVal::Obj(o) => {
                let mut m = Map::new();
                for (k, v) in o {
                    if let Some(j) = v.to_json() {
                        m.insert(k.clone(), j);
                    }
                }
                Value::Object(m)
            }
        })
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, JsVal::Undefined | JsVal::Null)
    }

    pub fn get(&self, key: &str) -> &JsVal {
        match self {
            JsVal::Obj(o) => o.iter().find(|(k, _)| k == key).map_or(&JsVal::Undefined, |(_, v)| v),
            _ => &JsVal::Undefined,
        }
    }

    /// Gán thuộc tính (giữ vị trí nếu đã có, như JS).
    pub fn set(&mut self, key: &str, value: JsVal) {
        if let JsVal::Obj(o) = self {
            match o.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v = value,
                None => o.push((key.to_owned(), value)),
            }
        }
    }

    pub fn remove(&mut self, key: &str) {
        if let JsVal::Obj(o) = self {
            o.retain(|(k, _)| k != key);
        }
    }

    /// Độ thật của JS (`Boolean(v)`).
    pub fn truthy(&self) -> bool {
        match self {
            JsVal::Undefined | JsVal::Null => false,
            JsVal::Bool(b) => *b,
            JsVal::Num(n) => *n != 0.0 && !n.is_nan(),
            JsVal::Str(s) => !s.is_empty(),
            JsVal::Arr(_) | JsVal::Obj(_) => true,
        }
    }

    /// `typeof`.
    pub fn type_of(&self) -> &'static str {
        match self {
            JsVal::Undefined => "undefined",
            JsVal::Null | JsVal::Arr(_) | JsVal::Obj(_) => "object",
            JsVal::Bool(_) => "boolean",
            JsVal::Num(_) => "number",
            JsVal::Str(_) => "string",
        }
    }
}

fn num_json(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 {
        // JSON.stringify ghi số nguyên đủ chữ số (tới 1e21), không dạng mũ: số nguyên trong khoảng i64/u64 ghi như số
        // nguyên (không ".0", `-0` thành 0); ngoài khoảng đó mới giữ dạng float (deserialize vào số nguyên sẽ lỗi 400).
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        if (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&n) {
            return Value::Number(Number::from(n as i64));
        } else if (0.0..18_446_744_073_709_551_616.0).contains(&n) {
            return Value::Number(Number::from(n as u64));
        }
    }
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// `===` của JS cho giá trị nguyên thuỷ; mảng/đối tượng không bao giờ bằng (khác tham chiếu).
pub fn strict_eq(a: &JsVal, b: &JsVal) -> bool {
    match (a, b) {
        (JsVal::Undefined, JsVal::Undefined) | (JsVal::Null, JsVal::Null) => true,
        (JsVal::Bool(x), JsVal::Bool(y)) => x == y,
        (JsVal::Num(x), JsVal::Num(y)) => x == y,
        (JsVal::Str(x), JsVal::Str(y)) => x == y,
        _ => false,
    }
}

/// Khoảng trắng theo `String.prototype.trim` / `\s` của JS.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(v)`.
pub fn to_number(v: &JsVal) -> f64 {
    match v {
        JsVal::Undefined => f64::NAN,
        JsVal::Null => 0.0,
        JsVal::Bool(b) => f64::from(u8::from(*b)),
        JsVal::Num(n) => *n,
        JsVal::Str(s) => string_to_number(s),
        // Number([]) = 0, Number([5]) = 5, Number(obj) = NaN: qua String().
        JsVal::Arr(_) => string_to_number(&to_js_string(v)),
        JsVal::Obj(_) => f64::NAN,
    }
}

/// StringToNumber của JS.
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        if p.is_empty() || !p.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        p.chars()
            .fold(0.0, |acc, c| acc * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0)))
    };
    let lower = t.to_ascii_lowercase();
    if let Some(p) = lower.strip_prefix("0x") {
        return radix(p, 16);
    }
    if let Some(p) = lower.strip_prefix("0o") {
        return radix(p, 8);
    }
    if let Some(p) = lower.strip_prefix("0b") {
        return radix(p, 2);
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

/// `digits[.digits][e[+-]digits]` hoặc `.digits[...]` hoặc `digits.`.
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let int = digits(&mut i);
    let mut frac = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        frac = digits(&mut i);
    }
    if int + frac == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// `String(v)`.
pub fn to_js_string(v: &JsVal) -> String {
    match v {
        JsVal::Undefined => "undefined".into(),
        JsVal::Null => "null".into(),
        JsVal::Bool(b) => b.to_string(),
        JsVal::Num(n) => number_to_string(*n),
        JsVal::Str(s) => s.clone(),
        // Array.prototype.join: null/undefined thành chuỗi rỗng.
        JsVal::Arr(a) => a
            .iter()
            .map(|x| if x.is_nullish() { String::new() } else { to_js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        JsVal::Obj(_) => "[object Object]".into(),
    }
}

/// `Number.prototype.toString()` (cơ số 10) cho các giá trị gặp trong thực tế.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == 0.0 {
        return "0".into();
    }
    let a = n.abs();
    if (1e-6..1e21).contains(&a) {
        // Rust in số ngắn nhất khôi phục được như JS, không mũ trong khoảng này.
        let s = format!("{n}");
        return s;
    }
    // Dạng mũ của JS: 1e+21, 1.5e-7.
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// `parseInt(v)` (cơ số tự nhận: `0x` là hệ 16).
pub fn parse_int(v: &JsVal, radix: Option<u32>) -> f64 {
    let s = to_js_string(v);
    let t = s.trim_start_matches(is_js_space);
    let (sign, mut body) = match t.chars().next() {
        Some('-') => (-1.0, &t[1..]),
        Some('+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    let mut r = radix.unwrap_or(10);
    if (radix.is_none() || radix == Some(16)) && (body.starts_with("0x") || body.starts_with("0X")) {
        body = &body[2..];
        r = 16;
    }
    let digits: String = body.chars().take_while(|c| c.is_digit(r)).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits
        .chars()
        .fold(0.0, |acc, c| acc * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0)))
}

/// Độ dài chuỗi JS (`str.length`, đơn vị UTF-16).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_nhu_js() {
        for (s, want) in [
            ("", 0.0),
            ("  12 ", 12.0),
            ("0x1A", 26.0),
            ("1e3", 1000.0),
            ("+5", 5.0),
            ("-3", -3.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(string_to_number(s), want, "{s:?}");
        }
        for s in ["12px", "abc", "1_000", "-0x1A", "e3", "."] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
        assert_eq!(to_number(&JsVal::Arr(vec![])), 0.0);
        assert_eq!(to_number(&JsVal::Arr(vec![JsVal::Str("5".into())])), 5.0);
        assert!(to_number(&JsVal::Arr(vec![JsVal::Num(1.0), JsVal::Num(2.0)])).is_nan());
    }

    #[test]
    fn parse_int_nhu_js() {
        let p = |s: &str| parse_int(&JsVal::Str(s.into()), None);
        assert_eq!(p(" 7 "), 7.0);
        assert_eq!(p("3.7"), 3.0);
        assert_eq!(p("0x1A"), 26.0);
        assert_eq!(p("-12abc"), -12.0);
        assert!(p("abc").is_nan());
        assert_eq!(parse_int(&JsVal::Num(3.7), None), 3.0);
        assert_eq!(parse_int(&JsVal::Str("0x1A".into()), Some(10)), 0.0);
    }

    #[test]
    fn so_thanh_chuoi_nhu_js() {
        assert_eq!(number_to_string(3.7), "3.7");
        assert_eq!(number_to_string(12.0), "12");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(1.5e-7), "1.5e-7");
    }
}
