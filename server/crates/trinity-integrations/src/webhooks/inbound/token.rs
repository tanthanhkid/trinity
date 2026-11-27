//! Token nguồn webhook vào: `whk_` + 32 byte ngẫu nhiên base64url (43 ký tự); chỉ lưu SHA-256 hex.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub const INBOUND_PATH_PREFIX: &str = "/api/v1/hooks/in/";

/// `^whk_[A-Za-z0-9_-]{43}$`.
pub fn is_valid_token(t: &str) -> bool {
    t.len() == 47
        && t.strip_prefix("whk_")
            .is_some_and(|r| r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

pub fn generate_token() -> String {
    format!(
        "whk_{}",
        URL_SAFE_NO_PAD.encode(crate::webhooks::secret::random::<32>())
    )
}

/// SHA-256 hex của token.
pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            use std::fmt::Write;
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// 12 ký tự đầu để nhận diện trong giao diện (KHÔNG đủ để dùng).
pub fn token_prefix(token: &str) -> String {
    token.chars().take(12).collect()
}

/// `withCompanyHint`: đường công khai không có JWT nên công ty chọn từ `?cid=`; công ty 1 và bản một công ty giữ nguyên.
pub fn with_company_hint(url: &str, multi_tenant: bool, company_id: i32) -> String {
    if !multi_tenant || company_id == 1 {
        return url.to_owned();
    }
    let (base, hash) = url.find('#').map_or((url, ""), |i| (&url[..i], &url[i..]));
    if base.contains("?cid=") || base.contains("&cid=") {
        return url.to_owned();
    }
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}cid={company_id}{hash}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_dinh_dang_va_hash() {
        let a = generate_token();
        let b = generate_token();
        assert!(is_valid_token(&a), "{a}");
        assert_ne!(a, b);
        assert_eq!(hash_token(&a).len(), 64);
        assert_ne!(hash_token(&a), hash_token(&b));
        assert_eq!(token_prefix(&a), a[..12]);
        assert!(!is_valid_token("whk_short"));
        assert!(!is_valid_token(&format!("{a}x")));
        assert!(!is_valid_token(&a.replace("whk_", "xxx_")));
        // SHA-256("abc").
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn goi_y_cong_ty() {
        let u = "/api/v1/hooks/in/whk_x";
        assert_eq!(with_company_hint(u, false, 5), u);
        assert_eq!(with_company_hint(u, true, 1), u);
        assert_eq!(with_company_hint(u, true, 5), "/api/v1/hooks/in/whk_x?cid=5");
        assert_eq!(with_company_hint("/a?x=1#h", true, 5), "/a?x=1&cid=5#h");
        assert_eq!(with_company_hint("/a?cid=9", true, 5), "/a?cid=9");
    }
}
