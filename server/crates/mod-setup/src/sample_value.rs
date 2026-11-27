//! Chuẩn hoá giá trị bản ghi mẫu theo định nghĩa trường (tập con của `normalizeValue` ở `field-values.ts` đủ cho dữ liệu mẫu của
//! danh mục: văn bản, số, tiền, phần trăm, ngày, ngày giờ, đúng/sai, lựa chọn, email, SĐT, URL, người dùng, liên kết). Dữ liệu mẫu
//! do mã kiểm soát nên lỗi ở đây là lỗi danh mục (test duyệt cả danh mục).

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};
use trinity_kernel::vi::trim_js;

use crate::{iso, js_parse_date};

const MAX_TEXT: usize = 500;
const MAX_LONG_TEXT: usize = 10_000;
const MAX_URL: usize = 2_000;
const MAX_NUMBER: f64 = 1e15;
const MAX_CURRENCY: f64 = 1e13;
const MAX_MULTI: usize = 50;

/// Trường tối thiểu để chuẩn hoá giá trị.
pub struct Field<'a> {
    pub label: &'a str,
    pub kind: &'a str,
    pub options: &'a Value,
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => trim_js(s).is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

fn str_of(v: &Value, label: &str, max: usize) -> Result<String, String> {
    let Some(s) = v.as_str() else {
        return Err(format!("“{label}” phải là văn bản"));
    };
    let s = trim_js(s);
    if js_len(s) > max {
        return Err(format!("“{label}” tối đa {max} ký tự"));
    }
    if s.chars()
        .any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
    {
        return Err(format!("“{label}” chứa ký tự điều khiển không hợp lệ"));
    }
    Ok(s.to_owned())
}

fn num_of(v: &Value, label: &str) -> Result<f64, String> {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = trim_js(s);
            let body = t.strip_prefix('-').unwrap_or(t);
            let ok = !body.is_empty()
                && body.split_once('.').map_or_else(
                    || body.bytes().all(|b| b.is_ascii_digit()),
                    |(a, b)| {
                        !a.is_empty()
                            && !b.is_empty()
                            && a.bytes().all(|c| c.is_ascii_digit())
                            && b.bytes().all(|c| c.is_ascii_digit())
                    },
                );
            if ok { t.parse::<f64>().ok() } else { None }
        }
        _ => None,
    };
    n.filter(|n| n.is_finite())
        .ok_or_else(|| format!("“{label}” phải là số"))
}

fn positive_id(v: &Value, label: &str) -> Result<i64, String> {
    let n = match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse::<i64>().ok(),
        _ => None,
    };
    n.filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("“{label}” chứa mã tham chiếu không hợp lệ"))
}

fn valid_ymd(s: &str) -> bool {
    s.len() == 10 && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn norm_phone(raw: &str) -> Option<String> {
    let compact: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '.' | '-' | '(' | ')'))
        .collect();
    let local = if let Some(rest) = compact.strip_prefix("+84") {
        format!("0{rest}")
    } else if compact.starts_with("84") && compact.len() == 11 {
        format!("0{}", &compact[2..])
    } else {
        compact
    };
    (local.len() == 10 && local.starts_with('0') && local.bytes().all(|b| b.is_ascii_digit())).then_some(local)
}

fn valid_email(s: &str) -> bool {
    let Some((local, domain)) = s.rsplit_once('@') else {
        return false;
    };
    let no_ws = |x: &str| !x.chars().any(char::is_whitespace);
    (1..=64).contains(&local.chars().count())
        && !local.contains('@')
        && no_ws(local)
        && no_ws(domain)
        && domain
            .rsplit_once('.')
            .is_some_and(|(h, tld)| !h.is_empty() && tld.chars().count() >= 2)
}

fn choices<'a>(f: &'a Field<'_>) -> Vec<&'a str> {
    f.options
        .get("choices")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("value").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

/// `normalizeValue`: `Ok(Null)` = rỗng; lỗi là câu tiếng Việt.
pub fn normalize(f: &Field<'_>, raw: &Value) -> Result<Value, String> {
    let label = f.label;
    if f.kind == "formula" {
        return Err(format!(
            "“{label}” là trường công thức, tính tự động nên không nhập được"
        ));
    }
    if is_empty(raw) {
        return Ok(Value::Null);
    }
    match f.kind {
        "multi_select" => {
            let Some(a) = raw.as_array() else {
                return Err(format!("“{label}” phải là danh sách"));
            };
            if a.len() > MAX_MULTI {
                return Err(format!("“{label}” tối đa {MAX_MULTI} lựa chọn"));
            }
            let allowed = choices(f);
            let mut out: Vec<String> = Vec::new();
            for x in a {
                let s = str_of(x, label, 64)?;
                if !out.contains(&s) {
                    out.push(s);
                }
            }
            for x in &out {
                if !allowed.contains(&x.as_str()) {
                    return Err(format!(
                        "“{label}”: giá trị “{}” không nằm trong danh sách lựa chọn",
                        x.chars().take(30).collect::<String>()
                    ));
                }
            }
            Ok(json!(out))
        }
        "relation" => {
            let multiple = f.options.get("multiple").and_then(Value::as_bool) == Some(true);
            if multiple {
                let Some(a) = raw.as_array() else {
                    return Err(format!("“{label}” phải là danh sách"));
                };
                if a.len() > MAX_MULTI {
                    return Err(format!("“{label}” tối đa {MAX_MULTI} mục"));
                }
                let mut out: Vec<i64> = Vec::new();
                for x in a {
                    let id = positive_id(x, label)?;
                    if !out.contains(&id) {
                        out.push(id);
                    }
                }
                Ok(json!(out))
            } else {
                Ok(json!(positive_id(raw.as_array().map_or(raw, |a| &a[0]), label)?))
            }
        }
        "text" => Ok(json!(str_of(raw, label, MAX_TEXT)?)),
        "long_text" => Ok(json!(str_of(raw, label, MAX_LONG_TEXT)?)),
        "number" => {
            let n = num_of(raw, label)?;
            if n.abs() > MAX_NUMBER {
                return Err(format!("“{label}” vượt giới hạn cho phép"));
            }
            Ok(json_num(n))
        }
        "currency" => {
            let n = num_of(raw, label)?;
            if n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
                return Err(format!("“{label}” là số tiền VND, phải là số nguyên"));
            }
            if n < 0.0 {
                return Err(format!(
                    "“{label}” không được âm (hoàn tiền: dùng trạng thái, không nhập số âm)"
                ));
            }
            if n.abs() > MAX_CURRENCY {
                return Err(format!("“{label}” vượt giới hạn cho phép"));
            }
            Ok(json_num(n))
        }
        "percent" => {
            let n = num_of(raw, label)?;
            if !(-1000.0..=1000.0).contains(&n) {
                return Err(format!("“{label}” phải trong khoảng −1000% đến 1000%"));
            }
            Ok(json_num(n))
        }
        "date" => {
            let s = str_of(raw, label, 10)?;
            if !valid_ymd(&s) {
                return Err(format!("“{label}” phải là ngày hợp lệ dạng YYYY-MM-DD"));
            }
            Ok(json!(s))
        }
        "datetime" => {
            let s = str_of(raw, label, 40)?;
            let lo = NaiveDate::from_ymd_opt(1900, 1, 1)
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|n| n.and_utc());
            let hi = NaiveDate::from_ymd_opt(2200, 1, 1)
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|n| n.and_utc());
            let t: Option<DateTime<Utc>> = js_parse_date(&s).filter(|t| Some(*t) >= lo && Some(*t) <= hi);
            t.map(|t| json!(iso(t)))
                .ok_or_else(|| format!("“{label}” phải là ngày giờ hợp lệ"))
        }
        "boolean" => match raw {
            Value::Bool(b) => Ok(json!(b)),
            Value::String(s) if s == "true" => Ok(json!(true)),
            Value::String(s) if s == "false" => Ok(json!(false)),
            _ => Err(format!("“{label}” phải là đúng/sai")),
        },
        "select" => {
            let s = str_of(raw, label, 64)?;
            if !choices(f).contains(&s.as_str()) {
                return Err(format!(
                    "“{label}”: giá trị “{}” không nằm trong danh sách lựa chọn",
                    s.chars().take(30).collect::<String>()
                ));
            }
            Ok(json!(s))
        }
        "email" => {
            let s = str_of(raw, label, 254)?.to_lowercase();
            if !valid_email(&s) {
                return Err(format!("“{label}” không phải email hợp lệ"));
            }
            Ok(json!(s))
        }
        "phone" => {
            let p = norm_phone(&str_of(raw, label, 20)?);
            p.map(|p| json!(p))
                .ok_or_else(|| format!("“{label}” phải là số điện thoại Việt Nam (10 số, bắt đầu 0 hoặc +84)"))
        }
        "url" => {
            let s = str_of(raw, label, MAX_URL)?;
            let ok = s.starts_with("http://") || s.starts_with("https://");
            if !ok || s.chars().any(char::is_whitespace) {
                return Err(format!("“{label}” chỉ chấp nhận http:// hoặc https://"));
            }
            Ok(json!(s))
        }
        "user" => Ok(json!(positive_id(raw, label)?)),
        other => Err(format!("“{label}”: kiểu {other} không xử lý ở đây")),
    }
}

/// Số nguyên giữ dạng nguyên (như JSON.stringify của số JS), còn lại f64.
fn json_num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f<'a>(kind: &'a str, options: &'a Value) -> Field<'a> {
        Field {
            label: "X",
            kind,
            options,
        }
    }

    #[test]
    fn gia_tri_mau() {
        let none = json!({});
        let sel = json!({ "choices": [{ "value": "a", "label": "A" }] });
        assert_eq!(normalize(&f("text", &none), &json!("  an ")).unwrap(), json!("an"));
        assert_eq!(normalize(&f("text", &none), &json!("  ")).unwrap(), Value::Null);
        assert_eq!(
            normalize(&f("currency", &none), &json!("8550000")).unwrap(),
            json!(8_550_000)
        );
        assert!(
            normalize(&f("currency", &none), &json!(-1))
                .unwrap_err()
                .contains("không được âm")
        );
        assert_eq!(normalize(&f("select", &sel), &json!("a")).unwrap(), json!("a"));
        assert!(
            normalize(&f("select", &sel), &json!("b"))
                .unwrap_err()
                .contains("không nằm trong danh sách")
        );
        assert_eq!(
            normalize(&f("phone", &none), &json!("+84 900 000 001")).unwrap(),
            json!("0900000001")
        );
        assert_eq!(
            normalize(&f("date", &none), &json!("2026-02-30")).unwrap_err(),
            "“X” phải là ngày hợp lệ dạng YYYY-MM-DD"
        );
        assert_eq!(
            normalize(&f("datetime", &none), &json!("2026-03-15T09:00:00+07:00")).unwrap(),
            json!("2026-03-15T02:00:00.000Z")
        );
        assert_eq!(
            normalize(&f("email", &none), &json!("A.mau@Example.com")).unwrap(),
            json!("a.mau@example.com")
        );
        assert!(normalize(&f("formula", &none), &json!(1)).is_err());
    }
}
