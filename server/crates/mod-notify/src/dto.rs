//! Kiểm tay thân request của `/templates` và `/events` đúng câu của class-validator (các DTO này chưa có trong
//! `contracts/dto/schema.json`, nên không đi qua `ValidJson`; cùng cách `mod-settings/src/validate.rs` và `parse_transfer`
//! của mod-contacts). Thứ tự câu: khoá lạ (chỉ chế độ strict) trước, rồi từng thuộc tính theo thứ tự khai; với mỗi thuộc tính
//! decorator khai SAU chạy TRƯỚC (`@IsNotEmpty() @IsString()` ⇒ câu `IsString` đứng trước câu `IsNotEmpty`).
//!
//! - `CreateTemplateDto`, `UpdateTemplateDto`: lenient (tiền tố `/api/v1/templates`): khoá lạ bị bỏ.
//! - `PayslipApprovedDto`, `WsEmitDto`: strict (`/api/v1/events`): khoá lạ ⇒ `property x should not exist`; lỗi lồng có tiền tố
//!   đường dẫn (`payload.x …`, `items.0.x …`) như `ValidationPipe`.
//!
//! Cần golden: chưa có bản golden do `ValidationPipe` thật sinh cho bốn DTO này (đối chiếu theo mã nguồn class-validator).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde_json::{Map, Value};
use trinity_kernel::error::{AppError, HttpError};

use crate::events::{PayslipApprovedDto, WsEmitDto};
use crate::templates::{CreateTemplate, UpdateTemplate};

const CHANNELS: &str = "push, in_app, webhook";

fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `@IsNotEmpty()`: khác `''`, `null`, `undefined`.
fn not_empty(v: Option<&Value>) -> bool {
    !nullish(v) && !matches!(v, Some(Value::String(s)) if s.is_empty())
}

/// `Number.isInteger` trên giá trị JSON.
fn is_int(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64).is_some_and(|n| n.fract() == 0.0)
}

fn is_channel(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if matches!(s.as_str(), "push" | "in_app" | "webhook"))
}

/// `@IsNotEmpty() @IsString()`.
fn required_string(prop: &str, v: Option<&Value>, out: &mut Vec<String>) {
    if !matches!(v, Some(Value::String(_))) {
        out.push(format!("{prop} must be a string"));
    }
    if !not_empty(v) {
        out.push(format!("{prop} should not be empty"));
    }
}

/// `@IsNotEmpty() @IsInt()`.
fn required_int(prop: &str, v: Option<&Value>, out: &mut Vec<String>) {
    if !is_int(v) {
        out.push(format!("{prop} must be an integer number"));
    }
    if !not_empty(v) {
        out.push(format!("{prop} should not be empty"));
    }
}

/// `@IsOptional() @IsString()`.
fn optional_string(prop: &str, v: Option<&Value>, out: &mut Vec<String>) {
    if !nullish(v) && !matches!(v, Some(Value::String(_))) {
        out.push(format!("{prop} must be a string"));
    }
}

/// `@IsOptional() @IsObject()` (mảng không phải đối tượng).
fn optional_object(prop: &str, v: Option<&Value>, out: &mut Vec<String>) {
    if !nullish(v) && !matches!(v, Some(Value::Object(_))) {
        out.push(format!("{prop} must be an object"));
    }
}

/// `@IsOptional() @IsBoolean()`.
fn optional_bool(prop: &str, v: Option<&Value>, out: &mut Vec<String>) {
    if !nullish(v) && !matches!(v, Some(Value::Bool(_))) {
        out.push(format!("{prop} must be a boolean value"));
    }
}

fn channel_error(out: &mut Vec<String>) {
    out.push(format!("channel must be one of the following values: {CHANNELS}"));
}

/// Thân là đối tượng; thân khác (hoặc rỗng) coi như `{}` (DTO vẫn chạy nên trường bắt buộc báo lỗi bằng câu của class-validator).
fn object_of(body: &Value) -> Map<String, Value> {
    body.as_object().cloned().unwrap_or_default()
}

/// Khoá lạ (strict), theo thứ tự chữ cái (serde_json), xếp trước mọi luật.
fn unknown(o: &Map<String, Value>, known: &[&str], out: &mut Vec<String>) {
    for k in o.keys().filter(|k| !known.contains(&k.as_str())) {
        out.push(format!("property {k} should not exist"));
    }
}

fn finish(errs: Vec<String>) -> Result<(), AppError> {
    if errs.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errs).into())
    }
}

/// Giá trị đã qua kiểm luật nhưng không nhét vừa kiểu Rust (số nguyên ngoài i32…) ⇒ 400 trơn, như `validate_into`.
fn build<T: serde::de::DeserializeOwned>(o: Map<String, Value>) -> Result<T, AppError> {
    serde_json::from_value(Value::Object(o)).map_err(|_| HttpError::nest(400, None).into())
}

/// `CreateTemplateDto` (lenient).
pub fn parse_create_template(body: &Value) -> Result<CreateTemplate, AppError> {
    let o = object_of(body);
    let mut errs = Vec::new();
    required_string("name", o.get("name"), &mut errs);
    required_string("event_type", o.get("event_type"), &mut errs);
    if !is_channel(o.get("channel")) {
        channel_error(&mut errs);
    }
    if !not_empty(o.get("channel")) {
        errs.push("channel should not be empty".to_owned());
    }
    optional_string("subject", o.get("subject"), &mut errs);
    required_string("body", o.get("body"), &mut errs);
    optional_object("recipients_rule", o.get("recipients_rule"), &mut errs);
    optional_bool("is_active", o.get("is_active"), &mut errs);
    finish(errs)?;
    build(o)
}

/// `UpdateTemplateDto` (lenient): cột NOT NULL dùng `@ValidateIf(v !== undefined)` nên `null` bị kiểm (⇒ 400); `subject` và
/// `recipients_rule` dùng `@IsOptional()` nên `null` qua (xoá giá trị).
pub fn parse_update_template(body: &Value) -> Result<UpdateTemplate, AppError> {
    let o = object_of(body);
    let mut errs = Vec::new();
    let given = |k: &str| o.get(k).is_some();
    if given("name") && !matches!(o.get("name"), Some(Value::String(_))) {
        errs.push("name must be a string".to_owned());
    }
    if given("event_type") && !matches!(o.get("event_type"), Some(Value::String(_))) {
        errs.push("event_type must be a string".to_owned());
    }
    if given("channel") && !is_channel(o.get("channel")) {
        channel_error(&mut errs);
    }
    optional_string("subject", o.get("subject"), &mut errs);
    if given("body") && !matches!(o.get("body"), Some(Value::String(_))) {
        errs.push("body must be a string".to_owned());
    }
    optional_object("recipients_rule", o.get("recipients_rule"), &mut errs);
    if given("is_active") && !matches!(o.get("is_active"), Some(Value::Bool(_))) {
        errs.push("is_active must be a boolean value".to_owned());
    }
    finish(errs)?;
    build(o)
}

/// `nested property <prop> must be either object or array`.
fn nested_error(prop: &str) -> String {
    format!("nested property {prop} must be either object or array")
}

/// Các câu của `PayslipApprovedPayloadDto` (chưa có tiền tố `payload.`).
fn payslip_payload_errors(p: &Map<String, Value>, out: &mut Vec<String>) {
    const KNOWN: [&str; 9] = [
        "payslipId",
        "employeeId",
        "userId",
        "month",
        "baseSalary",
        "kpiBonus",
        "totalAmount",
        "approvedBy",
        "approvedAt",
    ];
    unknown(p, &KNOWN, out);
    for k in ["payslipId", "employeeId", "userId"] {
        required_int(k, p.get(k), out);
    }
    required_string("month", p.get("month"), out);
    for k in ["baseSalary", "kpiBonus", "totalAmount", "approvedBy"] {
        required_int(k, p.get(k), out);
    }
    required_string("approvedAt", p.get("approvedAt"), out);
}

/// `PayslipApprovedDto` (strict). `payload` vắng mặt không bị bắt ở bước kiểm (`ValidateNested` bỏ qua `undefined`) mà bản TS
/// sập ở tầng nghiệp vụ ⇒ 500; bản Rust trả 500 tương ứng.
pub fn parse_payslip_approved(body: &Value) -> Result<PayslipApprovedDto, AppError> {
    let o = object_of(body);
    let mut errs = Vec::new();
    unknown(&o, &["event", "timestamp", "payload"], &mut errs);
    required_string("event", o.get("event"), &mut errs);
    required_string("timestamp", o.get("timestamp"), &mut errs);
    match o.get("payload") {
        None => {}
        Some(Value::Object(p)) => {
            let mut inner = Vec::new();
            payslip_payload_errors(p, &mut inner);
            errs.extend(inner.into_iter().map(|m| format!("payload.{m}")));
        }
        Some(_) => errs.push(nested_error("payload")),
    }
    finish(errs)?;
    if !o.contains_key("payload") {
        return Err(AppError::internal("payslip-approved thiếu payload"));
    }
    build(o)
}

/// `action_url`: `@Matches(/^\/(?![/\\])/)` (đường dẫn tương đối, không `//` hay `/\`).
fn relative_path(s: &str) -> bool {
    s.strip_prefix('/').is_some_and(|rest| !rest.starts_with(['/', '\\']))
}

/// Các câu của `WsEmitItemDto` (chưa có tiền tố `items.<i>.`).
fn ws_item_errors(item: &Map<String, Value>, out: &mut Vec<String>) {
    const KNOWN: [&str; 6] = ["recipient_id", "title", "body", "event_type", "action_url", "log_id"];
    unknown(item, &KNOWN, out);
    required_int("recipient_id", item.get("recipient_id"), out);
    for k in ["title", "body", "event_type"] {
        required_string(k, item.get(k), out);
    }
    let url = item.get("action_url");
    if !nullish(url) {
        // `@IsOptional() @IsString() @Matches(..)` ⇒ `Matches` chạy trước `IsString`.
        if !matches!(url, Some(Value::String(s)) if relative_path(s)) {
            out.push("action_url phai la duong dan tuong doi bat dau bang /".to_owned());
        }
        if !matches!(url, Some(Value::String(_))) {
            out.push("action_url must be a string".to_owned());
        }
    }
    let log_id = item.get("log_id");
    if !nullish(log_id) && !is_int(log_id) {
        out.push("log_id must be an integer number".to_owned());
    }
}

/// `WsEmitDto` (strict).
pub fn parse_ws_emit(body: &Value) -> Result<WsEmitDto, AppError> {
    let o = object_of(body);
    let mut errs = Vec::new();
    unknown(&o, &["items"], &mut errs);
    match o.get("items") {
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                match item {
                    Value::Object(m) => {
                        let mut inner = Vec::new();
                        ws_item_errors(m, &mut inner);
                        errs.extend(inner.into_iter().map(|e| format!("items.{i}.{e}")));
                    }
                    Value::Null => {}
                    _ => errs.push(nested_error("items")),
                }
            }
        }
        None => errs.push("items must be an array".to_owned()),
        Some(_) => {
            errs.push("items must be an array".to_owned());
            errs.push(nested_error("items"));
        }
    }
    finish(errs)?;
    build(o)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trinity_kernel::error::Message;

    use super::*;

    fn messages<T>(r: Result<T, AppError>) -> Vec<String> {
        match r {
            Err(AppError::Http(h)) => match h.body().message {
                Message::Many(m) => m,
                Message::One(m) => vec![m],
            },
            Err(other) => vec![other.to_string()],
            Ok(_) => Vec::new(),
        }
    }

    #[test]
    fn tao_mau_dung_cau_loi_va_bo_khoa_la() {
        let ok =
            parse_create_template(&json!({ "name": "a", "event_type": "e", "channel": "push", "body": "b", "la": 1 }));
        assert!(ok.is_ok());
        assert_eq!(
            messages(parse_create_template(&json!({}))),
            [
                "name must be a string",
                "name should not be empty",
                "event_type must be a string",
                "event_type should not be empty",
                "channel must be one of the following values: push, in_app, webhook",
                "channel should not be empty",
                "body must be a string",
                "body should not be empty",
            ]
        );
        assert_eq!(
            messages(parse_create_template(&json!({
                "name": "", "event_type": 3, "channel": "sms", "subject": 1, "body": "b",
                "recipients_rule": [], "is_active": "x"
            }))),
            [
                "name should not be empty",
                "event_type must be a string",
                "channel must be one of the following values: push, in_app, webhook",
                "subject must be a string",
                "recipients_rule must be an object",
                "is_active must be a boolean value",
            ]
        );
    }

    #[test]
    fn sua_mau_null_cot_not_null_la_400_con_subject_null_qua() {
        let ok = parse_update_template(&json!({ "subject": null, "recipients_rule": null, "la": 1 })).unwrap();
        assert_eq!(ok.subject, Some(None));
        assert_eq!(
            messages(parse_update_template(&json!({
                "name": null, "event_type": null, "channel": null, "body": null, "is_active": null
            }))),
            [
                "name must be a string",
                "event_type must be a string",
                "channel must be one of the following values: push, in_app, webhook",
                "body must be a string",
                "is_active must be a boolean value",
            ]
        );
        assert!(parse_update_template(&json!({})).is_ok());
    }

    fn payslip() -> Value {
        json!({
            "event": "payslip.approved", "timestamp": "2026-03-29T10:30:00.000Z",
            "payload": {
                "payslipId": 1, "employeeId": 2, "userId": 3, "month": "2026-03", "baseSalary": 10,
                "kpiBonus": 1, "totalAmount": 11, "approvedBy": 4, "approvedAt": "2026-03-29T10:30:00.000Z"
            }
        })
    }

    #[test]
    fn phieu_luong_duyet_tien_to_payload_va_whitelist() {
        let dto = parse_payslip_approved(&payslip()).unwrap();
        assert_eq!((dto.payload.payslip_id, dto.payload.user_id), (1, 3));
        let mut v = payslip();
        v["la"] = json!(1);
        v["payload"]["lb"] = json!(2);
        v["payload"]["userId"] = json!("x");
        v["event"] = json!("");
        assert_eq!(
            messages(parse_payslip_approved(&v)),
            [
                "property la should not exist",
                "event should not be empty",
                "payload.property lb should not exist",
                "payload.userId must be an integer number",
            ]
        );
        v = payslip();
        v["payload"] = json!("x");
        assert_eq!(
            messages(parse_payslip_approved(&v)),
            ["nested property payload must be either object or array"]
        );
        let mut v = payslip();
        v.as_object_mut().unwrap().remove("payload");
        assert!(matches!(parse_payslip_approved(&v), Err(AppError::Internal(_))));
    }

    #[test]
    fn ws_emit_tien_to_items_va_action_url() {
        let ok = parse_ws_emit(&json!({ "items": [{
            "recipient_id": 1, "title": "t", "body": "b", "event_type": "e", "action_url": "/x", "log_id": null
        }] }));
        assert!(ok.is_ok());
        assert_eq!(messages(parse_ws_emit(&json!({}))), ["items must be an array"]);
        assert_eq!(
            messages(parse_ws_emit(&json!({ "items": "x" }))),
            [
                "items must be an array",
                "nested property items must be either object or array"
            ]
        );
        assert_eq!(
            messages(parse_ws_emit(&json!({ "la": 1, "items": [
                { "recipient_id": 1.5, "title": "t", "body": "b", "event_type": "e", "action_url": "//x", "log_id": "z", "q": 1 },
                7
            ] }))),
            [
                "property la should not exist",
                "items.0.property q should not exist",
                "items.0.recipient_id must be an integer number",
                "items.0.action_url phai la duong dan tuong doi bat dau bang /",
                "items.0.log_id must be an integer number",
                "nested property items must be either object or array",
            ]
        );
        assert_eq!(
            messages(parse_ws_emit(
                &json!({ "items": [{ "recipient_id": 1, "title": "t", "body": "b", "event_type": "e", "action_url": 5 }] })
            )),
            [
                "items.0.action_url phai la duong dan tuong doi bat dau bang /",
                "items.0.action_url must be a string",
            ]
        );
    }
}
