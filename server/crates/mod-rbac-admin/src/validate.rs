//! Kiểm thân request đúng câu của class-validator (các DTO trong `rbac-admin/dto`).

use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;

/// Độ dài theo đơn vị UTF-16 (`string.length` của JS, thước đo của class-validator).
fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

fn invalid(msgs: Vec<String>) -> HttpError {
    HttpError::validation(msgs)
}

/// Thân phải là object (thân không phải object coi như không có khoá nào).
fn body(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// `@IsString() @MinLength(min) @MaxLength(max)` với câu tuỳ biến. class-validator xếp thông báo theo thứ tự đăng ký
/// ngược (decorator dưới cùng chạy trước): tối đa, tối thiểu, rồi kiểu.
fn text_rule(
    field: &str,
    v: Option<&Value>,
    min: usize,
    max: usize,
    min_msg: &str,
    max_msg: &str,
    out: &mut Vec<String>,
) {
    match v.and_then(Value::as_str) {
        Some(s) => {
            let n = len16(s);
            if n > max {
                out.push(max_msg.to_owned());
            }
            if n < min {
                out.push(min_msg.to_owned());
            }
        }
        None => {
            out.push(max_msg.to_owned());
            out.push(min_msg.to_owned());
            out.push(format!("{field} must be a string"));
        }
    }
}

/// `@IsOptional() @IsString() @MaxLength(500)`: vắng hoặc `null` thì bỏ qua.
fn description_rule(v: Option<&Value>, out: &mut Vec<String>) {
    match v {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            if len16(s) > 500 {
                out.push("description must be shorter than or equal to 500 characters".to_owned());
            }
        }
        Some(_) => {
            out.push("description must be shorter than or equal to 500 characters".to_owned());
            out.push("description must be a string".to_owned());
        }
    }
}

fn grants_rule(v: Option<&Value>, out: &mut Vec<String>) -> Option<Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m.clone()),
        _ => {
            out.push("grants phải là object".to_owned());
            None
        }
    }
}

/// Tên vai trò được cắt khoảng trắng khi lưu nên độ dài tối thiểu tính SAU khi cắt (tên toàn dấu cách không lọt qua
/// `MinLength`); không phải chuỗi thì giữ nguyên để báo lỗi kiểu như cũ.
fn trimmed(v: Option<&Value>) -> Option<Value> {
    v.map(|x| x.as_str().map_or_else(|| x.clone(), |s| Value::String(s.trim().to_owned())))
}

const NAME_MIN: &str = "Tên vai trò tối thiểu 2 ký tự";
const NAME_MAX: &str = "Tên vai trò tối đa 80 ký tự";

/// Thân `POST /roles`.
#[derive(Debug, Clone)]
pub struct CreateRole {
    pub name: String,
    pub description: Option<String>,
    pub grants: Map<String, Value>,
}

pub fn validate_create_role(v: &Value) -> Result<CreateRole, HttpError> {
    let b = body(v);
    let mut errors = Vec::new();
    text_rule("name", trimmed(b.get("name")).as_ref(), 2, 80, NAME_MIN, NAME_MAX, &mut errors);
    description_rule(b.get("description"), &mut errors);
    let grants = grants_rule(b.get("grants"), &mut errors);
    if !errors.is_empty() {
        return Err(invalid(errors));
    }
    Ok(CreateRole {
        name: b["name"].as_str().unwrap_or_default().to_owned(),
        description: b.get("description").and_then(Value::as_str).map(str::to_owned),
        grants: grants.unwrap_or_default(),
    })
}

/// Thân `PATCH /roles/:id`: `name` vắng ⇒ không đổi; `description`: `null` = xoá.
#[derive(Debug, Clone, Default)]
pub struct UpdateRole {
    pub name: Option<String>,
    /// `None` = không gửi; `Some(None)` = `null`.
    pub description: Option<Option<String>>,
}

pub fn validate_update_role(v: &Value) -> Result<UpdateRole, HttpError> {
    let b = body(v);
    let mut errors = Vec::new();
    if b.contains_key("name") {
        text_rule("name", trimmed(b.get("name")).as_ref(), 2, 80, NAME_MIN, NAME_MAX, &mut errors);
    }
    description_rule(b.get("description"), &mut errors);
    if !errors.is_empty() {
        return Err(invalid(errors));
    }
    Ok(UpdateRole {
        name: b.get("name").and_then(Value::as_str).map(str::to_owned),
        description: b.get("description").map(|d| d.as_str().map(str::to_owned)),
    })
}

/// Thân `PUT /roles/:id/grants`.
pub fn validate_set_grants(v: &Value) -> Result<Map<String, Value>, HttpError> {
    let mut errors = Vec::new();
    let g = grants_rule(body(v).get("grants"), &mut errors);
    match g {
        Some(m) => Ok(m),
        None => Err(invalid(errors)),
    }
}

/// Thân `PUT /users/:id/roles`: mảng id nguyên, không trùng, tối đa 50.
pub fn validate_set_user_roles(v: &Value) -> Result<Vec<i32>, HttpError> {
    let b = body(v);
    let mut errors = Vec::new();
    let ids: Option<Vec<Option<i64>>> = b.get("roleIds").and_then(Value::as_array).map(|a| {
        a.iter()
            .map(|x| {
                x.as_i64()
                    .or_else(|| x.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
            })
            .collect()
    });
    match &ids {
        Some(list) => {
            if list.iter().any(Option::is_none) {
                errors.push("roleIds phải là số nguyên".to_owned());
            }
            let mut seen: Vec<i64> = list.iter().flatten().copied().collect();
            let before = seen.len();
            seen.sort_unstable();
            seen.dedup();
            if seen.len() != before {
                errors.push("roleIds bị trùng".to_owned());
            }
            if list.len() > 50 {
                errors.push("Tối đa 50 vai trò".to_owned());
            }
        }
        None => {
            errors.push("roleIds phải là số nguyên".to_owned());
            errors.push("roleIds bị trùng".to_owned());
            errors.push("Tối đa 50 vai trò".to_owned());
            errors.push("roleIds phải là mảng".to_owned());
        }
    }
    if !errors.is_empty() {
        return Err(invalid(errors));
    }
    ids.unwrap_or_default()
        .into_iter()
        .map(|x| i32::try_from(x.unwrap_or(0)).map_err(|_| invalid(vec!["roleIds phải là số nguyên".to_owned()])))
        .collect()
}

/// Query `GET /rbac/audit` đã kiểm.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditQuery {
    pub target_type: Option<String>,
    pub target_id: Option<i32>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

/// `Number(chuỗi)` của JS: rỗng là 0; `0x`/`0o`/`0b` là số nguyên hệ 16/8/2 (không dấu); còn lại là số thập phân.
fn js_number(t: &str) -> Option<f64> {
    if t.is_empty() {
        return Some(0.0);
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => return t.parse().ok(),
    };
    let digits = &t[2..];
    if digits.starts_with('+') {
        return None;
    }
    u64::from_str_radix(digits, radix).ok().map(|n| n as f64)
}

/// `Number(chuỗi)` của `@Type(() => Number)`: rỗng là 0, rác là NaN; trả `None` nếu không phải số nguyên.
fn query_int(raw: &str) -> Option<i64> {
    let n = js_number(raw.trim())?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

pub fn validate_audit_query(
    target_type: Option<&str>,
    target_id: Option<&str>,
    page: Option<&str>,
    limit: Option<&str>,
) -> Result<AuditQuery, HttpError> {
    let mut errors = Vec::new();
    if let Some(t) = target_type
        && t != "role"
        && t != "user"
    {
        errors.push("targetType must be one of the following values: role, user".to_owned());
    }
    let tid = target_id.and_then(|s| {
        let n = query_int(s).and_then(|n| i32::try_from(n).ok());
        if n.is_none() {
            errors.push("targetId must be an integer number".to_owned());
        }
        n
    });
    let mut bounded = |name: &str, raw: Option<&str>, min: i64, max: Option<i64>| -> Option<i64> {
        let s = raw?;
        match query_int(s) {
            Some(n) => {
                if max.is_some_and(|m| n > m) {
                    errors.push(format!("{name} must not be greater than {}", max.unwrap_or_default()));
                }
                if n < min {
                    errors.push(format!("{name} must not be less than {min}"));
                }
                Some(n)
            }
            None => {
                if let Some(m) = max {
                    errors.push(format!("{name} must not be greater than {m}"));
                }
                errors.push(format!("{name} must not be less than {min}"));
                errors.push(format!("{name} must be an integer number"));
                None
            }
        }
    };
    let page = bounded("page", page, 1, None);
    let limit = bounded("limit", limit, 1, Some(100));
    if !errors.is_empty() {
        return Err(invalid(errors));
    }
    Ok(AuditQuery {
        target_type: target_type.map(str::to_owned),
        target_id: tid,
        page,
        limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_int_hieu_hex_octal_nhi_phan_nhu_js() {
        assert_eq!(query_int("0x10"), Some(16));
        assert_eq!(query_int(" 0XfF "), Some(255));
        assert_eq!(query_int("0o17"), Some(15));
        assert_eq!(query_int("0b101"), Some(5));
        assert_eq!(query_int(""), Some(0));
        assert_eq!(query_int("12"), Some(12));
        assert_eq!(query_int("1e3"), Some(1000));
        assert_eq!(query_int("0x"), None);
        assert_eq!(query_int("0xZZ"), None);
        assert_eq!(query_int("0x+1"), None);
        assert_eq!(query_int("1.5"), None);
        assert_eq!(query_int("abc"), None);
    }

    #[test]
    fn ten_vai_tro_cat_khoang_trang_truoc_khi_kiem_do_dai_toi_thieu() {
        assert!(validate_create_role(&json!({"name": "   ", "grants": {}})).is_err());
        assert!(validate_create_role(&json!({"name": " a ", "grants": {}})).is_err());
        assert!(validate_create_role(&json!({"name": " ab ", "grants": {}})).is_ok());
        assert!(validate_update_role(&json!({"name": "  "})).is_err());
        assert!(validate_update_role(&json!({"name": " ab "})).is_ok());
    }
}
