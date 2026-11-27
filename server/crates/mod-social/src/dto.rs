//! DTO của route tài khoản (M53a) và bài đăng (M54a), kiểm đúng như class-validator (thông điệp của `ValidationPipe`, không
//! phải của serde).

use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;
use trinity_kernel::instant::parse_instant_with;

use crate::config::{REMOVED_SOCIAL_NETWORKS, SOCIAL_NETWORKS};
use crate::utm::utf16_len;

const BAD_NETWORK: &str = "Mạng không hợp lệ";

/// Body `POST /social/accounts/connect-url` (`SocialConnectDto`): `@IsIn([...SOCIAL_NETWORKS, ...removed], { message: 'Mạng không hợp lệ' })`.
/// Nhận cả tên mạng đã gỡ để service trả câu "đã ngừng hỗ trợ". Thiếu, `null`, không phải chuỗi ⇒ cùng câu lỗi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocialConnect {
    pub network: String,
}

impl SocialConnect {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let network = v
            .as_object()
            .and_then(|o| o.get("network"))
            .and_then(Value::as_str)
            .filter(|s| SOCIAL_NETWORKS.contains(s) || REMOVED_SOCIAL_NETWORKS.iter().any(|(k, _)| k == s));
        match network {
            Some(n) => Ok(Self { network: n.to_owned() }),
            None => Err(HttpError::validation(vec![BAD_NETWORK.to_owned()])),
        }
    }
}

// ───────────────────────────── bài đăng ─────────────────────────────

/// Tên các trường được phép (cách nhau bằng dấu cách); trường lạ ⇒ 400 như `forbidNonWhitelisted`.
const POST_KEYS: &str = "content media_keys targets scheduled_at use_queue utm";
const TARGET_KEYS: &str = "account_id caption options";
const UTM_KEYS: &str = "campaign content";

// Câu lỗi mặc định của class-validator (và các câu tuỳ chỉnh của DTO).
const M_ISO: &str = "scheduled_at phải là ISO 8601";
const M_CONTENT_MAX: &str = "content must be shorter than or equal to 70000 characters";
const M_CONTENT_STR: &str = "content must be a string";
const M_KEYS_EACH_MAX: &str = "each value in media_keys must be shorter than or equal to 200 characters";
const M_KEYS_EACH_STR: &str = "each value in media_keys must be a string";
const M_KEYS_MAX: &str = "media_keys must contain no more than 10 elements";
const M_KEYS_ARR: &str = "media_keys must be an array";
const M_TARGETS_MAX: &str = "targets must contain no more than 20 elements";
const M_TARGETS_MIN: &str = "Chọn ít nhất một kênh";
const M_TARGETS_ARR: &str = "targets must be an array";
const M_TARGETS_NESTED: &str = "nested property targets must be either object or array";
const M_ID_MIN: &str = "account_id must not be less than 1";
const M_ID_INT: &str = "account_id must be an integer number";
const M_CAPTION_MAX: &str = "caption must be shorter than or equal to 70000 characters";
const M_CAPTION_STR: &str = "caption must be a string";
const M_OPTIONS_OBJ: &str = "options must be an object";
const M_QUEUE_BOOL: &str = "use_queue must be a boolean value";
const M_UTM_NESTED: &str = "nested property utm must be either object or array";
const M_CAMPAIGN_STR: &str = "campaign must be a string";
const M_CAMPAIGN_MIN: &str = "campaign must be longer than or equal to 1 characters";
const M_CAMPAIGN_MAX: &str = "campaign must be shorter than or equal to 100 characters";
const M_CAMPAIGN_RANGE: &str = "campaign must be longer than or equal to 1 and shorter than or equal to 100 characters";
const M_UTM_CONTENT_MAX: &str = "content must be shorter than or equal to 100 characters";
const M_UTM_CONTENT_STR: &str = "content must be a string";

/// Một kênh của bài (`SocialTargetDto`).
#[derive(Debug, Clone, PartialEq)]
pub struct TargetInput {
    pub account_id: i32,
    pub caption: Option<String>,
    pub options: Option<Map<String, Value>>,
}

/// Body tạo/sửa/xem trước bài (`CreateSocialPostDto`) cùng đầu vào của các nơi khác (nháp, CSV, MCP).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PostInput {
    pub content: String,
    pub media_keys: Vec<String>,
    pub targets: Vec<TargetInput>,
    /// ISO 8601; vắng hoặc `null` = đăng ngay.
    pub scheduled_at: Option<String>,
    /// Đặt vào khung trống gần nhất của hàng đợi (chỉ khi không có `scheduled_at`).
    pub use_queue: bool,
    /// UTM chung cho mọi kênh. `None` = theo `options.utm` từng kênh; `Some(null)` = bỏ.
    pub utm: Option<Value>,
    /// Nguồn tạo bài; vắng ⇒ `web`.
    pub source: Option<String>,
}

/// Ghi lỗi `prefix + msg` khi `fail`.
fn push(errs: &mut Vec<String>, fail: bool, prefix: &str, msg: &str) {
    if fail {
        errs.push(format!("{prefix}{msg}"));
    }
}

/// `whitelist` + `forbidNonWhitelisted` của `ValidationPipe`: trường lạ ⇒ "property x should not exist".
fn unknown_keys(obj: &Map<String, Value>, known: &str, prefix: &str, errs: &mut Vec<String>) {
    for k in obj.keys().filter(|k| !known.split(' ').any(|x| x == k.as_str())) {
        errs.push(format!("{prefix}property {k} should not exist"));
    }
}

/// Chuỗi dài tối đa `max` đơn vị UTF-16 (`@IsString() @MaxLength(max)`).
fn text_within(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| utf16_len(s) <= max)
}

/// `Number.isInteger` của giá trị JSON (`1.0` cũng là số nguyên).
fn integer_of(v: &Value) -> Option<i128> {
    let n = match v {
        Value::Number(n) => n,
        _ => return None,
    };
    if let Some(i) = n.as_i64() {
        return Some(i128::from(i));
    }
    if let Some(u) = n.as_u64() {
        return Some(i128::from(u));
    }
    n.as_f64()
        .filter(|f| f.fract() == 0.0 && f.abs() < 1e30)
        .map(|f| f as i128)
}

/// Thuộc tính `@IsOptional()`: vắng hoặc `null` thì bỏ qua mọi luật.
fn given<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    obj.get(key).filter(|v| !v.is_null())
}

fn text_of(obj: &Map<String, Value>, key: &str) -> Option<String> {
    match obj.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn check_target(obj: &Map<String, Value>, prefix: &str, errs: &mut Vec<String>) -> Option<TargetInput> {
    let before = errs.len();
    unknown_keys(obj, TARGET_KEYS, prefix, errs);
    // `@IsInt() @Min(1)`: luật khai sau chạy trước.
    let id = obj.get("account_id");
    let id_num = id.and_then(Value::as_f64).filter(|f| f.is_finite());
    let id_int = id.and_then(integer_of);
    push(errs, id_num.is_none_or(|f| f < 1.0), prefix, M_ID_MIN);
    push(errs, id_int.is_none(), prefix, M_ID_INT);
    if let Some(v) = given(obj, "caption") {
        push(errs, !text_within(v, 70_000), prefix, M_CAPTION_MAX);
        push(errs, !v.is_string(), prefix, M_CAPTION_STR);
    }
    if let Some(v) = given(obj, "options") {
        push(errs, !v.is_object(), prefix, M_OPTIONS_OBJ);
    }
    // Id kênh ngoài int4: class-validator cho qua nhưng cột là int4 ⇒ báo 400 thay vì lỗi DB.
    let id_i32 = id_int.and_then(|i| i32::try_from(i).ok());
    if id_int > Some(i128::from(i32::MAX)) {
        errs.push(format!("{prefix}account_id must not be greater than {}", i32::MAX));
    }
    if errs.len() > before {
        return None;
    }
    Some(TargetInput {
        account_id: id_i32?,
        caption: text_of(obj, "caption"),
        options: given(obj, "options").and_then(Value::as_object).cloned(),
    })
}

/// `targets`: `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true })`. Lỗi của phần tử đi kèm tiền tố
/// `targets.<chỉ số>.`; như `ValidationPipe`, khi có lỗi phần tử thì các lỗi của chính mảng không được báo.
fn check_targets(v: Option<&Value>, errs: &mut Vec<String>) -> Vec<TargetInput> {
    let arr = v.and_then(Value::as_array);
    let mut own: Vec<String> = Vec::new();
    push(&mut own, arr.is_none_or(|a| a.len() > 20), "", M_TARGETS_MAX);
    push(&mut own, arr.is_none_or(|a| a.is_empty()), "", M_TARGETS_MIN);
    push(&mut own, arr.is_none(), "", M_TARGETS_ARR);
    let mut nested: Vec<String> = Vec::new();
    let mut out: Vec<TargetInput> = Vec::new();
    match v {
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                match item.as_object() {
                    Some(o) => out.extend(check_target(o, &format!("targets.{i}."), &mut nested)),
                    None => nested.push(format!("targets.nested property {i} must be either object or array")),
                }
            }
        }
        Some(Value::Object(o)) => out.extend(check_target(o, "targets.", &mut nested)),
        Some(Value::Null) | None => {}
        Some(_) => push(&mut own, true, "", M_TARGETS_NESTED),
    }
    if nested.is_empty() {
        errs.extend(own);
    } else {
        errs.extend(nested);
        out.clear();
    }
    out
}

/// Câu lỗi của `@Length(1, 100)` cho `campaign` (theo hàm tạo câu lỗi của class-validator); `None` nếu hợp lệ.
fn campaign_length_error(v: Option<&Value>) -> Option<&'static str> {
    let truthy = v.is_some_and(|x| match x {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => true,
    });
    match v.and_then(Value::as_str) {
        _ if !truthy => Some(M_CAMPAIGN_MIN),
        Some(s) if utf16_len(s) > 100 => Some(M_CAMPAIGN_MAX),
        Some(_) => None,
        None => Some(M_CAMPAIGN_RANGE),
    }
}

/// `utm`: `@ValidateNested() @Type(() => SocialUtmDto)`; lỗi trường con mang tiền tố `utm.`.
fn check_utm(v: Option<&Value>, errs: &mut Vec<String>) {
    let o = match v {
        None | Some(Value::Null) => return,
        Some(Value::Object(o)) => o,
        Some(_) => {
            errs.push(M_UTM_NESTED.to_owned());
            return;
        }
    };
    unknown_keys(o, UTM_KEYS, "utm.", errs);
    let campaign = o.get("campaign");
    if let Some(m) = campaign_length_error(campaign) {
        errs.push(format!("utm.{m}"));
    }
    let campaign_is_text = campaign.is_some_and(Value::is_string);
    push(errs, !campaign_is_text, "utm.", M_CAMPAIGN_STR);
    if let Some(c) = given(o, "content") {
        push(errs, !text_within(c, 100), "utm.", M_UTM_CONTENT_MAX);
        push(errs, !c.is_string(), "utm.", M_UTM_CONTENT_STR);
    }
}

impl PostInput {
    /// Body `CreateSocialPostDto` kiểm như `ValidationPipe` (whitelist, câu lỗi mặc định của class-validator; luật khai sau
    /// báo trước). Body không phải object kiểm như `{}`.
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let empty = Map::new();
        let obj = v.as_object().unwrap_or(&empty);
        let mut errs: Vec<String> = Vec::new();
        unknown_keys(obj, POST_KEYS, "", &mut errs);

        let content = obj.get("content");
        let content_short = content.is_some_and(|c| text_within(c, 70_000));
        push(&mut errs, !content_short, "", M_CONTENT_MAX);
        push(&mut errs, !content.is_some_and(Value::is_string), "", M_CONTENT_STR);

        // `@IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each }) @MaxLength(200, { each })`.
        let mut media_keys: Vec<String> = Vec::new();
        if let Some(v) = given(obj, "media_keys") {
            let items: Vec<&Value> = match v.as_array() {
                Some(a) => a.iter().collect(),
                None => vec![v],
            };
            let each_short = items.iter().all(|i| text_within(i, 200));
            let each_text = items.iter().all(|i| i.is_string());
            let too_many = v.as_array().is_none_or(|a| a.len() > 10);
            push(&mut errs, !each_short, "", M_KEYS_EACH_MAX);
            push(&mut errs, !each_text, "", M_KEYS_EACH_STR);
            push(&mut errs, too_many, "", M_KEYS_MAX);
            push(&mut errs, !v.is_array(), "", M_KEYS_ARR);
            for i in &items {
                if let Some(s) = i.as_str() {
                    media_keys.push(s.to_owned());
                }
            }
        }

        let targets = check_targets(obj.get("targets"), &mut errs);

        let scheduled = given(obj, "scheduled_at");
        let sched_ok = scheduled.is_none_or(|v| v.as_str().is_some_and(|s| parse_instant_with(s, 0).is_some()));
        push(&mut errs, !sched_ok, "", M_ISO);

        let use_queue = given(obj, "use_queue");
        let queue_bad = use_queue.is_some_and(|v| !v.is_boolean());
        push(&mut errs, queue_bad, "", M_QUEUE_BOOL);

        check_utm(obj.get("utm"), &mut errs);

        if !errs.is_empty() {
            return Err(HttpError::validation(errs));
        }
        Ok(Self {
            content: text_of(obj, "content").unwrap_or_default(),
            media_keys,
            targets,
            scheduled_at: scheduled.and_then(Value::as_str).map(str::to_owned),
            use_queue: use_queue.and_then(Value::as_bool).unwrap_or(false),
            utm: obj.get("utm").cloned(),
            source: None,
        })
    }
}

/// Body `POST /social/posts/:id/reschedule` (`SocialRescheduleDto`): `scheduled_at` bắt buộc, ISO 8601.
pub fn parse_reschedule(v: &Value) -> Result<String, HttpError> {
    let empty = Map::new();
    let obj = v.as_object().unwrap_or(&empty);
    let mut errs: Vec<String> = Vec::new();
    unknown_keys(obj, "scheduled_at", "", &mut errs);
    let at = text_of(obj, "scheduled_at");
    let ok = at.as_deref().is_some_and(|s| parse_instant_with(s, 0).is_some());
    push(&mut errs, !ok, "", M_ISO);
    match at {
        Some(s) if errs.is_empty() => Ok(s),
        _ => Err(HttpError::validation(errs)),
    }
}

/// Body `POST /social/drafts/:id/publish` (`SocialDraftPublishDto`), cả ba trường đều tuỳ chọn.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DraftPublish {
    /// `None` = không gửi (giữ giờ của nháp); `Some(None)` = `null` (đăng ngay); `Some(Some(s))` = giờ hẹn ISO 8601.
    pub scheduled_at: Option<Option<String>>,
    /// `updated_at` của nháp người dùng đang xem; nháp đã đổi sau đó ⇒ 409.
    pub expected_updated_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Đặt vào khung trống gần nhất của hàng đợi (thay cho giờ hẹn).
    pub use_queue: bool,
}

/// `SocialDraftPublishDto`: `@IsOptional() @IsISO8601()` (vắng hoặc `null` thì bỏ qua luật), `@IsBoolean()`; trường lạ ⇒ 400.
pub fn parse_draft_publish(v: &Value) -> Result<DraftPublish, HttpError> {
    let empty = Map::new();
    let obj = v.as_object().unwrap_or(&empty);
    let mut errs: Vec<String> = Vec::new();
    unknown_keys(obj, "scheduled_at expected_updated_at use_queue", "", &mut errs);
    let mut out = DraftPublish::default();
    match obj.get("scheduled_at") {
        None => {}
        Some(Value::Null) => out.scheduled_at = Some(None),
        Some(Value::String(s)) if parse_instant_with(s, 0).is_some() => out.scheduled_at = Some(Some(s.clone())),
        Some(_) => errs.push(M_ISO.to_owned()),
    }
    match given(obj, "expected_updated_at") {
        None => {}
        Some(Value::String(s)) if parse_instant_with(s, 0).is_some() => {
            out.expected_updated_at = parse_instant_with(s, 0);
        }
        Some(_) => errs.push("expected_updated_at phải là ISO 8601".to_owned()),
    }
    match given(obj, "use_queue") {
        None => {}
        Some(Value::Bool(b)) => out.use_queue = *b,
        Some(_) => errs.push(M_QUEUE_BOOL.to_owned()),
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(HttpError::validation(errs))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn messages(e: HttpError) -> Vec<String> {
        let (s, b) = trinity_kernel::error::AppError::from(e).response(true);
        assert_eq!(s, 400);
        // trinity-lint: allow-json-value (thông báo lỗi/giá trị so sánh trong test, không phải model hay cột DB)
        serde_json::from_value(serde_json::to_value(&b.message).unwrap()).unwrap()
    }

    fn bad(v: Value) -> Vec<String> {
        messages(PostInput::from_json(&v).unwrap_err())
    }

    #[test]
    fn kiem_mang() {
        assert_eq!(
            SocialConnect::from_json(&json!({"network":"facebook"}))
                .unwrap()
                .network,
            "facebook"
        );
        assert!(SocialConnect::from_json(&json!({"network":"youtube"})).is_ok());
        for bad in [
            json!({}),
            json!({"network":null}),
            json!({"network":1}),
            json!({"network":"x"}),
            json!([]),
            json!(null),
        ] {
            let e = SocialConnect::from_json(&bad).unwrap_err();
            let (s, b) = trinity_kernel::error::AppError::from(e).response(true);
            assert_eq!(s, 400);
            assert_eq!(
                serde_json::to_value(&b.message).unwrap(),
                json!(["Mạng không hợp lệ"]),
                "{bad}"
            );
        }
    }

    #[test]
    fn bai_hop_le() {
        let v = json!({
            "content": "Xin chào",
            "media_keys": ["social/a.png"],
            "targets": [{"account_id": 3, "caption": "riêng", "options": {"first_comment": "hi"}}, {"account_id": 4.0}],
            "scheduled_at": "2026-12-01T09:00:00+07:00",
            "use_queue": false,
            "utm": {"campaign": "thu"}
        });
        let p = PostInput::from_json(&v).unwrap();
        assert_eq!(p.content, "Xin chào");
        assert_eq!(p.media_keys, ["social/a.png"]);
        assert_eq!(p.targets.len(), 2);
        assert_eq!(p.targets[0].account_id, 3);
        assert_eq!(p.targets[0].caption.as_deref(), Some("riêng"));
        assert_eq!(p.targets[1].account_id, 4);
        assert_eq!(p.scheduled_at.as_deref(), Some("2026-12-01T09:00:00+07:00"));
        assert!(p.utm.is_some() && !p.use_queue);
        // `null` ở trường tuỳ chọn = vắng.
        let v = json!({"content": "", "targets": [{"account_id": 1}], "scheduled_at": null});
        assert_eq!(PostInput::from_json(&v).unwrap().scheduled_at, None);
    }

    #[test]
    fn thieu_het() {
        let m = bad(json!({}));
        assert_eq!(m.len(), 5);
        assert!(m[0].starts_with("content must be shorter"));
        assert_eq!(m[1], "content must be a string");
        assert!(m[2].starts_with("targets must contain no more"));
        assert_eq!(m[3], "Chọn ít nhất một kênh");
        assert_eq!(m[4], "targets must be an array");
    }

    #[test]
    fn truong_la() {
        let m = bad(json!({"content": "a", "targets": [{"account_id": 1}], "x": 1}));
        assert_eq!(m, ["property x should not exist"]);
        let m = bad(json!({"content": "a", "targets": [{"account_id": 1, "y": 1}]}));
        assert_eq!(m, ["targets.0.property y should not exist"]);
    }

    #[test]
    fn kenh_sai() {
        let m = bad(json!({"content": "a", "targets": [{"account_id": 0, "caption": 5}, 7]}));
        assert_eq!(m.len(), 4);
        assert_eq!(m[0], "targets.0.account_id must not be less than 1");
        assert!(m[1].ends_with("caption must be shorter than or equal to 70000 characters"));
        assert_eq!(m[2], "targets.0.caption must be a string");
        assert_eq!(m[3], "targets.nested property 1 must be either object or array");
        let m = bad(json!({"content": "a", "targets": [{"account_id": 1.5}]}));
        assert_eq!(m[0], "targets.0.account_id must be an integer number");
        let m = bad(json!({"content": "a", "targets": [{"account_id": 3000000000_i64}]}));
        assert_eq!(m, ["targets.0.account_id must not be greater than 2147483647"]);
        let m = bad(json!({"content": "a", "targets": "x"}));
        assert_eq!(m.len(), 4);
        assert_eq!(m[3], "nested property targets must be either object or array");
    }

    #[test]
    fn gio_tep_va_utm_sai() {
        let ok = json!({"account_id": 1});
        let m = bad(json!({"content": "a", "targets": [ok], "scheduled_at": "x", "use_queue": 1}));
        assert_eq!(m[0], "scheduled_at phải là ISO 8601");
        assert_eq!(m[1], "use_queue must be a boolean value");
        let m = bad(json!({"content": "a", "targets": [ok], "media_keys": "k"}));
        assert_eq!(m.len(), 2);
        assert_eq!(m[1], "media_keys must be an array");
        let m = bad(json!({"content": "a", "targets": [ok], "media_keys": [1]}));
        assert_eq!(m[1], "each value in media_keys must be a string");
        let m = bad(json!({"content": "a", "targets": [ok], "utm": {"content": 1}}));
        assert_eq!(m.len(), 4);
        assert!(m[0].starts_with("utm.campaign must be longer than or equal to 1"));
        assert_eq!(m[1], "utm.campaign must be a string");
        assert_eq!(m[3], "utm.content must be a string");
        let m = bad(json!({"content": "a", "targets": [ok], "utm": "x"}));
        assert_eq!(m, ["nested property utm must be either object or array"]);
    }

    #[test]
    fn doi_gio() {
        let v = json!({"scheduled_at": "2026-12-01T09:00:00Z"});
        assert_eq!(parse_reschedule(&v).unwrap(), "2026-12-01T09:00:00Z");
        for v in [json!({}), json!({"scheduled_at": 5}), json!({"scheduled_at": "x"})] {
            let m = messages(parse_reschedule(&v).unwrap_err());
            assert_eq!(m, ["scheduled_at phải là ISO 8601"]);
        }
        let m = messages(parse_reschedule(&json!({"scheduled_at": "2026-12-01", "y": 1})).unwrap_err());
        assert_eq!(m, ["property y should not exist"]);
    }

    #[test]
    fn dang_nhap_kiem_body() {
        let d = parse_draft_publish(&json!({})).unwrap();
        assert_eq!(d, DraftPublish::default());
        let d = parse_draft_publish(&json!({"scheduled_at": null, "use_queue": true})).unwrap();
        assert_eq!((d.scheduled_at, d.use_queue), (Some(None), true));
        let d = parse_draft_publish(&json!({"scheduled_at": "2030-01-02T03:04:05Z"})).unwrap();
        assert_eq!(d.scheduled_at, Some(Some("2030-01-02T03:04:05Z".to_owned())));
        let d = parse_draft_publish(&json!({"expected_updated_at": "2030-01-02T03:04:05.000Z"})).unwrap();
        assert!(d.expected_updated_at.is_some());
        // `null` ở trường tuỳ chọn khác bị bỏ qua như `@IsOptional()`.
        assert!(parse_draft_publish(&json!({"expected_updated_at": null, "use_queue": null})).is_ok());
        let m = messages(
            parse_draft_publish(&json!({"scheduled_at": "x", "expected_updated_at": 5, "use_queue": 1, "z": 1}))
                .unwrap_err(),
        );
        assert_eq!(m[0], "property z should not exist");
        assert!(m.contains(&"scheduled_at phải là ISO 8601".to_owned()));
        assert!(m.contains(&"expected_updated_at phải là ISO 8601".to_owned()));
        assert!(m.contains(&"use_queue must be a boolean value".to_owned()));
    }
}
