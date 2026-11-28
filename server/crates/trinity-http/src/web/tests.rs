//! `WebService` trên một thư mục `out/` giả.

use std::path::PathBuf;

use axum::body::{Body, to_bytes};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, LOCATION};
use axum::http::{Method, Request, StatusCode};
use serde_json::json;

use super::*;

fn out_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("trinity-web-svc-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let page = |title: &str| format!("<html><head><title>{title}</title></head><body>{title}</body></html>");
    for (f, body) in [
        ("login.html", page("login")),
        ("dashboard.html", page("dashboard")),
        ("privacy.html", page("privacy")),
        ("terms.html", page("terms")),
        ("404.html", page("het")),
        ("s/_.html", page("cua-hang")),
        ("contacts/_.html", page("contact")),
        ("oauth/authorize.html", page("authorize")),
        ("_next/static/a.js", "console.log(1)".to_owned()),
        ("logo.svg", "<svg/>".to_owned()),
    ] {
        let p = dir.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    dir
}

fn service(tag: &str, store_domain: Option<&str>) -> (WebService, PathBuf) {
    let dir = out_dir(tag);
    let svc = WebService::new(WebConfig {
        dir: dir.clone(),
        store_domain: store_domain.map(str::to_owned),
        site_config: json!({"legal": {"company_name": "Công ty A <b>", "company_tax_id": null}}),
        build_id: "abc123".to_owned(),
    });
    (svc, dir)
}

fn get(path: &str, host: &str, cookie: Option<&str>) -> Request<Body> {
    let mut b = Request::builder().method(Method::GET).uri(path).header("host", host);
    if let Some(c) = cookie {
        b = b.header("cookie", c);
    }
    b.body(Body::empty()).unwrap()
}

async fn text(resp: Response) -> String {
    String::from_utf8(to_bytes(resp.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
}

fn header<'a>(resp: &'a Response, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

#[test]
fn duong_dan_danh_rieng_khong_vao_web_tinh() {
    let (svc, dir) = service("reserved", None);
    for p in [
        "/api/v1/contacts",
        "/api",
        "/notif-ws",
        "/uploads/a.png",
        "/docs",
        "/.well-known/oauth-authorization-server",
        "/health",
    ] {
        assert!(!svc.handles(&Method::GET, p), "{p}");
    }
    for p in [
        "/",
        "/login",
        "/apiary",
        "/contacts/1",
        "/api/build-id",
        "/_next/static/a.js",
    ] {
        assert!(svc.handles(&Method::GET, p), "{p}");
    }
    assert!(svc.handles(&Method::HEAD, "/login"));
    assert!(!svc.handles(&Method::POST, "/login"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn goc_chuyen_huong_theo_cookie() {
    let (svc, dir) = service("root", None);
    let r = svc.serve(get("/", "app.test", None)).await;
    assert_eq!(r.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(header(&r, LOCATION.as_str()), Some("/login"));
    assert_eq!(header(&r, CACHE_CONTROL.as_str()), Some("no-store, must-revalidate"));
    let r = svc.serve(get("/", "app.test", Some("has_session=1"))).await;
    assert_eq!(header(&r, LOCATION.as_str()), Some("/dashboard"));
    // Cookie rỗng không tính là đã đăng nhập.
    let r = svc.serve(get("/", "app.test", Some("access_token="))).await;
    assert_eq!(header(&r, LOCATION.as_str()), Some("/login"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn trang_cong_khai_va_no_store() {
    let (svc, dir) = service("public", None);
    let r = svc.serve(get("/login", "app.test", None)).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(header(&r, "content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(header(&r, CACHE_CONTROL.as_str()), Some("no-store, must-revalidate"));
    assert_eq!(header(&r, "pragma"), Some("no-cache"));
    assert_eq!(header(&r, "x-content-type-options"), Some("nosniff"));
    assert!(text(r).await.contains("login"));
    // Trang riêng khi chưa đăng nhập ⇒ /login; có cookie thì vào, đoạn động dùng trang giữ chỗ.
    let r = svc.serve(get("/contacts/42", "app.test", None)).await;
    assert_eq!(header(&r, LOCATION.as_str()), Some("/login"));
    let r = svc.serve(get("/contacts/42", "app.test", Some("access_token=t"))).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert!(text(r).await.contains("contact"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn tai_nguyen_tinh_cache_dung_loai() {
    let (svc, dir) = service("assets", None);
    let r = svc.serve(get("/_next/static/a.js", "app.test", None)).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        header(&r, CACHE_CONTROL.as_str()),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(header(&r, "content-type"), Some("text/javascript; charset=utf-8"));
    let r = svc.serve(get("/logo.svg", "app.test", None)).await;
    assert_eq!(
        header(&r, CACHE_CONTROL.as_str()),
        Some("public, max-age=86400, stale-while-revalidate=604800")
    );
    // Tài nguyên thiếu: 404 trơn; trang thiếu: trang 404 của Next, mã 404.
    let r = svc.serve(get("/_next/static/none.js", "app.test", None)).await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(text(r).await, "Not Found");
    let r = svc.serve(get("/khong-co", "app.test", Some("has_session=1"))).await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert!(text(r).await.contains("het"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn assistant_va_build_id_va_oauth_authorize() {
    let (svc, dir) = service("misc", None);
    let r = svc.serve(get("/assistant/x", "app.test", None)).await;
    assert_eq!(r.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(header(&r, LOCATION.as_str()), Some("/settings?tab=integrations"));
    let r = svc.serve(get("/api/build-id", "app.test", None)).await;
    assert_eq!(header(&r, CACHE_CONTROL.as_str()), Some("no-store, must-revalidate"));
    assert_eq!(text(r).await, r#"{"buildId":"abc123"}"#);
    let r = svc.serve(get("/oauth/authorize?client_id=a", "app.test", None)).await;
    assert_eq!(
        header(&r, LOCATION.as_str()),
        Some("/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Da")
    );
    let r = svc
        .serve(get("/oauth/authorize?client_id=a", "app.test", Some("access_token=t")))
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        header(&r, CONTENT_SECURITY_POLICY.as_str()),
        Some("frame-ancestors 'none'")
    );
    assert_eq!(header(&r, "x-frame-options"), Some("DENY"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn ten_mien_phu_chen_slug_vao_html() {
    let (svc, dir) = service("store", Some("Shop.Example.com"));
    let r = svc.serve(get("/", "cua-hang-1.shop.example.com", None)).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(header(&r, CACHE_CONTROL.as_str()), Some("no-store, must-revalidate"));
    let html = text(r).await;
    assert!(
        html.contains(r#"<meta name="store-slug" content="cua-hang-1"></head>"#),
        "{html}"
    );
    // Trang khác của tên miền phụ cũng là trang cửa hàng; tên miền chính thì không chèn.
    let r = svc.serve(get("/bat-ky", "cua-hang-1.shop.example.com", None)).await;
    assert!(text(r).await.contains("store-slug"));
    let r = svc.serve(get("/s/cua-hang-1", "app.test", None)).await;
    assert!(!text(r).await.contains("store-slug"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn privacy_terms_chen_gia_tri_phap_ly() {
    let (svc, dir) = service("legal", None);
    for p in ["/privacy", "/terms"] {
        let html = text(svc.serve(get(p, "app.test", None)).await).await;
        assert!(
            html.contains(r#"<script id="trinity-site-config" type="application/json">"#),
            "{p}"
        );
        assert!(html.contains("C\u{00f4}ng ty A \\u003cb\\u003e"), "{html}");
        assert!(html.contains("</script></head>"), "{p}");
    }
    // Trang khác không có khối này.
    let html = text(svc.serve(get("/login", "app.test", None)).await).await;
    assert!(!html.contains("trinity-site-config"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn head_khong_co_than_nhung_co_do_dai() {
    let (svc, dir) = service("head", None);
    let req = Request::builder()
        .method(Method::HEAD)
        .uri("/login")
        .header("host", "app.test")
        .body(Body::empty())
        .unwrap();
    let r = svc.serve(req).await;
    assert_eq!(r.status(), StatusCode::OK);
    let len: usize = header(&r, "content-length").unwrap().parse().unwrap();
    assert!(len > 0);
    assert!(to_bytes(r.into_body(), 1 << 20).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn sw_js_khong_can_cookie_va_khong_cache() {
    // `sw-kill` nằm cạnh `WEB_DIR` (không trong đó): dựng cây riêng để không đụng test khác.
    let base = std::env::temp_dir().join(format!("trinity-web-sw-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = base.join("out");
    std::fs::create_dir_all(&dir).unwrap();
    let svc = WebService::new(WebConfig {
        dir: dir.clone(),
        store_domain: None,
        site_config: json!({}),
        build_id: "abc123".to_owned(),
    });
    // Chưa có sw.js (build cũ): trả bản tự huỷ để Service Worker đã cài tự gỡ.
    let r = svc.serve(get("/sw.js", "app.test", None)).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        header(&r, CACHE_CONTROL.as_str()),
        Some("no-cache, max-age=0, must-revalidate")
    );
    assert_eq!(header(&r, "service-worker-allowed"), Some("/"));
    assert!(text(r).await.contains("unregister"));
    // Có sw.js: phục vụ nguyên văn, không bị chuyển hướng /login dù không có phiên.
    std::fs::write(dir.join("sw.js"), "const BUILD_ID='x'").unwrap();
    let r = svc.serve(get("/sw.js", "app.test", None)).await;
    assert_eq!(text(r).await, "const BUILD_ID='x'");
    // Tệp sw-kill cạnh out/ ⇒ tắt khẩn (build xoá out/ nhưng không đụng tệp này).
    std::fs::write(base.join("sw-kill"), "").unwrap();
    let r = svc.serve(get("/sw.js", "app.test", None)).await;
    assert!(text(r).await.contains("unregister"));
    let _ = std::fs::remove_dir_all(base);
}

#[tokio::test]
async fn html_co_header_link_preload() {
    let (svc, dir) = service("link", None);
    std::fs::write(
        dir.join("login.html"),
        r#"<html><head><script src="/_next/static/chunks/m.js" async></script></head></html>"#,
    )
    .unwrap();
    let r = svc.serve(get("/login", "app.test", None)).await;
    assert_eq!(
        header(&r, "link"),
        Some("</_next/static/chunks/m.js>; rel=preload; as=script")
    );
    // Tài nguyên không phải HTML thì không có Link.
    let r = svc.serve(get("/_next/static/a.js", "app.test", None)).await;
    assert_eq!(header(&r, "link"), None);
    let _ = std::fs::remove_dir_all(dir);
}
