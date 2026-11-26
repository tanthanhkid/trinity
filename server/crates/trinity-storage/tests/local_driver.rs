//! Chuyển spec của `packages/storage/src/local-disk-driver.spec.ts` và phần đĩa của `uploads-store.spec.ts`.

use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use trinity_storage::{LocalDiskDriver, LocalUploadsStore, StorageError};

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("trinity-storage-test-{tag}-{}", uuid_like()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("{}-{n}", std::process::id())
}

async fn read_all(mut f: impl tokio::io::AsyncRead + Unpin, len: u64) -> Vec<u8> {
    let mut v = Vec::new();
    (&mut f).take(len).read_to_end(&mut v).await.unwrap();
    v
}

fn list(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[tokio::test]
async fn init_tao_root_long_nhau_va_khong_de_lai_file_thu() {
    let t = TempDir::new("init");
    let nested = t.0.join("a/b/c");
    LocalDiskDriver::new(&nested).init().await.unwrap();
    assert!(nested.is_dir());
    assert!(list(&nested).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn init_loi_ro_khi_root_khong_ghi_duoc() {
    use std::os::unix::fs::PermissionsExt;
    let t = TempDir::new("ro");
    let parent = t.0.join("readonly-parent");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o500)).unwrap();
    // root bỏ qua bit quyền: không kiểm được ca này (như spec TS).
    let is_root = std::fs::File::create(parent.join("probe")).is_ok();
    if !is_root {
        let err = LocalDiskDriver::new(parent.join("storage")).init().await.unwrap_err();
        assert!(matches!(err, StorageError::RootNotWritable { .. }));
        assert!(err.to_string().contains("không ghi được"), "{err}");
    }
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[tokio::test]
async fn upload_roi_doc_lai_dung_noi_dung_va_content_type() {
    let t = TempDir::new("rw");
    let d = LocalDiskDriver::new(&t.0);
    let key = "documents/0912345678/attachments/1_front.jpg";
    assert_eq!(d.upload(key, b"hello world", "image/jpeg").await.unwrap(), key);
    let o = d.get(key).await.unwrap();
    assert_eq!(o.content_type, "image/jpeg");
    assert_eq!(o.size, 11);
    assert_eq!(read_all(o.file, o.size).await, b"hello world");
}

#[tokio::test]
async fn upload_luong_khong_giu_ca_file() {
    let t = TempDir::new("stream");
    let d = LocalDiskDriver::new(&t.0);
    let content = vec![b'x'; 5000];
    let mut reader = tokio::io::AsyncReadExt::chain(&content[..2500], &content[2500..]);
    d.upload_reader("newsfeed/videos/1/a.mp4", &mut reader, "video/mp4")
        .await
        .unwrap();
    let o = d.get("newsfeed/videos/1/a.mp4").await.unwrap();
    assert_eq!(o.size, 5000);
    assert_eq!(read_all(o.file, o.size).await, content);
}

#[tokio::test]
async fn khong_de_lai_tep_tmp() {
    let t = TempDir::new("tmp");
    let d = LocalDiskDriver::new(&t.0);
    d.upload("a/b.txt", b"x", "text/plain").await.unwrap();
    assert_eq!(list(&t.0.join("a")), vec!["b.txt", "b.txt.meta.json"]);
}

#[tokio::test]
async fn khong_co_key_thi_no_such_key() {
    let t = TempDir::new("nf");
    let d = LocalDiskDriver::new(&t.0);
    let err = d.get("khong-ton-tai.jpg").await.unwrap_err();
    assert!(matches!(err, StorageError::NotFound(_)));
    assert_eq!(err.name(), "NoSuchKey");
    assert_eq!(err.to_string(), "Object not found: khong-ton-tai.jpg");
}

#[tokio::test]
async fn traversal_bi_chan_khong_ghi_ra_ngoai() {
    let t = TempDir::new("trav");
    let d = LocalDiskDriver::new(t.0.join("root"));
    let err = d.upload("../../etc/evil.txt", b"x", "text/plain").await.unwrap_err();
    assert!(matches!(err, StorageError::InvalidKey { .. }));
    assert_eq!(err.name(), "StorageInvalidKeyError");
    assert!(!t.0.join("etc").exists());
}

#[tokio::test]
async fn ghi_de_doc_ra_noi_dung_moi() {
    let t = TempDir::new("ow");
    let d = LocalDiskDriver::new(&t.0);
    d.upload("a/b.txt", b"cu", "text/plain").await.unwrap();
    d.upload("a/b.txt", b"moi", "text/html").await.unwrap();
    let o = d.get("a/b.txt").await.unwrap();
    assert_eq!(o.content_type, "text/html");
    assert_eq!(read_all(o.file, o.size).await, b"moi");
}

#[tokio::test]
async fn range() {
    let t = TempDir::new("range");
    let d = LocalDiskDriver::new(&t.0);
    let key = "documents/2026-09-27/voice-note-1.mp3";
    d.upload(key, b"0123456789", "audio/mpeg").await.unwrap();

    let r = d.get_range(key, None).await.unwrap();
    assert_eq!((r.status(), r.len, r.content_range()), (200, 10, None));
    assert_eq!(read_all(r.file, r.len).await, b"0123456789");

    let r = d.get_range(key, Some("bytes=2-5")).await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.content_range().as_deref(), Some("bytes 2-5/10"));
    assert_eq!(r.len, 4);
    assert_eq!(read_all(r.file, r.len).await, b"2345");

    let r = d.get_range(key, Some("bytes=-3")).await.unwrap();
    assert_eq!(read_all(r.file, r.len).await, b"789");

    let err = d.get_range("missing.mp3", Some("bytes=0-1")).await.unwrap_err();
    assert!(matches!(err, StorageError::NotFound(_)));
}

#[tokio::test]
async fn meta_hong_hoac_thieu_thi_octet_stream() {
    let t = TempDir::new("meta");
    let d = LocalDiskDriver::new(&t.0);
    d.upload("a.bin", b"x", "image/png").await.unwrap();
    for bad in ["{", "{\"contentType\":\"\"}", "{\"contentType\":1}", "[]", "null"] {
        std::fs::write(t.0.join("a.bin.meta.json"), bad).unwrap();
        assert_eq!(
            d.get("a.bin").await.unwrap().content_type,
            "application/octet-stream",
            "{bad}"
        );
    }
    std::fs::remove_file(t.0.join("a.bin.meta.json")).unwrap();
    assert_eq!(d.get("a.bin").await.unwrap().content_type, "application/octet-stream");
}

#[tokio::test]
async fn xoa() {
    let t = TempDir::new("del");
    let d = LocalDiskDriver::new(&t.0);
    d.upload("a/b.txt", b"x", "text/plain").await.unwrap();
    d.delete("a/b.txt").await.unwrap();
    assert!(matches!(d.get("a/b.txt").await.unwrap_err(), StorageError::NotFound(_)));
    assert!(list(&t.0.join("a")).is_empty(), "meta cũng bị xoá");
    d.delete("khong-bao-gio-ton-tai.txt").await.unwrap();
}

#[tokio::test]
async fn presigned_luon_loi() {
    let d = LocalDiskDriver::new("/nonexistent");
    assert!(matches!(
        d.presigned_url("any-key.jpg"),
        Err(StorageError::PresignNotSupported)
    ));
}

#[tokio::test]
async fn kho_uploads_ghi_xoa_tren_dia() {
    let t = TempDir::new("uploads");
    let s = LocalUploadsStore::new(&t.0);
    s.save("avatars/a.jpg", b"x", "image/jpeg").await.unwrap();
    assert_eq!(std::fs::read(t.0.join("avatars/a.jpg")).unwrap(), b"x");
    assert_eq!(
        list(&t.0.join("avatars")),
        vec!["a.jpg"],
        "không có meta, không có tệp tạm"
    );
    assert!(s.remove("avatars/a.jpg").await);
    assert!(!t.0.join("avatars/a.jpg").exists());
    assert!(!s.remove("avatars/none.jpg").await);
    assert!(s.save("../evil", b"x", "t").await.is_err());
    assert!(!s.remove("../evil").await);
}

#[tokio::test]
async fn init_don_tep_tam_mo_coi_cu_giu_tep_moi() {
    let t = TempDir::new("orphan");
    let old = t.0.join("a/b.jpg.tmp-0123456789abcdef");
    let fresh = t.0.join("a/c.jpg.tmp-fedcba9876543210");
    let keep = t.0.join("a/d.jpg");
    std::fs::create_dir_all(t.0.join("a")).unwrap();
    for p in [&old, &fresh, &keep] {
        std::fs::write(p, b"x").unwrap();
    }
    let two_hours_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(two_hours_ago)
        .unwrap();
    assert_eq!(LocalUploadsStore::new(&t.0).init().await.unwrap(), 1);
    assert!(!old.exists() && fresh.exists() && keep.exists());

    std::fs::write(&old, b"x").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(two_hours_ago)
        .unwrap();
    LocalDiskDriver::new(&t.0).init().await.unwrap();
    assert!(!old.exists() && fresh.exists());
}

#[tokio::test]
async fn kich_thuoc_theo_tep_da_mo_khi_bi_ghi_de_chen_giua() {
    let t = TempDir::new("race");
    let d = LocalDiskDriver::new(&t.0);
    d.upload("a.bin", b"0123456789", "x/y").await.unwrap();
    let o = d.get("a.bin").await.unwrap();
    // Ghi đè (rename) sau khi đã mở: tệp đang mở vẫn là bản cũ, kích thước khớp bản cũ.
    d.upload("a.bin", b"ab", "x/y").await.unwrap();
    assert_eq!(o.size, 10);
    assert_eq!(read_all(o.file, o.size).await, b"0123456789");
}
