//! Bộ lọc của màn xem (chuyển từ `record-query.ts`: `buildFilters` phần kiểm, `choiceValues`, `pruneStaleFilter`). Bản này
//! chỉ KIỂM và dọn bộ lọc (màn xem lưu bộ lọc, M17); dựng SQL của danh sách bản ghi thuộc M18.

use serde_json::{Map, Value};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime};

use crate::types::{FILTERABLE_TYPES, FieldDef, Limits};
use crate::{R, bad};

fn as_array(v: &Value) -> Vec<&Value> {
    match v.as_array() {
        Some(a) => a.iter().collect(),
        None => vec![v],
    }
}

fn norm(s: &str) -> String {
    trinity_kernel::vi::trim_js(s).to_lowercase()
}

fn slice(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `choiceValues`: nhận giá trị hoặc nhãn/giá trị không phân biệt hoa thường, đổi về giá trị thật; không có ⇒ lỗi nêu danh sách.
pub fn choice_values(f: &FieldDef, v: &Value) -> Result<Vec<String>, String> {
    let vals: Vec<String> = as_array(v)
        .into_iter()
        .filter_map(Value::as_str)
        .take(Limits::MAX_FILTER_VALUES)
        .map(str::to_owned)
        .collect();
    let choices: Vec<&Value> = f
        .options
        .get("choices")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|c| c.get("value").is_some_and(Value::is_string))
                .collect()
        })
        .unwrap_or_default();
    if choices.is_empty() {
        return Ok(vals);
    }
    let value_of = |c: &Value| c.get("value").and_then(Value::as_str).unwrap_or_default().to_owned();
    let label_of = |c: &Value| {
        c.get("label")
            .map(|l| l.as_str().map_or_else(|| l.to_string(), str::to_owned))
            .unwrap_or_default()
    };
    let mut bad_vals = Vec::new();
    let out: Vec<String> = vals
        .iter()
        .map(|x| {
            if choices.iter().any(|c| value_of(c) == *x) {
                return x.clone();
            }
            let by = choices
                .iter()
                .find(|c| norm(&label_of(c)) == norm(x))
                .or_else(|| choices.iter().find(|c| norm(&value_of(c)) == norm(x)));
            match by {
                Some(c) => value_of(c),
                None => {
                    bad_vals.push(x.clone());
                    x.clone()
                }
            }
        })
        .collect();
    if !bad_vals.is_empty() {
        let list: Vec<String> = choices
            .iter()
            .take(30)
            .map(|c| {
                let (v, l) = (value_of(c), label_of(c));
                if !l.is_empty() && l != v {
                    format!("{v} ({l})")
                } else {
                    v
                }
            })
            .collect();
        let shown: Vec<String> = bad_vals.iter().take(5).map(|b| format!("“{}”", slice(b, 40))).collect();
        return Err(format!(
            "Bộ lọc “{}”: không có lựa chọn {}. Value hợp lệ: {}",
            f.label,
            shown.join(", "),
            list.join(", ")
        ));
    }
    Ok(out)
}

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn valid_ymd(s: &str) -> bool {
    is_ymd(s) && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// `!Number.isNaN(Date.parse(s))` cho các dạng ISO-8601 thường gặp (ngày, ngày giờ, có hoặc không múi giờ).
fn parses_as_date(s: &str) -> bool {
    let t = trinity_kernel::vi::trim_js(s);
    valid_ymd(t)
        || DateTime::parse_from_rfc3339(t).is_ok()
        || DateTime::parse_from_rfc3339(&t.replacen(' ', "T", 1)).is_ok()
        || ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f"]
            .iter()
            .any(|f| NaiveDateTime::parse_from_str(t, f).is_ok())
}

fn empty(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

fn one_filter(f: &FieldDef, v: &Value) -> Result<(), String> {
    match f.kind.as_str() {
        "select" | "multi_select" => choice_values(f, v).map(|_| ()),
        "relation" | "user" => {
            let n = as_array(v)
                .into_iter()
                .filter(|x| crate::values::js_int(Some(x)).is_some())
                .take(Limits::MAX_FILTER_VALUES)
                .count();
            if n == 0 {
                Err(format!("Bộ lọc “{}” cần mã hợp lệ", f.label))
            } else {
                Ok(())
            }
        }
        "boolean" => {
            if v.is_boolean() {
                Ok(())
            } else {
                Err(format!("Bộ lọc “{}” cần đúng/sai", f.label))
            }
        }
        "number" | "currency" | "percent" => {
            let o = v.as_object();
            for k in ["min", "max"] {
                let x = o.and_then(|m| m.get(k));
                if empty(x) {
                    continue;
                }
                if !x.is_some_and(Value::is_number) {
                    return Err(format!("Bộ lọc “{}” cần số hợp lệ", f.label));
                }
            }
            Ok(())
        }
        _ => {
            let o = v.as_object();
            for k in ["from", "to"] {
                let x = o.and_then(|m| m.get(k));
                if empty(x) {
                    continue;
                }
                let ok = x
                    .and_then(Value::as_str)
                    .is_some_and(|s| if f.kind == "date" { is_ymd(s) } else { parses_as_date(s) });
                if !ok {
                    return Err(format!("Bộ lọc “{}” cần ngày hợp lệ", f.label));
                }
                let s = x.and_then(Value::as_str).unwrap_or_default();
                if f.kind != "date" && is_ymd(s) && !valid_ymd(s) {
                    return Err(format!("Bộ lọc “{}” cần ngày hợp lệ", f.label));
                }
            }
            Ok(())
        }
    }
}

/// Kiểm bộ lọc dạng chuỗi JSON `{khoá_trường: giá trị}` (như `buildFilters`): chỉ trường sống, kiểu cho phép lọc.
pub fn validate_filters(fields: &[FieldDef], raw: &str) -> R<()> {
    if raw.is_empty() {
        return Ok(());
    }
    if raw.contains('\0') || raw.to_ascii_lowercase().contains("\\u0000") {
        return Err(bad("Bộ lọc chứa ký tự không hợp lệ"));
    }
    let Ok(obj) = serde_json::from_str::<Value>(raw) else {
        return Err(bad("Bộ lọc không phải JSON hợp lệ"));
    };
    let Some(map) = obj.as_object() else {
        return Err(bad("Bộ lọc phải là object"));
    };
    if map.len() > Limits::MAX_FILTER_KEYS {
        return Err(bad(format!("Tối đa {} bộ lọc", Limits::MAX_FILTER_KEYS)));
    }
    for (key, v) in map {
        let f = fields
            .iter()
            .find(|x| x.key == *key)
            .filter(|f| FILTERABLE_TYPES.contains(&f.kind.as_str()));
        let Some(f) = f else {
            return Err(bad(format!("Không lọc được theo trường “{}”", slice(key, 30))));
        };
        one_filter(f, v).map_err(bad)?;
    }
    Ok(())
}

/// `pruneStaleFilter`: bỏ khoá của trường đã xoá/đổi kiểu và lựa chọn đã không còn (màn cũ vẫn mở được).
pub fn prune_stale_filter(fields: &[FieldDef], filter: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, v) in filter {
        let Some(f) = fields
            .iter()
            .find(|x| x.key == *key)
            .filter(|f| FILTERABLE_TYPES.contains(&f.kind.as_str()))
        else {
            continue;
        };
        if f.kind == "select" || f.kind == "multi_select" {
            let keep: Vec<String> = as_array(v)
                .into_iter()
                .filter_map(Value::as_str)
                .flat_map(|x| choice_values(f, &Value::String(x.to_owned())).unwrap_or_default())
                .collect();
            if keep.is_empty() {
                continue;
            }
            out.insert(
                key.clone(),
                if v.is_array() {
                    Value::Array(keep.into_iter().map(Value::String).collect())
                } else {
                    Value::String(keep[0].clone())
                },
            );
            continue;
        }
        out.insert(key.clone(), v.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn f(key: &str, kind: &str, options: Value) -> FieldDef {
        FieldDef {
            id: 1,
            key: key.into(),
            label: key.to_uppercase(),
            kind: kind.into(),
            required: false,
            is_unique: false,
            is_title: false,
            show_in_list: true,
            sort_order: 10,
            options,
            help_text: None,
        }
    }

    fn fields() -> Vec<FieldDef> {
        vec![
            f(
                "tt",
                "select",
                json!({ "choices": [{ "value": "moi", "label": "Mới" }, { "value": "xong", "label": "Xong" }] }),
            ),
            f("gia", "currency", json!({})),
            f("ngay", "date", json!({})),
            f("gio", "datetime", json!({})),
            f("ok", "boolean", json!({})),
            f("ten", "text", json!({})),
            f("nv", "user", json!({})),
        ]
    }

    #[test]
    fn kiem_bo_loc() {
        let fs = fields();
        assert!(validate_filters(&fs, "").is_ok());
        assert!(
            validate_filters(
                &fs,
                r#"{"tt":"Mới","gia":{"min":1,"max":""},"ngay":{"from":"2026-01-01"},"ok":true,"nv":[1,2]}"#
            )
            .is_ok()
        );
        let msg = |raw: &str| validate_filters(&fs, raw).unwrap_err().to_string();
        assert!(msg("{").contains("Bộ lọc không phải JSON hợp lệ"));
        assert!(msg("[1]").contains("Bộ lọc phải là object"));
        assert!(msg(r#"{"ten":"a"}"#).contains("Không lọc được theo trường “ten”"));
        assert!(
            msg(r#"{"tt":"x"}"#).contains("Bộ lọc “TT”: không có lựa chọn “x”. Value hợp lệ: moi (Mới), xong (Xong)")
        );
        assert!(msg(r#"{"gia":{"min":"a"}}"#).contains("cần số hợp lệ"));
        assert!(msg(r#"{"ngay":{"from":"26/01/2026"}}"#).contains("cần ngày hợp lệ"));
        assert!(msg(r#"{"gio":{"to":"2026-02-30"}}"#).contains("cần ngày hợp lệ"));
        assert!(msg(r#"{"ok":"true"}"#).contains("cần đúng/sai"));
        assert!(msg(r#"{"nv":[]}"#).contains("cần mã hợp lệ"));
        assert!(msg(r#"{"tt":"a\u0000"}"#).contains("ký tự không hợp lệ"));
        let many: Vec<String> = (0..11).map(|i| format!("\"k{i}\":1")).collect();
        assert!(msg(&format!("{{{}}}", many.join(","))).contains("Tối đa 10 bộ lọc"));
    }

    #[test]
    fn nhan_lua_chon_va_don_bo_loc_cu() {
        let fs = fields();
        assert_eq!(
            choice_values(&fs[0], &json!(["mới", " XONG "])).unwrap(),
            ["moi", "xong"]
        );
        let filter = json!({ "tt": ["moi", "da_xoa"], "gia": { "min": 1 }, "ten": "x", "khong_co": 1, "ngay": null });
        let out = prune_stale_filter(&fs, filter.as_object().unwrap());
        assert_eq!(
            Value::Object(out),
            json!({ "tt": ["moi"], "gia": { "min": 1 }, "ngay": null })
        );
        let all_gone = json!({ "tt": "da_xoa" });
        assert!(prune_stale_filter(&fs, all_gone.as_object().unwrap()).is_empty());
    }
}
