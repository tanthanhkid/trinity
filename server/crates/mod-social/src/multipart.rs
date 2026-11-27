//! Dựng thân `multipart/form-data` bằng tay (reqwest của workspace không bật feature `multipart`, tránh thêm phụ thuộc).
//! Dùng để tải ảnh và từng phần video lên Graph ([`crate::publish`]). Tên trường và tên tệp do mã gọi cố định (ASCII), không
//! lấy từ người dùng.

/// Một thân multipart đang dựng.
pub struct Form {
    boundary: String,
    body: Vec<u8>,
}

impl Default for Form {
    fn default() -> Self {
        Self::new()
    }
}

impl Form {
    pub fn new() -> Self {
        let rand = uuid::Uuid::new_v4().simple().to_string();
        Self {
            boundary: format!("----trinity{rand}"),
            body: Vec::new(),
        }
    }

    /// Trường chữ.
    #[must_use]
    pub fn text(mut self, name: &str, value: &str) -> Self {
        self.body.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n",
                self.boundary
            )
            .as_bytes(),
        );
        self
    }

    /// Trường tệp.
    #[must_use]
    pub fn file(mut self, name: &str, file_name: &str, content_type: &str, data: &[u8]) -> Self {
        self.body.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\nContent-Type: {content_type}\r\n\r\n",
                self.boundary
            )
            .as_bytes(),
        );
        self.body.extend_from_slice(data);
        self.body.extend_from_slice(b"\r\n");
        self
    }

    /// `(Content-Type, thân)`.
    pub fn finish(mut self) -> (String, Vec<u8>) {
        self.body
            .extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        (format!("multipart/form-data; boundary={}", self.boundary), self.body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dung_than_multipart() {
        let (ct, body) = Form::new()
            .text("message", "Chào")
            .file("source", "image.jpg", "image/jpeg", &[1, 2, 3])
            .finish();
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        assert!(boundary.starts_with("----trinity"));
        let text = String::from_utf8_lossy(&body).into_owned();
        let head = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"message\"\r\n\r\nChào\r\n");
        assert!(text.starts_with(&head));
        assert!(text.contains("name=\"source\"; filename=\"image.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"));
        assert!(text.ends_with(&format!("\r\n--{boundary}--\r\n")));
        // Nhị phân giữ nguyên byte.
        let pos = body.windows(5).position(|w| w == [b'\n', 1, 2, 3, b'\r']).unwrap();
        assert!(pos > 0);
    }

    #[test]
    fn moi_lan_mot_ranh_gioi_khac() {
        let a = Form::new().finish().0;
        let b = Form::new().finish().0;
        assert_ne!(a, b);
    }
}
