//! `state` của OAuth Facebook (`facebook-oauth-state.ts`): ràng buộc callback với ĐÚNG người bấm "Kết nối" (chống CSRF và
//! login CSRF). Ký HMAC-SHA256, hạn 10 phút. Nhiều công ty: kèm `c` = công ty mở luồng; callback chạy dưới công ty khác ⇒
//! `state` không hợp lệ. Định dạng `base64url(JSON {u,e,c?}).base64url(HMAC)` giống bản Node để hai bên kiểm được của nhau.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::config::Env;

/// Hạn của `state` (giây).
pub const STATE_TTL_SEC: i64 = 10 * 60;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("JWT_SECRET chưa đặt")]
pub struct MissingSecret;

/// `JWT_SECRET` của tiến trình (không có ⇒ lỗi, không tự sinh).
pub fn jwt_secret(env: &Env) -> Result<String, MissingSecret> {
    env("JWT_SECRET").filter(|s| !s.is_empty()).ok_or(MissingSecret)
}

fn mac(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC nhận khoá mọi độ dài");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}

/// Khoá ký: `HMAC-SHA256(khoá = hằng chuỗi, thông điệp = JWT_SECRET)`, đúng như `createHmac('sha256', hằng).update(secret)`.
fn key(secret: &str) -> Vec<u8> {
    mac(b"trinity-facebook-oauth-state-v1", secret.as_bytes())
}

/// Ký `state` cho người `user_id`. `company_claim`: công ty mở luồng khi cài nhiều công ty (`stateCompanyClaim`).
pub fn sign_state(secret: &str, user_id: i32, company_claim: Option<i32>, now_ms: i64) -> String {
    // Dựng chuỗi JSON tay để khoá đúng thứ tự `u, e, c` như `JSON.stringify` của Node.
    let e = now_ms.div_euclid(1000) + STATE_TTL_SEC;
    let claims = match company_claim {
        Some(c) => format!(r#"{{"u":{user_id},"e":{e},"c":{c}}}"#),
        None => format!(r#"{{"u":{user_id},"e":{e}}}"#),
    };
    let body = URL_SAFE_NO_PAD.encode(&claims);
    let sig = URL_SAFE_NO_PAD.encode(mac(&key(secret), body.as_bytes()));
    format!("{body}.{sig}")
}

/// Công ty đang chạy request phải đúng công ty đã ký `state` (`stateCompanyMatches`): chặn callback rơi về công ty 1 (mất
/// dòng `remember_oauth_state`) rồi gắn kênh nhầm công ty, vì id người dùng lặp giữa các công ty. `state` ký trước khi có
/// nhiều công ty (không có `c`) chỉ chấp nhận cho công ty 1.
pub fn company_matches(claim: Option<&Value>, multi_tenant: bool, current: Option<i32>) -> bool {
    if !multi_tenant {
        return true;
    }
    match claim {
        None | Some(Value::Null) => current == Some(1),
        Some(v) => v.as_i64().is_some_and(|c| Some(c) == current.map(i64::from)),
    }
}

/// Kiểm `state`: trả id người bấm "Kết nối", hoặc `None` nếu sai chữ ký, hết hạn, sai công ty, hỏng định dạng.
pub fn verify_state(
    secret: &str,
    state: &str,
    now_ms: i64,
    multi_tenant: bool,
    current_company: Option<i32>,
) -> Option<i32> {
    let mut parts = state.split('.');
    let (body, sig, extra) = (parts.next()?, parts.next()?, parts.next());
    if body.is_empty() || sig.is_empty() || extra.is_some() {
        return None;
    }
    let want = URL_SAFE_NO_PAD.encode(mac(&key(secret), body.as_bytes()));
    // So hằng thời gian; khác độ dài thì loại ngay (độ dài chữ ký không phải bí mật).
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
    if !company_matches(c.get("c"), multi_tenant, current_company) {
        return None;
    }
    // Id người dùng là số nguyên int4.
    (u.fract() == 0.0 && u >= 1.0 && u <= f64::from(i32::MAX)).then_some(u as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn ky_va_kiem() {
        let s = sign_state("bi-mat", 42, None, NOW);
        assert_eq!(verify_state("bi-mat", &s, NOW, false, None), Some(42));
        assert_eq!(verify_state("bi-mat", &s, NOW + 599_000, false, None), Some(42));
        assert_eq!(
            verify_state("bi-mat", &s, NOW + 601_000, false, None),
            None,
            "hết hạn sau 10 phút"
        );
        assert_eq!(verify_state("khac", &s, NOW, false, None), None, "sai khoá");
        let (b, m) = s.split_once('.').unwrap();
        assert_eq!(verify_state("bi-mat", &format!("{b}.{}x", m), NOW, false, None), None);
        assert_eq!(
            verify_state("bi-mat", &format!("{b}.{m}.extra"), NOW, false, None),
            None
        );
        assert_eq!(verify_state("bi-mat", "khong.hop.le", NOW, false, None), None);
        assert_eq!(verify_state("bi-mat", "", NOW, false, None), None);
        // Sửa thân (đổi người dùng) làm chữ ký sai.
        let forged = URL_SAFE_NO_PAD.encode(r#"{"u":1,"e":9999999999}"#);
        assert_eq!(verify_state("bi-mat", &format!("{forged}.{m}"), NOW, false, None), None);
    }

    #[test]
    fn rang_buoc_cong_ty() {
        let s = sign_state("k", 7, Some(3), NOW);
        assert_eq!(verify_state("k", &s, NOW, true, Some(3)), Some(7));
        assert_eq!(
            verify_state("k", &s, NOW, true, Some(1)),
            None,
            "callback rơi về công ty 1"
        );
        assert_eq!(verify_state("k", &s, NOW, true, None), None);
        assert_eq!(
            verify_state("k", &s, NOW, false, None),
            Some(7),
            "một công ty: bỏ qua claim"
        );
        // State cũ không có claim: chỉ công ty 1.
        let old = sign_state("k", 7, None, NOW);
        assert_eq!(verify_state("k", &old, NOW, true, Some(1)), Some(7));
        assert_eq!(verify_state("k", &old, NOW, true, Some(2)), None);
    }

    #[test]
    fn khoa_giong_ban_node() {
        // Vector tính bằng Node: createHmac('sha256','trinity-facebook-oauth-state-v1').update('bi-mat').digest('hex').
        assert_eq!(
            hex(&key("bi-mat")),
            "20a5b09555b71e7fdf1d6678b0655b719cc1f1b3ab14c43bf2ff81f3c116a9d4"
        );
        // Và `state` ký bằng Node cho người 42, hết hạn sau 10 phút kể từ NOW: Rust ký ra đúng cùng chuỗi và kiểm được nó.
        let node = "eyJ1Ijo0MiwiZSI6MTgwMDAwMDYwMH0.SAz8y3ZzbnM_QXA_fAg01cHXQ9eHlTsj2BLhKwJHX7Y";
        assert_eq!(sign_state("bi-mat", 42, None, NOW), node);
        assert_eq!(verify_state("bi-mat", node, NOW, false, None), Some(42));
        let none: Env = std::sync::Arc::new(|_| None);
        assert!(jwt_secret(&none).is_err());
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
