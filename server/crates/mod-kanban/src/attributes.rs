//! Kiểm giá trị trường tuỳ biến của thẻ theo `kanban_field_defs` của board (`common/kanban-field.validator.ts`).
//!
//! Khác bản TS (ghi để người review biết): chuỗi ngày chỉ nhận dạng ISO 8601 (`YYYY-MM-DD` hoặc có giờ), không nhận các dạng
//! V8 `Date.parse` còn chấp nhận (`Jan 1 2025`); giá trị số dạng mảng/đối tượng (`Number([5])`) bị từ chối thay vì ép kiểu.

use serde_json::{Map, Number, Value};
use trinity_db::models::KanbanFieldDef;
use trinity_kernel::error::AppError;
use trinity_kernel::vi::is_js_whitespace;

use crate::{bad_request, len16};

pub const TEXT_MAX_LENGTH: usize = 2000;
pub const NUMBER_CEILING: f64 = 1_000_000_000_000.0;
pub const MONEY_CEILING: f64 = 1_000_000_000_000.0;

fn err<T>(msg: String) -> Result<T, AppError> {
    Err(bad_request(msg))
}

fn as_object(v: Option<&Value>) -> Result<Map<String, Value>, AppError> {
    match v {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => err("attributes phải là object".to_owned()),
    }
}

/// Kiểm `raw` theo các trường của board. `partial` (khi sửa): chỉ kiểm khoá có mặt. Trả đối tượng đã chuẩn hoá theo thứ tự
/// khai báo trường; giá trị rỗng không bắt buộc thành `null`.
pub fn validate(defs: &[KanbanFieldDef], raw: Option<&Value>, partial: bool) -> Result<Map<String, Value>, AppError> {
    let input = as_object(raw)?;
    if defs.is_empty() {
        if !input.is_empty() {
            return err("Board chưa có trường tuỳ biến nào — không thể nhập attributes".to_owned());
        }
        return Ok(Map::new());
    }
    for key in input.keys() {
        if !defs.iter().any(|d| &d.key == key) {
            return err(format!("Trường \"{key}\" không thuộc board này"));
        }
    }
    let mut out = Map::new();
    for def in defs {
        if partial && !input.contains_key(&def.key) {
            continue;
        }
        out.insert(def.key.clone(), validate_one(def, input.get(&def.key))?);
    }
    Ok(out)
}

/// `{ ...existing, ...validatedNew }`.
pub fn merge(existing: &Value, validated: Map<String, Value>) -> Result<Map<String, Value>, AppError> {
    let mut base = as_object(Some(existing))?;
    for (k, v) in validated {
        base.insert(k, v);
    }
    Ok(base)
}

fn validate_one(def: &KanbanFieldDef, value: Option<&Value>) -> Result<Value, AppError> {
    let empty = matches!(value, None | Some(Value::Null)) || matches!(value, Some(Value::String(s)) if s.is_empty());
    let Some(value) = value.filter(|_| !empty) else {
        return if def.required {
            err(format!("Trường \"{}\" là bắt buộc", def.label))
        } else {
            Ok(Value::Null)
        };
    };
    let l = &def.label;
    match def.r#type.as_str() {
        "text" => string(l, value).map(Value::String),
        "url" => url(l, value).map(Value::String),
        "number" => number(l, value, NUMBER_CEILING).map(|(_, v)| v),
        "money" => money(l, value),
        "date" => date(l, value),
        "checkbox" => match value {
            Value::Bool(_) => Ok(value.clone()),
            _ => err(format!("Trường \"{l}\" phải là boolean")),
        },
        "select" => select(def, value),
        "multi_select" => multi_select(def, value),
        "user" => user(l, value),
        _ => err(format!("Board cấu hình sai kiểu cho trường \"{l}\"")),
    }
}

fn string(label: &str, v: &Value) -> Result<String, AppError> {
    let Value::String(s) = v else {
        return err(format!("Trường \"{label}\" phải là chuỗi"));
    };
    if len16(s) > TEXT_MAX_LENGTH {
        return err(format!("Trường \"{label}\" tối đa {TEXT_MAX_LENGTH} ký tự"));
    }
    Ok(s.clone())
}

fn url(label: &str, v: &Value) -> Result<String, AppError> {
    let s = string(label, v)?;
    let lower = s.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    if rest.is_some_and(|r| !r.is_empty() && !r.chars().any(is_js_whitespace)) {
        Ok(s)
    } else {
        err(format!("Trường \"{label}\" phải là URL hợp lệ (http/https)"))
    }
}

/// `Number(value)` cho số hoặc chuỗi số; giữ nguyên số JSON gốc.
fn to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = trinity_kernel::vi::trim_js(s);
            if t.is_empty() {
                return Some(0.0);
            }
            match t.get(..2) {
                Some("0x" | "0X") => u64::from_str_radix(&t[2..], 16).ok().map(|n| n as f64),
                Some("0b" | "0B") => u64::from_str_radix(&t[2..], 2).ok().map(|n| n as f64),
                Some("0o" | "0O") => u64::from_str_radix(&t[2..], 8).ok().map(|n| n as f64),
                _ => {
                    let ok = t
                        .bytes()
                        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'));
                    if ok { t.parse::<f64>().ok() } else { None }
                }
            }
        }
        _ => None,
    }
}

fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::Number(Number::from(n as i64))
    } else {
        Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

fn number(label: &str, v: &Value, ceiling: f64) -> Result<(f64, Value), AppError> {
    let Some(n) = to_f64(v).filter(|n| n.is_finite()) else {
        return err(format!("Trường \"{label}\" phải là số"));
    };
    if n.abs() > ceiling {
        return err(format!("Trường \"{label}\" vượt trần cho phép"));
    }
    Ok((
        n,
        if matches!(v, Value::Number(_)) {
            v.clone()
        } else {
            json_number(n)
        },
    ))
}

fn money(label: &str, v: &Value) -> Result<Value, AppError> {
    let (n, out) = number(label, v, MONEY_CEILING)?;
    if n.fract() != 0.0 {
        return err(format!("Trường \"{label}\" phải là số nguyên (VNĐ, không thập phân)"));
    }
    if n < 0.0 {
        return err(format!("Trường \"{label}\" không được âm"));
    }
    Ok(out)
}

/// Ngày ISO 8601: `YYYY-MM-DD` hoặc `YYYY-MM-DDTHH:mm[:ss[.fff]][Z|±HH:mm]` (tháng 1..12, ngày 1..31 như V8).
fn valid_iso(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|x| x.iter().all(u8::is_ascii_digit));
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok()).unwrap_or(99);
    if !(digits(0..4) && b.get(4) == Some(&b'-') && digits(5..7) && b.get(7) == Some(&b'-') && digits(8..10)) {
        return false;
    }
    if !(1..=12).contains(&num(5..7)) || !(1..=31).contains(&num(8..10)) {
        return false;
    }
    if s.len() == 10 {
        return true;
    }
    if !matches!(b.get(10), Some(b'T' | b't')) || !digits(11..13) || b.get(13) != Some(&b':') || !digits(14..16) {
        return false;
    }
    let (h, m) = (num(11..13), num(14..16));
    let mut i = 16;
    let mut sec = 0;
    if b.get(i) == Some(&b':') {
        if !digits(i + 1..i + 3) {
            return false;
        }
        sec = num(i + 1..i + 3);
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut j = start;
            while b.get(j).is_some_and(u8::is_ascii_digit) {
                j += 1;
            }
            if j == start {
                return false;
            }
            i = j;
        }
    }
    if m > 59 || sec > 59 || h > 24 || (h == 24 && (m != 0 || sec != 0)) {
        return false;
    }
    match &s[i..] {
        "" | "Z" | "z" => true,
        z if z.len() == 6 && matches!(z.as_bytes()[0], b'+' | b'-') && z.as_bytes()[3] == b':' => {
            z[1..3].chars().all(|c| c.is_ascii_digit())
                && z[4..].chars().all(|c| c.is_ascii_digit())
                && z[1..3].parse::<u32>().is_ok_and(|x| x < 24)
                && z[4..].parse::<u32>().is_ok_and(|x| x < 60)
        }
        _ => false,
    }
}

fn date(label: &str, v: &Value) -> Result<Value, AppError> {
    match v {
        Value::String(s) if valid_iso(s) => Ok(v.clone()),
        _ => err(format!("Trường \"{label}\" phải là ngày hợp lệ (ISO 8601)")),
    }
}

fn user(label: &str, v: &Value) -> Result<Value, AppError> {
    match to_f64(v) {
        Some(n) if n.fract() == 0.0 && n > 0.0 && n < 9.0e15 => Ok(if matches!(v, Value::Number(_)) {
            v.clone()
        } else {
            json_number(n)
        }),
        _ => err(format!("Trường \"{label}\" phải là ID người dùng hợp lệ")),
    }
}

fn option_values(def: &KanbanFieldDef) -> Result<Vec<String>, AppError> {
    let Some(Value::Array(items)) = def.options.as_ref().map(|o| &o.0) else {
        return err(format!(
            "Board thiếu cấu hình lựa chọn (options) cho trường \"{}\"",
            def.label
        ));
    };
    Ok(items
        .iter()
        .filter_map(|o| o.get("value").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

fn select(def: &KanbanFieldDef, v: &Value) -> Result<Value, AppError> {
    let Value::String(s) = v else {
        return err(format!("Trường \"{}\" phải là 1 lựa chọn (chuỗi)", def.label));
    };
    if !option_values(def)?.contains(s) {
        return err(format!("Trường \"{}\" có giá trị không hợp lệ", def.label));
    }
    Ok(v.clone())
}

fn multi_select(def: &KanbanFieldDef, v: &Value) -> Result<Value, AppError> {
    let items = match v {
        Value::Array(a) if a.iter().all(Value::is_string) => a,
        _ => return err(format!("Trường \"{}\" phải là mảng chuỗi", def.label)),
    };
    let allowed = option_values(def)?;
    for item in items {
        let s = item.as_str().unwrap_or_default();
        if !allowed.iter().any(|a| a == s) {
            return err(format!("Trường \"{}\" có giá trị \"{s}\" không hợp lệ", def.label));
        }
    }
    Ok(v.clone())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trinity_db::models::KanbanFieldDef;
    use trinity_db::types::{JsNumber, JsonValue, Timestamp};

    use super::*;

    fn def(key: &str, ty: &str, required: bool, options: Option<Value>) -> KanbanFieldDef {
        let now = Timestamp(chrono::Utc::now());
        KanbanFieldDef {
            id: 1,
            board_id: 1,
            key: key.into(),
            label: format!("Nhãn {key}"),
            r#type: ty.into(),
            options: options.map(JsonValue),
            required,
            show_on_card: false,
            position: JsNumber(1.0),
            created_at: now,
            updated_at: now,
        }
    }

    fn msg(r: Result<Map<String, Value>, AppError>) -> String {
        let (_, b) = r.unwrap_err().response(true);
        match b.message {
            trinity_kernel::error::Message::One(m) => m,
            trinity_kernel::error::Message::Many(m) => m.join(";"),
        }
    }

    #[test]
    fn kieu_truong_va_thong_diep() {
        let defs = [
            def("ten", "text", true, None),
            def("sl", "number", false, None),
            def("gia", "money", false, None),
            def("ngay", "date", false, None),
            def("tt", "select", false, Some(json!([{ "value": "a", "label": "A" }]))),
            def(
                "nhieu",
                "multi_select",
                false,
                Some(json!([{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }])),
            ),
            def("ai", "user", false, None),
            def("ok", "checkbox", false, None),
            def("web", "url", false, None),
        ];
        let good = json!({ "ten": "x", "sl": "12", "gia": 5000, "ngay": "2026-02-30", "tt": "a", "nhieu": ["a", "b"], "ai": "7", "ok": true, "web": "https://a.vn" });
        let out = validate(&defs, Some(&good), false).unwrap();
        assert_eq!(out["sl"], json!(12), "chuỗi số chuẩn hoá về số");
        assert_eq!(out["ai"], json!(7));
        for (bad, expect) in [
            (json!({}), "Trường \"Nhãn ten\" là bắt buộc"),
            (
                json!({ "ten": "x", "khac": 1 }),
                "Trường \"khac\" không thuộc board này",
            ),
            (json!({ "ten": "x", "sl": true }), "Trường \"Nhãn sl\" phải là số"),
            (
                json!({ "ten": "x", "sl": 2e12 }),
                "Trường \"Nhãn sl\" vượt trần cho phép",
            ),
            (
                json!({ "ten": "x", "gia": 1.5 }),
                "Trường \"Nhãn gia\" phải là số nguyên (VNĐ, không thập phân)",
            ),
            (json!({ "ten": "x", "gia": -1 }), "Trường \"Nhãn gia\" không được âm"),
            (
                json!({ "ten": "x", "ngay": "hôm qua" }),
                "Trường \"Nhãn ngay\" phải là ngày hợp lệ (ISO 8601)",
            ),
            (
                json!({ "ten": "x", "tt": "z" }),
                "Trường \"Nhãn tt\" có giá trị không hợp lệ",
            ),
            (
                json!({ "ten": "x", "nhieu": ["a", "z"] }),
                "Trường \"Nhãn nhieu\" có giá trị \"z\" không hợp lệ",
            ),
            (
                json!({ "ten": "x", "ai": 0 }),
                "Trường \"Nhãn ai\" phải là ID người dùng hợp lệ",
            ),
            (
                json!({ "ten": "x", "web": "ftp://a" }),
                "Trường \"Nhãn web\" phải là URL hợp lệ (http/https)",
            ),
            (
                json!({ "ten": "x", "ok": "true" }),
                "Trường \"Nhãn ok\" phải là boolean",
            ),
        ] {
            assert_eq!(msg(validate(&defs, Some(&bad), false)), expect, "{bad}");
        }
        // Sửa một phần: chỉ kiểm khoá có mặt, rồi trộn vào giá trị cũ.
        let patch = validate(&defs, Some(&json!({ "sl": 3 })), true).unwrap();
        assert_eq!(patch.len(), 1);
        let merged = merge(&json!({ "ten": "cũ", "sl": 1 }), patch).unwrap();
        assert_eq!(Value::Object(merged), json!({ "ten": "cũ", "sl": 3 }));
        assert_eq!(
            msg(validate(&[], Some(&json!({ "a": 1 })), false)),
            "Board chưa có trường tuỳ biến nào — không thể nhập attributes"
        );
        assert!(validate(&[], None, false).unwrap().is_empty());
        assert_eq!(
            msg(validate(&defs, Some(&json!([1])), false)),
            "attributes phải là object"
        );
    }
}
