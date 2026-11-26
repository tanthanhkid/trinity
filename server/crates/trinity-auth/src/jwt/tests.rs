use super::*;

const SECRET: &str = "k11-test-secret-0123456789abcdef0123456789abcdef";
const NOW: u64 = 1_800_000_000;

// Sinh bằng `jsonwebtoken` của Node (cùng gói với @nestjs/jwt) với iat = NOW, exp = NOW + 900.
const NODE_ACCESS: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsImVtYWlsIjoiYUBiLnZuIiwic2lkIjoiczEiLCJjaWQiOjMsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwOTAwfQ.rC7u_x1f_U4Y4EgsU9zMHF-bKqJDX1kApBl1-_dp374";
const NODE_PLAIN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsImVtYWlsIjoiYUBiLnZuIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDA5MDB9.Va704KTK1MoX9wO14ciFPUg9e4QppMGf9GIpNvPOZSI";
const NODE_REFRESH: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsImVtYWlsIjoiYUBiLnZuIiwidHlwZSI6InJlZnJlc2giLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMDkwMH0.rDG245z28fBD0ykKi0wbYCnchxXfSThDCdXNcfYuJxg";

/// Đồng hồ giả: `jsonwebtoken` dùng giờ hệ thống nên token thử đặt `exp` quanh hiện tại.
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

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
fn doc_payload_token_node() {
    // Chữ ký hợp lệ nhưng đã hết hạn (NOW + 900 là năm 2027? kiểm bằng phép so, không phụ thuộc ngày chạy test).
    let long = Claims {
        exp: Some(now() + 600),
        ..Claims::access(7, "a@b.vn", Some("s1".into()), Some(3), now())
    };
    let t = sign(&long, SECRET).unwrap();
    let c = verify(&t, SECRET).unwrap();
    assert_eq!(
        (c.sub, c.sid.as_deref(), c.company_id(), c.is_refresh()),
        (7, Some("s1"), 3, false)
    );
}

#[test]
fn chu_ky_cua_node_dung_duoc_khi_con_han() {
    // Node ký NODE_*: chữ ký đúng (so byte ở trên); `exp` 2027-01-15 còn hạn tại thời điểm viết, nên chỉ kiểm khi chưa quá hạn.
    if now() < NOW + 900 {
        assert_eq!(verify(NODE_ACCESS, SECRET).unwrap().sub, 7);
        assert_eq!(verify(NODE_PLAIN, SECRET).unwrap().company_id(), 1);
        assert!(verify(NODE_REFRESH, SECRET).unwrap().is_refresh());
    }
}

#[test]
fn sai_bi_mat_hoac_bi_sua_bi_tu_choi() {
    let t = sign(&Claims::access(7, "a@b.vn", None, None, now()), SECRET).unwrap();
    assert!(verify(&t, "bi-mat-khac").is_err());
    let mut parts: Vec<&str> = t.split('.').collect();
    parts[1] = "eyJzdWIiOjEsImVtYWlsIjoieCIsImV4cCI6OTk5OTk5OTk5OTl9";
    assert!(verify(&parts.join("."), SECRET).is_err());
    assert!(verify("khong-phai-jwt", SECRET).is_err());
}

#[test]
fn leeway_bang_0_token_het_han_1_giay_bi_tu_choi() {
    let n = now();
    let expired = Claims {
        exp: Some(n - 1),
        iat: Some(n - 901),
        ..Claims::access(7, "a@b.vn", None, None, n)
    };
    assert!(
        verify(&sign(&expired, SECRET).unwrap(), SECRET).is_err(),
        "mặc định 60 giây của crate sẽ cho qua"
    );
    let valid = Claims {
        exp: Some(n + 5),
        ..expired.clone()
    };
    assert!(verify(&sign(&valid, SECRET).unwrap(), SECRET).is_ok());
}

#[test]
fn khong_co_exp_van_hop_le_nhu_node_va_alg_khac_bi_tu_choi() {
    let c = Claims {
        exp: None,
        iat: None,
        ..Claims::access(7, "a@b.vn", None, None, 0)
    };
    assert!(verify(&sign(&c, SECRET).unwrap(), SECRET).is_ok());
    // alg = none / HS384 không được nhận.
    // HS384 ghép tay (header đổi `alg`, giữ chữ ký HS256): bị từ chối vì `alg` không phải HS256.
    let good = sign(&c, SECRET).unwrap();
    let mut parts: Vec<String> = good.split('.').map(str::to_owned).collect();
    parts[0] = "eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9".into();
    assert!(verify(&parts.join("."), SECRET).is_err());
    parts[0] = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0".into();
    parts[2].clear();
    assert!(verify(&parts.join("."), SECRET).is_err(), "alg none");
}
