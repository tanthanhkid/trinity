//! Chữ ký kiểu Stripe: `X-Trinity-Signature: t=<unix giây>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Dùng chung cho
//! webhook RA (ký) và webhook VÀO (kiểm, M35).

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const SIGNATURE_TOLERANCE_SEC: i64 = 300;

fn mac(secret: &str, t: i64, body: &[u8]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("HMAC nhận khoá mọi độ dài");
    m.update(format!("{t}.").as_bytes());
    m.update(body);
    m.finalize().into_bytes().into()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Hex HMAC-SHA256 trên đúng các byte của thân (không qua giải mã UTF-8).
pub fn compute_signature(secret: &str, timestamp_sec: i64, raw_body: &[u8]) -> String {
    hex(&mac(secret, timestamp_sec, raw_body))
}

pub fn build_signature_header(secret: &str, raw_body: &[u8], now_ms: i64) -> String {
    let t = now_ms.div_euclid(1000);
    format!("t={t},v1={}", compute_signature(secret, t, raw_body))
}

fn unhex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// `true` chỉ khi header đúng cú pháp, `t` trong ±`tolerance_sec`, và một `v1` khớp (so sánh thời gian cố định).
pub fn verify_signature_header(
    secret: &str,
    raw_body: &[u8],
    header: Option<&str>,
    tolerance_sec: i64,
    now_ms: i64,
) -> bool {
    let Some(header) = header.filter(|h| !h.is_empty() && h.encode_utf16().count() <= 512) else {
        return false;
    };
    let mut t: Option<i64> = None;
    let mut sigs = Vec::new();
    for part in header.split(',') {
        let Some((k, v)) = part.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if k == "t" && !v.is_empty() && v.len() <= 12 && v.bytes().all(|b| b.is_ascii_digit()) {
            t = v.parse().ok();
        } else if k == "v1"
            && let Some(s) = unhex(v)
        {
            sigs.push(s);
        }
    }
    let Some(t) = t.filter(|_| !sigs.is_empty()) else {
        return false;
    };
    if (now_ms.div_euclid(1000) - t).abs() > tolerance_sec {
        return false;
    }
    let expected = mac(secret, t, raw_body);
    sigs.iter().any(|s| bool::from(expected.ct_eq(s)))
}
