//! Xử lý ảnh tải lên (K30) — thay `sharp` ở 3 chỗ của bản Node, cùng kích thước và định dạng đầu ra:
//! - [`avatar_jpeg`]: avatar người dùng (`auth.service.ts`) và ảnh nhân viên (`employees.service.ts`) —
//!   `sharp(buf).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 })`;
//! - [`newsfeed_webp`]: ảnh bảng tin (`newsfeed.service.ts`) —
//!   `sharp(path).resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 })`.
//!
//! Như sharp mặc định:
//! - xoay/lật theo EXIF Orientation trước khi cắt/thu nhỏ (như `.rotate()` của sharp, #310 — ảnh điện thoại chụp dọc
//!   không còn bị lưu nằm ngang), không giữ EXIF/ICC ở đầu ra;
//! - ảnh có hồ sơ màu ICC RGB (Display P3, Adobe RGB…) được chuyển về sRGB (moxcms);
//! - thu nhỏ trên màu đã nhân alpha (premultiplied) nên viền trong suốt không bị loang màu; JPEG từ ảnh có alpha
//!   trải trên nền đen; GIF/WebP động chỉ lấy khung đầu.
//!
//! Khác biệt còn lại (ghi nhận, không ảnh hưởng kích thước/định dạng): JPEG CMYK được `image` đổi sang RGB theo công
//! thức đơn giản, không theo hồ sơ CMYK nhúng như libvips — màu có thể lệch so với bản Node.
//!
//! Bộ nhớ: từ chối trước khi giải mã ảnh quá [`MAX_INPUT_PIXELS`] điểm ảnh (như `limitInputPixels` của sharp); khi thu
//! nhỏ, trước tiên giảm theo bậc bằng lọc trung bình vùng (số nguyên) xuống còn ≤ 2 lần đích, rồi mới lọc Lanczos3, nên
//! bộ đệm số thực của bộ lọc (≈ rộng × cao × 16 byte) chỉ tính trên ảnh đã giảm, không trên ảnh gốc.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, Pixel, RgbImage, RgbaImage};
use moxcms::{ColorProfile, DataColorSpace, Layout, TransformOptions};

/// Cạnh avatar (vuông).
pub const AVATAR_SIZE: u32 = 200;
/// Cạnh dài tối đa của mọi ảnh người dùng tải lên (bảng tin, selfie, ảnh sản phẩm, thư viện media…).
pub const UPLOAD_MAX_PX: u32 = 1600;
/// Chất lượng WebP lossy của ảnh tải lên (nén mạnh để giảm đĩa và băng thông tải ra).
pub const QUALITY: u8 = 70;
/// Chất lượng JPEG của avatar (200×200).
pub const AVATAR_QUALITY: u8 = 70;
/// Chất lượng JPEG khi bắt buộc JPEG (ảnh gửi sang Facebook/Zalo, chứng từ nhân sự).
pub const COMPAT_JPEG_QUALITY: u8 = 75;
/// Số điểm ảnh tối đa mà [`compress_upload`] chịu giải mã (40 megapixel): máy chủ chỉ có ~1 GB RAM.
pub const UPLOAD_MAX_INPUT_PIXELS: u64 = 40_000_000;
/// Số điểm ảnh tối đa của ảnh đầu vào — `limitInputPixels` mặc định của sharp (0x3FFF × 0x3FFF).
pub const MAX_INPUT_PIXELS: u64 = 268_402_689;
/// Bộ nhớ tối đa để giải mã (đủ cho ảnh RGBA 8 bit lớn nhất được nhận).
pub const MAX_DECODE_BYTES: u64 = MAX_INPUT_PIXELS * 4 + 64 * 1024 * 1024;

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

fn not_image(e: impl std::fmt::Display) -> ImageError {
    ImageError::NotImage(e.to_string())
}

fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, ImageError> {
    let r = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(not_image)?;
    match r.format() {
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif) => Ok(r),
        Some(f) => Err(ImageError::NotImage(format!("định dạng {f:?} không hỗ trợ"))),
        None => Err(ImageError::NotImage("không nhận ra định dạng".to_owned())),
    }
}

/// Giải mã ảnh JPEG/PNG/WebP/GIF theo nội dung (không tin đuôi tệp hay mimetype client khai), kiểm số điểm ảnh từ phần
/// đầu tệp TRƯỚC khi giải mã, xoay/lật theo EXIF Orientation, rồi đưa màu về sRGB theo hồ sơ ICC nhúng (nếu có).
pub fn decode(bytes: &[u8]) -> Result<DynamicImage, ImageError> {
    decode_with(bytes, MAX_INPUT_PIXELS)
}

/// Như [`decode`] nhưng với trần điểm ảnh tuỳ chọn (bộ nhớ giải mã tối đa ≈ `max_px × 4` byte + 64 MiB).
pub fn decode_with(bytes: &[u8], max_px: u64) -> Result<DynamicImage, ImageError> {
    let (w, h) = reader(bytes)?.into_dimensions().map_err(not_image)?;
    if u64::from(w) * u64::from(h) > max_px {
        return Err(ImageError::NotImage(format!(
            "ảnh {w}×{h} vượt giới hạn {max_px} điểm ảnh"
        )));
    }
    let mut dec = reader(bytes)?.into_decoder().map_err(not_image)?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(max_px * 4 + 64 * 1024 * 1024);
    dec.set_limits(limits).map_err(not_image)?;
    let icc = dec.icc_profile().ok().flatten();
    // Không đọc được orientation (EXIF hỏng) ⇒ coi như không có, không làm hỏng việc tải ảnh.
    let orientation = dec.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(dec).map_err(not_image)?;
    img.apply_orientation(orientation);
    Ok(match icc {
        Some(p) => to_srgb(img, &p),
        None => img,
    })
}

/// Chuyển ảnh RGB có hồ sơ ICC về sRGB; hồ sơ không đọc được / không phải RGB ⇒ giữ nguyên (như ảnh không có hồ sơ).
fn to_srgb(img: DynamicImage, icc: &[u8]) -> DynamicImage {
    let Ok(src) = ColorProfile::new_from_slice(icc) else {
        return img;
    };
    if src.color_space != DataColorSpace::Rgb {
        return img;
    }
    let srgb = ColorProfile::new_srgb();
    let opts = TransformOptions::default();
    if img.color().has_alpha() {
        let mut buf = img.to_rgba8();
        let Ok(t) = src.create_transform_8bit(Layout::Rgba, &srgb, Layout::Rgba, opts) else {
            return img;
        };
        let mut out = vec![0u8; buf.len()];
        if t.transform(buf.as_raw(), &mut out).is_err() {
            return img;
        }
        buf.copy_from_slice(&out);
        DynamicImage::ImageRgba8(buf)
    } else {
        let mut buf = img.to_rgb8();
        let Ok(t) = src.create_transform_8bit(Layout::Rgb, &srgb, Layout::Rgb, opts) else {
            return img;
        };
        let mut out = vec![0u8; buf.len()];
        if t.transform(buf.as_raw(), &mut out).is_err() {
            return img;
        }
        buf.copy_from_slice(&out);
        DynamicImage::ImageRgb8(buf)
    }
}

/// Nhân màu với alpha (premultiply) — tại chỗ.
fn premultiply(img: &mut RgbaImage) {
    for p in img.pixels_mut() {
        let a = u16::from(p[3]);
        for c in &mut p.channels_mut()[..3] {
            *c = ((u16::from(*c) * a + 127) / 255) as u8;
        }
    }
}

/// Chia lại cho alpha sau khi lọc.
fn unpremultiply(img: &mut RgbaImage) {
    for p in img.pixels_mut() {
        let a = u16::from(p[3]);
        if a == 0 {
            continue;
        }
        for c in &mut p.channels_mut()[..3] {
            *c = ((u16::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

/// Thu/phóng tới đúng `w`×`h`: giảm theo bậc bằng trung bình vùng tới ≤ 2 lần đích, rồi Lanczos3. Gọi qua
/// `DynamicImage` để dùng mã đã biên dịch tối ưu của crate `image`.
fn resize_dyn(src: DynamicImage, w: u32, h: u32) -> DynamicImage {
    if (src.width(), src.height()) == (w, h) {
        return src;
    }
    let src = if src.width() >= w * 4 && src.height() >= h * 4 {
        src.thumbnail_exact(w * 2, h * 2)
    } else {
        src
    };
    src.resize_exact(w, h, FilterType::Lanczos3)
}

fn resize_rgba(src: RgbaImage, w: u32, h: u32) -> RgbaImage {
    resize_dyn(DynamicImage::ImageRgba8(src), w, h).into_rgba8()
}

fn resize_rgb(src: RgbImage, w: u32, h: u32) -> RgbImage {
    resize_dyn(DynamicImage::ImageRgb8(src), w, h).into_rgb8()
}

fn jpeg(img: &RgbImage, quality: u8) -> Result<Vec<u8>, ImageError> {
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(img)
        .map_err(|e| ImageError::Encode(e.to_string()))?;
    Ok(buf)
}

/// Avatar 200×200 JPEG (`fit: 'cover'`): cắt hình vuông ở giữa ảnh gốc rồi thu/phóng đúng 200×200 (ảnh nhỏ hơn cũng
/// được phóng to); ảnh có alpha trải trên nền đen (= màu đã nhân alpha).
pub fn avatar_jpeg(bytes: &[u8]) -> Result<Encoded, ImageError> {
    let img = decode(bytes)?;
    let (w, h) = (img.width(), img.height());
    let side = w.min(h);
    let square = img.crop_imm((w - side) / 2, (h - side) / 2, side, side);
    drop(img);
    let rgb = if square.color().has_alpha() {
        let mut rgba = square.to_rgba8();
        drop(square);
        premultiply(&mut rgba);
        let small = resize_rgba(rgba, AVATAR_SIZE, AVATAR_SIZE);
        RgbImage::from_fn(AVATAR_SIZE, AVATAR_SIZE, |x, y| {
            let p = small.get_pixel(x, y);
            image::Rgb([p[0], p[1], p[2]])
        })
    } else {
        resize_rgb(square.to_rgb8(), AVATAR_SIZE, AVATAR_SIZE)
    };
    Ok(Encoded {
        bytes: jpeg(&rgb, AVATAR_QUALITY)?,
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
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

fn webp(raw: &[u8], w: u32, h: u32, alpha: bool, quality: u8) -> Result<Vec<u8>, ImageError> {
    let enc = if alpha {
        webp::Encoder::from_rgba(raw, w, h)
    } else {
        webp::Encoder::from_rgb(raw, w, h)
    };
    let mem = enc
        .encode_simple(false, f32::from(quality))
        .map_err(|e| ImageError::Encode(format!("libwebp: {e:?}")))?;
    if mem.is_empty() {
        return Err(ImageError::Encode("libwebp trả ảnh rỗng".to_owned()));
    }
    Ok(mem.to_vec())
}

/// Ảnh bảng tin: cạnh dài tối đa [`UPLOAD_MAX_PX`] (không phóng to), WebP có mất dữ liệu chất lượng [`QUALITY`]; giữ kênh alpha.
pub fn newsfeed_webp(bytes: &[u8]) -> Result<Encoded, ImageError> {
    let img = decode(bytes)?;
    let (w, h) = fit_inside(img.width(), img.height(), UPLOAD_MAX_PX);
    let out = if img.color().has_alpha() {
        let mut rgba = img.to_rgba8();
        drop(img);
        premultiply(&mut rgba);
        let mut small = resize_rgba(rgba, w, h);
        unpremultiply(&mut small);
        webp(small.as_raw(), w, h, true, QUALITY)?
    } else {
        let rgb = img.to_rgb8();
        drop(img);
        webp(resize_rgb(rgb, w, h).as_raw(), w, h, false, QUALITY)?
    };
    Ok(Encoded {
        bytes: out,
        width: w,
        height: h,
        format: ImageFormat::WebP,
    })
}

/// Định dạng đầu ra của [`compress_upload`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadFormat {
    /// WebP lossy q70, giữ alpha — mặc định cho ảnh chỉ xem trong ứng dụng.
    WebP,
    /// JPEG q75, alpha trải trên nền trắng — ảnh gửi sang Facebook/Zalo hoặc chứng từ cần định dạng phổ biến.
    Jpeg,
}

/// Kết quả [`compress_upload`]: byte để lưu, content-type và đuôi tệp khớp với byte đó.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compressed {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    /// Đuôi không có dấu chấm (`webp`, `jpg`, `png`, `gif`…).
    pub ext: &'static str,
    /// `true` khi bản nén được dùng; `false` khi giữ nguyên tệp gốc.
    pub recompressed: bool,
}

/// Loại ảnh theo magic bytes: (content-type, đuôi) của JPEG/PNG/WebP/GIF.
fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some(("image/png", "png"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else {
        None
    }
}

/// Giữ nguyên tệp gốc (content-type/đuôi theo nội dung; không nhận ra ⇒ `application/octet-stream`/`bin`).
pub fn keep_original(bytes: &[u8]) -> Compressed {
    let (content_type, ext) = sniff(bytes).unwrap_or(("application/octet-stream", "bin"));
    Compressed {
        bytes: bytes.to_vec(),
        content_type,
        ext,
        recompressed: false,
    }
}

/// WebP động (có khối `ANIM`) hoặc APNG (có khối `acTL`): giải mã chỉ lấy khung đầu nên không được nén.
fn is_animated(bytes: &[u8], mime: &str) -> bool {
    match mime {
        "image/webp" => bytes[..bytes.len().min(256)].windows(4).any(|w| w == b"ANIM"),
        "image/png" => bytes.windows(4).any(|w| w == b"acTL"),
        _ => false,
    }
}

/// Nén mạnh một ảnh người dùng tải lên trước khi lưu: cạnh dài ≤ [`UPLOAD_MAX_PX`] (không phóng to), xoay đúng chiều theo
/// EXIF rồi bỏ mọi metadata, WebP q70 ([`UploadFormat::WebP`], giữ alpha) hoặc JPEG q75 ([`UploadFormat::Jpeg`]).
///
/// KHÔNG BAO GIỜ lỗi: tệp không phải ảnh JPEG/PNG/WebP, GIF, WebP/PNG động, ảnh vượt [`UPLOAD_MAX_INPUT_PIXELS`], tệp hỏng,
/// hay bản nén không nhỏ hơn bản gốc ⇒ trả lại nguyên tệp gốc ([`keep_original`]). Hàm nặng CPU: gọi trong `spawn_blocking`.
pub fn compress_upload(bytes: &[u8], target: UploadFormat) -> Compressed {
    let Some((mime, _)) = sniff(bytes).filter(|(m, _)| *m != "image/gif") else {
        return keep_original(bytes);
    };
    if is_animated(bytes, mime) {
        return keep_original(bytes);
    }
    let Ok(img) = decode_with(bytes, UPLOAD_MAX_INPUT_PIXELS) else {
        return keep_original(bytes);
    };
    let (w, h) = fit_inside(img.width(), img.height(), UPLOAD_MAX_PX);
    let alpha = img.color().has_alpha();
    let encoded: Result<Vec<u8>, ImageError> = match target {
        UploadFormat::WebP if alpha => {
            let mut rgba = img.to_rgba8();
            drop(img);
            premultiply(&mut rgba);
            let mut small = resize_rgba(rgba, w, h);
            unpremultiply(&mut small);
            webp(small.as_raw(), w, h, true, QUALITY)
        }
        UploadFormat::WebP => {
            let rgb = img.to_rgb8();
            drop(img);
            webp(resize_rgb(rgb, w, h).as_raw(), w, h, false, QUALITY)
        }
        UploadFormat::Jpeg => {
            let rgb = if alpha {
                let mut rgba = img.to_rgba8();
                drop(img);
                premultiply(&mut rgba);
                let small = resize_rgba(rgba, w, h);
                // Màu đã nhân alpha: cộng phần nền trắng còn lại (255 − alpha).
                RgbImage::from_fn(w, h, |x, y| {
                    let p = small.get_pixel(x, y);
                    let bg = 255 - u16::from(p[3]);
                    image::Rgb([0, 1, 2].map(|i| (u16::from(p[i]) + bg).min(255) as u8))
                })
            } else {
                let rgb = img.to_rgb8();
                drop(img);
                resize_rgb(rgb, w, h)
            };
            jpeg(&rgb, COMPAT_JPEG_QUALITY)
        }
    };
    match encoded {
        Ok(out) if out.len() < bytes.len() => {
            let (content_type, ext) = match target {
                UploadFormat::WebP => ("image/webp", "webp"),
                UploadFormat::Jpeg => ("image/jpeg", "jpg"),
            };
            Compressed {
                bytes: out,
                content_type,
                ext,
                recompressed: true,
            }
        }
        _ => keep_original(bytes),
    }
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
            assert_eq!(fit_inside(w, h, 1920), want, "{w}×{h}");
        }
    }

    #[test]
    fn khong_phai_anh() {
        assert!(matches!(avatar_jpeg(b"khong phai anh"), Err(ImageError::NotImage(_))));
        assert!(matches!(newsfeed_webp(b"%PDF-1.7"), Err(ImageError::NotImage(_))));
    }

    #[test]
    fn premultiply_roi_chia_lai() {
        let mut img = RgbaImage::from_pixel(1, 1, image::Rgba([200, 100, 50, 128]));
        premultiply(&mut img);
        assert_eq!(img.get_pixel(0, 0).0, [100, 50, 25, 128]);
        unpremultiply(&mut img);
        assert_eq!(img.get_pixel(0, 0).0, [199, 100, 50, 128]);
    }

    /// JPEG 4×2: nửa trái đỏ, nửa phải xanh, kèm EXIF Orientation `o` (APP1 little-endian, một mục 0x0112).
    fn jpeg_with_orientation(o: u8) -> Vec<u8> {
        let img = RgbImage::from_fn(4, 2, |x, _| {
            if x < 2 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        });
        let mut base = Vec::new();
        JpegEncoder::new_with_quality(&mut base, 100)
            .encode_image(&img)
            .unwrap();
        let exif: [u8; 28] = [
            b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0,
        ];
        // đoạn APP1: FFE1 + độ dài (gồm 2 byte độ dài) + dữ liệu + 4 byte kết thúc IFD (offset kế = 0)
        let len = (2 + exif.len() + 4) as u16;
        let mut out = base[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&exif);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&base[2..]);
        out
    }

    #[test]
    fn xoay_theo_exif_orientation() {
        // 6 = xoay 90° theo chiều kim đồng hồ khi hiển thị: 4×2 thành 2×4, nửa trái (đỏ) lên trên.
        let img = decode(&jpeg_with_orientation(6)).unwrap();
        assert_eq!((img.width(), img.height()), (2, 4));
        let rgb = img.to_rgb8();
        assert!(rgb.get_pixel(0, 0)[0] > 200 && rgb.get_pixel(0, 0)[2] < 60);
        assert!(rgb.get_pixel(0, 3)[2] > 200 && rgb.get_pixel(0, 3)[0] < 60);
        // 8 = ngược lại: nửa trái (đỏ) xuống dưới.
        let img = decode(&jpeg_with_orientation(8)).unwrap();
        assert_eq!((img.width(), img.height()), (2, 4));
        assert!(img.to_rgb8().get_pixel(0, 3)[0] > 200);
        // 1 hoặc không có EXIF ⇒ giữ nguyên.
        assert_eq!(decode(&jpeg_with_orientation(1)).unwrap().width(), 4);
    }

    #[test]
    fn newsfeed_anh_chup_doc_ra_doc() {
        // 4×2 có orientation 6 nhỏ hơn khung nên không bị thu nhỏ: đầu ra phải là 2×4 (dọc), không phải 4×2.
        let out = newsfeed_webp(&jpeg_with_orientation(6)).unwrap();
        assert_eq!((out.width, out.height), (2, 4));
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            }
        }
        !c
    }

    #[test]
    fn anh_qua_so_diem_anh_bi_tu_choi_truoc_khi_giai_ma() {
        use image::ImageEncoder;
        // PNG khai 20000×20000 (400 triệu điểm ảnh): bị từ chối chỉ từ phần đầu tệp, không cấp phát bộ đệm ảnh.
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0u8; 3], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        png[16..20].copy_from_slice(&20_000u32.to_be_bytes());
        png[20..24].copy_from_slice(&20_000u32.to_be_bytes());
        let crc = crc32(&png[12..29]);
        png[29..33].copy_from_slice(&crc.to_be_bytes());
        let err = newsfeed_webp(&png).unwrap_err();
        assert!(err.to_string().contains("vượt giới hạn"), "{err}");
    }

    fn noisy_rgb(w: u32, h: u32) -> RgbImage {
        let mut seed = 12345u32;
        RgbImage::from_fn(w, h, |x, y| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let n = (seed >> 24) as u8 / 4;
            image::Rgb([(x * 255 / w) as u8 ^ n, (y * 255 / h) as u8 ^ n, n.wrapping_mul(3)])
        })
    }

    fn png_of(img: &DynamicImage) -> Vec<u8> {
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).unwrap();
        out
    }

    fn jpeg_of(img: &RgbImage, q: u8) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, q).encode_image(img).unwrap();
        out
    }

    #[test]
    fn nen_thu_nho_ve_1600_va_doi_sang_webp() {
        let src = jpeg_of(&noisy_rgb(3200, 2000), 95);
        let out = compress_upload(&src, UploadFormat::WebP);
        assert!(out.recompressed);
        assert_eq!((out.content_type, out.ext), ("image/webp", "webp"));
        assert!(out.bytes.len() < src.len() / 2, "{} vs {}", out.bytes.len(), src.len());
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (1600, 1000));
        assert_eq!(image::guess_format(&out.bytes).unwrap(), ImageFormat::WebP);
    }

    #[test]
    fn nen_jpeg_khi_bat_buoc_jpeg() {
        let src = png_of(&DynamicImage::ImageRgb8(noisy_rgb(2400, 1200)));
        let out = compress_upload(&src, UploadFormat::Jpeg);
        assert!(out.recompressed);
        assert_eq!((out.content_type, out.ext), ("image/jpeg", "jpg"));
        assert_eq!(image::guess_format(&out.bytes).unwrap(), ImageFormat::Jpeg);
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (1600, 800));
    }

    #[test]
    fn khong_phong_to_anh_nho() {
        let src = jpeg_of(&noisy_rgb(800, 600), 98);
        let out = compress_upload(&src, UploadFormat::WebP);
        assert!(out.recompressed);
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (800, 600));
    }

    #[test]
    fn nen_xoay_theo_exif_va_bo_exif() {
        // 4×2 orientation 6 ⇒ 2×4; ảnh quá nhỏ nên bản gốc có thể nhỏ hơn: dùng ảnh lớn hơn bằng cách kiểm decode.
        let src = jpeg_with_orientation(6);
        let out = compress_upload(&src, UploadFormat::Jpeg);
        let bytes = if out.recompressed { out.bytes } else { src };
        let img = if out.recompressed {
            image::load_from_memory(&bytes).unwrap()
        } else {
            decode(&bytes).unwrap()
        };
        assert_eq!((img.width(), img.height()), (2, 4));
        if out.recompressed {
            assert!(!bytes.windows(6).any(|w| w == b"Exif\0\0"));
        }
        // Ảnh đủ lớn (có EXIF 8) để chắc chắn được nén: kích thước ra là đã xoay (cao > rộng).
        let big = {
            let img = noisy_rgb(2000, 1000);
            let base = jpeg_of(&img, 95);
            let exif: [u8; 28] = [
                b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0,
                0, 0,
            ];
            let len = (2 + exif.len() + 4) as u16;
            let mut v = base[..2].to_vec();
            v.extend_from_slice(&[0xFF, 0xE1]);
            v.extend_from_slice(&len.to_be_bytes());
            v.extend_from_slice(&exif);
            v.extend_from_slice(&[0, 0, 0, 0]);
            v.extend_from_slice(&base[2..]);
            v
        };
        let out = compress_upload(&big, UploadFormat::WebP);
        assert!(out.recompressed);
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (800, 1600));
        assert!(!out.bytes.windows(4).any(|w| w == b"EXIF"));
    }

    #[test]
    fn png_alpha_giu_alpha_khi_webp_va_tran_nen_trang_khi_jpeg() {
        let mut img = RgbaImage::from_fn(1800, 900, |x, y| {
            let n = ((x * 7 + y * 13) % 251) as u8;
            image::Rgba([n, 255 - n, n / 2, 255])
        });
        for y in 0..900 {
            for x in 0..900 {
                img.put_pixel(x, y, image::Rgba([10, 20, 30, 0]));
            }
        }
        let src = png_of(&DynamicImage::ImageRgba8(img));
        let w = compress_upload(&src, UploadFormat::WebP);
        assert!(w.recompressed);
        let back = image::load_from_memory(&w.bytes).unwrap().to_rgba8();
        assert!(back.get_pixel(10, 10)[3] < 8, "mất alpha: {:?}", back.get_pixel(10, 10));
        assert!(back.get_pixel(1500, 700)[3] > 240);
        let j = compress_upload(&src, UploadFormat::Jpeg);
        assert!(j.recompressed);
        let back = image::load_from_memory(&j.bytes).unwrap().to_rgb8();
        let p = back.get_pixel(5, 5);
        assert!(p.0.iter().all(|c| *c > 240), "vùng trong suốt phải trắng: {p:?}");
    }

    #[test]
    fn goc_nho_hon_thi_giu_goc() {
        // PNG phẳng rất nhỏ: WebP lossy không nhỏ hơn ⇒ giữ nguyên byte và đuôi gốc.
        let src = png_of(&DynamicImage::ImageRgb8(RgbImage::from_pixel(
            8,
            8,
            image::Rgb([1, 2, 3]),
        )));
        let out = compress_upload(&src, UploadFormat::Jpeg);
        if !out.recompressed {
            assert_eq!(out.bytes, src);
            assert_eq!((out.content_type, out.ext), ("image/png", "png"));
        }
        // Chắc chắn giữ gốc: WebP đã nén chặt rồi nén lại.
        let first = compress_upload(&jpeg_of(&noisy_rgb(500, 500), 95), UploadFormat::WebP);
        let again = compress_upload(&first.bytes, UploadFormat::WebP);
        assert!(!again.recompressed || again.bytes.len() < first.bytes.len());
    }

    #[test]
    fn khong_dung_gif_svg_pdf_va_anh_dong() {
        for data in [
            &b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"[..],
            b"<svg xmlns='x'/>",
            b"%PDF-1.7 abc",
            b"",
        ] {
            let out = compress_upload(data, UploadFormat::WebP);
            assert!(!out.recompressed);
            assert_eq!(out.bytes, data);
        }
        assert_eq!(compress_upload(b"GIF89a....", UploadFormat::WebP).ext, "gif");
        // WebP động: khối ANIM trong phần đầu.
        let mut anim = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\x02\0\0\0\0\0\0\0\0\0ANIM".to_vec();
        anim.extend_from_slice(&[0u8; 64]);
        assert!(!compress_upload(&anim, UploadFormat::WebP).recompressed);
    }

    #[test]
    fn anh_qua_40_megapixel_giu_nguyen() {
        use image::ImageEncoder;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0u8; 3], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        png[16..20].copy_from_slice(&7_000u32.to_be_bytes());
        png[20..24].copy_from_slice(&7_000u32.to_be_bytes());
        let crc = crc32(&png[12..29]);
        png[29..33].copy_from_slice(&crc.to_be_bytes());
        let out = compress_upload(&png, UploadFormat::WebP);
        assert!(!out.recompressed);
        assert_eq!(out.bytes, png);
    }
}
