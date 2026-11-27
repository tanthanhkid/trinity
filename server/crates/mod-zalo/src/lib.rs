//! Zalo OA và ZNS (M52), chuyển từ `services/crm/src/zalo-oa`.
//!
//! - [`config`]: cấu hình env (`ZALO_*`), URL theo điểm cuối (`ZALO_*_BASE_URL` trỏ tới máy chủ giả khi test), SĐT Zalo/nội địa.
//! - [`errors`]: [`errors::ZaloApiError`] (mã `-216`/`-124`/`-118` token, `-3` cấu hình) và câu tiếng Việt cho người dùng.
//! - [`client`]: [`client::ZaloClient`] (đổi code, làm mới token, tin tư vấn, ZNS, hồ sơ người dùng).
//! - [`signature`]: chữ ký webhook `X-ZEvent-Signature = sha256(app_id + body + timestamp + secret)`.
//! - [`token`]: OAuth v4 PKCE, lưu token mã hoá, làm mới dưới `pg_advisory_xact_lock` theo OA.
//! - [`contacts`], [`threads`]: ghép khách, hội thoại và tin nhắn (khử trùng theo `msg_id`, outbox `zalo_oa.message_*`).
//! - [`webhook`]: nhận sự kiện (kiểm chữ ký, tìm công ty theo OA, bỏ qua khi cờ `zalo_oa` tắt).
//! - [`messaging`]: gửi tin tư vấn (≤ 48 giờ) và ZNS, qua `ChannelGuard` của M45 (ZNS tính vào hạn mức tin hàng loạt).
//! - [`routes`]: bảng route K14 (11 route).
//!
//! Chưa có ở đây: thông báo chuông cho tin khách gửi tới (`ChannelNotificationsService`, thuộc module thông báo kênh) và trait
//! `MessageChannel` dùng chung cho bot AI/bản tin (chưa có ở Rust). Tầng route gọi thêm chúng khi các module đó có.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod client;
pub mod config;
pub mod contacts;
pub mod errors;
pub mod messaging;
pub mod routes;
pub mod signature;
pub mod threads;
pub mod token;
pub mod webhook;

use serde_json::Value;
use trinity_kernel::error::HttpError;

/// `s.slice(0, n)` của JS tính theo đơn vị UTF-16 (không cắt giữa cặp thay thế).
pub(crate) fn utf16_prefix(s: &str, n: usize) -> String {
    let (mut units, mut out) = (0, String::new());
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `Math.min(Math.max(Number(v) || def, 1), max)` cho tham số `limit` ở query.
pub fn clamp_limit(v: Option<&str>, def: i64, max: i64) -> i64 {
    let n = v
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0);
    n.map_or(def, |n| n.clamp(f64::MIN, f64::MAX) as i64).clamp(1, max)
}

/// `Number(cursor) || undefined` ở query: `0`, rỗng, không phải số ⇒ `None` (không lọc).
pub fn parse_cursor(v: Option<&str>) -> Option<i64> {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .map(|n| n as i64)
}

fn validation(e: Vec<String>) -> HttpError {
    HttpError::validation(e)
}

/// Body `POST /zalo-oa/threads/:id/messages` (`SendTextDto`): `text` chuỗi 1–2000 ký tự.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendText {
    pub text: String,
}

impl SendText {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let t = v.get("text");
        let mut e = Vec::new();
        match t.and_then(Value::as_str) {
            Some(s) if (1..=2000).contains(&len16(s)) => return Ok(Self { text: s.to_owned() }),
            Some(_) => {
                e.push("text must be longer than or equal to 1 and shorter than or equal to 2000 characters".to_owned())
            }
            None => {
                e.push(
                    "text must be longer than or equal to 1 and shorter than or equal to 2000 characters".to_owned(),
                );
                e.push("text must be a string".to_owned());
            }
        }
        Err(validation(e))
    }
}

/// Body `POST /zalo-oa/zns` (`SendZnsDto`): `phone` chuỗi ≤ 20, `template_id` chỉ chữ số (1–20), `template_data` object (giá trị
/// ép thành chuỗi), `tracking_id` chuỗi ≤ 48 (tuỳ chọn).
#[derive(Debug, Clone, PartialEq)]
pub struct SendZns {
    pub phone: String,
    pub template_id: String,
    pub template_data: serde_json::Map<String, Value>,
    pub tracking_id: Option<String>,
}

/// `String(v)` của JS cho giá trị JSON dùng làm dữ liệu mẫu ZNS.
fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        Value::Number(n) => n
            .as_f64()
            .map_or_else(|| n.to_string(), trinity_kernel::json::js_number),
        other => other.to_string(),
    }
}

impl SendZns {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let mut e = Vec::new();
        let phone = v.get("phone").and_then(Value::as_str);
        if phone.is_some_and(|p| len16(p) > 20) {
            e.push("phone must be shorter than or equal to 20 characters".to_owned());
        }
        if phone.is_none() {
            e.push("phone must be shorter than or equal to 20 characters".to_owned());
            e.push("phone must be a string".to_owned());
        }
        let tid = v.get("template_id").and_then(Value::as_str);
        if !tid.is_some_and(|t| (1..=20).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit())) {
            e.push("template_id chỉ gồm chữ số".to_owned());
        }
        if tid.is_none() {
            e.push("template_id must be a string".to_owned());
        }
        let data = v.get("template_data").and_then(Value::as_object);
        if data.is_none() {
            e.push("template_data must be an object".to_owned());
        }
        let tracking = match v.get("tracking_id") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => {
                if len16(s) > 48 {
                    e.push("tracking_id must be shorter than or equal to 48 characters".to_owned());
                }
                Some(s.clone())
            }
            Some(_) => {
                e.push("tracking_id must be shorter than or equal to 48 characters".to_owned());
                e.push("tracking_id must be a string".to_owned());
                None
            }
        };
        if !e.is_empty() {
            return Err(validation(e));
        }
        let data = data
            .map(|m| m.iter().map(|(k, x)| (k.clone(), Value::String(js_str(x)))).collect())
            .unwrap_or_default();
        Ok(Self {
            phone: phone.unwrap_or_default().to_owned(),
            template_id: tid.unwrap_or_default().to_owned(),
            template_data: data,
            tracking_id: tracking,
        })
    }
}

/// Body `POST /zalo-oa/threads/:id/link` (`LinkThreadDto`): `contact_id` số nguyên int4, hoặc `phone` chuỗi ≤ 20; cần một trong hai.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkThread {
    pub contact_id: Option<i32>,
    pub phone: Option<String>,
}

impl LinkThread {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let mut e = Vec::new();
        let contact_id = match v.get("contact_id") {
            None | Some(Value::Null) => None,
            Some(x) => {
                let n = x.as_i64().and_then(|n| i32::try_from(n).ok());
                if n.is_none() {
                    e.push("contact_id must be an integer number".to_owned());
                }
                n
            }
        };
        let phone = match v.get("phone") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => {
                if len16(s) > 20 {
                    e.push("phone must be shorter than or equal to 20 characters".to_owned());
                }
                Some(s.clone())
            }
            Some(_) => {
                e.push("phone must be shorter than or equal to 20 characters".to_owned());
                e.push("phone must be a string".to_owned());
                None
            }
        };
        if !e.is_empty() {
            return Err(validation(e));
        }
        // `if (!dto.contact_id && !dto.phone)` của controller: `0` và chuỗi rỗng đều coi như vắng.
        if contact_id.unwrap_or(0) == 0 && phone.as_deref().unwrap_or_default().is_empty() {
            return Err(HttpError::bad_request("Cần contact_id hoặc phone"));
        }
        Ok(Self {
            contact_id: contact_id.filter(|c| *c != 0),
            phone: phone.filter(|p| !p.is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msgs(e: HttpError) -> Value {
        let (_, b) = trinity_kernel::error::AppError::from(e).response(true);
        serde_json::to_value(&b.message).unwrap()
    }

    #[test]
    fn gioi_han_va_con_tro() {
        assert_eq!(
            (
                clamp_limit(None, 30, 100),
                clamp_limit(Some("5"), 30, 100),
                clamp_limit(Some("500"), 30, 100)
            ),
            (30, 5, 100)
        );
        assert_eq!(
            (
                clamp_limit(Some("0"), 30, 100),
                clamp_limit(Some("-4"), 30, 100),
                clamp_limit(Some("abc"), 30, 100)
            ),
            (30, 1, 30)
        );
        assert_eq!(
            (
                parse_cursor(Some("7")),
                parse_cursor(Some("0")),
                parse_cursor(Some("")),
                parse_cursor(Some("x")),
                parse_cursor(None)
            ),
            (Some(7), None, None, None, None)
        );
        assert_eq!(utf16_prefix("ab😀", 3), "ab");
    }

    #[test]
    fn kiem_luat_dto() {
        assert_eq!(SendText::from_json(&json!({ "text": "chào" })).unwrap().text, "chào");
        for bad in [json!({}), json!({ "text": "" }), json!({ "text": "x".repeat(2001) })] {
            assert!(SendText::from_json(&bad).is_err());
        }
        assert_eq!(
            msgs(SendText::from_json(&json!({ "text": 5 })).unwrap_err())
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let z = SendZns::from_json(&json!({ "phone": "0912345678", "template_id": "123", "template_data": { "name": "Lan", "n": 5, "b": true }, "tracking_id": "t1" })).unwrap();
        assert_eq!(z.template_data["n"], "5");
        assert_eq!(z.template_data["b"], "true");
        for bad in [
            json!({ "phone": "1".repeat(21), "template_id": "1", "template_data": {} }),
            json!({ "phone": "0912", "template_id": "12a", "template_data": {} }),
            json!({ "phone": "0912", "template_id": "1", "template_data": [] }),
            json!({ "phone": "0912", "template_id": "1", "template_data": {}, "tracking_id": "x".repeat(49) }),
            json!({ "phone": 5, "template_id": 1 }),
        ] {
            assert!(SendZns::from_json(&bad).is_err(), "{bad}");
        }
        assert!(
            LinkThread::from_json(&json!({ "contact_id": 5 })).is_ok()
                && LinkThread::from_json(&json!({ "phone": "0912" })).is_ok()
        );
        for bad in [
            json!({}),
            json!({ "contact_id": 0 }),
            json!({ "phone": "" }),
            json!({ "contact_id": 1.5 }),
            json!({ "contact_id": 2_147_483_648_i64 }),
            json!({ "contact_id": 1, "phone": "1".repeat(21) }),
        ] {
            assert!(LinkThread::from_json(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            msgs(LinkThread::from_json(&json!({ "contact_id": "x" })).unwrap_err()),
            json!(["contact_id must be an integer number"])
        );
    }
}
