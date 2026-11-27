//! Bộ đọc payload webhook vào (`parse_inbound_payload`): JSON bất kỳ thân `/webhooks/in/<token>`.
//! Bất biến: không panic; `Err` luôn có ít nhất một câu lỗi; `Ok` luôn có SĐT đã chuẩn hoá.
#![no_main]

use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use trinity_integrations::webhooks::inbound::payload::parse_inbound_payload;

fuzz_target!(|data: &[u8]| {
    let Ok(body) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    match parse_inbound_payload(&body) {
        Ok(p) => assert!(!p.phone.is_empty(), "Ok mà SĐT rỗng"),
        Err(errors) => assert!(!errors.is_empty(), "Err không có câu lỗi"),
    }
});
