//! `state` OAuth đăng đa kênh (`social-oauth-state.ts`): gắn callback với ĐÚNG người bấm "Liên kết" và ĐÚNG mạng (chống CSRF /
//! tráo mạng). HMAC-SHA256, hạn 10 phút. Định dạng `base64url(JSON {u,n,e,v?,c?}).base64url(HMAC)`, thứ tự khoá như
//! `JSON.stringify` của Node.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use mod_facebook::state::company_matches;
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::config::is_social_network;

pub const STATE_TTL_SEC: i64 = 10 * 60;

type HmacSha256 = Hmac<Sha256>;

fn mac(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC nhận khoá mọi độ dài");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}

fn key(secret: &str) -> Vec<u8> {
    mac(b"trinity-social-oauth-state-v1", secret.as_bytes())
}

/// Người bấm và PKCE verifier (nếu có) đọc từ `state` hợp lệ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocialState {
    pub user_id: i32,
    pub verifier: Option<String>,
}

/// Ký `state`. `verifier`/`company_claim` vắng thì không có khoá tương ứng.
pub fn sign_social_state(
    secret: &str,
    user_id: i32,
    network: &str,
    verifier: Option<&str>,
    company_claim: Option<i32>,
    now_ms: i64,
) -> String {
    let e = now_ms.div_euclid(1000) + STATE_TTL_SEC;
    // Dựng chuỗi tay để giữ thứ tự `u, n, e, v, c` như `JSON.stringify`.
    let mut parts = vec![
        format!("\"u\":{user_id}"),
        format!("\"n\":{}", Value::String(network.to_owned())),
        format!("\"e\":{e}"),
    ];
    if let Some(v) = verifier {
        parts.push(format!("\"v\":{}", Value::String(v.to_owned())));
    }
    if let Some(c) = company_claim {
        parts.push(format!("\"c\":{c}"));
    }
    let body = URL_SAFE_NO_PAD.encode(format!("{{{}}}", parts.join(",")));
    let sig = URL_SAFE_NO_PAD.encode(mac(&key(secret), body.as_bytes()));
    format!("{body}.{sig}")
}

/// Kiểm `state` cho `network`; sai chữ ký, hết hạn, sai mạng, sai công ty, hỏng định dạng ⇒ `None`.
pub fn verify_social_state(
    secret: &str,
    state: &str,
    network: &str,
    now_ms: i64,
    multi_tenant: bool,
    current_company: Option<i32>,
) -> Option<SocialState> {
    let mut it = state.split('.');
    let (body, sig, extra) = (it.next()?, it.next()?, it.next());
    if body.is_empty() || sig.is_empty() || extra.is_some() {
        return None;
    }
    let want = URL_SAFE_NO_PAD.encode(mac(&key(secret), body.as_bytes()));
    if sig.len() != want.len() || sig.as_bytes().ct_eq(want.as_bytes()).unwrap_u8() != 1 {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(body).ok()?;
    let c: Value = serde_json::from_slice(&raw).ok()?;
    let u = c.get("u")?.as_f64()?;
    let e = c.get("e")?.as_f64()?;
    if e * 1000.0 < now_ms as f64 {
        return None;
    }
    let n = c.get("n")?.as_str()?;
    if !is_social_network(n) || n != network {
        return None;
    }
    if !company_matches(c.get("c"), multi_tenant, current_company) {
        return None;
    }
    // Id người dùng là số nguyên int4.
    if !(u.fract() == 0.0 && u >= 1.0 && u <= f64::from(i32::MAX)) {
        return None;
    }
    let verifier = c.get("v").and_then(Value::as_str).map(str::to_owned);
    Some(SocialState {
        user_id: u as i32,
        verifier,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn ky_va_kiem() {
        let s = sign_social_state("bi-mat", 42, "facebook", None, None, NOW);
        let ok = verify_social_state("bi-mat", &s, "facebook", NOW, false, None).unwrap();
        assert_eq!((ok.user_id, ok.verifier), (42, None));
        assert!(verify_social_state("bi-mat", &s, "facebook", NOW + 601_000, false, None).is_none());
        assert!(
            verify_social_state("bi-mat", &s, "youtube", NOW, false, None).is_none(),
            "sai mạng"
        );
        assert!(verify_social_state("khac", &s, "facebook", NOW, false, None).is_none());
        assert!(verify_social_state("bi-mat", &format!("{s}.x"), "facebook", NOW, false, None).is_none());
        assert!(verify_social_state("bi-mat", "", "facebook", NOW, false, None).is_none());
        let s = sign_social_state("k", 7, "facebook", None, Some(3), NOW);
        assert!(verify_social_state("k", &s, "facebook", NOW, true, Some(3)).is_some());
        assert!(verify_social_state("k", &s, "facebook", NOW, true, Some(1)).is_none());
    }

    #[test]
    fn giong_ban_node() {
        // Vector tính bằng Node (createHmac như social-oauth-state.ts, e = 1800000600).
        assert_eq!(
            sign_social_state("bi-mat", 42, "facebook", None, None, NOW),
            "eyJ1Ijo0MiwibiI6ImZhY2Vib29rIiwiZSI6MTgwMDAwMDYwMH0.O_dYbiyxljLJFhfgqwwkYfoiDSE-9pMuZG-pNreX-Y0"
        );
        let full = "eyJ1Ijo3LCJuIjoiZmFjZWJvb2siLCJlIjoxODAwMDAwNjAwLCJ2IjoidmVyIiwiYyI6M30.fpgDsl8mz0mBMMdFcN9widUysmmuLMSYg1V18GaJu00";
        assert_eq!(
            sign_social_state("bi-mat", 7, "facebook", Some("ver"), Some(3), NOW),
            full
        );
        let st = verify_social_state("bi-mat", full, "facebook", NOW, true, Some(3)).unwrap();
        assert_eq!((st.user_id, st.verifier.as_deref()), (7, Some("ver")));
    }
}
