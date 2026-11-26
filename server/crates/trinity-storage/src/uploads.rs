use std::path::{Path, PathBuf};

use crate::{StorageError, resolve_safe_key, write_atomic};

/// URL lưu trong DB có dạng `/uploads/<thư mục>/<tên>` (ảnh đại diện, ảnh sản phẩm).
pub const UPLOADS_URL_PREFIX: &str = "/uploads/";

/// Kho `uploads` trên đĩa, như `LocalUploadsStore` của `packages/storage/src/uploads-store.ts`: file nằm thẳng ở
/// `<root>/<thư mục>/<tên>`, không có tệp meta (`Content-Type` suy từ đuôi khi phục vụ). Gốc mặc định
/// `UPLOADS_LOCAL_ROOT` hoặc `<cwd>/uploads`. Khác TS: ghi nguyên tử (TS ghi thẳng), kết quả trên đĩa như nhau.
#[derive(Debug, Clone)]
pub struct LocalUploadsStore {
    root: PathBuf,
}

impl LocalUploadsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Gốc theo env như `createUploadsStore()`: `UPLOADS_LOCAL_ROOT` (bỏ khoảng trắng, rỗng thì bỏ qua) hoặc
    /// `<cwd>/uploads`.
    pub fn from_env() -> Self {
        let root = std::env::var("UPLOADS_LOCAL_ROOT")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("uploads"));
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `rel_path` dạng `avatars/1_123.jpg`. `_content_type` giữ cho khớp giao diện TS (nhánh đĩa không lưu).
    pub async fn save(&self, rel_path: &str, body: &[u8], _content_type: &str) -> Result<(), StorageError> {
        let target = resolve_safe_key(&self.root, rel_path)?;
        write_atomic(&target, body).await?;
        Ok(())
    }

    /// Không ném lỗi: `true` khi đã xoá, `false` khi không có, key hỏng hoặc lỗi khác.
    pub async fn remove(&self, rel_path: &str) -> bool {
        match resolve_safe_key(&self.root, rel_path) {
            Ok(p) => tokio::fs::remove_file(p).await.is_ok(),
            Err(_) => false,
        }
    }
}

/// `/uploads/avatars/x.jpg` → `avatars/x.jpg`; không đúng dạng, có `..`, `\` hoặc `//` ⇒ `None`.
pub fn uploads_rel_path_from_url(url: Option<&str>) -> Option<&str> {
    let rel = url?.strip_prefix(UPLOADS_URL_PREFIX)?;
    if rel.is_empty() || rel.contains("..") || rel.contains('\\') || rel.contains("//") {
        return None;
    }
    Some(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_tu_url() {
        // Ca của uploads-store.spec.ts.
        assert_eq!(
            uploads_rel_path_from_url(Some("/uploads/avatars/1.jpg")),
            Some("avatars/1.jpg")
        );
        assert_eq!(uploads_rel_path_from_url(Some("/uploads/../etc")), None);
        assert_eq!(uploads_rel_path_from_url(Some("https://x/uploads/a")), None);
        assert_eq!(uploads_rel_path_from_url(None), None);
        assert_eq!(uploads_rel_path_from_url(Some("/uploads/")), None);
        assert_eq!(uploads_rel_path_from_url(Some("/uploads/a//b")), None);
        assert_eq!(uploads_rel_path_from_url(Some("/uploads/a\\b")), None);
    }
}
