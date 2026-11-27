//! Kiểm body kiểu class-validator cho DTO của link mở chat và kịch bản (`dto-facebook.ts`: `ChatLinkDto`, `FlowDto`). Các DTO này
//! chưa có trong `contracts/dto/schema.json` nên viết tay như `pages::UpdatePage::from_json`: thông điệp lỗi là của class-validator,
//! lỗi trường lạ (`property x should not exist`) đứng trước, rồi lỗi từng thuộc tính theo thứ tự khai báo.

use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;

pub(crate) type Obj = Map<String, Value>;

/// Body phải là object (`body must be an object`).
pub(crate) fn object(v: &Value) -> Result<&Obj, HttpError> {
    v.as_object()
        .ok_or_else(|| HttpError::validation(vec!["body must be an object".to_owned()]))
}

/// Trường ngoài danh sách cho phép (`forbidNonWhitelisted`).
pub(crate) fn unknown(o: &Obj, allowed: &[&str], e: &mut Vec<String>) {
    for k in o.keys() {
        if !allowed.contains(&k.as_str()) {
            e.push(format!("property {k} should not exist"));
        }
    }
}

/// `@IsOptional() @IsString() @MaxLength(max)`. Vắng ⇒ `None`; `null` ⇒ `Some("")` (class-validator bỏ qua `null`, rồi
/// service coi như chuỗi rỗng và trả 400 bằng câu riêng của nó).
pub(crate) fn opt_string(o: &Obj, name: &str, max: usize, e: &mut Vec<String>) -> Option<String> {
    match o.get(name)? {
        Value::Null => Some(String::new()),
        Value::String(s) => {
            if s.encode_utf16().count() > max {
                e.push(format!("{name} must be shorter than or equal to {max} characters"));
                return None;
            }
            Some(s.clone())
        }
        _ => {
            e.push(format!("{name} must be shorter than or equal to {max} characters"));
            e.push(format!("{name} must be a string"));
            None
        }
    }
}

/// `@IsOptional() @IsBoolean()`: `null` như vắng.
pub(crate) fn opt_bool(o: &Obj, name: &str, e: &mut Vec<String>) -> Option<bool> {
    match o.get(name) {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            e.push(format!("{name} must be a boolean value"));
            None
        }
    }
}

/// Số nguyên trong `int4` (JS: `Number.isInteger`, nhận cả `5.0`).
pub(crate) fn int_of(v: &Value) -> Option<i32> {
    if let Some(n) = v.as_i64() {
        return i32::try_from(n).ok();
    }
    v.as_f64()
        .filter(|f| f.fract() == 0.0 && (-2_147_483_648.0..=2_147_483_647.0).contains(f))
        .map(|f| f as i32)
}

/// `@ValidateIf(v !== undefined && v !== null) @IsInt()`: vắng ⇒ `None`; `null` ⇒ `Some(None)`; số nguyên ⇒ `Some(Some(n))`.
/// Số ngoài `int4` ⇒ lỗi 400 (không để DB báo tràn).
pub(crate) fn nullable_int(o: &Obj, name: &str, e: &mut Vec<String>) -> Option<Option<i32>> {
    match o.get(name)? {
        Value::Null => Some(None),
        v => {
            let n = int_of(v);
            if n.is_none() {
                e.push(format!("{name} must be an integer number"));
            }
            n.map(Some)
        }
    }
}

/// Gộp lỗi thành kết quả.
pub(crate) fn finish(e: Vec<String>) -> Result<(), HttpError> {
    if e.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(e))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chuoi_toi_da_va_kieu() {
        let v = json!({ "a": "x".repeat(5), "b": 3, "c": null });
        let o = v.as_object().unwrap();
        let mut e = Vec::new();
        assert_eq!(opt_string(o, "a", 4, &mut e), None);
        assert_eq!(opt_string(o, "b", 4, &mut e), None);
        assert_eq!(opt_string(o, "c", 4, &mut e).as_deref(), Some(""));
        assert_eq!(opt_string(o, "zz", 4, &mut e), None);
        assert_eq!(
            e,
            vec![
                "a must be shorter than or equal to 4 characters",
                "b must be shorter than or equal to 4 characters",
                "b must be a string",
            ]
        );
    }

    #[test]
    fn so_nguyen_int4() {
        assert_eq!(int_of(&json!(5)), Some(5));
        assert_eq!(int_of(&json!(5.0)), Some(5));
        assert_eq!(int_of(&json!(5.5)), None);
        assert_eq!(int_of(&json!(2_147_483_648_i64)), None);
        assert_eq!(int_of(&json!("5")), None);
        let v = json!({ "n": null, "m": 9_999_999_999_i64 });
        let o = v.as_object().unwrap();
        let mut e = Vec::new();
        assert_eq!(nullable_int(o, "n", &mut e), Some(None));
        assert_eq!(nullable_int(o, "m", &mut e), None);
        assert_eq!(e, vec!["m must be an integer number"]);
    }

    #[test]
    fn truong_la_va_logic() {
        let v = json!({ "x": 1, "is_active": "yes" });
        let o = v.as_object().unwrap();
        let mut e = Vec::new();
        unknown(o, &["is_active"], &mut e);
        assert_eq!(opt_bool(o, "is_active", &mut e), None);
        assert_eq!(e, vec!["property x should not exist", "is_active must be a boolean value"]);
        assert!(finish(e).is_err());
        assert!(finish(Vec::new()).is_ok());
        assert!(object(&json!([1])).is_err());
    }
}
