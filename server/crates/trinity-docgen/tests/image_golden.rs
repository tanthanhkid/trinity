//! K30 — kích thước + định dạng đầu ra khớp bản Node (sharp) trên 10 ảnh mẫu, gồm ảnh có EXIF Orientation 3/6/8.
//! Bảng: `server/contracts/cases/images.json` (sinh bằng chính chuỗi sharp của bản Node ở
//! `services/crm/src/common/helpers/__tests__/docgen-image-golden.spec.ts`).

use std::path::PathBuf;

use image::ImageFormat;
use serde_json::Value;
use trinity_docgen::image::{Encoded, avatar_jpeg, newsfeed_webp};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn format_name(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::WebP => "webp",
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        _ => "khác",
    }
}

/// Đọc lại đầu ra bằng bộ giải mã độc lập với lời khai của hàm: định dạng theo nội dung, kích thước thật.
fn check(out: &Encoded, want: &Value, label: &str) {
    let fmt = image::guess_format(&out.bytes).unwrap();
    let decoded = image::load_from_memory(&out.bytes).unwrap();
    let got = (decoded.width(), decoded.height(), format_name(fmt));
    let exp = (
        want["width"].as_u64().unwrap() as u32,
        want["height"].as_u64().unwrap() as u32,
        want["format"].as_str().unwrap(),
    );
    assert_eq!(got, exp, "{label}");
    assert_eq!(
        (out.width, out.height, format_name(out.format)),
        exp,
        "{label}: kích thước khai báo"
    );
    // Như sharp: không giữ EXIF ở đầu ra (orientation null trong bảng).
    assert!(want["orientation"].is_null());
    assert!(
        !out.bytes.windows(6).any(|w| w == b"Exif\0\0"),
        "{label}: đầu ra còn EXIF"
    );
}

#[test]
fn muoi_anh_mau_khop_ban_node() {
    let golden: Value =
        serde_json::from_str(&std::fs::read_to_string(root().join("server/contracts/cases/images.json")).unwrap())
            .unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/images");
    for c in cases {
        let file = c["file"].as_str().unwrap();
        let bytes = std::fs::read(dir.join(file)).unwrap();
        check(&avatar_jpeg(&bytes).unwrap(), &c["avatar"], &format!("{file} avatar"));
        check(
            &newsfeed_webp(&bytes).unwrap(),
            &c["newsfeed"],
            &format!("{file} bảng tin"),
        );
    }
}
