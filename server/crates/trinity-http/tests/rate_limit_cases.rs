//! Bảng ca dùng chung TS ↔ Rust (K25): nhóm `limiter` của `server/contracts/cases/plan.json` (cột kết quả sinh từ
//! `FixedWindowLimiter` của bản TS).

use serde_json::{Value, json};
use trinity_http::rate_limit::FixedWindowLimiter;

#[test]
fn cua_so_co_dinh_khop_ban_ts() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contracts/cases/plan.json");
    let t: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("đọc plan.json")).expect("hợp lệ");
    let cases = t["limiter"].as_array().expect("nhóm limiter");
    assert!(cases.len() >= 4);
    for c in cases {
        let l = FixedWindowLimiter::new(
            u32::try_from(c["max"].as_u64().unwrap()).unwrap(),
            c["window_ms"].as_u64().unwrap(),
        );
        let got: Vec<Value> = c["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let h = l.hit(s[0].as_str().unwrap(), s[1].as_u64().unwrap());
                json!({"allowed": h.allowed, "count": h.count, "retryAfterSec": h.retry_after_sec})
            })
            .collect();
        assert_eq!(Value::Array(got), c["out"], "ca {c}");
    }
}
