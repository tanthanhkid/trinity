//! Hợp đồng `NOTIFY trinity_sync` (docs/sync-notify.md), phần của auth: kind `token` và `session`.
//! Envelope `{"v":1,"o":<origin>,"k":<kind>,"c":<companyId>, ...}`, tối đa 7.500 byte, gửi là fire-and-forget.

use serde_json::{Value, json};

pub const CHANNEL: &str = "trinity_sync";
pub const VERSION: i64 = 1;
pub const MAX_PAYLOAD: usize = 7_500;

/// Origin của tiến trình: `rust-<pid>-<hex>`; bỏ qua tin của chính mình.
pub fn new_origin() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos() ^ (d.as_secs() as u32));
    format!("rust-{}-{nanos:x}", std::process::id())
}

/// Tắt nghe và gửi: `TRINITY_SYNC=off` hoặc `TRINITY_RUNTIME=serverless`.
pub fn disabled(get: impl Fn(&str) -> Option<String>) -> bool {
    get("TRINITY_SYNC").is_some_and(|v| v.trim().eq_ignore_ascii_case("off"))
        || get("TRINITY_RUNTIME").is_some_and(|v| v.trim().eq_ignore_ascii_case("serverless"))
}

/// Dựng payload. `company` 0 = không có công ty; bản một công ty dùng 1.
pub fn envelope(origin: &str, kind: &str, company: i32, fields: Value) -> Option<String> {
    let mut m = serde_json::Map::new();
    m.insert("v".into(), json!(VERSION));
    m.insert("o".into(), json!(origin));
    m.insert("k".into(), json!(kind));
    m.insert("c".into(), json!(company));
    if let Value::Object(f) = fields {
        m.extend(f);
    }
    let s = Value::Object(m).to_string();
    (s.len() <= MAX_PAYLOAD).then_some(s)
}

/// Tin nhận được đã qua kiểm phiên bản và origin.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub kind: String,
    /// Công ty (`c` thiếu, 0 hoặc âm ⇒ 1, như `tenantKeyFor`).
    pub company: i32,
    pub fields: Value,
}

/// Phân tích một payload; `None` nếu hỏng, khác phiên bản, hoặc của chính tiến trình này.
pub fn parse(payload: &str, own_origin: &str) -> Option<Message> {
    let v: Value = serde_json::from_str(payload).ok()?;
    if v.get("v")?.as_i64()? != VERSION || v.get("o")?.as_str()? == own_origin {
        return None;
    }
    let kind = v.get("k")?.as_str()?.to_owned();
    let company = v
        .get("c")
        .and_then(Value::as_i64)
        .filter(|c| *c >= 1)
        .and_then(|c| i32::try_from(c).ok())
        .unwrap_or(1);
    Some(Message {
        kind,
        company,
        fields: v,
    })
}
