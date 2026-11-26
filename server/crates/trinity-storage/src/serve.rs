//! Route `/uploads/*`, trả như bản Node nhìn từ trình duyệt: route Next `apps/web/src/app/uploads/[...path]/route.ts`
//! chặn segment xấu rồi chuyển sang `express.static(<cwd>/uploads)` của monolith (serve-static 1.16 + send 0.19).
//!
//! | Tình huống | Node | Rust |
//! |---|---|---|
//! | Đường dẫn kết thúc bằng `/` | 308 về bản không có `/` (Next) | như vậy |
//! | Segment rỗng, `.`, `..`, chứa `/` hoặc `\` sau giải mã (`%2F`, `%5C`) | 400 | 400 |
//! | Giải mã `%` hỏng | 400 | 400 |
//! | Có null byte | 404 (send báo 400, serve-static `fallthrough` chuyển thành 404) | 404 |
//! | Segment cuối bắt đầu bằng `.` (dotfile) | 404 | 404 |
//! | Không có file, `ENOTDIR`, `ENAMETOOLONG` | 404 | 404 |
//! | Thư mục | 301 → Next đi theo → `index.html` nếu có, không thì 404 | như vậy |
//! | Có file | 200, `Content-Type` theo mime 1.6, `nosniff`, `Cache-Control` 1 ngày | như vậy |
//! | Header `Range` hợp lệ | bỏ qua (Next không chuyển tiếp), 200 cả file | **206** (khác có chủ đích, PLAN 4.11) |
//! | `Accept-Ranges` | không có (Next bỏ header của monolith) | **`bytes`** (đi kèm Range) |
//! | Tệp tạm `<tên>.tmp-<16 hex>` của ghi nguyên tử | 200 | **404** |
//! | Phương thức khác GET/HEAD | 405 | 405 |
//!
//! Lỗi trả thân rỗng, không header riêng, như `new NextResponse(null, { status })`.

use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::{content_type_for_path, parse_range};

/// `Cache-Control` của ảnh tải lên (route Next).
pub const UPLOADS_CACHE_CONTROL: &str = "public, max-age=86400, immutable";

/// Router phục vụ `/uploads/*` từ thư mục `root` (thường là [`crate::LocalUploadsStore::root`]).
pub fn uploads_router(root: impl Into<PathBuf>) -> Router {
    Router::new()
        .route("/uploads/", get(serve))
        .route("/uploads/{*rest}", get(serve))
        .with_state(root.into())
}

fn empty(status: StatusCode) -> Response {
    (status, Body::empty()).into_response()
}

async fn serve(State(root): State<PathBuf>, req: Request) -> Response {
    let uri = req.uri();
    let path = uri.path();

    // Next (trailingSlash: false) chuyển hướng 308 trước khi tới route.
    if path.len() > 1 && path.ends_with('/') {
        let mut loc = path.trim_end_matches('/').to_owned();
        if loc.is_empty() {
            loc.push('/');
        }
        if let Some(q) = uri.query() {
            loc.push('?');
            loc.push_str(q);
        }
        let mut res = empty(StatusCode::PERMANENT_REDIRECT);
        if let Ok(v) = HeaderValue::from_str(&loc) {
            res.headers_mut().insert(header::LOCATION, v);
        }
        return res;
    }

    let Some(rest) = path.strip_prefix("/uploads/") else {
        return empty(StatusCode::NOT_FOUND);
    };
    let mut segments = Vec::new();
    for raw in rest.split('/') {
        let Some(seg) = percent_decode(raw) else {
            return empty(StatusCode::BAD_REQUEST);
        };
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(['/', '\\']) {
            return empty(StatusCode::BAD_REQUEST);
        }
        segments.push(seg);
    }

    // Phần của send/serve-static.
    if segments.iter().any(|s| s.contains('\0')) {
        return empty(StatusCode::NOT_FOUND);
    }
    if segments.last().is_some_and(|s| s.starts_with('.')) {
        return empty(StatusCode::NOT_FOUND);
    }
    // Tệp tạm của ghi nguyên tử (đang ghi dở hoặc mồ côi) không bao giờ được phục vụ. Node phục vụ cả loại này.
    if segments.last().is_some_and(|s| crate::is_tmp_name(s)) {
        return empty(StatusCode::NOT_FOUND);
    }

    let mut file_path = root.clone();
    for s in &segments {
        file_path.push(s);
    }
    let md = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m,
        Err(e) => return io_status(&e),
    };
    if md.is_dir() {
        file_path.push("index.html");
        match tokio::fs::metadata(&file_path).await {
            Ok(m) if m.is_file() => {}
            _ => return empty(StatusCode::NOT_FOUND),
        }
    }
    let ct = content_type_for_path(&file_path.to_string_lossy());
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    match open_ranged(&file_path, range).await {
        Ok((body, len, content_range)) => {
            let mut res = Response::new(body);
            let h = res.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&ct) {
                h.insert(header::CONTENT_TYPE, v);
            }
            h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static(UPLOADS_CACHE_CONTROL));
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            if let Some(cr) = content_range {
                if let Ok(v) = HeaderValue::from_str(&cr) {
                    h.insert(header::CONTENT_RANGE, v);
                }
                *res.status_mut() = StatusCode::PARTIAL_CONTENT;
            }
            res
        }
        Err(e) => io_status(&e),
    }
}

async fn open_ranged(path: &std::path::Path, range: Option<&str>) -> std::io::Result<(Body, u64, Option<String>)> {
    let mut file = tokio::fs::File::open(path).await?;
    // Kích thước từ tệp đã mở: upload đè chen giữa không làm lệch Content-Length.
    let size = file.metadata().await?.len();
    let (len, cr) = match parse_range(range, size) {
        Some(r) => {
            file.seek(std::io::SeekFrom::Start(r.start)).await?;
            (r.len(), Some(format!("bytes {}-{}/{}", r.start, r.end, size)))
        }
        None => (size, None),
    };
    let stream = tokio_util::io::ReaderStream::new(file.take(len));
    Ok((Body::from_stream(stream), len, cr))
}

fn io_status(e: &std::io::Error) -> Response {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound | NotADirectory | InvalidFilename => empty(StatusCode::NOT_FOUND),
        _ => empty(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// `decodeURIComponent` cho một segment: `None` khi `%` hỏng hoặc kết quả không phải UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let hi = hex(*b.get(i + 1)?)?;
            let lo = hex(*b.get(i + 2)?)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
