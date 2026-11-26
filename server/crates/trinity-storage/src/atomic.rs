use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWriteExt};

/// Ghi nguyên tử như `writeAtomic` của `packages/storage/src/atomic-write.ts`: tạo thư mục cha, ghi ra
/// `<đích>.tmp-<16 hex>` rồi `rename` sang đích (cùng hệ thống file nên là một thao tác nguyên tử); lỗi thì xoá tệp
/// tạm. Trả về số byte thật đã ghi.
pub async fn write_atomic(target: &Path, body: &[u8]) -> std::io::Result<u64> {
    let mut reader = body;
    write_atomic_reader(target, &mut reader).await
}

/// Như [`write_atomic`] nhưng đọc từ luồng (file lớn), không giữ cả file trong RAM.
pub async fn write_atomic_reader<R>(target: &Path, body: &mut R) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin + ?Sized,
{
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = tmp_path(target);
    let res = async {
        let mut f = tokio::fs::File::create(&tmp).await?;
        let n = tokio::io::copy(body, &mut f).await?;
        f.flush().await?;
        drop(f);
        tokio::fs::rename(&tmp, target).await?;
        Ok::<_, std::io::Error>(n)
    }
    .await;
    if res.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    res
}

fn tmp_path(target: &Path) -> PathBuf {
    let rand = uuid::Uuid::new_v4().simple().to_string();
    let mut s = target.as_os_str().to_owned();
    s.push(format!(".tmp-{}", &rand[..16]));
    PathBuf::from(s)
}

/// Tệp tạm cũ hơn mức này coi là mồ côi (tiến trình chết giữa lúc ghi).
pub const ORPHAN_TMP_AGE: Duration = Duration::from_secs(3600);

/// Tên tệp tạm của [`write_atomic`] (và `writeAtomic` của Node): `<tên>.tmp-<16 hex thường>`.
pub fn is_tmp_name(name: &str) -> bool {
    name.len() > 21
        && name.as_bytes()[name.len() - 21..name.len() - 16] == *b".tmp-"
        && name.as_bytes()[name.len() - 16..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// Xoá đệ quy các tệp tạm mồ côi dưới `root` có thời điểm sửa cũ hơn `older_than`. Lỗi chỉ ghi cảnh báo. Trả số tệp
/// đã xoá.
pub async fn remove_orphan_tmp(root: &Path, older_than: Duration) -> usize {
    let mut removed = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(e)) = rd.next_entry().await {
            let Ok(ft) = e.file_type().await else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() && is_tmp_name(&e.file_name().to_string_lossy()) {
                let old = e
                    .metadata()
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age >= older_than);
                if old {
                    match tokio::fs::remove_file(e.path()).await {
                        Ok(()) => removed += 1,
                        Err(err) => tracing::warn!("không xoá được tệp tạm mồ côi {}: {err}", e.path().display()),
                    }
                }
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nhan_ra_ten_tep_tam() {
        assert!(is_tmp_name("a.jpg.tmp-0123456789abcdef"));
        assert!(is_tmp_name(".write-test-abc.tmp-ffffffffffffffff"));
        assert!(!is_tmp_name("a.jpg.tmp-0123456789ABCDEF"));
        assert!(!is_tmp_name("a.jpg.tmp-0123456789abcde"));
        assert!(!is_tmp_name(".tmp-0123456789abcdef"));
        assert!(!is_tmp_name("a.jpg"));
    }
}
