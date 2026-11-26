//! Xử lý ảnh tải lên (K30) — thay `sharp` ở 3 chỗ của bản Node, cùng kích thước và định dạng đầu ra:
//! - [`avatar_jpeg`]: avatar người dùng (`auth.service.ts`) và ảnh nhân viên (`employees.service.ts`) —
//!   `sharp(buf).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 })`;
//! - [`newsfeed_webp`]: ảnh bảng tin (`newsfeed.service.ts`) —
//!   `sharp(path).resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 })`.
//!
//! Như sharp mặc định: KHÔNG tự xoay theo EXIF Orientation (bản Node không gọi `.rotate()`), không giữ siêu dữ liệu
//! (EXIF, ICC) ở đầu ra, GIF/WebP động chỉ lấy khung đầu, JPEG có kênh alpha được trải lên nền đen.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader, Limits, RgbImage};

/// Cạnh avatar (vuông).
pub const AVATAR_SIZE: u32 = 200;
/// Cạnh dài tối đa của ảnh bảng tin.
pub const NEWSFEED_MAX_PX: u32 = 1920;
/// Chất lượng nén JPEG/WebP (như `quality: 80` của bản Node).
pub const QUALITY: u8 = 80;
/// Cạnh tối đa của ảnh đầu vào (sharp: `limitInputPixels` ≈ 16383²).
pub const MAX_INPUT_SIDE: u32 = 16_383;
/// Bộ nhớ tối đa để giải mã một ảnh (chặn "bom" giải nén trên máy nhỏ).
pub const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    /// Không phải ảnh, định dạng không hỗ trợ, tệp hỏng hoặc quá lớn — tầng HTTP trả 400 như bản Node.
    #[error("tệp không phải ảnh hợp lệ: {0}")]
    NotImage(String),
    #[error("mã hoá ảnh lỗi: {0}")]
    Encode(String),
}

/// Ảnh đầu ra: byte, kích thước, định dạng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
}

impl Encoded {
    /// Content-Type để lưu kho.
    pub fn content_type(&self) -> &'static str {
        match self.format {
            ImageFormat::WebP => "image/webp",
            _ => "image/jpeg",
        }
    }
}

/// Giải mã ảnh JPEG/PNG/WebP/GIF theo nội dung (không tin đuôi tệp hay mimetype client khai).
pub fn decode(bytes: &[u8]) -> Result<DynamicImage, ImageError> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_SIDE);
    limits.max_image_height = Some(MAX_INPUT_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| ImageError::NotImage(e.to_string()))?;
    match reader.format() {
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif) => {}
        Some(f) => return Err(ImageError::NotImage(format!("định dạng {f:?} không hỗ trợ"))),
        None => return Err(ImageError::NotImage("không nhận ra định dạng".to_owned())),
    }
    reader.limits(limits);
    reader.decode().map_err(|e| ImageError::NotImage(e.to_string()))
}

/// RGB trải trên nền đen (như sharp khi xuất JPEG từ ảnh có alpha).
fn flatten_black(img: &DynamicImage) -> RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u16::from(p[3]);
        for i in 0..3 {
            o[i] = ((u16::from(p[i]) * a + 127) / 255) as u8;
        }
    }
    out
}

fn jpeg(img: &RgbImage) -> Result<Vec<u8>, ImageError> {
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, QUALITY)
        .encode_image(img)
        .map_err(|e| ImageError::Encode(e.to_string()))?;
    Ok(buf)
}

/// Avatar 200×200 JPEG: thu/phóng để phủ kín khung rồi cắt giữa (`fit: 'cover'`, ảnh nhỏ hơn cũng được phóng to).
pub fn avatar_jpeg(bytes: &[u8]) -> Result<Encoded, ImageError> {
    let img = decode(bytes)?;
    let out = img.resize_to_fill(AVATAR_SIZE, AVATAR_SIZE, FilterType::Lanczos3);
    let rgb = flatten_black(&out);
    Ok(Encoded {
        bytes: jpeg(&rgb)?,
        width: rgb.width(),
        height: rgb.height(),
        format: ImageFormat::Jpeg,
    })
}

/// Kích thước sau `fit: 'inside', withoutEnlargement: true` trong khung `max`×`max`: cạnh dài về `max`, cạnh còn lại
/// làm tròn (đo bằng sharp 0.35: 2560×1441 ⇒ 1920×1081, 5000×7 ⇒ 1920×3), không phóng to ảnh nhỏ hơn.
pub fn fit_inside(width: u32, height: u32, max: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max {
        return (width, height);
    }
    let scale = f64::from(max) / f64::from(long);
    let side = |d: u32| {
        if d == long {
            max
        } else {
            ((f64::from(d) * scale).round() as u32).max(1)
        }
    };
    (side(width), side(height))
}

/// Ảnh bảng tin: cạnh dài tối đa 1920 (không phóng to), WebP có mất dữ liệu chất lượng 80; giữ kênh alpha.
pub fn newsfeed_webp(bytes: &[u8]) -> Result<Encoded, ImageError> {
    let img = decode(bytes)?;
    let (w, h) = fit_inside(img.width(), img.height(), NEWSFEED_MAX_PX);
    let img = if (w, h) == (img.width(), img.height()) {
        img
    } else {
        img.resize_exact(w, h, FilterType::Lanczos3)
    };
    let mem = if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        webp::Encoder::from_rgba(rgba.as_raw(), w, h).encode(f32::from(QUALITY))
    } else {
        let rgb = img.to_rgb8();
        webp::Encoder::from_rgb(rgb.as_raw(), w, h).encode(f32::from(QUALITY))
    };
    if mem.is_empty() {
        return Err(ImageError::Encode("libwebp không mã hoá được".to_owned()));
    }
    Ok(Encoded {
        bytes: mem.to_vec(),
        width: w,
        height: h,
        format: ImageFormat::WebP,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kich_thuoc_inside_khop_sharp() {
        for ((w, h), want) in [
            ((3000, 1999), (1920, 1279)),
            ((1999, 3000), (1279, 1920)),
            ((2001, 2001), (1920, 1920)),
            ((1921, 1000), (1920, 999)),
            ((5000, 7), (1920, 3)),
            ((7, 5000), (3, 1920)),
            ((3333, 2222), (1920, 1280)),
            ((2560, 1441), (1920, 1081)),
            ((1920, 1081), (1920, 1081)),
            ((4033, 3025), (1920, 1440)),
            ((640, 480), (640, 480)),
        ] {
            assert_eq!(fit_inside(w, h, NEWSFEED_MAX_PX), want, "{w}×{h}");
        }
    }

    #[test]
    fn khong_phai_anh() {
        assert!(matches!(avatar_jpeg(b"khong phai anh"), Err(ImageError::NotImage(_))));
        assert!(matches!(newsfeed_webp(b"%PDF-1.7"), Err(ImageError::NotImage(_))));
    }
}
