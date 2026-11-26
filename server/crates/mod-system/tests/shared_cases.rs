//! Bảng ca dùng chung TS ↔ Rust (K27): `contracts/cases/telemetry.json` do `services/crm/src/telemetry/telemetry-cases.spec.ts`
//! sinh từ `buildTelemetryConfig` của bản TS. Rust chạy cùng đầu vào và so từng ca (so JSON theo giá trị, số nguyên không `.0`).

use std::collections::BTreeMap;

use mod_system::SystemConfig;
use serde_json::Value;

const CASES: &str = include_str!("../../../contracts/cases/telemetry.json");

#[test]
fn telemetry_config_khop_ban_ts() {
    let table: Value = serde_json::from_str(CASES).unwrap();
    let base: BTreeMap<String, String> = serde_json::from_value(table["base"].clone()).unwrap();
    let cases = table["cases"].as_array().unwrap();
    assert!(cases.len() >= 19, "bảng ca bị cắt");
    for (i, c) in cases.iter().enumerate() {
        let mut env = base.clone();
        let extra: BTreeMap<String, String> = serde_json::from_value(c["env"].clone()).unwrap();
        env.extend(extra);
        let cfg = SystemConfig::from_lookup(|k| env.get(k).cloned());
        // So chuỗi JSON để bắt cả lệch `1` và `1.0`.
        let got = serde_json::to_string(cfg.telemetry()).unwrap();
        let want = serde_json::to_string(&c["out"]).unwrap();
        // Khoá object của serde_json (không `preserve_order`) sắp theo bảng chữ cái ở cả hai vế vì cùng đi qua `Value`.
        assert_eq!(got, want, "ca #{i}: env {:?}", c["env"]);
    }
}
