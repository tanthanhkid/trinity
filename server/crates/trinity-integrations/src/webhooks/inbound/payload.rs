//! Kiểm payload khách của webhook vào (`inbound-payload.ts`), chạy SAU khi đã xác thực token/chữ ký (người chưa xác thực không
//! thấy thông điệp kiểm). Luật class-validator đọc từ metadata thật của `InboundContactPayload` (`contracts/dto/schema.json`,
//! chế độ lenient: trường lạ bị bỏ). Lỗi chỉ nêu tên trường/ràng buộc, KHÔNG chép lại giá trị (SĐT).

use serde_json::{Map, Value};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::Message;
use trinity_kernel::phone::normalize_phone;

pub const MAX_EXTRA_BYTES: usize = 4096;
pub const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedInbound {
    pub name: String,
    /// Đã chuẩn hoá `0xxxxxxxxx`.
    pub phone: String,
    pub email: Option<String>,
    pub note: Option<String>,
    pub source: Option<String>,
    pub external_id: Option<String>,
    pub extra: Option<Map<String, Value>>,
}

fn opt(m: &Map<String, Value>, k: &str) -> Option<String> {
    m.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// `Err` = các câu lỗi (ghép bằng `"; "` thành thông điệp 400).
pub fn parse_inbound_payload(body: &Value) -> Result<ParsedInbound, Vec<String>> {
    if !body.is_object() {
        return Err(vec!["Body phải là object JSON".to_owned()]);
    }
    let cleaned = match validate_value("InboundContactPayload", body, Mode::Lenient) {
        Ok(v) => v,
        Err(e) => {
            let (_, b) = e.response(false);
            return Err(match b.message {
                Message::Many(m) => m,
                Message::One(s) => vec![s],
            });
        }
    };
    let m = cleaned.as_object().cloned().unwrap_or_default();
    let mut errors = Vec::new();
    let phone = m.get("phone").and_then(Value::as_str).and_then(normalize_phone);
    if phone.is_none() {
        errors.push("phone không hợp lệ (SĐT Việt Nam, vd 0912345678 hoặc +84912345678)".to_owned());
    }
    let extra = m.get("extra").and_then(Value::as_object).cloned();
    if let Some(e) = &extra
        && trinity_kernel::json::js_json(&Value::Object(e.clone())).len() > MAX_EXTRA_BYTES
    {
        errors.push(format!("extra tối đa {MAX_EXTRA_BYTES} byte"));
    }
    match (phone, errors.is_empty()) {
        (Some(phone), true) => Ok(ParsedInbound {
            name: opt(&m, "name").unwrap_or_default(),
            phone,
            email: opt(&m, "email"),
            note: opt(&m, "note"),
            source: opt(&m, "source"),
            external_id: opt(&m, "external_id"),
            extra,
        }),
        _ => Err(errors),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msgs(body: Value) -> String {
        parse_inbound_payload(&body).unwrap_err().join(";")
    }

    #[test]
    fn hop_le_cat_khoang_trang_va_chuan_hoa_sdt() {
        let r = parse_inbound_payload(&json!({
            "name": "  Nguyễn Văn A ", "phone": "+84 912 345 678", "email": " a@x.vn ", "note": "quan tâm gói A",
            "source": "FB form", "external_id": "lead-123", "extra": { "utm": "x" }
        }))
        .unwrap();
        assert_eq!(r.name, "Nguyễn Văn A");
        assert_eq!(r.phone, "0912345678");
        assert_eq!(r.email.as_deref(), Some("a@x.vn"));
        assert_eq!(r.external_id.as_deref(), Some("lead-123"));
        assert_eq!(r.extra.unwrap()["utm"], "x");
    }

    #[test]
    fn chi_name_phone_la_du_truong_thua_bi_bo() {
        let r =
            parse_inbound_payload(&json!({ "name": "A", "phone": "0912345678", "password": "x", "assigned_to": 1 }))
                .unwrap();
        assert_eq!(
            (r.email, r.note, r.source, r.external_id, r.extra),
            (None, None, None, None, None)
        );
    }

    #[test]
    fn tu_choi_dung_truong() {
        let ok = |extra: Value| {
            let mut b = json!({ "name": "A", "phone": "0912345678" });
            b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            b
        };
        for (body, want) in [
            (json!({ "phone": "0912345678" }), "name"),
            (json!({ "name": "A" }), "phone"),
            (json!({ "name": "", "phone": "0912345678" }), "name"),
            (json!({ "name": "A", "phone": "xyz" }), "phone"),
            (ok(json!({ "email": "sai" })), "email"),
            (ok(json!({ "external_id": "có dấu cách" })), "external_id"),
            (ok(json!({ "external_id": "x".repeat(129) })), "external_id"),
            (ok(json!({ "note": "x".repeat(2001) })), "note"),
            (ok(json!({ "extra": "str" })), "extra"),
            (
                ok(json!({ "extra": { "big": "x".repeat(MAX_EXTRA_BYTES) } })),
                "extra tối đa",
            ),
            (json!({ "name": 123, "phone": "0912345678" }), "name"),
            (json!({ "name": "A".repeat(101), "phone": "0912345678" }), "name"),
        ] {
            let m = msgs(body.clone());
            assert!(m.contains(want), "{body} => {m}");
        }
    }

    #[test]
    fn body_khong_phai_object_va_khong_lo_sdt() {
        for b in [json!(null), json!([1]), json!("x")] {
            assert!(parse_inbound_payload(&b).is_err());
        }
        let m = msgs(json!({ "name": "A", "phone": "0912345678999" }));
        assert!(!m.contains("0912345678999"), "{m}");
    }
}
