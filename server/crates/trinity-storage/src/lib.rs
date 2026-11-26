//! Lưu trữ file: driver đĩa cục bộ (ghi nguyên tử, chống thoát thư mục, `Range`), kho `uploads` và route
//! `/uploads/*` (PLAN 4.11, issue K22). Chuyển từ `packages/storage` của bản TS; bố cục trên đĩa giữ nguyên nên file
//! do Node ghi đọc được (test `tests/node_compat.rs`). Driver S3 làm ở issue riêng.

mod atomic;
mod error;
mod key;
mod local;
mod mime;
mod mime_db;
mod range;
mod serve;
mod uploads;

pub use atomic::{ORPHAN_TMP_AGE, is_tmp_name, remove_orphan_tmp, write_atomic, write_atomic_reader};
pub use error::StorageError;
pub use key::resolve_safe_key;
pub use local::{LocalDiskDriver, Object, RangedObject};
pub use mime::content_type_for_path;
pub use range::{ByteRange, parse_range};
pub use serve::{UPLOADS_CACHE_CONTROL, uploads_router};
pub use uploads::{LocalUploadsStore, UPLOADS_URL_PREFIX, uploads_rel_path_from_url};
