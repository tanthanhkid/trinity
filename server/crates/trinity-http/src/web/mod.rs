//! Phục vụ web tĩnh (K18, docs/rust/PLAN.md mục 5 và 4.14): bản xuất `out/` của `next build` (`output: 'export'`) và
//! luật điều hướng của `proxy.ts`.
//!
//! - [`nav`]: chuyển hướng theo cookie, `no-store`, `/assistant`, tên miền phụ cửa hàng (`STORE_DOMAIN`), bảng ca khớp
//!   `proxy.ts`.
//! - [`assets`]: tìm tệp trong `WEB_DIR`, đoạn động thay bằng trang giữ chỗ `_` (R004, phương án A).
//! - [`inject`]: chèn slug cửa hàng và cấu hình pháp lý (`LEGAL_*`, từ `site-config`) vào HTML.
//! - [`WebService`]: ghép ba phần trên, gắn header `Cache-Control` và header bảo mật. Bật bằng `"web": "rust"` trong
//!   tệp sở hữu (đọc mỗi request nên `SIGHUP` đổi được ngay); `"web": "node"` thì [`crate::strangler`] chuyển tiếp
//!   trang sang Next như trước.
//!
//! Chuyển tiếp không đổi: `/api/*`, `/notif-ws`, `/uploads`, `/docs`, `/.well-known`, `/health`… không bao giờ do
//! [`WebService`] nhận (xem [`is_reserved`]); chúng vẫn đi router của Rust hoặc proxy sang Node như K17.

pub mod assets;
pub mod inject;
pub mod nav;

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, HOST, LOCATION, VARY,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use serde_json::Value;

use self::assets::{WebAssets, content_type};
use self::nav::{Nav, NavRequest, assistant_redirect, decide, matcher_skips};

/// Cấu hình dịch vụ web.
#[derive(Debug, Clone)]
pub struct WebConfig {
    /// `WEB_DIR`: thư mục `out/`.
    pub dir: PathBuf,
    /// `STORE_DOMAIN`: bật rewrite tên miền phụ trang bán hàng.
    pub store_domain: Option<String>,
    /// Nội dung `GET /api/v1/site-config`, chèn vào `/privacy` và `/terms`.
    pub site_config: Value,
    /// Giá trị trả ở `GET /api/build-id` (`unknown` khi không biết).
    pub build_id: String,
}

/// Đường dẫn không bao giờ thuộc web tĩnh (API, socket, tệp tải lên, tài liệu, metadata OAuth, sức khoẻ).
const RESERVED: [&str; 10] = [
    "/api",
    "/notif-ws",
    "/uploads",
    "/docs",
    "/.well-known",
    "/health",
    "/ready",
    "/live",
    "/internal",
    "/metrics",
];

/// `/api/build-id` là route của Next nên web tĩnh nhận (Rust trả build id).
const BUILD_ID_PATH: &str = "/api/build-id";

fn under(path: &str, prefix: &str) -> bool {
    path == prefix || path.strip_prefix(prefix).is_some_and(|r| r.starts_with('/'))
}

/// Đường dẫn dành cho API, socket, tệp tải lên hay metadata: web tĩnh không nhận.
pub fn is_reserved(path: &str) -> bool {
    path != BUILD_ID_PATH && RESERVED.iter().any(|p| under(path, p))
}

/// Dịch vụ phục vụ trang.
pub struct WebService {
    assets: WebAssets,
    store_domain: Option<String>,
    site_config: Value,
    build_id: String,
}

/// `private` để proxy dùng chung (CDN, Caddy) không giữ: phản hồi của trang phụ thuộc cookie phiên (chuyển hướng /login,
/// /dashboard), một bản 307 bị cache sẽ đá cả người đã đăng nhập về /login. Kèm `Vary: Cookie`.
const NO_STORE: &str = "private, no-store, must-revalidate";
/// Service Worker (`/sw.js`) luôn được trình duyệt hỏi lại. Tắt khẩn: biến môi trường `TRINITY_SW_KILL=1`, hoặc tệp
/// `sw-kill` NGOÀI `WEB_DIR` (cạnh nó: `<WEB_DIR>/../sw-kill`) — build xoá sạch `out/` nên tệp đặt trong đó sẽ mất.
const SW_PATH: &str = "/sw.js";
const SW_KILL_FILE: &str = "sw-kill";
/// Bản tự huỷ: xoá mọi cache `trinity-*`, huỷ đăng ký, tải lại các tab để về bản không qua Service Worker.
const SW_KILL_SCRIPT: &str = "self.addEventListener('install',()=>self.skipWaiting());\
self.addEventListener('activate',e=>e.waitUntil((async()=>{\
for(const k of await caches.keys())if(k.startsWith('trinity-'))await caches.delete(k);\
await self.registration.unregister();\
for(const c of await self.clients.matchAll({type:'window'}))c.navigate(c.url).catch(()=>{});\
})()));\
self.addEventListener('fetch',()=>{});\
";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const IMAGE_CACHE: &str = "public, max-age=86400, stale-while-revalidate=604800";

impl WebService {
    pub fn new(config: WebConfig) -> Self {
        Self {
            assets: WebAssets::new(config.dir),
            store_domain: config
                .store_domain
                .map(|d| d.trim().to_ascii_lowercase())
                .filter(|d| !d.is_empty()),
            site_config: config.site_config,
            build_id: config.build_id,
        }
    }

    pub fn dir(&self) -> &Path {
        self.assets.root()
    }

    /// Web tĩnh có nhận request này không (khi `web: rust`)? Chỉ GET/HEAD vào đường dẫn không thuộc [`is_reserved`].
    pub fn handles(&self, method: &Method, path: &str) -> bool {
        (method == Method::GET || method == Method::HEAD) && !is_reserved(path)
    }

    /// Phục vụ một request đã qua [`handles`](Self::handles).
    pub async fn serve(&self, req: Request) -> Response {
        let head = req.method() == Method::HEAD;
        let path = req.uri().path().to_owned();
        if path == BUILD_ID_PATH {
            return self.build_id_response(head);
        }
        if path == SW_PATH {
            return self.sw_response(head).await;
        }
        if let Some(to) = assistant_redirect(&path) {
            return redirect(to);
        }
        // Mọi thứ mượn từ `req` gói trong khối này: không giữ tham chiếu qua `.await`.
        let decision = {
            let host = host_of(&req);
            let cookies = cookie_names_with_value(req.headers());
            let nav_req = NavRequest {
                host: &host,
                path: &path,
                query: req.uri().query(),
                has_access_token: cookies.contains(&"access_token"),
                has_session: cookies.contains(&"has_session"),
            };
            decide(&nav_req, self.store_domain.as_deref())
        };
        let (lookup, slug, no_store) = match decision {
            Nav::Redirect { location } => return redirect(&location),
            Nav::Pass { no_store } => (path.clone(), None, no_store),
            Nav::Store { slug } => (format!("/s/{slug}"), Some(slug), true),
        };
        let skipped = matcher_skips(&path);
        self.file_response(lookup, &path, slug.as_deref(), no_store, skipped, head)
            .await
    }

    /// `/sw.js`: không qua luật chuyển hướng theo cookie (trình duyệt tải script không kèm phiên). Có kill (xem `SW_KILL_FILE`) hoặc không
    /// có tệp ⇒ trả bản tự huỷ để các Service Worker đã cài tự gỡ.
    async fn sw_response(&self, head: bool) -> Response {
        let dir = self.assets.root().to_path_buf();
        let body = tokio::task::spawn_blocking(move || {
            let env_kill =
                std::env::var("TRINITY_SW_KILL").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes" | "on"));
            if env_kill || dir.parent().is_some_and(|p| p.join(SW_KILL_FILE).exists()) {
                return None;
            }
            std::fs::read(dir.join("sw.js")).ok()
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| SW_KILL_SCRIPT.as_bytes().to_vec());
        let mut resp = bytes_response(StatusCode::OK, "text/javascript; charset=utf-8", body, head);
        let h = resp.headers_mut();
        set(h, CACHE_CONTROL, "no-cache, max-age=0, must-revalidate");
        set(h, HeaderName::from_static("service-worker-allowed"), "/");
        set(h, HeaderName::from_static("x-content-type-options"), "nosniff");
        resp
    }

    fn build_id_response(&self, head: bool) -> Response {
        let body = serde_json::json!({ "buildId": self.build_id }).to_string();
        let mut resp = bytes_response(StatusCode::OK, "application/json", body.into_bytes(), head);
        set(resp.headers_mut(), CACHE_CONTROL, NO_STORE);
        resp
    }

    async fn file_response(
        &self,
        lookup: String,
        original: &str,
        slug: Option<&str>,
        no_store: bool,
        skipped: bool,
        head: bool,
    ) -> Response {
        let assets = self.assets.clone();
        // Chỉ điều hướng trang (không có đuôi tệp) nhận trang 404 của Next; tài nguyên thiếu trả 404 trơn.
        let is_page = !last_segment(original).contains('.');
        // Tìm và đọc tệp bằng I/O chặn, ngoài luồng async.
        let read = tokio::task::spawn_blocking(move || {
            let (file, status) = match assets.find(&lookup) {
                Some(f) => (f, StatusCode::OK),
                None if is_page => (assets.not_found_page()?, StatusCode::NOT_FOUND),
                None => return None,
            };
            let bytes = std::fs::read(&file).ok()?;
            Some((file, status, bytes))
        })
        .await
        .ok()
        .flatten();
        let Some((file, status, bytes)) = read else {
            return plain_not_found(head);
        };
        let ctype = content_type(&file);
        let is_html = ctype.starts_with("text/html");
        let body = if is_html && status == StatusCode::OK {
            self.inject(bytes, original, slug)
        } else {
            bytes
        };
        // Early Hints: CDN đọc `Link: rel=preload` để phát 103 trước khi HTML về. Chỉ trang thật (không phải trang cửa hàng).
        let link = (is_html && status == StatusCode::OK && slug.is_none())
            .then(|| std::str::from_utf8(&body).ok().and_then(inject::preload_link_header))
            .flatten();
        let mut resp = bytes_response(status, ctype, body, head);
        let h = resp.headers_mut();
        if let Some(v) = link.and_then(|l| HeaderValue::from_str(&l).ok()) {
            h.insert(HeaderName::from_static("link"), v);
        }
        set(h, HeaderName::from_static("x-content-type-options"), "nosniff");
        if no_store {
            set(h, CACHE_CONTROL, NO_STORE);
            set(h, VARY, "Cookie");
            set(h, HeaderName::from_static("pragma"), "no-cache");
        } else if original.starts_with("/_next/static/") {
            set(h, CACHE_CONTROL, IMMUTABLE);
        } else if is_image_or_font(original) {
            set(h, CACHE_CONTROL, IMAGE_CACHE);
        } else if is_html && !skipped {
            set(h, CACHE_CONTROL, NO_STORE);
            set(h, VARY, "Cookie");
        }
        if original == "/oauth/authorize" {
            // Màn đồng ý OAuth không được nhúng vào khung của trang khác (clickjacking).
            set(h, CONTENT_SECURITY_POLICY, "frame-ancestors 'none'");
            set(h, HeaderName::from_static("x-frame-options"), "DENY");
            set(h, HeaderName::from_static("referrer-policy"), "no-referrer");
        }
        resp
    }

    /// Chèn slug (tên miền phụ) và cấu hình pháp lý (`/privacy`, `/terms`) vào HTML.
    fn inject(&self, bytes: Vec<u8>, original: &str, slug: Option<&str>) -> Vec<u8> {
        let legal = matches!(original.trim_end_matches('/'), "/privacy" | "/terms");
        if slug.is_none() && !legal {
            return bytes;
        }
        let html = match String::from_utf8(bytes) {
            Ok(h) => h,
            Err(e) => return e.into_bytes(),
        };
        let mut snippet = String::new();
        if let Some(slug) = slug {
            snippet.push_str(&inject::store_slug_meta(slug));
        }
        if legal {
            snippet.push_str(&inject::site_config_script(&self.site_config));
        }
        inject::insert_before_head_end(&html, &snippet).into_bytes()
    }
}

fn last_segment(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

fn is_image_or_font(path: &str) -> bool {
    let ext = last_segment(path).rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("svg" | "jpg" | "jpeg" | "png" | "webp" | "avif" | "ico" | "woff" | "woff2")
    )
}

fn host_of(req: &Request) -> String {
    req.headers()
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_owned()))
        .unwrap_or_default()
}

/// Tên các cookie có giá trị khác rỗng (`request.cookies.get(name)?.value` của Next).
fn cookie_names_with_value(headers: &HeaderMap) -> Vec<&str> {
    let mut out = Vec::new();
    for v in headers.get_all(COOKIE) {
        let Ok(s) = v.to_str() else { continue };
        for pair in s.split(';') {
            if let Some((name, value)) = pair.trim().split_once('=')
                && !value.trim().is_empty()
            {
                out.push(name.trim());
            }
        }
    }
    out
}

fn set(h: &mut HeaderMap, name: HeaderName, value: &'static str) {
    h.insert(name, HeaderValue::from_static(value));
}

fn redirect(location: &str) -> Response {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::TEMPORARY_REDIRECT;
    if let Ok(v) = HeaderValue::from_str(location) {
        resp.headers_mut().insert(LOCATION, v);
    }
    set(resp.headers_mut(), CACHE_CONTROL, NO_STORE);
    set(resp.headers_mut(), VARY, "Cookie");
    set(resp.headers_mut(), HeaderName::from_static("pragma"), "no-cache");
    resp
}

fn bytes_response(status: StatusCode, ctype: &str, body: Vec<u8>, head: bool) -> Response {
    let len = body.len();
    let mut resp = Response::new(if head { Body::empty() } else { Body::from(body) });
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(ctype) {
        h.insert(CONTENT_TYPE, v);
    }
    h.insert(CONTENT_LENGTH, HeaderValue::from(len));
    resp
}

fn plain_not_found(head: bool) -> Response {
    bytes_response(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        b"Not Found".to_vec(),
        head,
    )
}

#[cfg(test)]
mod tests;
