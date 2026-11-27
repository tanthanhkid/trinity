//! Chữ ký webhook Zalo OA (`zalo-oa-signature.ts`): header `X-ZEvent-Signature: mac=<hex>` với
//! `mac = sha256(app_id + <body thô> + timestamp + OA secret key)`: ghép chuỗi rồi băm SHA-256, KHÔNG phải HMAC. `timestamp`
//! lấy từ body. Thiếu secret hoặc app_id ⇒ luôn từ chối (không bao giờ "mở" khi chưa cấu hình).

use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use trinity_kernel::json::js_number;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn compute_zalo_mac(app_id: &str, raw_body: &[u8], timestamp: &str, secret: &str) -> String {
    let mut h = Sha256::new();
    h.update(app_id.as_bytes());
    h.update(raw_body);
    h.update(timestamp.as_bytes());
    h.update(secret.as_bytes());
    hex(&h.finalize())
}

/// `String(v)` của JS cho giá trị JSON vô hướng; mảng/object ⇒ `None` (không bao giờ khớp chữ ký hợp lệ).
fn js_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.as_f64().map_or_else(|| n.to_string(), js_number)),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub fn verify_zalo_signature(
    app_id: Option<&str>,
    secret: Option<&str>,
    raw_body: Option<&[u8]>,
    header: Option<&str>,
) -> bool {
    let (Some(app_id), Some(secret), Some(raw), Some(header)) = (app_id, secret, raw_body, header) else {
        return false;
    };
    if app_id.is_empty() || secret.is_empty() || raw.is_empty() || header.is_empty() || header.chars().count() > 200 {
        return false;
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(raw) else {
        return false;
    };
    let Some(ts) = parsed.get("timestamp").filter(|t| !t.is_null()) else {
        return false;
    };
    if parsed
        .get("app_id")
        .filter(|a| !a.is_null())
        .is_some_and(|a| js_string(a).as_deref() != Some(app_id))
    {
        return false;
    }
    let Some(ts) = js_string(ts) else { return false };
    let h = header.trim();
    let got = h
        .get(..4)
        .filter(|p| p.eq_ignore_ascii_case("mac="))
        .map_or(h, |_| &h[4..])
        .to_lowercase();
    if got.len() != 64 || !got.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let want = compute_zalo_mac(app_id, raw, &ts, secret);
    got.as_bytes().ct_eq(want.as_bytes()).unwrap_u8() == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(ts: &str) -> Vec<u8> {
        format!(r#"{{"app_id":"123","event_name":"user_send_text","timestamp":{ts}}}"#).into_bytes()
    }

    #[test]
    fn chu_ky_dung_va_sai() {
        let raw = body("1700000000000");
        let mac = compute_zalo_mac("123", &raw, "1700000000000", "bi-mat");
        let ok = |h: &str| verify_zalo_signature(Some("123"), Some("bi-mat"), Some(&raw), Some(h));
        assert!(ok(&format!("mac={mac}")) && ok(&format!("MAC={}", mac.to_uppercase())) && ok(&mac));
        assert!(!ok(&format!("mac={}", "0".repeat(64))) && !ok("mac=xyz") && !ok(""));
        assert!(
            !verify_zalo_signature(Some("123"), Some("khac"), Some(&raw), Some(&mac)),
            "sai secret"
        );
        assert!(
            !verify_zalo_signature(Some("999"), Some("bi-mat"), Some(&raw), Some(&mac)),
            "app_id khác body"
        );
        assert!(
            !verify_zalo_signature(None, Some("bi-mat"), Some(&raw), Some(&mac))
                && !verify_zalo_signature(Some("123"), None, Some(&raw), Some(&mac))
        );
        assert!(
            !verify_zalo_signature(Some("123"), Some("bi-mat"), None, Some(&mac))
                && !verify_zalo_signature(Some("123"), Some("bi-mat"), Some(b""), Some(&mac))
        );
        let mut tampered = raw.clone();
        tampered[10] = b'9';
        assert!(!verify_zalo_signature(
            Some("123"),
            Some("bi-mat"),
            Some(&tampered),
            Some(&mac)
        ));
        assert!(!verify_zalo_signature(
            Some("123"),
            Some("bi-mat"),
            Some(b"khong phai json"),
            Some(&mac)
        ));
        assert!(!verify_zalo_signature(
            Some("123"),
            Some("bi-mat"),
            Some(&raw),
            Some(&"a".repeat(201))
        ));
        // Thiếu timestamp ⇒ từ chối.
        let no_ts = br#"{"app_id":"123"}"#;
        assert!(!verify_zalo_signature(
            Some("123"),
            Some("bi-mat"),
            Some(no_ts),
            Some(&compute_zalo_mac("123", no_ts, "", "bi-mat"))
        ));
    }

    #[test]
    fn vector_sha256_tu_node() {
        // node -e "crypto.createHash('sha256').update('123').update('{}').update('1').update('s').digest('hex')"
        assert_eq!(
            compute_zalo_mac("123", b"{}", "1", "s"),
            "d43b7d889b1c1fd1b902dcdb39f9e48337dc6147ddac69a3b31915753dd4634c"
        );
    }
}
