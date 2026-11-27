//! Kiểm thân/query request đúng câu của class-validator cho các DTO của M06. `CreateOptionDto` và `QueryOptionsDto` có
//! trong `contracts/dto/schema.json` nên đi qua bộ kiểm chung K15 ([`trinity_http::validate`]); bốn DTO còn lại
//! (`UpdateOptionDto`, `UpdateNotificationSoundDto`, `UpdateDepartmentsDto`, `UpdateOrgFeaturesDto`) chưa có metadata
//! trong schema nên kiểm tay ở đây, đối chiếu với `ValidationPipe` thật bằng `tests/fixtures/dto.json`
//! (sinh bởi `apps/monolith/src/__tests__/settings-dto-golden.spec.ts`). Mọi route của M06 chạy chế độ strict: khoá lạ ⇒
//! `property <khoá> should not exist` (xếp TRƯỚC các lỗi luật, như class-validator).
//!
//! Khác bản Node đã biết: thứ tự các khoá lạ theo thứ tự chữ cái (serde_json), và `null` ở khoá của
//! `UpdateOrgFeaturesDto` được coi như vắng (Node lưu `null`).

use serde_json::{Map, Value};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::general::{MAX_DEPARTMENT_NAME_LENGTH, MAX_DEPARTMENTS, SOUND_IDS};

/// Độ dài của `@MaxLength` (validator.js `isLength`): đếm điểm mã, cặp thay thế tính một ký tự.
fn len16(s: &str) -> usize {
    s.chars().count()
}

fn body(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// Khoá không khai báo trong DTO (chế độ strict).
fn unknown(b: &Map<String, Value>, allowed: &[&str], out: &mut Vec<String>) {
    for k in b.keys() {
        if !allowed.contains(&k.as_str()) {
            out.push(format!("property {k} should not exist"));
        }
    }
}

fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

// ---- Tuỳ chọn ----------------------------------------------------------------------------------------------------

/// Thân `POST /settings/options` đã kiểm.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateOption {
    pub group_key: String,
    pub value: String,
    pub label: String,
    pub sort_order: Option<i32>,
    pub is_active: Option<bool>,
    /// `None` hoặc `Null` đều lưu JSON `null`.
    pub metadata: Option<Value>,
}

pub fn validate_create_option(v: &Value) -> Result<CreateOption, AppError> {
    let out = validate_value("CreateOptionDto", v, Mode::Strict)?;
    let g = |k: &str| out.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    Ok(CreateOption {
        group_key: g("group_key"),
        value: g("value"),
        label: g("label"),
        sort_order: out
            .get("sort_order")
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok()),
        is_active: out.get("is_active").and_then(Value::as_bool),
        metadata: out.get("metadata").cloned(),
    })
}

/// Query `GET /settings/options` đã kiểm.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryOptions {
    pub group: Option<String>,
    pub active: Option<bool>,
}

pub fn validate_query_options(v: &Value) -> Result<QueryOptions, AppError> {
    let out = validate_value("QueryOptionsDto", v, Mode::Strict)?;
    Ok(QueryOptions {
        group: out.get("group").and_then(Value::as_str).map(str::to_owned),
        active: out.get("active").and_then(Value::as_bool),
    })
}

/// Thân `PATCH /settings/options/:id`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateOption {
    pub label: Option<String>,
    pub sort_order: Option<i32>,
    pub is_active: Option<bool>,
    /// `Some(Null)` = đặt lại JSON `null`.
    pub metadata: Option<Value>,
}

pub fn validate_update_option(v: &Value) -> Result<UpdateOption, HttpError> {
    let b = body(v);
    let mut e = Vec::new();
    unknown(&b, &["label", "sort_order", "is_active", "metadata"], &mut e);
    let mut out = UpdateOption::default();
    // `@ValidateIf(v !== undefined)`: khoá vắng thì bỏ qua; có (kể cả null) thì kiểm. Decorator dưới cùng chạy trước.
    if let Some(l) = b.get("label") {
        match l.as_str() {
            Some(s) if len16(s) <= 100 => out.label = Some(s.to_owned()),
            Some(_) => e.push("Nhãn tối đa 100 ký tự".to_owned()),
            None => {
                e.push("Nhãn tối đa 100 ký tự".to_owned());
                e.push("label must be a string".to_owned());
            }
        }
    }
    if let Some(n) = b.get("sort_order") {
        let num = n.as_f64();
        if !num.is_some_and(|x| x >= 0.0) {
            e.push("sort_order phải >= 0".to_owned());
        }
        match num.filter(|x| x.fract() == 0.0 && x.abs() < 9.0e15) {
            Some(x) if (0.0..=f64::from(i32::MAX)).contains(&x) => out.sort_order = Some(x as i32),
            Some(x) if x >= 0.0 => e.push("sort_order phải là số nguyên".to_owned()),
            Some(_) => {}
            None => e.push("sort_order phải là số nguyên".to_owned()),
        }
    }
    if let Some(a) = b.get("is_active") {
        match a.as_bool() {
            Some(x) => out.is_active = Some(x),
            None => e.push("is_active must be a boolean value".to_owned()),
        }
    }
    match b.get("metadata") {
        None => {}
        Some(Value::Null) => out.metadata = Some(Value::Null),
        Some(m @ Value::Object(_)) => out.metadata = Some(m.clone()),
        Some(_) => e.push("metadata phải là object JSON".to_owned()),
    }
    finish(e)?;
    Ok(out)
}

// ---- Âm báo, phòng ban -------------------------------------------------------------------------------------------

/// Thân `PATCH /settings/notification-sound`: trả `sound_id`.
pub fn validate_update_notification_sound(v: &Value) -> Result<String, HttpError> {
    let b = body(v);
    let mut e = Vec::new();
    unknown(&b, &["sound_id"], &mut e);
    match b.get("sound_id").and_then(Value::as_str) {
        Some(s) if SOUND_IDS.contains(&s) => {}
        Some(_) => e.push(format!(
            "sound_id must be one of the following values: {}",
            SOUND_IDS.join(", ")
        )),
        None => {
            e.push(format!(
                "sound_id must be one of the following values: {}",
                SOUND_IDS.join(", ")
            ));
            e.push("sound_id must be a string".to_owned());
        }
    }
    finish(e)?;
    Ok(b["sound_id"].as_str().unwrap_or_default().to_owned())
}

/// Thân `PATCH /settings/departments`: mảng giữ nguyên (việc làm sạch ở [`crate::general::update_departments`]).
pub fn validate_update_departments(v: &Value) -> Result<Vec<Value>, HttpError> {
    let b = body(v);
    let mut e = Vec::new();
    unknown(&b, &["departments"], &mut e);
    // Luật theo thứ tự đăng ký (decorator dưới cùng trước): MaxLength each, IsString each, ArrayMaxSize, ArrayNotEmpty, IsArray.
    let d = b.get("departments");
    let arr = d.and_then(Value::as_array);
    // `each: true` trên giá trị không phải mảng kiểm chính giá trị đó (vắng/null/số… đều không phải chuỗi).
    let items: Vec<Option<&str>> = match (arr, d) {
        (Some(a), _) => a.iter().map(Value::as_str).collect(),
        (None, Some(Value::String(s))) => vec![Some(s.as_str())],
        (None, _) => vec![None],
    };
    if items
        .iter()
        .any(|s| s.is_none_or(|s| len16(s) > MAX_DEPARTMENT_NAME_LENGTH))
    {
        e.push(format!(
            "each value in departments must be shorter than or equal to {MAX_DEPARTMENT_NAME_LENGTH} characters"
        ));
    }
    if items.iter().any(Option::is_none) {
        e.push("each value in departments must be a string".to_owned());
    }
    if !arr.is_some_and(|a| a.len() <= MAX_DEPARTMENTS) {
        e.push(format!(
            "departments must contain no more than {MAX_DEPARTMENTS} elements"
        ));
    }
    if !arr.is_some_and(|a| !a.is_empty()) {
        e.push("departments should not be empty".to_owned());
    }
    if arr.is_none() {
        e.push("departments must be an array".to_owned());
    }
    finish(e)?;
    Ok(arr.cloned().unwrap_or_default())
}

// ---- Tính năng ---------------------------------------------------------------------------------------------------

/// Khoá của `UpdateOrgFeaturesDto` theo thứ tự khai báo (gồm 3 khoá đã gỡ, nhận rồi bỏ qua).
pub const ORG_FEATURE_DTO_KEYS: [&str; 22] = [
    "dashboard",
    "contacts",
    "reports",
    "newsfeed",
    "kanban",
    "attendance",
    "payroll",
    "products",
    "pos",
    "management",
    "integrations",
    "ai_briefing",
    "zalo_oa",
    "lead_scoring",
    "stale_reminders",
    "facebook_page",
    "social_posting",
    "online_store",
    "inbox",
    "google_sheets",
    "commerce_connectors",
    "payments",
];

/// Cờ đã gửi lên (khoá vắng giữ nguyên).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrgFeaturesInput(Vec<(&'static str, bool)>);

impl OrgFeaturesInput {
    pub fn get(&self, key: &str) -> Option<bool> {
        self.0.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
    }
}

pub fn validate_org_features(v: &Value) -> Result<OrgFeaturesInput, HttpError> {
    let b = body(v);
    let mut e = Vec::new();
    unknown(&b, &ORG_FEATURE_DTO_KEYS, &mut e);
    let mut out = Vec::new();
    for k in ORG_FEATURE_DTO_KEYS {
        match b.get(k) {
            None | Some(Value::Null) => {}
            Some(Value::Bool(x)) => out.push((k, *x)),
            Some(_) => e.push(format!("{k} must be a boolean value")),
        }
    }
    finish(e)?;
    Ok(OrgFeaturesInput(out))
}

/// Thân `PUT /settings/plan` (kiểu inline, không qua DTO): `plan` phải là khoá gói.
pub fn validate_plan_body(v: &Value) -> Result<trinity_rbac::plan::PlanKey, HttpError> {
    crate::features::parse_plan(v.get("plan"))
}
