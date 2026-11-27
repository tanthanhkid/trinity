//! Chuẩn hoá MỘT giá trị bản ghi theo định nghĩa trường (chuyển từ `field-values.ts`: `normalizeValue`, `isEmptyValue`,
//! `normalizeVnPhone`, thẻ liên kết). Quan hệ (relation, user) chỉ kiểm HÌNH DẠNG; tồn tại và phạm vi kiểm ở `records`.
//! Số đi qua `f64` như JS; kết quả là `Value` sẵn sàng lưu jsonb.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use trinity_kernel::vi::trim_js;

use crate::dates::{iso, parse_instant, valid_ymd};
use crate::types::{FieldDef, Limits};
use crate::values::{ValueError, err, text};

static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?[0-9]+(\.[0-9]+)?$").expect("regex hợp lệ"));
static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$").expect("regex hợp lệ"));
static LINK_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:record|contact|deal|task):[0-9]{1,10}|@?[A-Za-z]{2,4}[0-9]{1,9})$").expect("regex hợp lệ")
});

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `isEmptyValue`: thiếu, null, chuỗi toàn khoảng trắng hoặc mảng rỗng.
pub fn is_empty_value(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => trim_js(s).is_empty(),
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

/// Số JS thành `Value`: số nguyên không có phần thập phân.
pub fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

fn num(v: &Value, label: &str) -> Result<f64, ValueError> {
    let n = match v {
        Value::String(s) if NUM.is_match(trim_js(s)) => trim_js(s).parse::<f64>().ok(),
        Value::Number(x) => x.as_f64(),
        _ => None,
    };
    match n.filter(|x| x.is_finite()) {
        Some(x) => Ok(x),
        None => err(format!("“{label}” phải là số")),
    }
}

/// `normalizeVnPhone`: bỏ khoảng trắng, dấu chấm, gạch, ngoặc; `+84`/`84` thành `0`; phải đúng `0` + 9 số.
pub fn normalize_vn_phone(raw: &str) -> Option<String> {
    let compact: String = raw
        .chars()
        .filter(|c| !(c.is_whitespace() || matches!(c, '.' | '-' | '(' | ')')))
        .collect();
    let local = if let Some(rest) = compact.strip_prefix("+84") {
        format!("0{rest}")
    } else if compact.starts_with("84") && compact.chars().count() == 11 {
        format!("0{}", &compact[2..])
    } else {
        compact
    };
    let ok = local.len() == 10 && local.starts_with('0') && local.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(local)
}

fn positive_id(v: &Value, label: &str) -> Result<i64, ValueError> {
    let n = match v {
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse::<f64>().ok(),
        Value::Number(x) => x.as_f64(),
        _ => None,
    };
    match n {
        Some(x) if x.fract() == 0.0 && x.abs() <= MAX_SAFE && x > 0.0 => Ok(x as i64),
        _ => err(format!("“{label}” chứa mã tham chiếu không hợp lệ")),
    }
}

fn id_list(v: &Value, label: &str) -> Result<Value, ValueError> {
    let Some(a) = v.as_array() else {
        return err(format!("“{label}” phải là danh sách"));
    };
    if a.len() > Limits::MAX_RELATION_VALUES {
        return err(format!("“{label}” tối đa {} mục", Limits::MAX_RELATION_VALUES));
    }
    let mut out: Vec<i64> = Vec::new();
    for x in a {
        let id = positive_id(x, label)?;
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(Value::Array(out.into_iter().map(Value::from).collect()))
}

/// Trường "Liên kết": danh sách thẻ, mã (`HS001`, `@HS001`) hoặc `loại:id`. Chuỗi "HS001, KH002" cũng nhận. Chỉ kiểm hình dạng.
fn link_tokens(raw: &Value, label: &str) -> Result<Value, ValueError> {
    let list: Vec<&Value>;
    let split: Vec<Value>;
    let items: &[&Value] = match raw {
        Value::String(s) => {
            split = s
                .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
                .map(|x| Value::String(x.to_owned()))
                .collect();
            list = split.iter().collect();
            &list
        }
        Value::Array(a) => {
            list = a.iter().collect();
            &list
        }
        _ => &[],
    };
    let invalid = || format!("“{label}” phải là danh sách mã bản ghi (vd [\"HS001\"])");
    if !matches!(raw, Value::String(_) | Value::Array(_)) || items.iter().any(|x| !x.is_string()) {
        return err(invalid());
    }
    let mut out: Vec<String> = Vec::new();
    for x in items {
        let t = trim_js(x.as_str().unwrap_or_default());
        let t = t.strip_prefix('@').unwrap_or(t);
        if !t.is_empty() && !out.iter().any(|o| o == t) {
            out.push(t.to_owned());
        }
    }
    if out.len() > Limits::MAX_LINK_VALUES {
        return err(format!("“{label}” tối đa {} thẻ", Limits::MAX_LINK_VALUES));
    }
    if let Some(bad) = out.iter().find(|x| !LINK_TOKEN.is_match(x)) {
        let short: String = bad.chars().take(30).collect();
        return err(format!("“{label}”: “{short}” không phải mã bản ghi (vd HS001)"));
    }
    Ok(Value::Array(out.into_iter().map(Value::String).collect()))
}

fn choices(f: &FieldDef) -> Vec<&str> {
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

fn not_in_choices(label: &str, s: &str) -> ValueError {
    let short: String = s.chars().take(30).collect();
    ValueError(format!(
        "“{label}”: giá trị “{short}” không nằm trong danh sách lựa chọn"
    ))
}

fn scalar(f: &FieldDef, v: &Value) -> Result<Value, ValueError> {
    let label = f.label.as_str();
    match f.kind.as_str() {
        "text" => text(v, label, Limits::MAX_TEXT).map(Value::String),
        "long_text" => text(v, label, Limits::MAX_LONG_TEXT).map(Value::String),
        "number" => {
            let n = num(v, label)?;
            if n.abs() > Limits::MAX_NUMBER {
                return err(format!("“{label}” vượt giới hạn cho phép"));
            }
            Ok(number_value(n))
        }
        "currency" => {
            let n = num(v, label)?;
            if n.fract() != 0.0 || n.abs() > MAX_SAFE {
                return err(format!("“{label}” là số tiền VND, phải là số nguyên"));
            }
            if n < 0.0 {
                return err(format!(
                    "“{label}” không được âm (hoàn tiền: dùng trạng thái, không nhập số âm)"
                ));
            }
            if n.abs() > Limits::MAX_CURRENCY {
                return err(format!("“{label}” vượt giới hạn cho phép"));
            }
            Ok(number_value(n))
        }
        "percent" => {
            let n = num(v, label)?;
            if !(-1000.0..=1000.0).contains(&n) {
                return err(format!("“{label}” phải trong khoảng −1000% đến 1000%"));
            }
            Ok(number_value(n))
        }
        "date" => {
            let s = text(v, label, 10)?;
            if !valid_ymd(&s) {
                return err(format!("“{label}” phải là ngày hợp lệ dạng YYYY-MM-DD"));
            }
            Ok(Value::String(s))
        }
        "datetime" => {
            let s = text(v, label, 40)?;
            let t = parse_instant(&s).filter(|t| {
                let ms = t.timestamp_millis();
                (-2_208_988_800_000..=7_258_118_400_000).contains(&ms)
            });
            match t {
                Some(t) => Ok(Value::String(iso(t))),
                None => err(format!("“{label}” phải là ngày giờ hợp lệ")),
            }
        }
        "boolean" => match v {
            Value::Bool(b) => Ok(Value::Bool(*b)),
            Value::String(s) if s == "true" => Ok(Value::Bool(true)),
            Value::String(s) if s == "false" => Ok(Value::Bool(false)),
            _ => err(format!("“{label}” phải là đúng/sai")),
        },
        "select" => {
            let s = text(v, label, 64)?;
            if !choices(f).contains(&s.as_str()) {
                return Err(not_in_choices(label, &s));
            }
            Ok(Value::String(s))
        }
        "email" => {
            let s = text(v, label, 254)?.to_lowercase();
            if !EMAIL.is_match(&s) {
                return err(format!("“{label}” không phải email hợp lệ"));
            }
            Ok(Value::String(s))
        }
        "phone" => {
            let s = text(v, label, 20)?;
            match normalize_vn_phone(&s) {
                Some(p) => Ok(Value::String(p)),
                None => err(format!(
                    "“{label}” phải là số điện thoại Việt Nam (10 số, bắt đầu 0 hoặc +84)"
                )),
            }
        }
        "url" => {
            let s = text(v, label, Limits::MAX_URL)?;
            let Ok(u) = url::Url::parse(&s) else {
                return err(format!("“{label}” không phải địa chỉ web hợp lệ"));
            };
            if u.scheme() != "http" && u.scheme() != "https" {
                return err(format!("“{label}” chỉ chấp nhận http:// hoặc https://"));
            }
            Ok(Value::String(s))
        }
        "user" => positive_id(v, label).map(Value::from),
        other => err(format!("“{label}”: kiểu {other} không xử lý ở đây")),
    }
}

/// `normalizeValue`: `Ok(None)` = xoá giá trị (rỗng); sai kiểu ⇒ [`ValueError`].
pub fn normalize_value(f: &FieldDef, raw: &Value) -> Result<Option<Value>, ValueError> {
    let label = f.label.as_str();
    if f.kind == "formula" {
        return err(format!(
            "“{label}” là trường công thức, tính tự động nên không nhập được"
        ));
    }
    if is_empty_value(Some(raw)) {
        return Ok(None);
    }
    match f.kind.as_str() {
        "multi_select" => {
            let Some(a) = raw.as_array() else {
                return err(format!("“{label}” phải là danh sách"));
            };
            if a.len() > Limits::MAX_MULTI_VALUES {
                return err(format!("“{label}” tối đa {} lựa chọn", Limits::MAX_MULTI_VALUES));
            }
            let allowed = choices(f);
            let mut out: Vec<String> = Vec::new();
            for x in a {
                let s = text(x, label, 64)?;
                if !out.contains(&s) {
                    out.push(s);
                }
            }
            for x in &out {
                if !allowed.contains(&x.as_str()) {
                    return Err(not_in_choices(label, x));
                }
            }
            Ok(Some(Value::Array(out.into_iter().map(Value::String).collect())))
        }
        "relation" => {
            if f.options.get("multiple").and_then(Value::as_bool) == Some(true) {
                id_list(raw, label).map(Some)
            } else {
                let one = raw.as_array().map_or(raw, |a| a.first().unwrap_or(&Value::Null));
                positive_id(one, label).map(|n| Some(Value::from(n)))
            }
        }
        "link" => link_tokens(raw, label).map(Some),
        _ => scalar(f, raw).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field(kind: &str, options: Value) -> FieldDef {
        FieldDef {
            id: 1,
            key: "k".into(),
            label: "Nhãn".into(),
            kind: kind.into(),
            required: false,
            is_unique: false,
            is_title: false,
            show_in_list: true,
            sort_order: 0,
            options,
            help_text: None,
        }
    }

    #[test]
    fn so_dien_thoai_va_rong() {
        assert_eq!(normalize_vn_phone("+84 901-234-567").as_deref(), Some("0901234567"));
        assert_eq!(normalize_vn_phone("84901234567").as_deref(), Some("0901234567"));
        assert_eq!(normalize_vn_phone("901234567"), None);
        assert!(is_empty_value(Some(&json!("  "))));
        assert!(is_empty_value(Some(&json!([]))));
        assert!(!is_empty_value(Some(&json!(0))));
        assert_eq!(normalize_value(&field("text", json!({})), &json!("  ")).unwrap(), None);
    }

    #[test]
    fn the_lien_ket() {
        let f = field("link", json!({}));
        assert_eq!(
            normalize_value(&f, &json!("@HS001, record:5; HS001")).unwrap(),
            Some(json!(["HS001", "record:5"]))
        );
        assert!(normalize_value(&f, &json!(["x y"])).is_err());
        assert!(normalize_value(&f, &json!(5)).is_err());
    }
}
