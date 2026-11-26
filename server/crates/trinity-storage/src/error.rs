/// Lỗi lưu trữ. Câu thông báo giữ như `packages/storage/src/types.ts`.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// `StorageObjectNotFoundError` của TS (tên lỗi `NoSuchKey`, khớp S3).
    #[error("Object not found: {0}")]
    NotFound(String),
    /// `StorageInvalidKeyError`: traversal, null byte, đường dẫn tuyệt đối…
    #[error("Key không hợp lệ ({reason}): {key:?}")]
    InvalidKey { key: String, reason: &'static str },
    /// `PresignNotSupportedError`: đĩa cục bộ không có URL chữ ký.
    #[error(
        "getPresignedUrl không được hỗ trợ ở driver hiện tại (STORAGE_DRIVER=local) — dùng getObjectStream/getObjectStreamRange để stream qua backend thay vì URL chữ ký trực tiếp."
    )]
    PresignNotSupported,
    /// Thư mục gốc không ghi được lúc khởi động (lỗi cấu hình, phải làm tiến trình dừng).
    #[error(
        "STORAGE_LOCAL_ROOT '{root}' không ghi được — kiểm tra quyền sở hữu/thư mục (chown/mkdir trước khi khởi động service). Lỗi gốc: {source}"
    )]
    RootNotWritable { root: String, source: std::io::Error },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl StorageError {
    /// Tên lỗi như bản TS (`err.name`), để tầng trên phân biệt "không có" với lỗi thật giống caller cũ.
    pub fn name(&self) -> &'static str {
        match self {
            StorageError::NotFound(_) => "NoSuchKey",
            StorageError::InvalidKey { .. } => "StorageInvalidKeyError",
            StorageError::PresignNotSupported => "PresignNotSupportedError",
            StorageError::RootNotWritable { .. } | StorageError::Io(_) => "Error",
        }
    }
}
