//! Driver S3 chạy với MinIO thật. Bỏ qua khi không có `MINIO_ENDPOINT`; CI chạy ở job `Rust S3 (MinIO)`
//! với bucket tạo sẵn. Cục bộ: `MINIO_ENDPOINT=http://127.0.0.1:9000 MINIO_ACCESS_KEY=… MINIO_SECRET_KEY=… MINIO_BUCKET=…`.

use bytes::Bytes;
use futures_util::TryStreamExt;
use trinity_storage::{S3Config, S3Driver, StorageError};

async fn collect(s: futures_util::stream::BoxStream<'static, Result<Bytes, StorageError>>) -> Vec<u8> {
    s.try_fold(Vec::new(), |mut acc, b| async move {
        acc.extend_from_slice(&b);
        Ok(acc)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn upload_get_range_presign_delete() {
    let Ok(cfg) = S3Config::from_env(|k| std::env::var(k).ok()) else {
        // CI đặt REQUIRE_MINIO=1: thiếu biến thì đỏ, không im lặng bỏ qua.
        assert!(std::env::var_os("REQUIRE_MINIO").is_none(), "thiếu MINIO_*");
        return;
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    // `init` tạo bucket khi thiếu.
    let fresh = S3Config {
        bucket: format!("k23-init-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
        ..cfg.clone()
    };
    S3Driver::new(&fresh).unwrap().init().await.unwrap();

    let d = S3Driver::new(&cfg).unwrap();
    d.init().await.unwrap();

    let key = format!("k23-test/{}/hồ sơ (1).txt", uuid::Uuid::new_v4().simple());
    assert_eq!(
        d.upload(&key, Bytes::from_static(b"0123456789"), "text/plain")
            .await
            .unwrap(),
        key
    );

    let o = d.get(&key).await.unwrap();
    assert_eq!((o.size, o.content_type.as_str()), (10, "text/plain"));
    assert_eq!(collect(o.stream).await, b"0123456789");

    let r = d.get_range(&key, Some("bytes=2-4")).await.unwrap();
    assert_eq!(
        (r.status(), r.len, r.content_range().as_deref()),
        (206, 3, Some("bytes 2-4/10"))
    );
    assert_eq!(collect(r.stream).await, b"234");
    let r = d.get_range(&key, Some("bytes=-3")).await.unwrap();
    assert_eq!(collect(r.stream).await, b"789");
    let r = d.get_range(&key, Some("rác")).await.unwrap();
    assert_eq!((r.status(), r.len), (200, 10));
    assert_eq!(collect(r.stream).await, b"0123456789");

    // Luồng (multipart/đơn phần) giữ nguyên Content-Type.
    let key2 = format!("{key}.bin");
    let mut body: &[u8] = b"stream-body";
    d.upload_reader(&key2, &mut body, "application/x-test").await.unwrap();
    let o = d.get(&key2).await.unwrap();
    assert_eq!(o.content_type, "application/x-test");
    assert_eq!(collect(o.stream).await, b"stream-body");

    // URL ký sẵn: tải được không cần credential.
    let url = d.presigned_url(&key).await.unwrap();
    let body = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
    assert_eq!(&body[..], b"0123456789");

    d.delete(&key).await.unwrap();
    d.delete(&key2).await.unwrap();
    d.delete(&key).await.unwrap(); // xoá lần hai không lỗi
    let e = d.get(&key).await.err().unwrap();
    assert_eq!(e.name(), "NoSuchKey");
}
