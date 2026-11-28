//! Kiểm thân request của M01 như class-validator (`services/auth/src/auth/dto/*.ts`). Các DTO này chưa có trong
//! `contracts/dto/schema.json` nên kiểm tay; câu lỗi và thứ tự giống Nest: theo thứ tự trường, trong một trường theo thứ
//! tự decorator từ dưới lên.
#![allow(clippy::result_large_err)]

use serde_json::Value;
use trinity_kernel::error::HttpError;

use crate::Patch;

/// Câu lỗi tuỳ chỉnh của decorator (`None` = câu mặc định của class-validator).
type Custom<'a> = Option<&'a str>;

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `isEmail` của class-validator, rút gọn: một `@`, phần trước và domain không rỗng, domain có dấu chấm, không khoảng trắng.
fn valid_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !e.contains(char::is_whitespace)
        && domain.contains('.')
        && !domain.starts_with(['.', '-'])
        && !domain.ends_with(['.', '-'])
        && !domain.contains("..")
        && !domain.contains('@')
        && local.len() <= 64
        && e.len() <= 254
}

/// `@IsString` + `@MinLength` + `@MaxLength` (lỗi xếp max, min, isString: decorator dưới cùng chạy trước).
fn str_errs(
    v: Option<&Value>,
    prop: &str,
    min: Option<(usize, Custom<'_>)>,
    max: Option<(usize, Custom<'_>)>,
) -> Vec<String> {
    let s = v.and_then(Value::as_str);
    let len = s.map(utf16);
    let mut e = Vec::new();
    if let Some((n, msg)) = max
        && len.is_none_or(|l| l > n)
    {
        e.push(msg.map_or_else(
            || format!("{prop} must be shorter than or equal to {n} characters"),
            str::to_owned,
        ));
    }
    if let Some((n, msg)) = min
        && len.is_none_or(|l| l < n)
    {
        e.push(msg.map_or_else(
            || format!("{prop} must be longer than or equal to {n} characters"),
            str::to_owned,
        ));
    }
    if s.is_none() {
        e.push(format!("{prop} must be a string"));
    }
    e
}

/// `@IsEmail` (+ `@MaxLength` tuỳ chọn, chạy trước vì khai báo sau).
fn email_errs(v: Option<&Value>, prop: &str, max: Option<usize>) -> Vec<String> {
    let s = v.and_then(Value::as_str);
    let mut e = Vec::new();
    if let Some(n) = max
        && s.is_none_or(|s| utf16(s) > n)
    {
        e.push(format!("{prop} must be shorter than or equal to {n} characters"));
    }
    if s.is_none_or(|s| !valid_email(s)) {
        e.push("Email không hợp lệ".to_owned());
    }
    e
}

/// `@IsInt` + `@Min` + `@Max`; trả giá trị khi không có lỗi.
fn int_errs(
    v: Option<&Value>,
    prop: &str,
    min: Option<(f64, Custom<'_>)>,
    max: Option<f64>,
    int_msg: Custom<'_>,
) -> (Vec<String>, Option<i64>) {
    let f = v.and_then(Value::as_f64);
    let mut e = Vec::new();
    if let Some(n) = max
        && f.is_none_or(|f| f > n)
    {
        e.push(format!("{prop} must not be greater than {n}"));
    }
    if let Some((n, msg)) = min
        && f.is_none_or(|f| f < n)
    {
        e.push(msg.map_or_else(|| format!("{prop} must not be less than {n}"), str::to_owned));
    }
    if f.is_none_or(|f| !f.is_finite() || f.fract() != 0.0) {
        e.push(int_msg.map_or_else(|| format!("{prop} must be an integer number"), str::to_owned));
    }
    let value = if e.is_empty() { f.map(|f| f as i64) } else { None };
    (e, value)
}

fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

fn text(body: &Value, key: &str) -> String {
    body.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

#[derive(Debug, Clone)]
pub struct Login {
    pub email: String,
    pub password: String,
}

/// `LoginDto`.
pub fn login(body: &Value) -> Result<Login, HttpError> {
    let mut e = email_errs(body.get("email"), "email", None);
    e.extend(str_errs(
        body.get("password"),
        "password",
        Some((6, Some("Mật khẩu tối thiểu 6 ký tự"))),
        None,
    ));
    finish(e)?;
    Ok(Login {
        email: text(body, "email"),
        password: text(body, "password"),
    })
}

/// `RefreshDto`.
pub fn refresh(body: &Value) -> Result<String, HttpError> {
    if body.get("refresh_token").and_then(Value::as_str).is_none() {
        return Err(HttpError::validation(vec!["Refresh token phải là chuỗi".to_owned()]));
    }
    Ok(text(body, "refresh_token"))
}

/// `LogoutDto`: `refresh_token` tuỳ chọn.
pub fn logout(body: &Value) -> Result<Option<String>, HttpError> {
    match body.get("refresh_token") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(HttpError::validation(vec!["Refresh token phải là chuỗi".to_owned()])),
    }
}

/// `ChangePasswordDto`: (mật khẩu hiện tại, mật khẩu mới).
pub fn change_password(body: &Value) -> Result<(String, String), HttpError> {
    let mut e = str_errs(body.get("currentPassword"), "currentPassword", None, None);
    e.extend(str_errs(
        body.get("newPassword"),
        "newPassword",
        Some((8, Some("Mật khẩu mới tối thiểu 8 ký tự"))),
        None,
    ));
    finish(e)?;
    Ok((text(body, "currentPassword"), text(body, "newPassword")))
}

/// `ResetMyPasswordDto`.
pub fn reset_my_password(body: &Value) -> Result<String, HttpError> {
    let e = str_errs(body.get("currentPassword"), "currentPassword", Some((1, None)), None);
    finish(e)?;
    Ok(text(body, "currentPassword"))
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub full_name: Option<String>,
    pub phone: Patch<String>,
}

/// `\d{9}` sau `0` hoặc `+84`.
fn valid_phone(s: &str) -> bool {
    let rest = s.strip_prefix("+84").or_else(|| s.strip_prefix('0'));
    rest.is_some_and(|r| r.len() == 9 && r.bytes().all(|b| b.is_ascii_digit()))
}

/// `UpdateProfileDto`: `full_name` kiểm khi khác `undefined` (kể cả `null`), `phone` bỏ qua khi `null`/`undefined`.
pub fn update_profile(body: &Value) -> Result<Profile, HttpError> {
    let mut e = Vec::new();
    let full_name = body.get("full_name");
    if full_name.is_some() {
        e.extend(str_errs(
            full_name,
            "full_name",
            Some((2, Some("Họ tên tối thiểu 2 ký tự"))),
            Some((100, Some("Họ tên tối đa 100 ký tự"))),
        ));
    }
    let phone = match body.get("phone") {
        None => Patch::Keep,
        Some(Value::Null) => Patch::Clear,
        Some(Value::String(s)) if valid_phone(s) => Patch::Set(s.clone()),
        Some(other) => {
            e.push("Số điện thoại không hợp lệ (VD: 0912345678)".to_owned());
            if !other.is_string() {
                e.push("phone must be a string".to_owned());
            }
            Patch::Keep
        }
    };
    finish(e)?;
    Ok(Profile {
        full_name: full_name.and_then(Value::as_str).map(str::to_owned),
        phone,
    })
}

/// `UpdateLoginWifiCheckDto` / `UpdateSingleSessionDto`.
pub fn enabled(body: &Value) -> Result<bool, HttpError> {
    body.get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| HttpError::validation(vec!["enabled phải là boolean".to_owned()]))
}

#[derive(Debug, Clone)]
pub struct Register {
    pub company_name: String,
    pub full_name: String,
    pub email: String,
    pub password: String,
}

/// `RegisterDto`.
pub fn register(body: &Value) -> Result<Register, HttpError> {
    let mut e = str_errs(
        body.get("company_name"),
        "company_name",
        Some((2, Some("Tên công ty tối thiểu 2 ký tự"))),
        Some((200, None)),
    );
    e.extend(str_errs(
        body.get("full_name"),
        "full_name",
        Some((2, Some("Họ tên tối thiểu 2 ký tự"))),
        Some((200, None)),
    ));
    e.extend(email_errs(body.get("email"), "email", Some(255)));
    e.extend(str_errs(
        body.get("password"),
        "password",
        Some((8, Some("Mật khẩu tối thiểu 8 ký tự"))),
        Some((200, None)),
    ));
    finish(e)?;
    Ok(Register {
        company_name: text(body, "company_name"),
        full_name: text(body, "full_name"),
        email: text(body, "email"),
        password: text(body, "password"),
    })
}

/// `CreateInvitationDto`: (email, role_id).
pub fn create_invitation(body: &Value) -> Result<(String, i32), HttpError> {
    let mut e = email_errs(body.get("email"), "email", Some(255));
    let (errs, role) = int_errs(
        body.get("role_id"),
        "role_id",
        Some((1.0, None)),
        Some(2_147_483_647.0),
        None,
    );
    e.extend(errs);
    finish(e)?;
    let role = role.and_then(|r| i32::try_from(r).ok()).unwrap_or_default();
    Ok((text(body, "email"), role))
}

fn token_errs(body: &Value) -> Vec<String> {
    str_errs(body.get("token"), "token", Some((8, None)), Some((200, None)))
}

/// `InvitationTokenDto`.
pub fn invitation_token(body: &Value) -> Result<String, HttpError> {
    finish(token_errs(body))?;
    Ok(text(body, "token"))
}

#[derive(Debug, Clone)]
pub struct Accept {
    pub token: String,
    pub full_name: String,
    /// Có `code` thì mật khẩu không bắt buộc (bỏ qua nếu gửi kèm).
    pub password: Option<String>,
    /// Mã 6 số gửi tới email của lời mời (#675).
    pub code: Option<String>,
}

/// `AcceptInvitationDto`: trường của lớp con trước, `token` (lớp cha) sau cùng. #675: gửi `code` (mã xác nhận email) thì
/// không cần `password`.
pub fn accept_invitation(body: &Value) -> Result<Accept, HttpError> {
    let mut e = str_errs(
        body.get("full_name"),
        "full_name",
        Some((2, Some("Họ tên tối thiểu 2 ký tự"))),
        Some((200, None)),
    );
    let code = match body.get("code") {
        None | Some(Value::Null) => None,
        v => {
            e.extend(code_errs(v));
            v.and_then(Value::as_str).map(str::to_owned)
        }
    };
    if code.is_none() {
        e.extend(str_errs(
            body.get("password"),
            "password",
            Some((8, Some("Mật khẩu tối thiểu 8 ký tự"))),
            Some((200, None)),
        ));
    }
    e.extend(token_errs(body));
    finish(e)?;
    Ok(Accept {
        token: text(body, "token"),
        full_name: text(body, "full_name"),
        password: code.is_none().then(|| text(body, "password")),
        code,
    })
}

/// Mã 6 chữ số.
fn code_errs(v: Option<&Value>) -> Vec<String> {
    match v.and_then(Value::as_str).map(str::trim) {
        Some(c) if c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()) => Vec::new(),
        _ => vec!["Mã gồm 6 chữ số".to_owned()],
    }
}

/// `POST /auth/email/start { email }`.
pub fn email_start(body: &Value) -> Result<String, HttpError> {
    finish(email_errs(body.get("email"), "email", Some(254)))?;
    Ok(text(body, "email"))
}

/// `POST /auth/email/verify { email, code }`.
pub fn email_verify(body: &Value) -> Result<(String, String), HttpError> {
    let mut e = email_errs(body.get("email"), "email", Some(254));
    e.extend(code_errs(body.get("code")));
    finish(e)?;
    Ok((text(body, "email"), text(body, "code").trim().to_owned()))
}

/// `{ <key>: chuỗi bí mật }` (token link, vé): 1..=512 ký tự.
pub fn secret(body: &Value, key: &str) -> Result<String, HttpError> {
    match body.get(key).and_then(Value::as_str) {
        Some(t) if !t.trim().is_empty() && t.len() <= 512 => Ok(t.trim().to_owned()),
        _ => Err(HttpError::validation(vec![format!("{key} không hợp lệ")])),
    }
}

/// `PUT /auth/account/password { new_password, current_password? }`.
pub fn set_password(body: &Value) -> Result<(Option<String>, String), HttpError> {
    let mut e = str_errs(
        body.get("new_password"),
        "new_password",
        Some((8, Some("Mật khẩu mới tối thiểu 8 ký tự"))),
        Some((200, None)),
    );
    let current = match body.get("current_password") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            e.push("current_password must be a string".to_owned());
            None
        }
    };
    finish(e)?;
    Ok((current, text(body, "new_password")))
}

/// `DELETE /auth/account/password { current_password }`.
pub fn remove_password(body: &Value) -> Result<String, HttpError> {
    finish(str_errs(
        body.get("current_password"),
        "current_password",
        Some((1, Some("Vui lòng nhập mật khẩu hiện tại"))),
        Some((200, None)),
    ))?;
    Ok(text(body, "current_password"))
}

/// Một dòng của danh sách áp dụng Wi-Fi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetItem {
    pub scope_type: String,
    pub target_user_id: i32,
}

const MAX_TARGET_ITEMS: usize = 1000;
const NESTED_ITEMS: &str = "each value in nested property items must be either object or array";

/// `ReplaceLoginWifiCheckTargetsDto`.
pub fn replace_targets(body: &Value) -> Result<Vec<TargetItem>, HttpError> {
    let mut e = Vec::new();
    let mut out = Vec::new();
    match body.get("items") {
        Some(Value::Array(a)) => {
            if a.len() > MAX_TARGET_ITEMS {
                e.push(format!("Tối đa {MAX_TARGET_ITEMS} dòng cấu hình"));
            }
            for it in a {
                if !it.is_object() {
                    e.push(NESTED_ITEMS.to_owned());
                    continue;
                }
                let scope = it
                    .get("scope_type")
                    .and_then(Value::as_str)
                    .filter(|s| ["user", "team", "department"].contains(s));
                if scope.is_none() {
                    e.push("scope_type không hợp lệ".to_owned());
                }
                let (errs, id) = int_errs(
                    it.get("target_user_id"),
                    "target_user_id",
                    Some((1.0, Some("target_user_id không hợp lệ"))),
                    None,
                    Some("target_user_id phải là số nguyên"),
                );
                e.extend(errs);
                let id32 = id.and_then(|i| i32::try_from(i).ok());
                if id.is_some() && id32.is_none() {
                    // Ngoài khoảng int4: không có người dùng nào mang id này.
                    e.push("target_user_id không hợp lệ".to_owned());
                }
                if let (Some(s), Some(id)) = (scope, id32) {
                    out.push(TargetItem {
                        scope_type: s.to_owned(),
                        target_user_id: id,
                    });
                }
            }
        }
        other => {
            if other.is_some_and(|v| !v.is_null() && !v.is_object()) {
                e.push("nested property items must be either object or array".to_owned());
            }
            e.push(format!("Tối đa {MAX_TARGET_ITEMS} dòng cấu hình"));
            e.push("items phải là mảng".to_owned());
        }
    }
    finish(e)?;
    Ok(out)
}
