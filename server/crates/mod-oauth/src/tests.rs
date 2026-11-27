use super::*;
use crate::crypto::*;

#[test]
fn tien_to_cong_ty_cua_bi_mat() {
    assert_eq!(company_token_prefix(1), "");
    assert_eq!(company_token_prefix(7), "c7.");
    assert_eq!(company_id_of_token("trn_at_x"), 1);
    assert_eq!(company_id_of_token("c7.trn_at_x"), 7);
    assert_eq!(company_id_of_token("c07.x"), 1);
    assert_eq!(company_id_of_token("c7."), 1);
    assert_eq!(company_id_of_token("c12345678901.x"), 1);
    assert_eq!(company_id_of_token("cx.x"), 1);
}

#[test]
fn pkce_rfc7636() {
    // Ví dụ của RFC 7636 phụ lục B.
    assert_eq!(
        pkce_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    assert!(is_code_verifier(&"a".repeat(43)));
    assert!(!is_code_verifier(&"a".repeat(42)));
    assert!(!is_code_verifier(&"a".repeat(129)));
    assert!(!is_code_verifier(&format!("{} ", "a".repeat(43))));
    assert!(is_code_challenge(&"A".repeat(43)));
    assert!(!is_code_challenge(&"A".repeat(44)));
    assert!(!is_code_challenge(&format!("{}=", "A".repeat(42))));
}

#[test]
fn consent_ky_va_kiem() {
    let now = 1_000_000_000_000_i64;
    let t = sign_consent("bi-mat", 7, 1, "abc", now / 1000 + 600);
    let c = verify_consent("bi-mat", &t, now).expect("hợp lệ");
    assert_eq!((c.u, c.c, c.h.as_str()), (7.0, Some(1.0), "abc"));
    // Sai khoá, hết hạn, giả mạo, thừa/thiếu phần.
    assert!(verify_consent("khac", &t, now).is_none());
    assert!(verify_consent("bi-mat", &t, now + 601_000).is_none());
    assert!(verify_consent("bi-mat", &format!("{t}x"), now).is_none());
    assert!(verify_consent("bi-mat", &format!("{t}.x"), now).is_none());
    assert!(verify_consent("bi-mat", "chi-mot-phan", now).is_none());
    assert!(verify_consent("bi-mat", ".", now).is_none());
    // Khoá KHÔNG cắt khoảng trắng: " bi-mat " là khoá khác.
    assert!(verify_consent(" bi-mat ", &t, now).is_none());
    // Token do bản Node ký (cùng JSON.stringify, cùng khoá dẫn xuất) phải xác minh được: dựng đúng byte như TS.
    let body = "eyJ1Ijo3LCJjIjoxLCJoIjoiYWJjIiwiZSI6MTAwMDAwMDYwMH0";
    assert_eq!(t.split('.').next().unwrap(), body);
}

#[test]
fn so_sanh_hang_thoi_gian() {
    assert!(safe_equal("a", "a"));
    assert!(!safe_equal("a", "b"));
    assert!(!safe_equal("a", "aa"));
    assert_eq!(
        sha256_hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
