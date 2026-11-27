//! X10: lớp header bảo mật chung.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, Request, header};
use axum::middleware::from_fn_with_state;
use axum::response::IntoResponse;
use axum::routing::get;
use tower::ServiceExt;
use trinity_http::edge::security_headers::{SecurityHeadersConfig, security_headers_layer};

fn cfg(pairs: &[(&str, &str)], production: bool, https: bool) -> SecurityHeadersConfig {
    let owned: Vec<(String, String)> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    SecurityHeadersConfig::from_lookup(
        |k| owned.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()),
        production,
        https,
    )
}

fn app(c: SecurityHeadersConfig) -> Router {
    Router::new()
        .route("/", get(|| async { "ok" }))
        .route(
            "/own",
            get(|| async { ([(header::X_FRAME_OPTIONS, "SAMEORIGIN")], "own").into_response() }),
        )
        .layer(from_fn_with_state(Arc::new(c), security_headers_layer))
}

async fn get_headers(app: Router, path: &str, proto: Option<&str>) -> axum::http::HeaderMap {
    let mut b = Request::builder().uri(path);
    if let Some(p) = proto {
        b = b.header("x-forwarded-proto", p);
    }
    app.oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap()
        .headers()
        .clone()
}

#[tokio::test]
async fn header_co_ban() {
    let h = get_headers(app(cfg(&[], true, false)), "/", None).await;
    assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(h[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(h[header::CONTENT_SECURITY_POLICY], "frame-ancestors 'none'");
    assert_eq!(h[header::REFERRER_POLICY], "strict-origin-when-cross-origin");
    // http thường: không HSTS.
    assert!(h.get(header::STRICT_TRANSPORT_SECURITY).is_none());
}

#[tokio::test]
async fn hsts_khi_listener_https() {
    let h = get_headers(app(cfg(&[], true, true)), "/", None).await;
    assert_eq!(
        h[header::STRICT_TRANSPORT_SECURITY],
        HeaderValue::from_static("max-age=31536000; includeSubDomains")
    );
}

#[tokio::test]
async fn hsts_theo_forwarded_proto_chi_khi_tin_proxy() {
    let khong_tin = get_headers(app(cfg(&[], true, false)), "/", Some("https")).await;
    assert!(khong_tin.get(header::STRICT_TRANSPORT_SECURITY).is_none());
    let tin = get_headers(
        app(cfg(
            &[("TRUST_FORWARDED_PROTO", "true"), ("HSTS_MAX_AGE", "600")],
            true,
            false,
        )),
        "/",
        Some("https, http"),
    )
    .await;
    assert_eq!(tin[header::STRICT_TRANSPORT_SECURITY], "max-age=600; includeSubDomains");
    let http = get_headers(
        app(cfg(&[("TRUST_FORWARDED_PROTO", "true")], true, false)),
        "/",
        Some("http"),
    )
    .await;
    assert!(http.get(header::STRICT_TRANSPORT_SECURITY).is_none());
}

#[tokio::test]
async fn hsts_tat_ngoai_production_va_khi_cau_hinh_khong() {
    let dev = get_headers(app(cfg(&[], false, true)), "/", None).await;
    assert!(dev.get(header::STRICT_TRANSPORT_SECURITY).is_none());
    let tat = get_headers(app(cfg(&[("HSTS_MAX_AGE", "0")], true, true)), "/", None).await;
    assert!(tat.get(header::STRICT_TRANSPORT_SECURITY).is_none());
    let khong_con = get_headers(app(cfg(&[("HSTS_INCLUDE_SUBDOMAINS", "false")], true, true)), "/", None).await;
    assert_eq!(khong_con[header::STRICT_TRANSPORT_SECURITY], "max-age=31536000");
}

#[tokio::test]
async fn giu_header_da_co_va_cho_phep_doi_frame_ancestors() {
    let h = get_headers(app(cfg(&[], true, false)), "/own", None).await;
    assert_eq!(h[header::X_FRAME_OPTIONS], "SAMEORIGIN");
    let h = get_headers(app(cfg(&[("FRAME_ANCESTORS", "'self'")], true, false)), "/", None).await;
    assert_eq!(h[header::CONTENT_SECURITY_POLICY], "frame-ancestors 'self'");
    assert!(h.get(header::X_FRAME_OPTIONS).is_none());
}
