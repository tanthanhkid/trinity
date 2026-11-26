//! Serializer JSON thống nhất (PLAN 4.4, K10): mọi giá trị ra API phải có đúng chữ như bản Node in bằng
//! `JSON.stringify` sau khi Prisma đọc từ Postgres.
//!
//! - Số (`Float`, số trong cột `Json`, `BigInt` qua `BigInt.prototype.toJSON = Number(this)`): [`js_number`], như
//!   `Number.prototype.toString` (`1` chứ không `1.0`, `1e+21`, `1e-7`, `0.000001`).
//! - `Decimal` (decimal.js của Prisma): [`decimal_js`], bỏ số 0 thừa, dạng mũ khi số mũ ≥ 21 hoặc ≤ -7.
//! - Thời gian: ISO 8601 UTC, đúng 3 chữ số mili giây và `Z` ([`crate::vn_time::js_iso_string`]).
//! - Cột `Json`: [`write_js_json`], số theo [`js_number`], khoá dạng chỉ số mảng (`"0"`, `"10"`) lên trước theo thứ tự số
//!   như object của JS, các khoá khác giữ thứ tự Postgres trả về.

use serde_json::Value;

/// `Number.prototype.toString()` của JS cho số hữu hạn (ECMAScript Number::toString, cơ số 10). `NaN`/`±Infinity`
/// thành `null` như `JSON.stringify`.
pub fn js_number(x: f64) -> String {
    if !x.is_finite() {
        return "null".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned(); // gồm cả -0
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // `{:e}` của f64: chữ số ngắn nhất khôi phục đúng số, dạng `d.ddde±x`.
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let n = exp.parse::<i64>().unwrap_or(0) + 1; // vị trí dấu thập phân theo ECMAScript
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat(usize::try_from(n - k).unwrap_or(0)))
    } else if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(usize::try_from(n).unwrap_or(0));
        format!("{a}.{b}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-n).unwrap_or(0)))
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        let (a, b) = digits.split_at(1);
        if b.is_empty() {
            format!("{a}e{es}")
        } else {
            format!("{a}.{b}e{es}")
        }
    };
    format!("{sign}{body}")
}

/// `Decimal.toString()` của decimal.js (Prisma) cho số có `mantissa × 10^-scale`: bỏ số 0 thừa; dạng mũ
/// (`1.5e+21`, `1e-7`) khi số mũ của chữ số đầu ≥ 21 hoặc ≤ -7, còn lại dạng thường.
pub fn decimal_js(mantissa: i128, scale: u32) -> String {
    if mantissa == 0 {
        return "0".to_owned();
    }
    let sign = if mantissa < 0 { "-" } else { "" };
    let mut digits = mantissa.unsigned_abs().to_string();
    let mut scale = i64::from(scale);
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
        scale -= 1;
    }
    let len = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let e = len - 1 - scale; // số mũ của chữ số đầu
    let body = if e <= -7 || e >= 21 {
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        let (a, b) = digits.split_at(1);
        if b.is_empty() {
            format!("{a}e{es}")
        } else {
            format!("{a}.{b}e{es}")
        }
    } else if e < 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-e - 1).unwrap_or(0)))
    } else {
        let int_len = usize::try_from(e + 1).unwrap_or(0);
        if digits.len() > int_len {
            let (a, b) = digits.split_at(int_len);
            format!("{a}.{b}")
        } else {
            format!("{digits}{}", "0".repeat(int_len - digits.len()))
        }
    };
    format!("{sign}{body}")
}

/// Khoá là chỉ số mảng theo ECMAScript (`"0"` hoặc số không có 0 đầu, nhỏ hơn 2^32 - 1): object JS liệt kê các khoá
/// này trước, tăng dần theo số.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// Viết `v` như `JSON.stringify(JSON.parse(text))` của Node, với `text` là JSON Postgres trả về.
pub fn write_js_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => write_js_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut index_keys: Vec<(u32, &String, &Value)> = map
                .iter()
                .filter_map(|(k, v)| array_index(k).map(|n| (n, k, v)))
                .collect();
            index_keys.sort_by_key(|&(n, _, _)| n);
            let others = map.iter().filter(|(k, _)| array_index(k).is_none());
            out.push('{');
            let mut first = true;
            for (k, v) in index_keys.into_iter().map(|(_, k, v)| (k, v)).chain(others) {
                if !first {
                    out.push(',');
                }
                first = false;
                write_js_string(k, out);
                out.push(':');
                write_js_json(v, out);
            }
            out.push('}');
        }
    }
}

/// Chuỗi JSON như `JSON.stringify`: thoát `"`, `\`, ký tự điều khiển (`\b \f \n \r \t`, còn lại `\u00xx`).
pub fn write_js_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// [`write_js_json`] ra chuỗi mới.
pub fn js_json(v: &Value) -> String {
    let mut out = String::new();
    write_js_json(v, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_nhu_js() {
        let cases: [(f64, &str); 18] = [
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (-0.0, "0"),
            (123.456, "123.456"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.0000015, "0.0000015"),
            (9007199254740993.0, "9007199254740992"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (0.30000000000000004, "0.30000000000000004"),
            (f64::NAN, "null"),
            (100.0, "100"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number(x), want, "{x}");
        }
    }

    #[test]
    fn decimal_nhu_decimal_js() {
        let cases: [(i128, u32, &str); 10] = [
            (1250, 2, "12.5"),
            (0, 2, "0"),
            (10, 2, "0.1"),
            (100, 0, "100"),
            (-5, 1, "-0.5"),
            (1, 7, "1e-7"),
            (1, 6, "0.000001"),
            (15, 8, "1.5e-7"),
            (1, 0, "1"),
            (123_456_789_012_345_678_901_234, 2, "1.23456789012345678901234e+21"),
        ];
        for (m, s, want) in cases {
            assert_eq!(decimal_js(m, s), want, "{m}e-{s}");
        }
    }

    #[test]
    fn json_khoa_chi_so_len_truoc_va_so_kieu_js() {
        let v: Value =
            serde_json::from_str(r#"{"b":1.0,"10":[1.50,2e21],"2":"x\u0001","a":{"1":null,"0":true}}"#).expect("json");
        assert_eq!(
            js_json(&v),
            r#"{"2":"x\u0001","10":[1.5,2e+21],"b":1,"a":{"0":true,"1":null}}"#
        );
    }
}
