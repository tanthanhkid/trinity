use std::path::{Path, PathBuf};

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
