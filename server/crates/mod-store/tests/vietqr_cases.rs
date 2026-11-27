//! Bảng ca VietQR dùng chung TS ↔ Rust: `server/contracts/cases/vietqr.json` (chuỗi mong đợi do bản cài Python độc lập sinh).

use mod_store::vietqr::{VIETQR_BANKS, build, content, crc16, find_bank};
use serde_json::Value;

fn cases() -> Value {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned());
    let text = std::fs::read_to_string(format!("{dir}/../../contracts/cases/vietqr.json")).expect("đọc vietqr.json");
    serde_json::from_str(&text).expect("JSON hợp lệ")
}

#[test]
fn crc_va_mau_chuoi_qr() {
    let c = cases();
    for x in c["crc16"].as_array().unwrap() {
        assert_eq!(crc16(x["input"].as_str().unwrap()), x["crc"].as_str().unwrap());
    }
    let samples = c["samples"].as_array().unwrap();
    assert_eq!(samples.len(), 10);
    for s in samples {
        let bank = find_bank(s["bank"].as_str().unwrap()).unwrap_or_else(|| panic!("không thấy {}", s["bank"]));
        assert_eq!(bank.bin, s["bin"].as_str().unwrap());
        let qr = build(
            bank.bin,
            s["account"].as_str().unwrap(),
            s["amount"].as_i64().unwrap(),
            s["content"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(qr, s["qr"].as_str().unwrap(), "{}", s["bank"]);
    }
}

#[test]
fn bang_ngan_hang_giong_ban_ts() {
    let c = cases();
    let banks = c["banks"].as_array().unwrap();
    assert_eq!(banks.len(), VIETQR_BANKS.len());
    for (a, b) in banks.iter().zip(VIETQR_BANKS) {
        assert_eq!(a["bin"], b.bin);
        assert_eq!(a["name"], b.name);
        let al: Vec<&str> = a["aliases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(al, b.aliases);
    }
    for f in c["find_bank"].as_array().unwrap() {
        assert_eq!(
            find_bank(f["input"].as_str().unwrap()).map(|b| b.bin),
            f["bin"].as_str(),
            "{}",
            f["input"]
        );
    }
}

#[test]
fn noi_dung_va_tham_so_sai() {
    let c = cases();
    for x in c["content"].as_array().unwrap() {
        assert_eq!(content(x["input"].as_str().unwrap()), x["output"].as_str().unwrap());
    }
    for e in c["errors"].as_array().unwrap() {
        // Số tiền không nguyên (1.5) không biểu diễn được bằng i64: coi là ngoài miền ⇒ lỗi "Số tiền" như TS.
        let amount = e["amount"].as_i64().unwrap_or(0);
        let err = build(
            e["bin"].as_str().unwrap(),
            e["account"].as_str().unwrap(),
            amount,
            e["content"].as_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.contains(e["error"].as_str().unwrap()), "{err}");
    }
}
