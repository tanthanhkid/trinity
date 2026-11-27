//! Ảnh minh hoạ sản phẩm (M25): `POST /products/upload-image` và dọn file khi xoá hẳn. Bản TS:
//! `product-image-upload.helper.ts`. Nhận diện định dạng bằng magic bytes (không tin `Content-Type`), SVG không được
//! nhận. Lọc `image/*` theo `Content-Type` do lớp multipart của route làm (như `fileFilter` của Multer).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::time::{SystemTime, UNIX_EPOCH};

use trinity_db::CompanyRef;
use trinity_docgen::image::{UploadFormat, compress_upload};
use trinity_kernel::error::{AppError, HttpError};
use trinity_storage::LocalUploadsStore;

/// Trần dung lượng ảnh (khớp `PRODUCT_IMAGE_MAX_BYTES` của web).
pub const PRODUCT_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Thư mục con trong `uploads/`.
pub const PRODUCT_IMAGE_SUBDIR: &str = "products";

/// Định dạng ảnh nhận diện được: (đuôi file, MIME).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageKind {
    pub ext: &'static str,
    pub mime: &'static str,
}

/// `detectImageKind`: JPEG, PNG, WebP, GIF theo magic bytes.
pub fn detect_image_kind(buf: &[u8]) -> Option<ImageKind> {
    if buf.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(ImageKind {
            ext: "jpg",
            mime: "image/jpeg",
        });
    }
    if buf.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(ImageKind {
            ext: "png",
            mime: "image/png",
        });
    }
    if buf.len() >= 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        return Some(ImageKind {
            ext: "webp",
            mime: "image/webp",
        });
    }
    if buf.len() >= 6 && (buf.starts_with(b"GIF87a") || buf.starts_with(b"GIF89a")) {
        return Some(ImageKind {
            ext: "gif",
            mime: "image/gif",
        });
    }
    None
}

/// Thư mục ảnh của công ty: công ty 1 giữ `products/` cũ, công ty khác `c<id>/products/`.
fn image_dir(company: CompanyRef) -> String {
    if company.id() == 1 {
        PRODUCT_IMAGE_SUBDIR.to_owned()
    } else {
        format!("c{}/{PRODUCT_IMAGE_SUBDIR}", company.id())
    }
}

/// `(bytes / 1024 / 1024).toFixed(1)` của JS (hoà thì làm tròn lên).
fn mb_one_decimal(bytes: usize) -> String {
    let tenths = ((bytes as f64 / 1024.0 / 1024.0) * 10.0 + 0.5).floor() as u64;
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// Lưu ảnh đã nhận được xuống kho uploads, trả `{ image_url }` (`/uploads/products/<tên>`). `file`: nội dung ảnh, `None`
/// khi không có phần `file` trong form.
pub async fn save_product_image(
    store: &LocalUploadsStore,
    company: CompanyRef,
    file: Option<&[u8]>,
) -> Result<String, AppError> {
    let Some(buf) = file else {
        return Err(HttpError::bad_request("Vui lòng chọn ảnh để tải lên").into());
    };
    if buf.len() > PRODUCT_IMAGE_MAX_BYTES {
        return Err(HttpError::bad_request(format!(
            "Ảnh quá lớn: {}MB. Tối đa {}MB.",
            mb_one_decimal(buf.len()),
            PRODUCT_IMAGE_MAX_BYTES / 1024 / 1024
        ))
        .into());
    }
    let Some(kind) = detect_image_kind(buf) else {
        return Err(HttpError::bad_request("Định dạng ảnh không hợp lệ. Chỉ chấp nhận JPG, PNG, WebP, GIF.").into());
    };
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let rand = uuid::Uuid::new_v4().simple().to_string();
    // Nén mạnh (WebP q70, cạnh dài ≤ 1600, bỏ EXIF); GIF/ảnh lạ/bản nén không nhỏ hơn ⇒ giữ nguyên byte và đuôi gốc.
    // Ảnh sản phẩm chỉ hiển thị trong web/POS, không gửi nguyên tệp sang Facebook/Zalo nên dùng WebP.
    let src = buf.to_vec();
    let (data, ext, mime) = match tokio::task::spawn_blocking(move || compress_upload(&src, UploadFormat::WebP)).await {
        Ok(c) if c.recompressed => (c.bytes, c.ext, c.content_type),
        _ => (buf.to_vec(), kind.ext, kind.mime),
    };
    let name = format!("{millis}_{}.{ext}", &rand[..12]);
    let dir = image_dir(company);
    store
        .save(&format!("{dir}/{name}"), &data, mime)
        .await
        .map_err(AppError::internal)?;
    Ok(format!("/uploads/{dir}/{name}"))
}

/// Tách `/uploads/(c<id>/)?products/<tên>.(jpg|png|webp|gif)` → (tiền tố công ty, tên). Chỉ nhận đúng dạng
/// [`save_product_image`] sinh ra: chặn `..`, đường dẫn tuyệt đối, URL ngoài.
fn own_image_url(url: &str) -> Option<(Option<&str>, &str)> {
    let rest = url.strip_prefix("/uploads/")?;
    let (company, rest) = match rest.split_once('/') {
        Some((c, r)) if c.len() > 1 && c.starts_with('c') && c[1..].bytes().all(|b| b.is_ascii_digit()) => (Some(c), r),
        _ => (None, rest),
    };
    let name = rest.strip_prefix("products/")?;
    let (stem, ext) = name.rsplit_once('.')?;
    let stem_ok = !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (stem_ok && matches!(ext, "jpg" | "png" | "webp" | "gif")).then_some((company, name))
}

/// Xoá file ảnh trên đĩa của sản phẩm vừa bị xoá hẳn (best-effort). Chỉ file do chính upload tạo và nằm trong thư mục
/// của công ty hiện tại. Người gọi phải kiểm không sản phẩm nào khác còn dùng cùng URL.
pub async fn delete_product_image_file(
    store: &LocalUploadsStore,
    company: CompanyRef,
    image_url: Option<&str>,
) -> bool {
    let Some((owner, name)) = image_url.and_then(own_image_url) else {
        return false;
    };
    let dir = image_dir(company);
    let url_dir = owner.map_or_else(
        || PRODUCT_IMAGE_SUBDIR.to_owned(),
        |c| format!("{c}/{PRODUCT_IMAGE_SUBDIR}"),
    );
    if url_dir != dir {
        return false;
    }
    store.remove(&format!("{dir}/{name}")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nhan_dien_magic_bytes() {
        assert_eq!(detect_image_kind(&[0xff, 0xd8, 0xff, 0xe0]).unwrap().ext, "jpg");
        assert_eq!(
            detect_image_kind(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
                .unwrap()
                .mime,
            "image/png"
        );
        assert_eq!(detect_image_kind(b"RIFF\0\0\0\0WEBPVP8 ").unwrap().ext, "webp");
        assert_eq!(detect_image_kind(b"GIF89a..").unwrap().ext, "gif");
        assert_eq!(detect_image_kind(b"GIF88a").map(|k| k.ext), None);
        assert_eq!(detect_image_kind(b"<svg xmlns=''></svg>"), None);
        assert_eq!(detect_image_kind(&[]), None);
    }

    #[test]
    fn lam_tron_mot_so_le_nhu_js_to_fixed() {
        assert_eq!(mb_one_decimal(5_505_024), "5.3"); // 5.25 MB
        assert_eq!(mb_one_decimal(6 * 1024 * 1024), "6.0");
        assert_eq!(mb_one_decimal(5 * 1024 * 1024 + 1), "5.0");
    }

    #[test]
    fn url_anh_cua_minh() {
        assert_eq!(own_image_url("/uploads/products/1_ab.jpg"), Some((None, "1_ab.jpg")));
        assert_eq!(
            own_image_url("/uploads/c12/products/x-Y_1.webp"),
            Some((Some("c12"), "x-Y_1.webp"))
        );
        for bad in [
            "/uploads/products/../a.jpg",
            "/uploads/products/a.svg",
            "/uploads/products/a b.jpg",
            "/uploads/avatars/a.jpg",
            "https://x/uploads/products/a.jpg",
            "/uploads/cx/products/a.jpg",
            "/uploads/products/.jpg",
        ] {
            assert_eq!(own_image_url(bad), None, "{bad}");
        }
    }
}
