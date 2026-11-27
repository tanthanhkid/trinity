//! "File do Node ghi đọc được" (tiêu chí K22) và `/uploads` trả như bản Node.
//!
//! `tests/fixtures/node-written/` và `tests/fixtures/node-uploads-golden.json` do `scripts/gen-node-fixture.cjs` sinh
//! bằng chính `packages/storage` (dist) và `express.static` của monolith; xem đầu script để sinh lại.

use std::path::PathBuf;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use tokio::io::AsyncReadExt;
use tower::ServiceExt;
use trinity_storage::{LocalDiskDriver, uploads_router};

fn fixtures() -> PathBuf {
    PathBuf::from(manifest_dir()).join("tests/fixtures")
}

async fn read(d: &LocalDiskDriver, key: &str) -> (Vec<u8>, String) {
    let o = d.get(key).await.unwrap_or_else(|e| panic!("{key}: {e}"));
    let mut v = Vec::new();
    o.file.take(o.size).read_to_end(&mut v).await.unwrap();
    (v, o.content_type)
}

#[tokio::test]
async fn doc_duoc_file_do_driver_node_ghi() {
    let d = LocalDiskDriver::new(fixtures().join("node-written/storage"));
    for (key, body, ct) in [
        (
            "documents/0912345678/attachments/1_front.jpg",
            &b"hello world"[..],
            "image/jpeg",
        ),
        ("documents/hồ sơ (1).pdf", b"%PDF-1.4 fake", "application/pdf"),
        ("voice/2026-09-27/abc", b"0123456789", "audio/mpeg"),
        ("notes/1/..report.jpg", b"dots", "image/jpeg"),
        ("a/quote.txt", b"q", "text/plain; charset=\"utf-8\"\n\u{e9}"),
        ("a/empty.bin", b"", "application/octet-stream"),
    ] {
        assert_eq!(read(&d, key).await, (body.to_vec(), ct.to_owned()), "{key}");
    }
    let r = d.get_range("voice/2026-09-27/abc", Some("bytes=3-")).await.unwrap();
    assert_eq!(r.content_range().as_deref(), Some("bytes 3-9/10"));
}

#[tokio::test]
async fn meta_rust_ghi_giong_tung_byte_meta_node_ghi() {
    let node = fixtures().join("node-written/storage");
    let tmp = std::env::temp_dir().join(format!("trinity-storage-meta-{}", std::process::id()));
    let d = LocalDiskDriver::new(&tmp);
    for (key, ct) in [
        ("documents/0912345678/attachments/1_front.jpg", "image/jpeg"),
        ("documents/hồ sơ (1).pdf", "application/pdf"),
        ("a/quote.txt", "text/plain; charset=\"utf-8\"\n\u{e9}"),
    ] {
        d.upload(key, b"", ct).await.unwrap();
        let mine = std::fs::read(tmp.join(format!("{key}.meta.json"))).unwrap();
        let theirs = std::fs::read(node.join(format!("{key}.meta.json"))).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&mine),
            String::from_utf8_lossy(&theirs),
            "{key}"
        );
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

#[derive(serde::Deserialize)]
struct Golden {
    segments: Vec<String>,
    status: u16,
    content_type: Option<String>,
    body_hex: Option<String>,
}

fn encode(seg: &str) -> String {
    // encodeURIComponent
    seg.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

async fn call(uri: &str, range: Option<&str>, method: Method) -> axum::response::Response {
    let app = uploads_router(fixtures().join("node-written/uploads"));
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(r) = range {
        req = req.header(header::RANGE, r);
    }
    app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
}

#[tokio::test]
async fn uploads_khop_golden_cua_express_static() {
    let raw = std::fs::read_to_string(fixtures().join("node-uploads-golden.json")).unwrap();
    let cases: Vec<Golden> = serde_json::from_str(&raw).unwrap();
    assert!(cases.len() >= 15);
    for c in cases {
        let uri = format!(
            "/uploads/{}",
            c.segments.iter().map(|s| encode(s)).collect::<Vec<_>>().join("/")
        );
        let res = call(&uri, None, Method::GET).await;
        assert_eq!(res.status().as_u16(), c.status, "{uri}");
        let h = res.headers().clone();
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        if c.status == 200 {
            assert_eq!(
                h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
                c.content_type.as_deref(),
                "{uri}"
            );
            assert_eq!(Some(hex(&body)), c.body_hex, "{uri}");
            // Header của route Next.
            assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
            assert_eq!(
                h.get(header::CACHE_CONTROL).unwrap(),
                "public, max-age=86400, immutable"
            );
            assert_eq!(h.get(header::CONTENT_LENGTH).unwrap(), &body.len().to_string());
            assert_eq!(h.get(header::ACCEPT_RANGES).unwrap(), "bytes");
        } else {
            assert!(body.is_empty(), "{uri}: lỗi trả thân rỗng");
        }
    }
}

#[tokio::test]
async fn uploads_tang_route_next() {
    // Ca trong apps/web/src/__tests__/products/uploads-proxy-route.test.ts: segment `..`, chứa `/` hoặc `\` sau
    // giải mã, segment rỗng ⇒ 400; tên có khoảng trắng phục vụ bình thường.
    for uri in [
        "/uploads/../x",
        "/uploads/%2e%2e/x",
        "/uploads/products/..%2Fapi",
        "/uploads/products/..%5Cx",
        "/uploads/a//b",
        "/uploads/./a",
        "/uploads/%E0%A4%A",
        "/uploads/%ff",
    ] {
        assert_eq!(
            call(uri, None, Method::GET).await.status(),
            StatusCode::BAD_REQUEST,
            "{uri}"
        );
    }
    assert_eq!(
        call("/uploads/products/a%20b.webp", None, Method::GET).await.status(),
        StatusCode::OK
    );

    let res = call("/uploads/avatars/?x=1", None, Method::GET).await;
    assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(res.headers().get(header::LOCATION).unwrap(), "/uploads/avatars?x=1");

    assert_eq!(
        call("/uploads/avatars/1_123.jpg", None, Method::POST).await.status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    let res = call("/uploads/avatars/1_123.jpg", None, Method::HEAD).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "7");
    assert!(to_bytes(res.into_body(), usize::MAX).await.unwrap().is_empty());
}

#[tokio::test]
async fn uploads_range() {
    // Khác có chủ đích với Node (Next không chuyển tiếp Range): Rust trả 206 để <video> tua được.
    let res = call("/uploads/avatars/1_123.jpg", Some("bytes=1-3"), Method::GET).await;
    assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(res.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 1-3/7");
    assert_eq!(res.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
    assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "3");
    assert_eq!(res.headers().get(header::CONTENT_TYPE).unwrap(), "image/jpeg");
    assert_eq!(
        to_bytes(res.into_body(), usize::MAX).await.unwrap().as_ref(),
        &[0xd8, 0xff, 0xe0]
    );

    // Range lạ hoặc vượt kích thước ⇒ 200 cả file (không 416), như parseRange.
    for r in ["bytes=0-1,3-4", "bytes=100-", "items=0-1"] {
        let res = call("/uploads/avatars/1_123.jpg", Some(r), Method::GET).await;
        assert_eq!(res.status(), StatusCode::OK, "{r}");
        assert_eq!(to_bytes(res.into_body(), usize::MAX).await.unwrap().len(), 7);
    }
}

#[tokio::test]
async fn uploads_khong_phuc_vu_tep_tam() {
    let root = std::env::temp_dir().join(format!("trinity-uploads-tmp-{}", std::process::id()));
    std::fs::create_dir_all(root.join("avatars")).unwrap();
    std::fs::write(root.join("avatars/a.jpg.tmp-0123456789abcdef"), b"half").unwrap();
    std::fs::write(root.join("avatars/a.jpg"), b"full").unwrap();
    let app = uploads_router(&root);
    for (uri, st) in [
        ("/uploads/avatars/a.jpg.tmp-0123456789abcdef", StatusCode::NOT_FOUND),
        ("/uploads/avatars/a.jpg", StatusCode::OK),
    ] {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), st, "{uri}");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
