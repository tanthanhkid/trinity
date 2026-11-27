//! Đọc đối số tool như `tool-types.ts`: `optInt`, `optStr`, `clampLimit`, `rejectDigitProbe`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::ai_output::slice16;
use crate::exec::ToolError;

pub const INT32_MAX: i64 = 2_147_483_647;

/// Số nguyên dương trong khoảng int4 (`typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= INT32_MAX`).
pub fn opt_int(v: Option<&Value>) -> Option<i32> {
    let n = match v? {
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
                .map(|f| f as i64)
        })?,
        _ => return None,
    };
    (1..=INT32_MAX)
        .contains(&n)
        .then(|| i32::try_from(n).unwrap_or(i32::MAX))
}

/// Chuỗi đã cắt khoảng trắng, không rỗng, tối đa `max` đơn vị UTF-16.
pub fn opt_str(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| slice16(s, max))
}

/// `limit` 1..50, mặc định 20 (`clampLimit`).
pub fn clamp_limit(v: Option<&Value>) -> i64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).map_or(20, |f| f.trunc() as i64),
        _ => 20,
    };
    n.clamp(1, 50)
}

static PROBE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9][^\p{L}\p{N}]{0,3}[0-9][^\p{L}\p{N}]{0,3}[0-9][^\p{L}\p{N}]{0,3}[0-9]").expect("regex hợp lệ")
});

/// Chặn oracle dò chữ số: bộ lọc văn bản khớp bằng `contains` mà phản hồi che SĐT, nhưng việc KHỚP không che, nên gọi lặp
/// "0901", "09012"… lột được dãy số. Chuỗi có ≥ 4 chữ số (≤ 3 ký tự phân cách xen giữa, MỌI ký tự không phải chữ/số đều là phân cách, đã NFKC) ⇒ từ chối.
pub fn reject_digit_probe(q: &str) -> Result<(), ToolError> {
    let n: String = q
        .nfkc()
        .filter(|c| !matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}'))
        .collect();
    if PROBE.is_match(&n) {
        return Err(ToolError::Plain(
            "Không hỗ trợ tìm theo chuỗi có nhiều chữ số — SĐT/số định danh luôn bị che với AI. Hãy tìm theo tên."
                .into(),
        ));
    }
    Ok(())
}

/// Giá trị chuỗi của khoá `k` (nếu có và là chuỗi).
pub fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn doc_doi_so() {
        assert_eq!(opt_int(Some(&json!(5))), Some(5));
        assert_eq!(opt_int(Some(&json!(5.0))), Some(5));
        for bad in [
            json!(0),
            json!(-1),
            json!(2_147_483_648_i64),
            json!("5"),
            json!(1.5),
            json!(null),
        ] {
            assert_eq!(opt_int(Some(&bad)), None, "{bad}");
        }
        assert_eq!(opt_str(Some(&json!("  ab ")), 10).as_deref(), Some("ab"));
        assert_eq!(opt_str(Some(&json!("   ")), 10), None);
        assert_eq!(opt_str(Some(&json!("abcdef")), 3).as_deref(), Some("abc"));
        assert_eq!(
            (
                clamp_limit(None),
                clamp_limit(Some(&json!(0))),
                clamp_limit(Some(&json!(99))),
                clamp_limit(Some(&json!(7.9)))
            ),
            (20, 1, 50, 7)
        );
    }

    #[test]
    fn chan_do_chu_so() {
        for ok in ["Nguyễn Văn A", "abc 123", "a1b2c3", "12 ngày"] {
            assert!(reject_digit_probe(ok).is_ok(), "{ok}");
        }
        for bad in ["0901", "09 01", "0.9.0.1", "０９０１", "x 0-9/0 1"] {
            assert!(reject_digit_probe(bad).is_err(), "{bad}");
        }
    }
}
