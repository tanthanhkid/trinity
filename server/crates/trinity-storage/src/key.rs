use std::path::{Component, Path, PathBuf};

use crate::StorageError;

/// Chuyển storage key (không tin cậy) thành đường dẫn tuyệt đối nằm trong `root`, như `resolveSafeKey` của
/// `packages/storage/src/path-safety.ts`. Đây là tuyến chặn path traversal duy nhất của driver đĩa.
///
/// Chặn: key rỗng; null byte; backslash; đường dẫn tuyệt đối (`/…`, `C:…`); `..` thoát khỏi root sau khi chuẩn
/// hoá kiểu `path.posix.normalize` (key `documents/../notes/x.jpg` vẫn hợp lệ vì không ra ngoài root). Chuẩn hoá
/// là thuần chữ (không đọc hệ thống file), giống `path.resolve` của Node.
pub fn resolve_safe_key(root: &Path, key: &str) -> Result<PathBuf, StorageError> {
    let invalid = |reason| StorageError::InvalidKey {
        key: key.to_owned(),
        reason,
    };
    if key.is_empty() {
        return Err(invalid("rỗng"));
    }
    if key.contains('\0') {
        return Err(invalid("chứa null byte"));
    }
    if key.contains('\\') {
        return Err(invalid("chứa backslash"));
    }
    let b = key.as_bytes();
    if key.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') {
        return Err(invalid("là đường dẫn tuyệt đối"));
    }

    // posix.normalize: bỏ `.` và đoạn rỗng, `..` lùi một cấp; lùi quá gốc ⇒ kết quả bắt đầu bằng `..`.
    let mut parts: Vec<&str> = Vec::new();
    for seg in key.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(invalid("traversal ra ngoài root (..)"));
                }
            }
            s => parts.push(s),
        }
    }

    let root = absolute_lexical(root);
    let mut target = root.clone();
    for p in &parts {
        target.push(p);
    }
    // Kiểm lại cuối như bản TS: đích phải là root hoặc nằm dưới root.
    if !target.starts_with(&root) {
        return Err(invalid("nằm ngoài storage root sau khi resolve"));
    }
    Ok(target)
}

/// `path.resolve(root)`: thêm thư mục hiện tại nếu tương đối, chuẩn hoá `.`/`..` theo chữ.
fn absolute_lexical(root: &Path) -> PathBuf {
    let base = if root.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    let mut out = PathBuf::new();
    for c in base.components().chain(root.components()) {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/var/lib/trinity/storage";

    fn ok(key: &str) -> String {
        resolve_safe_key(Path::new(ROOT), key)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn bad(key: &str) -> &'static str {
        match resolve_safe_key(Path::new(ROOT), key) {
            Err(StorageError::InvalidKey { reason, .. }) => reason,
            other => panic!("{key:?} phải bị chặn, được {other:?}"),
        }
    }

    // Các ca chép từ packages/storage/src/path-safety.spec.ts.
    #[test]
    fn key_hop_le_nam_trong_root() {
        assert_eq!(
            ok("documents/0912345678/attachments/1_a.jpg"),
            "/var/lib/trinity/storage/documents/0912345678/attachments/1_a.jpg"
        );
    }

    #[test]
    fn cac_ca_bi_chan() {
        assert_eq!(bad(""), "rỗng");
        assert_eq!(bad("a\0b"), "chứa null byte");
        assert_eq!(bad("..\\..\\etc\\passwd"), "chứa backslash");
        assert_eq!(bad("/etc/passwd"), "là đường dẫn tuyệt đối");
        assert_eq!(bad("C:/Windows/System32"), "là đường dẫn tuyệt đối");
        assert_eq!(bad(".."), "traversal ra ngoài root (..)");
        assert_eq!(bad("../../etc/passwd"), "traversal ra ngoài root (..)");
        assert_eq!(bad("documents/../../etc/passwd"), "traversal ra ngoài root (..)");
    }

    #[test]
    fn lui_mot_cap_roi_tien_van_hop_le() {
        assert_eq!(
            ok("documents/../notes/1/x.jpg"),
            "/var/lib/trinity/storage/notes/1/x.jpg"
        );
    }

    #[test]
    fn ten_giong_traversal_khong_co_gach_van_an_toan() {
        assert_eq!(
            ok("notes/1/..report.jpg"),
            "/var/lib/trinity/storage/notes/1/..report.jpg"
        );
    }

    #[test]
    fn unicode_va_khoang_trang_giu_nguyen() {
        assert_eq!(
            ok("documents/hồ sơ (1).pdf"),
            "/var/lib/trinity/storage/documents/hồ sơ (1).pdf"
        );
    }

    #[test]
    fn chuan_hoa_nhu_posix_normalize() {
        assert_eq!(ok("a//b/./c/"), "/var/lib/trinity/storage/a/b/c");
        // `a/..` chuẩn hoá thành `.`: Node trả chính root, Rust cũng vậy.
        assert_eq!(ok("a/.."), "/var/lib/trinity/storage");
    }

    #[test]
    fn root_tuong_doi_va_root_co_cham_cham() {
        let p = resolve_safe_key(Path::new("/srv/x/../storage"), "a.jpg").unwrap();
        assert_eq!(p, PathBuf::from("/srv/storage/a.jpg"));
        let p = resolve_safe_key(Path::new("uploads"), "a.jpg").unwrap();
        assert_eq!(p, std::env::current_dir().unwrap().join("uploads/a.jpg"));
    }
}
