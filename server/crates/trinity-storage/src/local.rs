use std::io::SeekFrom;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncRead, AsyncSeekExt};

use crate::{ByteRange, StorageError, parse_range, resolve_safe_key, write_atomic, write_atomic_reader};

const DEFAULT_CONTENT_TYPE: &str = "application/octet-stream";

/// Một object đọc ra: tệp đã mở, kích thước, `Content-Type` đã lưu.
#[derive(Debug)]
pub struct Object {
    pub file: tokio::fs::File,
    pub size: u64,
    pub content_type: String,
}

/// Kết quả đọc có `Range`: `file` đã đặt ở byte đầu, đọc đúng `len` byte.
#[derive(Debug)]
pub struct RangedObject {
    pub file: tokio::fs::File,
    pub len: u64,
    pub size: u64,
    pub content_type: String,
    /// `Some` ⇒ trả 206 với `Content-Range: bytes a-b/size`; `None` ⇒ 200 cả file.
    pub range: Option<ByteRange>,
}

impl RangedObject {
    pub fn status(&self) -> u16 {
        if self.range.is_some() { 206 } else { 200 }
    }

    pub fn content_range(&self) -> Option<String> {
        self.range.map(|r| format!("bytes {}-{}/{}", r.start, r.end, self.size))
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    #[serde(rename = "contentType")]
    content_type: String,
}

/// Driver đĩa cục bộ, như `LocalDiskStorageDriver` của `packages/storage`. Bố cục: nội dung ở `<root>/<key>`,
/// `Content-Type` ở `<root>/<key>.meta.json` dạng `{"contentType":"…"}` (đúng byte `JSON.stringify` ghi). Mọi key
/// đi qua [`resolve_safe_key`].
#[derive(Debug, Clone)]
pub struct LocalDiskDriver {
    root: PathBuf,
}

impl LocalDiskDriver {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `mkdir -p` root rồi ghi thử một byte (ghi nguyên tử) và xoá; sau đó dọn tệp tạm mồ côi (cũ hơn
    /// [`crate::atomic::ORPHAN_TMP_AGE`], để không xoá tệp đang ghi dở của tiến trình khác). Lỗi ghi thử là lỗi cấu
    /// hình: tiến trình phải dừng.
    pub async fn init(&self) -> Result<(), StorageError> {
        let rand = uuid::Uuid::new_v4().simple().to_string();
        let probe = self.root.join(format!(".write-test-{}", &rand[..12]));
        let res = async {
            tokio::fs::create_dir_all(&self.root).await?;
            write_atomic(&probe, b"1").await?;
            Ok::<_, std::io::Error>(())
        }
        .await;
        let _ = tokio::fs::remove_file(&probe).await;
        if res.is_ok() {
            crate::atomic::remove_orphan_tmp(&self.root, crate::atomic::ORPHAN_TMP_AGE).await;
        }
        res.map_err(|source| StorageError::RootNotWritable {
            root: self.root.to_string_lossy().into_owned(),
            source,
        })
    }

    /// Ghi nội dung trước, meta sau (đọc chen giữa thấy nội dung mà chưa có meta thì rơi về
    /// `application/octet-stream`, an toàn hơn chiều ngược lại). Trả lại `key` như bản TS.
    pub async fn upload(&self, key: &str, body: &[u8], content_type: &str) -> Result<String, StorageError> {
        let mut r = body;
        self.upload_reader(key, &mut r, content_type).await
    }

    /// Như [`Self::upload`] nhưng nhận luồng (file lớn).
    pub async fn upload_reader<R>(&self, key: &str, body: &mut R, content_type: &str) -> Result<String, StorageError>
    where
        R: AsyncRead + Unpin + ?Sized,
    {
        let path = resolve_safe_key(&self.root, key)?;
        write_atomic_reader(&path, body).await?;
        let meta = serde_json::to_vec(&Meta {
            content_type: content_type.to_owned(),
        })
        .map_err(std::io::Error::other)?;
        write_atomic(&meta_path(&path), &meta).await?;
        Ok(key.to_owned())
    }

    /// Đọc cả object.
    pub async fn get(&self, key: &str) -> Result<Object, StorageError> {
        let path = resolve_safe_key(&self.root, key)?;
        let (file, size) = open(&path, key).await?;
        Ok(Object {
            file,
            size,
            content_type: read_content_type(&path).await,
        })
    }

    /// Đọc có `Range` (giá trị thô của header). Range không hợp lệ ⇒ cả file 200, không lỗi.
    pub async fn get_range(&self, key: &str, range: Option<&str>) -> Result<RangedObject, StorageError> {
        let path = resolve_safe_key(&self.root, key)?;
        let (mut file, size) = open(&path, key).await?;
        let content_type = read_content_type(&path).await;
        let parsed = parse_range(range, size);
        let len = match parsed {
            Some(r) => {
                file.seek(SeekFrom::Start(r.start)).await?;
                r.len()
            }
            None => size,
        };
        Ok(RangedObject {
            file,
            len,
            size,
            content_type,
            range: parsed,
        })
    }

    /// Xoá không ném lỗi khi không có; lỗi khác chỉ ghi cảnh báo. Meta xoá kèm, bỏ qua lỗi.
    pub async fn delete(&self, key: &str) -> Result<(), StorageError> {
        let path = resolve_safe_key(&self.root, key)?;
        if let Err(e) = tokio::fs::remove_file(&path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("Could not delete object {key}: {e}");
        }
        let _ = tokio::fs::remove_file(meta_path(&path)).await;
        Ok(())
    }

    /// Đĩa cục bộ không có URL chữ ký: luôn lỗi.
    pub fn presigned_url(&self, _key: &str) -> Result<String, StorageError> {
        Err(StorageError::PresignNotSupported)
    }
}

fn meta_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".meta.json");
    PathBuf::from(s)
}

async fn open(path: &Path, key: &str) -> Result<(tokio::fs::File, u64), StorageError> {
    // Kích thước lấy từ chính tệp đã mở: upload đè (rename) chen giữa không làm lệch kích thước với nội dung đọc.
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(StorageError::NotFound(key.to_owned())),
        Err(e) => return Err(e.into()),
    };
    let md = file.metadata().await?;
    if md.is_dir() {
        return Err(std::io::Error::from(std::io::ErrorKind::IsADirectory).into());
    }
    Ok((file, md.len()))
}

async fn read_content_type(path: &Path) -> String {
    let Ok(raw) = tokio::fs::read(meta_path(path)).await else {
        return DEFAULT_CONTENT_TYPE.to_owned();
    };
    // Như TS: `contentType` phải là chuỗi khác rỗng, còn lại (JSON hỏng, thiếu khoá, sai kiểu) ⇒ mặc định.
    match serde_json::from_slice::<serde_json::Value>(&raw) {
        Ok(v) => match v.get("contentType").and_then(|c| c.as_str()) {
            Some(c) if !c.is_empty() => c.to_owned(),
            _ => DEFAULT_CONTENT_TYPE.to_owned(),
        },
        Err(_) => DEFAULT_CONTENT_TYPE.to_owned(),
    }
}
