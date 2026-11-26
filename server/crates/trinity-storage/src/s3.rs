use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjectPath;
use object_store::signer::Signer;
use object_store::{Attribute, Attributes, GetOptions, GetRange, ObjectStore, ObjectStoreExt, PutPayload};
use tokio::io::{AsyncRead, AsyncWriteExt};

use crate::{ByteRange, StorageError};

const DEFAULT_CONTENT_TYPE: &str = "application/octet-stream";
/// Khớp `DEFAULT_PRESIGN_EXPIRY_SECONDS` của `s3-driver.ts` (15 phút).
const DEFAULT_PRESIGN_EXPIRY: Duration = Duration::from_secs(900);

/// Cấu hình driver S3/MinIO, như `S3StorageDriverConfig` của `packages/storage`. Driver không tự đọc biến môi
/// trường; dùng [`S3Config::from_env`] ở nơi khởi động.
#[derive(Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
    /// Mặc định 900 giây.
    pub presign_expiry: Duration,
}

impl std::fmt::Debug for S3Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("access_key_id", &"***")
            .field("secret_access_key", &"***")
            .field("presign_expiry", &self.presign_expiry)
            .finish()
    }
}

/// Thiếu biến `MINIO_*` bắt buộc.
#[derive(Debug, thiserror::Error)]
#[error("STORAGE_DRIVER=s3 nhưng thiếu biến {0}")]
pub struct S3ConfigError(pub &'static str);

impl S3Config {
    /// Đọc `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` (bắt buộc), `MINIO_BUCKET` (mặc định
    /// `trinity-documents`), `MINIO_REGION` (mặc định `us-east-1`) qua `get` (để test không đụng môi trường thật).
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self, S3ConfigError> {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let need = |k: &'static str| val(k).ok_or(S3ConfigError(k));
        Ok(Self {
            endpoint: need("MINIO_ENDPOINT")?,
            access_key_id: need("MINIO_ACCESS_KEY")?,
            secret_access_key: need("MINIO_SECRET_KEY")?,
            bucket: val("MINIO_BUCKET").unwrap_or_else(|| "trinity-documents".to_owned()),
            region: val("MINIO_REGION").unwrap_or_else(|| "us-east-1".to_owned()),
            presign_expiry: DEFAULT_PRESIGN_EXPIRY,
        })
    }
}

/// Object đọc ra: luồng byte, kích thước (nếu kho trả), `Content-Type`.
pub struct S3Object {
    pub stream: BoxStream<'static, Result<Bytes, StorageError>>,
    pub size: u64,
    pub content_type: String,
}

/// Kết quả đọc có `Range`: giống [`crate::RangedObject`] nhưng nội dung là luồng.
pub struct S3RangedObject {
    pub stream: BoxStream<'static, Result<Bytes, StorageError>>,
    pub len: u64,
    pub size: u64,
    pub content_type: String,
    pub range: Option<ByteRange>,
}

impl S3RangedObject {
    pub fn status(&self) -> u16 {
        if self.range.is_some() { 206 } else { 200 }
    }

    pub fn content_range(&self) -> Option<String> {
        self.range.map(|r| format!("bytes {}-{}/{}", r.start, r.end, self.size))
    }
}

/// Driver S3/MinIO trên `object_store` (path-style, cho phép http để chạy với MinIO), như `S3StorageDriver` của
/// `packages/storage`. Key là key S3 nguyên văn.
///
/// Khác bản TS có chủ đích: key đi qua `object_store::path::Path::parse`, nên key rỗng, bắt đầu bằng `/`, có đoạn
/// rỗng (`a//b`) hoặc đoạn `.`/`..` bị từ chối (`InvalidKey`) thay vì gửi đi; key do hệ thống sinh không có các
/// dạng này. [`Self::init`] kiểm bucket và tạo khi thiếu.
#[derive(Debug, Clone)]
pub struct S3Driver {
    store: AmazonS3,
    bucket: String,
    region: String,
    presign_expiry: Duration,
    http: reqwest::Client,
}

impl S3Driver {
    pub fn new(config: &S3Config) -> Result<Self, StorageError> {
        let store = AmazonS3Builder::new()
            .with_endpoint(&config.endpoint)
            .with_region(&config.region)
            .with_access_key_id(&config.access_key_id)
            .with_secret_access_key(&config.secret_access_key)
            .with_bucket_name(&config.bucket)
            .with_allow_http(true)
            .with_virtual_hosted_style_request(false)
            .build()
            .map_err(backend)?;
        Ok(Self {
            store,
            bucket: config.bucket.clone(),
            region: config.region.clone(),
            presign_expiry: config.presign_expiry,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| StorageError::Backend(e.to_string()))?,
        })
    }

    /// Kiểm bucket truy cập được; thiếu (hoặc không truy cập được) thì thử tạo bằng `PUT /{bucket}` ký sẵn như
    /// `CreateBucketCommand` của bản TS. Không tạo được ⇒ lỗi khởi động (tiến trình phải dừng, đừng chạy với bucket
    /// hỏng). Thiếu quyền tạo: tạo tay bằng `mc mb <alias>/<bucket>`.
    pub async fn init(&self) -> Result<(), StorageError> {
        let probe = self.store.list(None).next().await;
        let Some(Err(probe_err)) = probe else { return Ok(()) };
        tracing::warn!("S3 bucket '{}' chưa truy cập được ({probe_err}), thử tạo", self.bucket);
        let url = self
            .store
            .signed_url(http::Method::PUT, &ObjectPath::default(), self.presign_expiry)
            .await
            .map_err(backend)?;
        let body = if self.region == "us-east-1" {
            String::new()
        } else {
            format!(
                "<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><LocationConstraint>{}</LocationConstraint></CreateBucketConfiguration>",
                self.region
            )
        };
        let resp = self
            .http
            .put(url)
            .body(body)
            .send()
            .await
            .map_err(|e| StorageError::Backend(format!("tạo bucket '{}': {e}", self.bucket)))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() || text.contains("BucketAlreadyOwnedByYou") {
            return Ok(());
        }
        Err(StorageError::Backend(format!(
            "bucket '{}' không truy cập được ({probe_err}) và tạo không được (HTTP {status}); tạo tay: mc mb <alias>/{}",
            self.bucket, self.bucket
        )))
    }

    /// Ghi object kèm `Content-Type`; trả lại `key`.
    pub async fn upload(&self, key: &str, body: Bytes, content_type: &str) -> Result<String, StorageError> {
        let path = to_path(key)?;
        let mut attributes = Attributes::new();
        attributes.insert(Attribute::ContentType, content_type.to_owned().into());
        self.store
            .put_opts(&path, PutPayload::from_bytes(body), attributes.into())
            .await
            .map_err(backend)?;
        Ok(key.to_owned())
    }

    /// Như [`Self::upload`] nhưng nhận luồng; đẩy lên theo từng phần (multipart) nên không giữ cả file trong RAM.
    pub async fn upload_reader<R>(&self, key: &str, body: &mut R, content_type: &str) -> Result<String, StorageError>
    where
        R: AsyncRead + Unpin + ?Sized,
    {
        let path = to_path(key)?;
        let mut attributes = Attributes::new();
        attributes.insert(Attribute::ContentType, content_type.to_owned().into());
        let mut w = object_store::buffered::BufWriter::new(std::sync::Arc::new(self.store.clone()), path)
            .with_attributes(attributes);
        let res = async {
            tokio::io::copy(body, &mut w).await?;
            w.shutdown().await
        }
        .await;
        if let Err(e) = res {
            // Lỗi giữa chừng: huỷ multipart đang dở, khỏi để rác trong bucket.
            let _ = w.abort().await;
            return Err(e.into());
        }
        Ok(key.to_owned())
    }

    /// URL ký sẵn GET, hết hạn sau `presign_expiry`: tương đương `getSignedUrl` của bản TS.
    pub async fn presigned_url(&self, key: &str) -> Result<String, StorageError> {
        let path = to_path(key)?;
        let url = self
            .store
            .signed_url(http::Method::GET, &path, self.presign_expiry)
            .await
            .map_err(backend)?;
        Ok(url.to_string())
    }

    /// Đọc cả object.
    pub async fn get(&self, key: &str) -> Result<S3Object, StorageError> {
        let path = to_path(key)?;
        let res = self.store.get(&path).await.map_err(|e| map_err(e, key))?;
        let content_type = content_type_of(&res.attributes);
        let size = res.meta.size;
        Ok(S3Object {
            stream: res.into_stream().map_err(backend).boxed(),
            size,
            content_type,
        })
    }

    /// Đọc có `Range` (giá trị thô của header), cùng luật với driver đĩa: range không hợp lệ hoặc ngoài object ⇒ cả
    /// object (200). Một request: kích thước và khoảng thực trả về lấy từ phản hồi.
    pub async fn get_range(&self, key: &str, range: Option<&str>) -> Result<S3RangedObject, StorageError> {
        let path = to_path(key)?;
        let mut got = None;
        if let Some(r) = range.and_then(syntactic_range) {
            let opts = GetOptions {
                range: Some(r),
                ..Default::default()
            };
            match self.store.get_opts(&path, opts).await {
                Ok(v) => got = Some((v, true)),
                Err(object_store::Error::NotFound { .. }) => return Err(StorageError::NotFound(key.to_owned())),
                // Khoảng ngoài object (hoặc object rỗng, S3 trả 416): như `parse_range` ⇒ cả object.
                Err(_) => {}
            }
        }
        let (res, ranged) = match got {
            Some(v) => v,
            None => (self.store.get(&path).await.map_err(|e| map_err(e, key))?, false),
        };
        let size = res.meta.size;
        let parsed = (ranged && res.range.end > res.range.start).then(|| ByteRange {
            start: res.range.start,
            end: res.range.end - 1,
        });
        Ok(S3RangedObject {
            content_type: content_type_of(&res.attributes),
            len: parsed.map_or(size, |r| r.len()),
            size,
            range: parsed,
            stream: res.into_stream().map_err(backend).boxed(),
        })
    }

    /// Xoá không ném lỗi (không có thì thôi; lỗi khác chỉ ghi cảnh báo), như bản TS.
    pub async fn delete(&self, key: &str) -> Result<(), StorageError> {
        let path = match to_path(key) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Could not delete object {key}: {e}");
                return Ok(());
            }
        };
        match self.store.delete(&path).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => tracing::warn!("Could not delete object {key}: {e}"),
        }
        Ok(())
    }
}

fn to_path(key: &str) -> Result<ObjectPath, StorageError> {
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
    if key.ends_with('/') {
        // `Path::parse` bỏ `/` cuối ngầm ⇒ key `a/` và `a` thành một object; từ chối rõ ràng.
        return Err(invalid("kết thúc bằng /"));
    }
    if key.starts_with('/') {
        return Err(invalid("là đường dẫn tuyệt đối"));
    }
    ObjectPath::parse(key).map_err(|_| invalid("không dùng được làm key S3 (đoạn rỗng, `.` hoặc `..`)"))
}

/// Chỉ cú pháp `Range: bytes=…` một khoảng (`a-b`, `a-`, `-n`); khác ⇒ `None` (cả object).
fn syntactic_range(h: &str) -> Option<GetRange> {
    let rest = h.trim().strip_prefix("bytes=")?;
    let (a, b) = rest.split_once('-')?;
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    match (a.is_empty(), b.is_empty()) {
        (true, true) => None,
        (true, false) => b.parse().ok().filter(|n| *n > 0).map(GetRange::Suffix),
        (false, true) => a.parse().ok().map(GetRange::Offset),
        (false, false) => {
            let (s, e): (u64, u64) = (a.parse().ok()?, b.parse().ok()?);
            if s <= e {
                Some(GetRange::Bounded(s..e.checked_add(1)?))
            } else {
                None
            }
        }
    }
}

fn content_type_of(attrs: &Attributes) -> String {
    attrs
        .get(&Attribute::ContentType)
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_CONTENT_TYPE.to_owned())
}

fn backend(e: object_store::Error) -> StorageError {
    StorageError::Backend(e.to_string())
}

fn map_err(e: object_store::Error, key: &str) -> StorageError {
    match e {
        object_store::Error::NotFound { .. } => StorageError::NotFound(key.to_owned()),
        other => backend(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> S3Config {
        // Như `main`: cài provider `ring` một lần (reqwest dùng `rustls-no-provider`).
        let _ = rustls::crypto::ring::default_provider().install_default();
        S3Config::from_env(|k| {
            match k {
                "MINIO_ENDPOINT" => Some("http://localhost:9000"),
                "MINIO_ACCESS_KEY" => Some("AKIDEXAMPLE"),
                "MINIO_SECRET_KEY" => Some("s3cr3t-value"),
                "MINIO_BUCKET" => Some("b1"),
                _ => None,
            }
            .map(str::to_owned)
        })
        .unwrap()
    }

    #[test]
    fn env_thieu_bien_bat_buoc_va_mac_dinh() {
        let c = cfg();
        assert_eq!((c.region.as_str(), c.presign_expiry.as_secs()), ("us-east-1", 900));
        let e = S3Config::from_env(|_| None).unwrap_err();
        assert_eq!(e.to_string(), "STORAGE_DRIVER=s3 nhưng thiếu biến MINIO_ENDPOINT");
        assert!(!format!("{c:?}").contains("s3cr3t-value"));
    }

    #[tokio::test]
    async fn presign_path_style_het_han_900s_khong_goi_mang() {
        let d = S3Driver::new(&cfg()).unwrap();
        let url = d.presigned_url("documents/0912345678/hồ sơ (1).pdf").await.unwrap();
        let u = url::Url::parse(&url).unwrap();
        assert_eq!(u.host_str(), Some("localhost"));
        assert!(u.path().starts_with("/b1/documents/0912345678/"), "{url}");
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["X-Amz-Algorithm"], "AWS4-HMAC-SHA256");
        assert_eq!(q["X-Amz-Expires"], "900");
        assert!(q["X-Amz-Credential"].starts_with("AKIDEXAMPLE/"));
        assert_eq!(q["X-Amz-Signature"].len(), 64);
    }

    #[tokio::test]
    async fn key_xau_bi_tu_choi_truoc_khi_gui() {
        let d = S3Driver::new(&cfg()).unwrap();
        for k in ["", "a\0b", "a//b", "/a", "a/", "a/../b", "a/./b"] {
            let e = d.get(k).await.err().unwrap();
            assert_eq!(e.name(), "StorageInvalidKeyError", "{k:?}");
            assert!(d.delete(k).await.is_ok(), "delete nuốt key xấu {k:?}");
        }
    }
}
