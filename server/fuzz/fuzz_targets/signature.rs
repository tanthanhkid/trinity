//! Bộ kiểm chữ ký webhook vào (`X-Trinity-Signature: t=..,v1=..`).
//! Bất biến: (1) header bất kỳ không làm panic; (2) chữ ký do chính ta ký luôn qua; (3) đổi một byte thân thì trượt.
#![no_main]

use libfuzzer_sys::fuzz_target;
use trinity_integrations::webhooks::signature::{
    SIGNATURE_TOLERANCE_SEC, build_signature_header, verify_signature_header,
};

fuzz_target!(|input: (String, Option<String>, Vec<u8>, i64)| {
    let (secret, header, body, now_ms) = input;
    let _ = verify_signature_header(&secret, &body, header.as_deref(), SIGNATURE_TOLERANCE_SEC, now_ms);

    // `t` chỉ nhận tối đa 12 chữ số thập phân không dấu: giữ thời điểm ký trong miền đó.
    let now_ms = now_ms.rem_euclid(1_000_000_000_000_000);
    let signed = build_signature_header(&secret, &body, now_ms);
    assert!(
        verify_signature_header(&secret, &body, Some(&signed), SIGNATURE_TOLERANCE_SEC, now_ms),
        "chữ ký tự ký bị từ chối"
    );
    let mut tampered = body.clone();
    tampered.push(0);
    assert!(
        !verify_signature_header(&secret, &tampered, Some(&signed), SIGNATURE_TOLERANCE_SEC, now_ms),
        "thân bị sửa vẫn qua"
    );
});
