use super::*;

const SECRET: &str = "k11-test-secret-0123456789abcdef0123456789abcdef";
const NOW: u64 = 1_800_000_000;

// Sinh bằng `jsonwebtoken` của Node (cùng gói với @nestjs/jwt) với iat = NOW, exp = NOW + 900.
const NODE_ACCESS: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsImVtYWlsIjoiYUBiLnZuIiwic2lkIjoiczEiLCJjaWQiOjMsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwOTAwfQ.rC7u_x1f_U4Y4EgsU9zMHF-bKqJDX1kApBl1-_dp374";
const NODE_PLAIN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsImVtYWlsIjoiYUBiLnZuIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDA5MDB9.Va704KTK1MoX9wO14ciFPUg9e4QppMGf9GIpNvPOZSI";
const NODE_REFRESH: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsImVtYWlsIjoiYUBiLnZuIiwidHlwZSI6InJlZnJlc2giLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMDkwMH0.rDG245z28fBD0ykKi0wbYCnchxXfSThDCdXNcfYuJxg";

const AT: u64 = NOW + 10; // thời điểm kiểm, nằm trong hạn của token Node (NOW .. NOW + 900)

#[test]
fn payload_ky_o_rust_giong_tung_byte_token_node() {
    // Header của jsonwebtoken Rust ghi `typ` trước `alg` (Node ghi `alg` trước); Node đọc header theo khoá nên không
    // ảnh hưởng. Phần payload (thứ tự khoá, số nguyên, vắng khoá None) phải giống từng byte.
    let seg = |t: &str| t.split('.').nth(1).unwrap().to_owned();
    let c = Claims::access(7, "a@b.vn", Some("s1".into()), Some(3), NOW);
    assert_eq!(seg(&sign(&c, SECRET).unwrap()), seg(NODE_ACCESS));
    let c = Claims::access(7, "a@b.vn", None, None, NOW);
    assert_eq!(seg(&sign(&c, SECRET).unwrap()), seg(NODE_PLAIN));
}

#[test]
fn token_node_dung_duoc_voi_dong_ho_co_dinh() {
    let c = verify_at(NODE_ACCESS, SECRET, AT).unwrap();
    assert_eq!(
        (c.sub, c.sid.as_deref(), c.company_id(), c.is_refresh()),
        (7, Some("s1"), 3, false)
    );
    assert_eq!(verify_at(NODE_PLAIN, SECRET, AT).unwrap().company_id(), 1);
    assert!(verify_at(NODE_REFRESH, SECRET, AT).unwrap().is_refresh());
}

#[test]
fn sai_bi_mat_hoac_bi_sua_bi_tu_choi() {
    let t = sign(&Claims::access(7, "a@b.vn", None, None, NOW), SECRET).unwrap();
    assert!(verify_at(&t, "bi-mat-khac", AT).is_err());
    let mut parts: Vec<&str> = t.split('.').collect();
    parts[1] = "eyJzdWIiOjEsImVtYWlsIjoieCIsImV4cCI6OTk5OTk5OTk5OTl9";
    assert!(verify_at(&parts.join("."), SECRET, AT).is_err());
    assert!(verify_at("khong-phai-jwt", SECRET, AT).is_err());
}

#[test]
fn leeway_bang_0_het_han_dung_giay_exp_va_1_giay_sau_deu_bi_tu_choi() {
    // NODE_ACCESS: exp = NOW + 900. Node từ chối khi now >= exp.
    assert!(verify_at(NODE_ACCESS, SECRET, NOW + 899).is_ok());
    assert!(
        verify_at(NODE_ACCESS, SECRET, NOW + 900).is_err(),
        "exp == now bị từ chối như Node"
    );
    assert!(
        verify_at(NODE_ACCESS, SECRET, NOW + 901).is_err(),
        "mặc định 60 giây của crate sẽ cho qua"
    );
    assert!(verify_at(NODE_ACCESS, SECRET, NOW + 959).is_err());
}

#[test]
fn nbf_chua_toi_bi_tu_choi() {
    let c = Claims {
        nbf: Some(NOW + 100),
        ..Claims::access(7, "a@b.vn", None, None, NOW)
    };
    let t = sign(&c, SECRET).unwrap();
    assert!(verify_at(&t, SECRET, NOW + 99).is_err());
    assert!(verify_at(&t, SECRET, NOW + 100).is_ok());
}

#[test]
fn khong_co_exp_van_hop_le_nhu_node_va_alg_khac_bi_tu_choi() {
    let c = Claims {
        exp: None,
        iat: None,
        ..Claims::access(7, "a@b.vn", None, None, 0)
    };
    assert!(verify_at(&sign(&c, SECRET).unwrap(), SECRET, AT).is_ok());
    // HS384 ghép tay (header đổi `alg`, giữ chữ ký HS256): bị từ chối vì `alg` không phải HS256.
    let good = sign(&c, SECRET).unwrap();
    let mut parts: Vec<String> = good.split('.').map(str::to_owned).collect();
    parts[0] = "eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9".into();
    assert!(verify_at(&parts.join("."), SECRET, AT).is_err());
    parts[0] = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0".into();
    parts[2].clear();
    assert!(verify_at(&parts.join("."), SECRET, AT).is_err(), "alg none");
}
