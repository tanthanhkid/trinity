//! `parse_instant` đối chiếu `new Date()` của V8 (golden sinh bằng Node thật, `TZ=UTC`): chỉ so chuỗi mà `@IsDateString` cho qua.

use mod_hr::recruitment::parse_instant;
use serde_json::Value;

#[test]
fn doc_ngay_nhu_v8() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/dates.json")).unwrap();
    let mut checked = 0;
    for c in &cases {
        if c["valid"] != true {
            continue;
        }
        let s = c["in"].as_str().unwrap();
        let want = c["ms"].as_i64();
        let got = parse_instant(s).map(|d| d.timestamp_millis());
        assert_eq!(got, want, "{s:?}");
        checked += 1;
    }
    assert!(checked > 30, "{checked}");
    // Chuỗi V8 đọc được nhưng validator từ chối thì tầng kiểm đã chặn: không bắt buộc khớp, chỉ không được panic.
    for c in &cases {
        let _ = parse_instant(c["in"].as_str().unwrap());
    }
}
