//! K30 — kích thước + định dạng đầu ra khớp bản Node (sharp) trên 11 ảnh mẫu (gồm ảnh có EXIF Orientation 3/6/8, PNG
//! có alpha, PNG 4 ô màu kiểm vùng cắt, JPEG hồ sơ màu Display P3), và màu RGBA tại 5 điểm lệch không quá [`TOLERANCE`].
//! Bảng: `server/contracts/cases/images.json` (sinh bằng chính chuỗi sharp của bản Node ở
//! `services/crm/src/common/helpers/__tests__/docgen-image-golden.spec.ts`).

use std::path::PathBuf;

use image::ImageFormat;
use serde_json::Value;
use trinity_docgen::image::{Encoded, UPLOAD_MAX_PX, avatar_jpeg, fit_inside, newsfeed_webp};

fn root() -> PathBuf {
    PathBuf::from(manifest_dir()).join("../../..")
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

/// Lệch màu tối đa mỗi kênh so với sharp: hai bộ lọc thu nhỏ và hai bộ nén có mất dữ liệu khác nhau.
const TOLERANCE: i32 = 10;

/// Đọc lại đầu ra bằng bộ giải mã độc lập với lời khai của hàm: định dạng theo nội dung, kích thước thật.
fn check(out: &Encoded, want: &Value, label: &str) {
    check_with(out, want, label, true);
}

/// `samples`: so cả màu tại các điểm mẫu (chỉ khi kích thước đầu ra giữ nguyên như bản Node).
fn check_with(out: &Encoded, want: &Value, label: &str, samples: bool) {
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
    if !samples {
        return;
    }
    let rgba = decoded.to_rgba8();
    for s in want["samples"].as_array().unwrap() {
        let (x, y) = (s["x"].as_u64().unwrap() as u32, s["y"].as_u64().unwrap() as u32);
        let got = rgba.get_pixel(x, y).0;
        let exp: Vec<i32> = s["rgba"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap() as i32)
            .collect();
        let worst = got
            .iter()
            .zip(&exp)
            .map(|(g, e)| (i32::from(*g) - e).abs())
            .max()
            .unwrap();
        assert!(worst <= TOLERANCE, "{label} @({x},{y}): Rust {got:?} ≠ sharp {exp:?}");
    }
}

#[test]
fn muoi_anh_mau_khop_ban_node() {
    let golden: Value =
        serde_json::from_str(&std::fs::read_to_string(root().join("server/contracts/cases/images.json")).unwrap())
            .unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 11);
    let dir = PathBuf::from(manifest_dir()).join("tests/fixtures/images");
    for c in cases {
        let file = c["file"].as_str().unwrap();
        let bytes = std::fs::read(dir.join(file)).unwrap();
        check(&avatar_jpeg(&bytes).unwrap(), &c["avatar"], &format!("{file} avatar"));
        // Bảng tin nay thu về tối đa UPLOAD_MAX_PX (1600) thay vì 1920 của bản Node: kích thước tính lại từ kích thước
        // bản Node (cạnh dài 1920 ⇒ 1600); ảnh vốn ≤ 1600 thì vẫn so cả màu như cũ.
        let mut want = c["newsfeed"].clone();
        let (w, h) = (
            want["width"].as_u64().unwrap() as u32,
            want["height"].as_u64().unwrap() as u32,
        );
        let scaled = w.max(h) > UPLOAD_MAX_PX;
        if scaled {
            let src = trinity_docgen::image::decode(&bytes).unwrap();
            let (nw, nh) = fit_inside(src.width(), src.height(), UPLOAD_MAX_PX);
            want["width"] = nw.into();
            want["height"] = nh.into();
        }
        check_with(
            &newsfeed_webp(&bytes).unwrap(),
            &want,
            &format!("{file} bảng tin"),
            !scaled,
        );
    }
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
