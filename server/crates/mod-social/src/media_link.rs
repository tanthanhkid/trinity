//! Link tải tệp CÔNG KHAI có chữ ký (`social-media-link.ts`) cho mạng chỉ nhận ảnh/video qua URL (Facebook Page hiện không cần;
//! giữ cho provider sau này). Token mang key tệp, loại, hạn và công ty (`c`), ký HMAC-SHA256: không đăng nhập vẫn tải được nhưng
//! chỉ đúng tệp đó, tới hết hạn, và chỉ khi công ty trong token trùng công ty route đã chọn. Định dạng
//! `base64url(JSON {k,t,e,c}).base64url(HMAC)`, thứ tự khoá như `JSON.stringify` của Node.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Hạn link: đủ cho mạng tải tệp (video có khi vài phút), không để link sống lâu.
pub const MEDIA_LINK_TTL_SEC: i64 = 2 * 60 * 60;

type HmacSha256 = Hmac<Sha256>;

fn mac(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC nhận khoá mọi độ dài");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}

fn key(secret: &str) -> Vec<u8> {
    mac(b"trinity-social-media-link-v1", secret.as_bytes())
}

/// Nội dung đọc ra từ token hợp lệ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaLink {
    pub key: String,
    pub content_type: String,
    pub company_id: i32,
}

/// Ký link cho tệp `key` / `content_type`, công ty `company_id` (không đa công ty thì 1, như `currentCompanyId() ?? 1`).
pub fn sign_media_link(secret: &str, key_of_file: &str, content_type: &str, company_id: i32, now_ms: i64) -> String {
    let e = now_ms.div_euclid(1000) + MEDIA_LINK_TTL_SEC;
    let json = format!(
        "{{\"k\":{},\"t\":{},\"e\":{e},\"c\":{company_id}}}",
        Value::String(key_of_file.to_owned()),
        Value::String(content_type.to_owned())
    );
    let body = URL_SAFE_NO_PAD.encode(json);
    let sig = URL_SAFE_NO_PAD.encode(mac(&key(secret), body.as_bytes()));
    format!("{body}.{sig}")
}

/// Kiểm token; sai chữ ký, hết hạn, hỏng định dạng ⇒ `None`. Token cấp trước đa công ty không có `c` ⇒ công ty 1.
pub fn verify_media_link(secret: &str, token: &str, now_ms: i64) -> Option<MediaLink> {
    let mut it = token.split('.');
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
    let k = c.get("k")?.as_str()?;
    let t = c.get("t")?.as_str()?;
    let e = c.get("e")?.as_f64()?;
    if e * 1000.0 < now_ms as f64 {
        return None;
    }
    let company = match c.get("c") {
        None => 1.0,
        Some(v) => v.as_f64()?,
    };
    if !(company.fract() == 0.0 && company >= 1.0 && company <= f64::from(i32::MAX)) {
        return None;
    }
    Some(MediaLink {
        key: k.to_owned(),
        content_type: t.to_owned(),
        company_id: company as i32,
    })
}

/// Đuôi tệp theo loại — có mạng đọc loại từ URL/headers; thêm đuôi cho chắc.
pub fn media_link_ext(content_type: &str) -> &'static str {
    match content_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        _ => "bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn ky_va_kiem() {
        let t = sign_media_link("bi-mat", "social/u1_2_abc.png", "image/png", 3, NOW);
        let v = verify_media_link("bi-mat", &t, NOW + 1000).unwrap();
        assert_eq!(
            (v.key.as_str(), v.content_type.as_str(), v.company_id),
            ("social/u1_2_abc.png", "image/png", 3)
        );
        assert!(
            verify_media_link("bi-mat", &t, NOW + 2 * 3600 * 1000 + 1000).is_none(),
            "hết hạn"
        );
        assert!(verify_media_link("khac", &t, NOW).is_none(), "sai khoá");
        assert!(verify_media_link("bi-mat", &format!("{t}.x"), NOW).is_none());
        assert!(verify_media_link("bi-mat", "", NOW).is_none());
        assert!(verify_media_link("bi-mat", "a.b", NOW).is_none());
    }

    #[test]
    fn token_khong_co_cong_ty_la_cong_ty_1() {
        let body = URL_SAFE_NO_PAD.encode(r#"{"k":"social/u1_2_a.png","t":"image/png","e":1800007200}"#);
        let sig = URL_SAFE_NO_PAD.encode(mac(&key("k"), body.as_bytes()));
        let v = verify_media_link("k", &format!("{body}.{sig}"), NOW).unwrap();
        assert_eq!(v.company_id, 1);
    }

    #[test]
    fn cong_ty_sai_kieu_bi_tu_choi() {
        for c in ["0", "-1", "1.5", "\"1\"", "3000000000"] {
            let body = URL_SAFE_NO_PAD.encode(format!(r#"{{"k":"a","t":"b","e":1800007200,"c":{c}}}"#));
            let sig = URL_SAFE_NO_PAD.encode(mac(&key("k"), body.as_bytes()));
            assert!(verify_media_link("k", &format!("{body}.{sig}"), NOW).is_none(), "{c}");
        }
    }

    #[test]
    fn duoi_theo_loai() {
        assert_eq!(media_link_ext("video/quicktime"), "mov");
        assert_eq!(media_link_ext("application/pdf"), "bin");
    }
}
