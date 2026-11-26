use serde_json::json;

use super::*;
use crate::sync;

const K: Key = (1, 7);

fn msg(kind: &str, company: i32, fields: Value) -> Message {
    Message {
        kind: kind.into(),
        company,
        fields,
    }
}

#[test]
fn blacklist_het_han_sau_15_phut_va_theo_cong_ty() {
    let mut s = State::default();
    s.apply_token(K, true, 1_000);
    assert!(s.is_blacklisted(K, 1_000 + TOKEN_TTL_MS));
    assert!(!s.is_blacklisted((2, 7), 1_000), "user id lặp giữa các công ty");
    assert!(!s.is_blacklisted(K, 1_000 + TOKEN_TTL_MS + 1));
}

#[test]
fn tin_cu_khong_ghi_de_thay_doi_moi_va_dau_mo() {
    let mut s = State::default();
    s.apply_token(K, false, 2_000); // unblock mới
    s.apply_token(K, true, 1_000); // block cũ đến muộn
    assert!(!s.is_blacklisted(K, 2_001));
    s.apply_session(K, Some("b".into()), 2_000);
    s.apply_session(K, Some("a".into()), 1_000);
    assert!(s.is_current_session(K, Some("b")) && !s.is_current_session(K, Some("a")));
    s.apply_session(K, None, 3_000);
    s.apply_session(K, Some("c".into()), 2_500);
    assert!(
        s.is_current_session(K, Some("zzz")),
        "đã gỡ ⇒ không còn phiên theo dõi (fail-open)"
    );
}

#[test]
fn phien_fail_open_khi_thieu_sid_hoac_chua_theo_doi() {
    let mut s = State::default();
    assert!(s.is_current_session(K, Some("x")));
    s.apply_session(K, Some("cur".into()), 1);
    assert!(s.is_current_session(K, None));
    assert!(!s.is_current_session(K, Some("khac")));
}

#[test]
fn xu_ly_tin_notify_theo_hop_dong() {
    let mut s = State::default();
    s.handle(&msg("token", 3, json!({ "op": "block", "u": 7, "t": 5_000 })));
    assert!(s.is_blacklisted((3, 7), 5_001));
    s.handle(&msg("token", 3, json!({ "op": "unblock", "u": 7, "t": 6_000 })));
    assert!(!s.is_blacklisted((3, 7), 6_001));
    s.handle(&msg("session", 1, json!({ "op": "start", "u": 7, "s": "abc", "t": 1 })));
    assert!(!s.is_current_session(K, Some("x")));
    s.handle(&msg("session", 1, json!({ "op": "clear", "u": 7, "t": 2 })));
    assert!(s.is_current_session(K, Some("x")));
    // Thiếu trường / kind lạ: bỏ.
    s.handle(&msg("token", 1, json!({ "op": "block" })));
    s.handle(&msg("cache", 1, json!({ "p": "x:" })));
    s.handle(&msg("session", 1, json!({ "op": "start", "u": 8, "t": 1 })));
    assert!(!s.is_blacklisted((1, 8), 2));
}

#[test]
fn nap_lai_tu_bang_dong_moi_hon_thang_va_muc_da_go_bi_bo() {
    let mut s = State::default();
    s.apply_token((1, 1), true, 1_000); // đã gỡ ở nơi khác, bảng không còn, đủ cũ
    s.apply_token((1, 2), true, 100_000); // vừa áp, bảng chưa kịp thấy: giữ
    s.reconcile_blocks(1, &[(3, 900_000, 500_000)], 100_100);
    assert!(!s.is_blacklisted((1, 1), 100_100));
    assert!(s.is_blacklisted((1, 2), 100_100));
    assert!(s.is_blacklisted((1, 3), 100_100));
    s.apply_session((1, 1), Some("cũ".into()), 1_000);
    s.reconcile_sessions(1, &[(2, "mới".into(), 50_000)], 100_100);
    assert!(s.is_current_session((1, 1), Some("x")), "phiên đã gỡ ở nơi khác");
    assert!(!s.is_current_session((1, 2), Some("x")));
}

#[test]
fn envelope_va_parse_bo_qua_tin_cua_minh_va_phien_ban_la() {
    let p = sync::envelope("rust-1-a", "token", 2, json!({ "op": "block", "u": 7, "t": 1 })).unwrap();
    assert!(p.contains("\"v\":1") && p.contains("\"k\":\"token\""));
    assert!(sync::parse(&p, "rust-1-a").is_none());
    let m = sync::parse(&p, "node-9-b").unwrap();
    assert_eq!((m.kind.as_str(), m.company), ("token", 2));
    assert!(sync::parse(r#"{"v":2,"o":"x","k":"token"}"#, "y").is_none());
    assert!(sync::parse("không phải json", "y").is_none());
    assert_eq!(
        sync::parse(r#"{"v":1,"o":"x","k":"token","c":0}"#, "y")
            .unwrap()
            .company,
        0
    );
    assert!(sync::envelope("o", "k", 1, json!({ "x": "a".repeat(8000) })).is_none());
}

#[test]
fn cong_tat_dong_bo() {
    let env = |k: &str| (k == "TRINITY_SYNC").then(|| "off".to_owned());
    assert!(sync::disabled(env));
    assert!(sync::disabled(
        |k| (k == "TRINITY_RUNTIME").then(|| "serverless".to_owned())
    ));
    assert!(!sync::disabled(|_| None));
}

#[test]
fn sid_rong_la_fail_open_va_tin_khong_cong_ty_bi_bo() {
    let mut s = State::default();
    s.apply_session(K, Some("cur".into()), 1);
    assert!(s.is_current_session(K, Some("")));
    s.handle(&msg("token", 0, json!({ "op": "block", "u": 7, "t": 5_000 })));
    assert!(!s.is_blacklisted((0, 7), 5_001) && !s.is_blacklisted((1, 7), 5_001));
}

#[test]
fn tra_blacklist_xoa_muc_het_han_tai_cho() {
    let mut s = State::default();
    for u in 0..1000 {
        s.apply_token((1, u), true, 0);
    }
    // Lần tra đầu quá 60 giây kể từ lần dọn cuối ⇒ dọn cả bảng: không còn mục hết hạn nào.
    assert!(!s.is_blacklisted((1, 5), TOKEN_TTL_MS + 1));
    assert!(s.blocks.is_empty());
}

#[test]
fn tra_blacklist_duoi_60_giay_chi_xoa_dung_muc_vua_tra() {
    let mut s = State::default();
    let t0 = TOKEN_TTL_MS + 1;
    assert!(!s.is_blacklisted((1, 0), t0)); // đặt mốc dọn
    for u in 0..10 {
        s.apply_token((1, u), true, 0); // hết hạn từ trước t0
    }
    // 30 giây sau mốc dọn: không quét cả bảng, chỉ xoá mục được tra.
    assert!(!s.is_blacklisted((1, 3), t0 + 30_000));
    assert_eq!(s.blocks.len(), 9);
    // Mục chưa hết hạn vẫn bị chặn.
    s.apply_token((1, 99), true, t0);
    assert!(s.is_blacklisted((1, 99), t0 + 30_000));
}
