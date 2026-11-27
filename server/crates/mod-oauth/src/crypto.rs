//! Băm, token ngẫu nhiên, PKCE và token consent ký HMAC (`oauth-crypto.ts`).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

pub fn sha256_hex(v: &str) -> String {
    Sha256::digest(v.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `randomBytes(n).toString('base64url')`.
pub fn random_token(bytes: usize) -> Result<String, String> {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).map_err(|e| format!("không đọc được nguồn ngẫu nhiên của hệ điều hành: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

/// So sánh hằng-thời-gian hai chuỗi bất kỳ (băm trước để độ dài không rò).
pub fn safe_equal(a: &str, b: &str) -> bool {
    let (x, y) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    x.ct_eq(&y).into()
}

/// PKCE S256: `BASE64URL(SHA256(verifier))` (RFC 7636 §4.2).
pub fn pkce_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// `^[A-Za-z0-9._~-]{43,128}$`.
pub fn is_code_verifier(s: &str) -> bool {
    (43..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
}

/// `^[A-Za-z0-9_-]{43}$`.
pub fn is_code_challenge(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// Token consent: ràng buộc quyết định với ĐÚNG người, ĐÚNG công ty và ĐÚNG tham số đã hiển thị.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsentClaims {
    pub u: f64,
    /// Công ty (id người dùng lặp giữa các công ty). Vắng ⇒ công ty 1.
    pub c: Option<f64>,
    pub h: String,
    pub e: f64,
}

/// Khoá ký dẫn xuất: `HMAC-SHA256(key = "trinity-oauth-consent-v1", msg = JWT_SECRET)`.
fn consent_key(secret: &str) -> [u8; 32] {
    let mut m = HmacSha256::new_from_slice(b"trinity-oauth-consent-v1").expect("HMAC nhận khoá mọi độ dài");
    m.update(secret.as_bytes());
    m.finalize().into_bytes().into()
}

fn mac_of(secret: &str, body: &str) -> String {
    let mut m = HmacSha256::new_from_slice(&consent_key(secret)).expect("HMAC nhận khoá mọi độ dài");
    m.update(body.as_bytes());
    URL_SAFE_NO_PAD.encode(m.finalize().into_bytes())
}

/// Thứ tự khoá `u, c, h, e` như `JSON.stringify` của bản TS: token do Node ký vẫn xác minh được ở Rust và ngược lại.
pub fn sign_consent(secret: &str, u: i32, c: i32, h: &str, e: i64) -> String {
    let json = format!(
        "{{\"u\":{u},\"c\":{c},\"h\":{},\"e\":{e}}}",
        trinity_kernel::json::js_json(&Value::String(h.to_owned()))
    );
    let body = URL_SAFE_NO_PAD.encode(json.as_bytes());
    let mac = mac_of(secret, &body);
    format!("{body}.{mac}")
}

pub fn verify_consent(secret: &str, token: &str, now_ms: i64) -> Option<ConsentClaims> {
    let parts: Vec<&str> = token.split('.').collect();
    let [body, mac] = parts[..] else { return None };
    if body.is_empty() || mac.is_empty() || !safe_equal(mac, &mac_of(secret, body)) {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(body).ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    let num = |k: &str| v.get(k).and_then(Value::as_f64);
    let (u, e) = (num("u")?, num("e")?);
    let h = v.get("h")?.as_str()?.to_owned();
    let c = match v.get("c") {
        None => None,
        Some(x) => Some(x.as_f64()?),
    };
    #[allow(clippy::cast_precision_loss)]
    if e * 1000.0 < now_ms as f64 {
        return None;
    }
    Some(ConsentClaims { u, c, h, e })
}
