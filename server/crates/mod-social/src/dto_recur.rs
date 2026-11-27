//! DTO của bài lặp và nhập CSV (M55b), kiểm đúng câu của class-validator qua `ValidationPipe` strict:
//! `SocialRecurrenceDto` (+ `SocialRecurrenceRuleDto`, `SocialRecurrenceTemplateDto`, `SocialTargetDto`, `SocialUtmDto`),
//! `SocialImportPlanDto`, `SocialImportDto`.
//!
//! Quy ước của class-validator đã mô phỏng:
//! - khoá lạ ⇒ `property <khoá> should not exist`, xếp TRƯỚC các lỗi luật; ở đối tượng lồng thì thêm tiền tố đường dẫn
//!   (`rule.property x should not exist`);
//! - decorator áp từ dưới lên nên các câu lỗi của MỘT trường xuất hiện theo thứ tự NGƯỢC khai báo
//!   (`@IsString() @MaxLength(5)` ⇒ "…shorter than or equal to 5 characters", "…must be a string");
//! - `@IsOptional()` bỏ qua `null` và vắng mặt; `@Length` có câu riêng theo giá trị (quá ngắn / quá dài / dạng khác);
//! - lỗi lồng nhau mang tiền tố tên trường cha (`template.targets.0.account_id must not be less than 1`).
//!
//! Chưa đối chiếu bằng golden với `ValidationPipe` thật (chưa có DTO này trong `contracts/dto/schema.json`): khi X-schema
//! sinh lại thì chuyển sang `trinity_http::validate`.

use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;

use crate::import::ImportMode;

/// Giới hạn `@MaxLength` của `SocialImportPlanDto.csv` (1 MB chữ cộng dư cho BOM/CRLF).
pub const CSV_FIELD_MAX: usize = 1_100_000;

const MODE_MSG: &str = "mode phải là drafts hoặc schedule";
const FREQ_MSG: &str = "freq phải là daily, weekly hoặc monthly";

/// Thân `POST /social/recurrences` và `PATCH /social/recurrences/:id` đã kiểm. `None` = vắng mặt hoặc `null`; riêng
/// `ends_on` và `max_count` `Some(None)` = `null` (xoá giá trị).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RecurrenceBody {
    pub title: Option<String>,
    /// Chỉ các khoá có gửi (ghép nông vào khuôn cũ).
    pub template: Option<Map<String, Value>>,
    pub rule: Option<Map<String, Value>>,
    pub starts_on: Option<String>,
    pub ends_on: Option<Option<String>>,
    pub max_count: Option<Option<i32>>,
}

/// `SocialImportPlanDto`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPlanBody {
    pub csv: String,
    pub mode: ImportMode,
}

/// `SocialImportDto` (thêm `plan_hash`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportBody {
    pub csv: String,
    pub mode: ImportMode,
    pub plan_hash: String,
}

type Errs = Vec<String>;

fn len(s: &str) -> usize {
    s.chars().count()
}

/// `@IsOptional()`: có giá trị khác `null`.
fn present<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    o.get(k).filter(|v| !v.is_null())
}

fn unknown_keys(o: &Map<String, Value>, allowed: &[&str], errs: &mut Errs) {
    for k in o.keys().filter(|k| !allowed.contains(&k.as_str())) {
        errs.push(format!("property {k} should not exist"));
    }
}

fn prefixed(path: &str, errs: Errs, out: &mut Errs) {
    out.extend(errs.into_iter().map(|e| format!("{path}.{e}")));
}

/// `@IsString() @MaxLength(max)` (đã bỏ qua khi `null`/vắng nếu trường `@IsOptional`).
fn check_string(name: &str, v: &Value, max: usize, errs: &mut Errs) {
    match v.as_str() {
        Some(s) if len(s) <= max => {}
        Some(_) => errs.push(format!("{name} must be shorter than or equal to {max} characters")),
        None => {
            errs.push(format!("{name} must be shorter than or equal to {max} characters"));
            errs.push(format!("{name} must be a string"));
        }
    }
}

fn int_value(v: &Value) -> Option<f64> {
    v.as_number().and_then(serde_json::Number::as_f64)
}

/// Các câu lỗi của `@IsInt() [@Min(min)] [@Max(max)]` theo thứ tự class-validator (Max, Min, IsInt); `label` là
/// "name" hoặc "each value in name".
fn int_failures(label: &str, v: &Value, min: Option<i64>, max: Option<i64>) -> Errs {
    let num = int_value(v);
    let mut out = Vec::new();
    if let Some(m) = max
        && num.is_none_or(|n| n > m as f64)
    {
        out.push(format!("{label} must not be greater than {m}"));
    }
    if let Some(m) = min
        && num.is_none_or(|n| n < m as f64)
    {
        out.push(format!("{label} must not be less than {m}"));
    }
    if num.is_none_or(|n| n.fract() != 0.0) {
        out.push(format!("{label} must be an integer number"));
    }
    out
}

fn check_int(name: &str, v: &Value, min: Option<i64>, max: Option<i64>, errs: &mut Errs) {
    errs.extend(int_failures(name, v, min, max));
}

/// `@Length(min, max)`: câu lỗi phụ thuộc giá trị như class-validator.
fn length_failure(name: &str, v: &Value, min: usize, max: usize) -> Option<String> {
    let falsy = match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    };
    match v.as_str() {
        _ if falsy => Some(format!("{name} must be longer than or equal to {min} characters")),
        Some(s) if len(s) < min => Some(format!("{name} must be longer than or equal to {min} characters")),
        Some(s) if len(s) > max => Some(format!("{name} must be shorter than or equal to {max} characters")),
        Some(_) => None,
        None => Some(format!(
            "{name} must be longer than or equal to {min} and shorter than or equal to {max} characters"
        )),
    }
}

/// `@IsString() @Length(min, max)` bắt buộc (Length trước, IsString sau).
fn check_required_length(name: &str, v: Option<&Value>, min: usize, max: usize, errs: &mut Errs) {
    let v = v.unwrap_or(&Value::Null);
    if let Some(m) = length_failure(name, v, min, max) {
        errs.push(m);
    }
    if !v.is_string() {
        errs.push(format!("{name} must be a string"));
    }
}

/// Đối tượng lồng (`@ValidateNested() @Type`): không phải đối tượng ⇒ câu "nested property".
fn nested_object<'a>(name: &str, v: &'a Value, errs: &mut Errs) -> Option<&'a Map<String, Value>> {
    let o = v.as_object();
    if o.is_none() {
        errs.push(format!("nested property {name} must be either object or array"));
    }
    o
}

// ---- SocialTargetDto -----------------------------------------------------------------------------------------------

fn target_errors(o: &Map<String, Value>) -> Errs {
    let mut errs = Vec::new();
    unknown_keys(o, &["account_id", "caption", "options"], &mut errs);
    // `@IsInt() @Min(1)` bắt buộc: vắng ⇒ hỏng cả hai.
    check_int(
        "account_id",
        o.get("account_id").unwrap_or(&Value::Null),
        Some(1),
        None,
        &mut errs,
    );
    if let Some(v) = o.get("account_id")
        && int_value(v).is_some_and(|n| n.fract() == 0.0 && n > f64::from(i32::MAX))
    {
        errs.push(format!("account_id must not be greater than {}", i32::MAX));
    }
    if let Some(v) = present(o, "caption") {
        check_string("caption", v, 70_000, &mut errs);
    }
    if let Some(v) = present(o, "options")
        && !v.is_object()
    {
        errs.push("options must be an object".to_owned());
    }
    errs
}

fn targets_errors(v: &Value, errs: &mut Errs) {
    // `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each })`, báo ngược: Max, Min, IsArray, rồi lồng.
    let Some(items) = v.as_array() else {
        errs.push("targets must contain no more than 20 elements".to_owned());
        errs.push("targets must contain at least 1 elements".to_owned());
        errs.push("targets must be an array".to_owned());
        errs.push("nested property targets must be either object or array".to_owned());
        return;
    };
    if items.len() > 20 {
        errs.push("targets must contain no more than 20 elements".to_owned());
    }
    if items.is_empty() {
        errs.push("targets must contain at least 1 elements".to_owned());
    }
    for (i, it) in items.iter().enumerate() {
        match it.as_object() {
            Some(o) => prefixed(&format!("targets.{i}"), target_errors(o), errs),
            None => errs.push(format!("nested property targets.{i} must be either object or array")),
        }
    }
}

// ---- SocialUtmDto --------------------------------------------------------------------------------------------------

fn utm_errors(o: &Map<String, Value>) -> Errs {
    let mut errs = Vec::new();
    unknown_keys(o, &["campaign", "content"], &mut errs);
    check_required_length("campaign", o.get("campaign"), 1, 100, &mut errs);
    if let Some(v) = present(o, "content") {
        check_string("content", v, 100, &mut errs);
    }
    errs
}

// ---- Khuôn bài -----------------------------------------------------------------------------------------------------

fn template_errors(o: &Map<String, Value>) -> Errs {
    let mut errs = Vec::new();
    unknown_keys(o, &["content", "media_keys", "targets", "utm"], &mut errs);
    if let Some(v) = present(o, "content") {
        check_string("content", v, 70_000, &mut errs);
    }
    if let Some(v) = present(o, "media_keys") {
        // `@IsArray() @ArrayMaxSize(10) @IsString({ each }) @MaxLength(200, { each })`; `each` bỏ qua giá trị không phải mảng.
        match v.as_array() {
            None => {
                errs.push("media_keys must contain no more than 10 elements".to_owned());
                errs.push("media_keys must be an array".to_owned());
            }
            Some(items) => {
                if items.iter().any(|k| k.as_str().is_none_or(|s| len(s) > 200)) {
                    errs.push("each value in media_keys must be shorter than or equal to 200 characters".to_owned());
                }
                if items.iter().any(|k| !k.is_string()) {
                    errs.push("each value in media_keys must be a string".to_owned());
                }
                if items.len() > 10 {
                    errs.push("media_keys must contain no more than 10 elements".to_owned());
                }
            }
        }
    }
    if let Some(v) = present(o, "targets") {
        targets_errors(v, &mut errs);
    }
    if let Some(v) = present(o, "utm") {
        let mut nested = Vec::new();
        if let Some(u) = nested_object("utm", v, &mut nested) {
            prefixed("utm", utm_errors(u), &mut nested);
        }
        errs.extend(nested);
    }
    errs
}

// ---- Luật ----------------------------------------------------------------------------------------------------------

fn rule_errors(o: &Map<String, Value>) -> Errs {
    let mut errs = Vec::new();
    unknown_keys(o, &["freq", "interval", "weekdays", "month_day", "time"], &mut errs);
    if let Some(v) = present(o, "freq")
        && !matches!(v.as_str(), Some("daily" | "weekly" | "monthly"))
    {
        errs.push(FREQ_MSG.to_owned());
    }
    if let Some(v) = present(o, "interval") {
        check_int("interval", v, Some(1), Some(12), &mut errs);
    }
    if let Some(v) = present(o, "weekdays") {
        // `@IsArray() @ArrayMaxSize(7) @IsInt({ each }) @Min(0, { each }) @Max(6, { each })`, báo ngược.
        match v.as_array() {
            None => {
                errs.push("weekdays must contain no more than 7 elements".to_owned());
                errs.push("weekdays must be an array".to_owned());
            }
            Some(items) => {
                let label = "each value in weekdays";
                let mut per = [false; 3];
                for it in items {
                    for m in int_failures(label, it, Some(0), Some(6)) {
                        if m.contains("greater") {
                            per[0] = true;
                        } else if m.contains("less") {
                            per[1] = true;
                        } else {
                            per[2] = true;
                        }
                    }
                }
                if per[0] {
                    errs.push(format!("{label} must not be greater than 6"));
                }
                if per[1] {
                    errs.push(format!("{label} must not be less than 0"));
                }
                if per[2] {
                    errs.push(format!("{label} must be an integer number"));
                }
                if items.len() > 7 {
                    errs.push("weekdays must contain no more than 7 elements".to_owned());
                }
            }
        }
    }
    if let Some(v) = present(o, "month_day") {
        check_int("month_day", v, Some(1), Some(31), &mut errs);
    }
    if let Some(v) = present(o, "time") {
        check_string("time", v, 5, &mut errs);
    }
    errs
}

// ---- Bài lặp -------------------------------------------------------------------------------------------------------

impl RecurrenceBody {
    /// Kiểm thân `SocialRecurrenceDto`. Thân không phải đối tượng coi như `{}` (như `validate_into` của K15).
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let empty = Map::new();
        let o = v.as_object().unwrap_or(&empty);
        let mut errs: Errs = Vec::new();
        unknown_keys(
            o,
            &["title", "template", "rule", "starts_on", "ends_on", "max_count"],
            &mut errs,
        );
        if let Some(t) = present(o, "title") {
            check_string("title", t, 200, &mut errs);
        }
        for (key, errors_of) in [
            ("template", template_errors as fn(&Map<String, Value>) -> Errs),
            ("rule", rule_errors as fn(&Map<String, Value>) -> Errs),
        ] {
            if let Some(v) = present(o, key) {
                let mut nested = Vec::new();
                if let Some(obj) = nested_object(key, v, &mut nested) {
                    prefixed(key, errors_of(obj), &mut nested);
                }
                errs.extend(nested);
            }
        }
        for key in ["starts_on", "ends_on"] {
            if let Some(v) = present(o, key) {
                check_string(key, v, 10, &mut errs);
            }
        }
        if let Some(v) = present(o, "max_count") {
            check_int("max_count", v, Some(1), Some(1000), &mut errs);
        }
        if !errs.is_empty() {
            return Err(HttpError::validation(errs));
        }
        let text = |k: &str| present(o, k).and_then(Value::as_str).map(str::to_owned);
        let map = |k: &str| present(o, k).and_then(Value::as_object).cloned();
        Ok(Self {
            title: text("title"),
            template: map("template"),
            rule: map("rule"),
            starts_on: text("starts_on"),
            ends_on: o.get("ends_on").map(|v| v.as_str().map(str::to_owned)),
            max_count: o
                .get("max_count")
                .map(|v| v.as_f64().and_then(|n| i32::try_from(n as i64).ok())),
        })
    }
}

// ---- Nhập CSV ------------------------------------------------------------------------------------------------------

fn csv_and_mode(o: &Map<String, Value>, errs: &mut Errs) {
    // `@IsString() @MaxLength(1_100_000)` bắt buộc.
    match o.get("csv").and_then(Value::as_str) {
        Some(s) if len(s) <= CSV_FIELD_MAX => {}
        Some(_) => errs.push(format!(
            "csv must be shorter than or equal to {CSV_FIELD_MAX} characters"
        )),
        None => {
            errs.push(format!(
                "csv must be shorter than or equal to {CSV_FIELD_MAX} characters"
            ));
            errs.push("csv must be a string".to_owned());
        }
    }
    if !matches!(o.get("mode").and_then(Value::as_str), Some("drafts" | "schedule")) {
        errs.push(MODE_MSG.to_owned());
    }
}

fn mode_of(o: &Map<String, Value>) -> ImportMode {
    if o.get("mode").and_then(Value::as_str) == Some("schedule") {
        ImportMode::Schedule
    } else {
        ImportMode::Drafts
    }
}

fn text_of(o: &Map<String, Value>, k: &str) -> String {
    o.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

impl ImportPlanBody {
    /// Kiểm thân `POST /social/posts/import/plan`.
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let empty = Map::new();
        let o = v.as_object().unwrap_or(&empty);
        let mut errs = Vec::new();
        unknown_keys(o, &["csv", "mode"], &mut errs);
        csv_and_mode(o, &mut errs);
        if !errs.is_empty() {
            return Err(HttpError::validation(errs));
        }
        Ok(Self {
            csv: text_of(o, "csv"),
            mode: mode_of(o),
        })
    }
}

impl ImportBody {
    /// Kiểm thân `POST /social/posts/import`.
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let empty = Map::new();
        let o = v.as_object().unwrap_or(&empty);
        let mut errs = Vec::new();
        unknown_keys(o, &["csv", "mode", "plan_hash"], &mut errs);
        csv_and_mode(o, &mut errs);
        check_required_length("plan_hash", o.get("plan_hash"), 64, 64, &mut errs);
        if !errs.is_empty() {
            return Err(HttpError::validation(errs));
        }
        Ok(Self {
            csv: text_of(o, "csv"),
            mode: mode_of(o),
            plan_hash: text_of(o, "plan_hash"),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trinity_kernel::error::AppError;

    use super::*;

    fn messages(e: HttpError) -> Vec<String> {
        let (s, b) = AppError::from(e).response(true);
        assert_eq!(s, 400);
        serde_json::from_value(serde_json::to_value(&b.message).unwrap()).unwrap()
    }

    fn rec(v: Value) -> Vec<String> {
        messages(RecurrenceBody::from_json(&v).unwrap_err())
    }

    #[test]
    fn than_hop_le() {
        let b = RecurrenceBody::from_json(&json!({
            "title": "Chào ngày mới",
            "template": {"content": "x", "targets": [{"account_id": 1, "caption": null}], "utm": null},
            "rule": {"freq": "weekly", "interval": 2, "weekdays": [1, 4], "time": "09:00"},
            "starts_on": "2026-10-20",
            "ends_on": null,
            "max_count": 5
        }))
        .unwrap();
        assert_eq!(b.title.as_deref(), Some("Chào ngày mới"));
        assert_eq!(b.ends_on, Some(None));
        assert_eq!(b.max_count, Some(Some(5)));
        assert_eq!(b.rule.unwrap().len(), 4);
        let empty = RecurrenceBody::from_json(&json!({})).unwrap();
        assert_eq!(empty, RecurrenceBody::default());
        assert_eq!(
            RecurrenceBody::from_json(&json!(null)).unwrap(),
            RecurrenceBody::default()
        );
        // null = vắng mặt (IsOptional), trừ ends_on/max_count mang nghĩa "xoá".
        let n = RecurrenceBody::from_json(&json!({"title": null, "template": null, "rule": null, "starts_on": null}))
            .unwrap();
        assert_eq!(n, RecurrenceBody::default());
    }

    #[test]
    fn khoa_la_xep_truoc() {
        assert_eq!(
            rec(json!({"foo": 1, "max_count": 0})),
            vec!["property foo should not exist", "max_count must not be less than 1"]
        );
        assert_eq!(
            rec(json!({"rule": {"zzz": 1}})),
            vec!["rule.property zzz should not exist"]
        );
    }

    #[test]
    fn so_nguyen_thu_tu_nguoc() {
        assert_eq!(
            rec(json!({"rule": {"interval": "x"}})),
            vec![
                "rule.interval must not be greater than 12",
                "rule.interval must not be less than 1",
                "rule.interval must be an integer number"
            ]
        );
        assert_eq!(
            rec(json!({"rule": {"interval": 13}})),
            vec!["rule.interval must not be greater than 12"]
        );
        assert_eq!(
            rec(json!({"rule": {"interval": 0}})),
            vec!["rule.interval must not be less than 1"]
        );
        assert_eq!(
            rec(json!({"rule": {"interval": 1.5}})),
            vec!["rule.interval must be an integer number"]
        );
        assert_eq!(
            rec(json!({"max_count": 1001})),
            vec!["max_count must not be greater than 1000"]
        );
    }

    #[test]
    fn luat_freq_weekdays_time() {
        assert_eq!(
            rec(json!({"rule": {"freq": "yearly"}})),
            vec!["freq phải là daily, weekly hoặc monthly"]
        );
        assert_eq!(
            rec(json!({"rule": {"weekdays": [7, -1, 1.5]}})),
            vec![
                "rule.each value in weekdays must not be greater than 6",
                "rule.each value in weekdays must not be less than 0",
                "rule.each value in weekdays must be an integer number"
            ]
        );
        assert_eq!(
            rec(json!({"rule": {"weekdays": [0, 1, 2, 3, 4, 5, 6, 0]}})),
            vec!["rule.weekdays must contain no more than 7 elements"]
        );
        assert_eq!(
            rec(json!({"rule": {"weekdays": "1"}})),
            vec![
                "rule.weekdays must contain no more than 7 elements",
                "rule.weekdays must be an array"
            ]
        );
        assert_eq!(
            rec(json!({"rule": {"time": "123456"}})),
            vec!["rule.time must be shorter than or equal to 5 characters"]
        );
        assert_eq!(
            rec(json!({"rule": {"time": 9}})),
            vec![
                "rule.time must be shorter than or equal to 5 characters",
                "rule.time must be a string"
            ]
        );
    }

    #[test]
    fn khuon_bai() {
        assert_eq!(
            rec(json!({"template": {"targets": []}})),
            vec!["template.targets must contain at least 1 elements"]
        );
        assert_eq!(
            rec(json!({"template": {"targets": [{"account_id": 0}, {"caption": 5}]}})),
            vec![
                "template.targets.0.account_id must not be less than 1",
                "template.targets.1.account_id must not be less than 1",
                "template.targets.1.account_id must be an integer number",
                "template.targets.1.caption must be shorter than or equal to 70000 characters",
                "template.targets.1.caption must be a string"
            ]
        );
        assert_eq!(
            rec(json!({"template": {"targets": [{"account_id": 3_000_000_000_i64}]}})),
            vec!["template.targets.0.account_id must not be greater than 2147483647"]
        );
        assert_eq!(
            rec(json!({"template": {"targets": [{"account_id": 1, "options": []}]}})),
            vec!["template.targets.0.options must be an object"]
        );
        assert_eq!(
            rec(json!({"template": {"media_keys": [1, "a"]}})),
            vec![
                "template.each value in media_keys must be shorter than or equal to 200 characters",
                "template.each value in media_keys must be a string"
            ]
        );
        assert_eq!(
            rec(json!({"template": "x"})),
            vec!["nested property template must be either object or array"]
        );
        assert_eq!(
            rec(json!({"rule": []})),
            vec!["nested property rule must be either object or array"]
        );
    }

    #[test]
    fn utm() {
        assert_eq!(
            rec(json!({"template": {"utm": {}}})),
            vec![
                "template.utm.campaign must be longer than or equal to 1 characters",
                "template.utm.campaign must be a string"
            ]
        );
        assert_eq!(
            rec(json!({"template": {"utm": {"campaign": "x".repeat(101)}}})),
            vec!["template.utm.campaign must be shorter than or equal to 100 characters"]
        );
        assert_eq!(
            rec(json!({"template": {"utm": {"campaign": 5}}})),
            vec![
                "template.utm.campaign must be longer than or equal to 1 and shorter than or equal to 100 characters",
                "template.utm.campaign must be a string"
            ]
        );
        assert!(
            RecurrenceBody::from_json(&json!({"template": {"utm": {"campaign": "thu-10", "content": "a"}}})).is_ok()
        );
    }

    #[test]
    fn tieu_de_va_ngay_qua_dai() {
        assert_eq!(
            rec(json!({"title": "x".repeat(201)})),
            vec!["title must be shorter than or equal to 200 characters"]
        );
        assert_eq!(
            rec(json!({"starts_on": "2026-10-20T00:00", "ends_on": 5})),
            vec![
                "starts_on must be shorter than or equal to 10 characters",
                "ends_on must be shorter than or equal to 10 characters",
                "ends_on must be a string"
            ]
        );
    }

    #[test]
    fn nhap_csv() {
        let p = ImportPlanBody::from_json(&json!({"csv": "a\nb", "mode": "schedule"})).unwrap();
        assert_eq!((p.csv.as_str(), p.mode), ("a\nb", ImportMode::Schedule));
        let msg = |v: Value| messages(ImportPlanBody::from_json(&v).unwrap_err());
        assert_eq!(
            msg(json!({"mode": "x"})),
            vec![
                "csv must be shorter than or equal to 1100000 characters",
                "csv must be a string",
                "mode phải là drafts hoặc schedule"
            ]
        );
        assert_eq!(
            msg(json!({"csv": "a", "mode": "drafts", "plan_hash": "x"})),
            vec!["property plan_hash should not exist"]
        );
        let hash = "a".repeat(64);
        let full = ImportBody::from_json(&json!({"csv": "a", "mode": "drafts", "plan_hash": hash})).unwrap();
        assert_eq!(full.plan_hash.len(), 64);
        let bad = |v: Value| messages(ImportBody::from_json(&v).unwrap_err());
        assert_eq!(
            bad(json!({"csv": "a", "mode": "drafts", "plan_hash": "abc"})),
            vec!["plan_hash must be longer than or equal to 64 characters"]
        );
        assert_eq!(
            bad(json!({"csv": "a", "mode": "drafts", "plan_hash": "a".repeat(65)})),
            vec!["plan_hash must be shorter than or equal to 64 characters"]
        );
        assert_eq!(
            bad(json!({"csv": "a", "mode": "drafts"})),
            vec![
                "plan_hash must be longer than or equal to 64 characters",
                "plan_hash must be a string"
            ]
        );
    }
}
