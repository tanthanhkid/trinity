//! Ca render Handlebars dùng chung TS ↔ Rust: `server/contracts/cases/notify-templates.json` (kết quả của handlebars.js với
//! `knownHelpersOnly`, sinh bởi `services/notification/src/templates/__tests__/render-cases.spec.ts`).

use mod_notify::templates::{check_syntax, render_source};
use serde_json::Value;

fn cases() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/cases/notify-templates.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("đọc notify-templates.json")).expect("JSON hợp lệ")
}

#[test]
fn render_giong_handlebars_js() {
    let c = cases();
    let data = &c["data"];
    let mut bad = Vec::new();
    let list = c["render"].as_array().unwrap();
    for r in list {
        let t = r["template"].as_str().unwrap();
        // `rust_err`: lệch có chủ đích đã ghi (section `{{#ten}}` không hỗ trợ): Rust phải lỗi.
        let want = if r["rust_err"] == true { None } else { r["ok"].as_str() };
        match (render_source(t, data), want) {
            (Ok(got), Some(w)) if got == w => {}
            (Ok(got), Some(w)) => bad.push(format!("{t:?}\n  node: {w:?}\n  rust: {got:?}")),
            (Err(_), None) => {} // cả hai đều lỗi
            (Ok(got), None) => bad.push(format!("{t:?}\n  node lỗi, rust: {got:?}")),
            (Err(e), Some(w)) => bad.push(format!("{t:?}\n  node: {w:?}\n  rust lỗi: {e:?}")),
        }
    }
    assert!(
        bad.is_empty(),
        "{} / {} ca lệch:\n{}",
        bad.len(),
        list.len(),
        bad.join("\n")
    );
}

#[test]
fn kiem_cu_phap_khi_luu_giong_node() {
    let c = cases();
    let mut bad = Vec::new();
    for r in c["syntax"].as_array().unwrap() {
        let t = r["template"].as_str().unwrap();
        // `rust`: lệch có chủ đích (section bị từ chối khi lưu).
        let node_ok = r["rust"].as_bool().unwrap_or_else(|| r["ok"].as_bool().unwrap());
        let rust_ok = check_syntax(&[Some(t)]).is_ok();
        if node_ok != rust_ok {
            bad.push(format!("{t:?}: node ok={node_ok}, rust ok={rust_ok}"));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
