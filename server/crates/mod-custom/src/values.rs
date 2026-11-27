//! Chuẩn hoá lựa chọn và tuỳ chọn trường (chuyển từ `field-values.ts`: `normalizeChoices`, `normalizeOptions`, `slugifyKey`,
//! `formulaInput`). Lỗi giá trị là [`ValueError`] (câu tiếng Việt), controller đổi thành 400.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};
use trinity_kernel::formula::Val;
use trinity_kernel::vi::{fold_vi, trim_js};

use crate::types::{CHOICE_COLORS, Limits, js_len};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueError(pub String);

pub(crate) fn err<T>(m: impl Into<String>) -> Result<T, ValueError> {
    Err(ValueError(m.into()))
}

/// Ký tự điều khiển cấm: `[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`.
fn has_control(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
}

pub(crate) fn text(v: &Value, label: &str, max: usize) -> Result<String, ValueError> {
    let Some(s) = v.as_str() else {
        return err(format!("“{label}” phải là văn bản"));
    };
    let s = trim_js(s);
    if js_len(s) > max {
        return err(format!("“{label}” tối đa {max} ký tự"));
    }
    if has_control(s) {
        return err(format!("“{label}” chứa ký tự điều khiển không hợp lệ"));
    }
    Ok(s.to_owned())
}

/// `slugifyKey`: bỏ dấu, chữ thường, mọi dãy ngoài a-z0-9 thành `_`, bỏ `_` hai đầu; không bắt đầu bằng chữ thì thêm `f_`.
pub fn slugify_key(input: &str) -> String {
    let folded = fold_vi(input);
    let mut base = String::new();
    let mut pending = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending && !base.is_empty() {
                base.push('_');
            }
            pending = false;
            base.push(c);
        } else {
            pending = true;
        }
    }
    let s = if base.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
        base
    } else {
        format!("f_{base}")
    };
    s.chars().take(48).collect()
}

pub fn normalize_choices(raw: &Value) -> Result<Vec<Value>, ValueError> {
    let Some(list) = raw.as_array().filter(|a| !a.is_empty()) else {
        return err("Danh sách lựa chọn không được trống");
    };
    if list.len() > Limits::MAX_CHOICES {
        return err(format!("Tối đa {} lựa chọn", Limits::MAX_CHOICES));
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for (i, c) in list.iter().enumerate() {
        let empty = Map::new();
        let o = c.as_object().unwrap_or(&empty);
        let n = i + 1;
        let label = text(o.get("label").unwrap_or(&Value::Null), &format!("Lựa chọn {n}"), 100)?;
        if label.is_empty() {
            return err(format!("Lựa chọn {n} chưa có tên"));
        }
        let mut value = match o.get("value") {
            None | Some(Value::Null) => slugify_key(&label),
            Some(Value::String(s)) if s.is_empty() => slugify_key(&label),
            Some(v) => text(v, &format!("Lựa chọn {n}"), 64)?,
        };
        if value.is_empty() {
            return err(format!("Lựa chọn {n} chưa có mã"));
        }
        if seen.contains(&value) {
            let base = value.clone();
            let mut k = n;
            while seen.contains(&value) {
                let suffix = format!("_{k}");
                let keep: String = base.chars().take(64usize.saturating_sub(suffix.len())).collect();
                value = format!("{keep}{suffix}");
                k += 1;
            }
        }
        seen.insert(value.clone());
        let color = o
            .get("color")
            .and_then(Value::as_str)
            .filter(|c| CHOICE_COLORS.contains(c));
        out.push(match color {
            Some(c) => json!({ "value": value, "label": label, "color": c }),
            None => json!({ "value": value, "label": label }),
        });
    }
    Ok(out)
}

/// `Number.isSafeInteger`: số nguyên (kể cả `1.0`) trong khoảng an toàn của JS.
pub fn js_int(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

/// `normalizeOptions`: tuỳ chọn theo kiểu trường (select/multi_select, relation, formula; kiểu khác ⇒ `{}`).
pub fn normalize_options(kind: &str, raw: &Value) -> Result<Value, ValueError> {
    let empty = Map::new();
    let o = raw.as_object().unwrap_or(&empty);
    Ok(match kind {
        "select" | "multi_select" => json!({ "choices": normalize_choices(o.get("choices").unwrap_or(&Value::Null))? }),
        "relation" => {
            let multiple = o.get("multiple") == Some(&Value::Bool(true));
            if o.get("target").and_then(Value::as_str) == Some("contact") {
                return Ok(json!({ "target": "contact", "multiple": multiple }));
            }
            match js_int(o.get("target_object_id")).filter(|n| *n > 0) {
                Some(id) => json!({ "target_object_id": id, "multiple": multiple }),
                None => return err("Chọn thực thể đích cho trường liên kết"),
            }
        }
        "formula" => {
            let expression = o.get("expression").and_then(Value::as_str).map_or("", trim_js);
            if expression.is_empty() {
                return err("Nhập biểu thức cho trường công thức");
            }
            let format = o
                .get("format")
                .and_then(Value::as_str)
                .filter(|f| matches!(*f, "currency" | "percent" | "number"))
                .unwrap_or("number");
            let decimals = js_int(o.get("decimals")).filter(|d| (0..=6).contains(d));
            match decimals {
                Some(d) => json!({ "expression": expression, "format": format, "decimals": d }),
                None => json!({ "expression": expression, "format": format }),
            }
        }
        _ => json!({}),
    })
}

/// `formulaInput`: giá trị mẫu của trường vào công thức (percent chia 100; ngày giữ chuỗi; kiểu khác ⇒ thiếu).
pub fn formula_input(kind: &str, v: Option<&Value>) -> Option<Val> {
    let v = v?;
    match kind {
        "percent" => v.as_f64().filter(|_| v.is_number()).map(|n| Val::Num(n / 100.0)),
        "number" | "currency" => v.as_f64().filter(|_| v.is_number()).map(Val::Num),
        "date" | "datetime" => v.as_str().map(|s| Val::Str(s.to_owned())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_va_lua_chon() {
        assert_eq!(slugify_key("Giá gốc (VND)"), "gia_goc_vnd");
        assert_eq!(slugify_key("Đơn hàng"), "don_hang");
        assert_eq!(slugify_key("123 abc"), "f_123_abc");
        assert_eq!(slugify_key("  "), "f_");
        assert_eq!(slugify_key(&"a".repeat(80)).len(), 48);
        let c = normalize_choices(&json!([{ "label": "Mới" }, { "label": "Mới" }, { "label": " Xong ", "value": "done", "color": "green" }, { "label": "Hồng", "color": "x" }])).unwrap();
        assert_eq!(c[0], json!({ "value": "moi", "label": "Mới" }));
        assert_eq!(c[1], json!({ "value": "moi_2", "label": "Mới" }));
        assert_eq!(c[2], json!({ "value": "done", "label": "Xong", "color": "green" }));
        assert_eq!(c[3], json!({ "value": "hong", "label": "Hồng" }));
        for bad in [
            json!([]),
            json!("x"),
            json!([{ "label": "" }]),
            json!([{ "label": 5 }]),
            json!([{ "label": "a\u{1}b" }]),
        ] {
            assert!(normalize_choices(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            normalize_choices(&json!([{ "label": 5 }])).unwrap_err().0,
            "“Lựa chọn 1” phải là văn bản"
        );
    }

    #[test]
    fn tuy_chon_theo_kieu() {
        assert_eq!(normalize_options("text", &json!({ "x": 1 })).unwrap(), json!({}));
        assert_eq!(
            normalize_options("relation", &json!({ "target": "contact", "multiple": true })).unwrap(),
            json!({ "target": "contact", "multiple": true })
        );
        assert_eq!(
            normalize_options("relation", &json!({ "target_object_id": 7 })).unwrap(),
            json!({ "target_object_id": 7, "multiple": false })
        );
        assert_eq!(
            normalize_options("relation", &json!({})).unwrap_err().0,
            "Chọn thực thể đích cho trường liên kết"
        );
        assert!(normalize_options("relation", &json!({ "target_object_id": 0 })).is_err());
        assert!(normalize_options("relation", &json!({ "target_object_id": 1.5 })).is_err());
        assert_eq!(
            normalize_options(
                "formula",
                &json!({ "expression": " {a}*2 ", "format": "currency", "decimals": 2 })
            )
            .unwrap(),
            json!({ "expression": "{a}*2", "format": "currency", "decimals": 2 })
        );
        assert_eq!(
            normalize_options("formula", &json!({ "expression": "1", "format": "x", "decimals": 9 })).unwrap(),
            json!({ "expression": "1", "format": "number" })
        );
        assert_eq!(
            normalize_options("formula", &json!({})).unwrap_err().0,
            "Nhập biểu thức cho trường công thức"
        );
    }

    #[test]
    fn dau_vao_cong_thuc() {
        assert_eq!(formula_input("percent", Some(&json!(50))), Some(Val::Num(0.5)));
        assert_eq!(formula_input("number", Some(&json!("5"))), None);
        assert_eq!(
            formula_input("date", Some(&json!("2026-01-01"))),
            Some(Val::Str("2026-01-01".to_owned()))
        );
        assert_eq!(formula_input("text", Some(&json!("a"))), None);
        assert_eq!(formula_input("number", None), None);
    }
}
