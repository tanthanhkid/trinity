//! K18: bật và lui web tĩnh bằng tệp sở hữu (`"web": "rust"` / `"web": "node"`), qua bộ phân phối thật.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::routing::get;
use tower::ServiceExt;
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::strangler::{NodeProxy, OwnershipTable, ProxyTimeouts, dispatcher_full};
use trinity_http::web::{WebConfig, WebService};
use trinity_kernel::config::EnvMap;

const SECRET: &str = "k18-service-secret-0123456789abcdef";

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("trinity-k18-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn app(table: Arc<OwnershipTable>, out: PathBuf) -> Router {
    let env: EnvMap = [("INTERNAL_SERVICE_SECRET".to_owned(), SECRET.to_owned())]
        .into_iter()
        .collect();
    let ip = Arc::new(
        ClientIpResolver::from_env(
            &env,
            NetProbe::Fixed {
                route_table: None,
                in_container: false,
            },
        )
        .unwrap(),
    );
    // Node không tồn tại: request nào bị chuyển tiếp sẽ ra 502.
    let proxy = NodeProxy::new(
        "http://127.0.0.1:9".parse().unwrap(),
        None,
        Some(SECRET.to_owned()),
        ProxyTimeouts::default(),
    );
    let rust = Router::new().route("/api/v1/ping", get(|| async { "pong" }));
    let web = Arc::new(WebService::new(WebConfig {
        dir: out,
        store_domain: None,
        site_config: serde_json::json!({}),
        build_id: "t".to_owned(),
    }));
    dispatcher_full(table, rust, proxy, ip, None, Some(web))
}

async fn call(app: &Router, path: &str, cookie: Option<&str>) -> (StatusCode, String) {
    let mut b = Request::builder().uri(path).header("host", "app.test");
    if let Some(c) = cookie {
        b = b.header("cookie", c);
    }
    let mut req = b.body(Body::empty()).unwrap();
    let peer: SocketAddr = "203.0.113.9:50000".parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(peer));
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let loc = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = String::from_utf8_lossy(&to_bytes(resp.into_body(), 1 << 20).await.unwrap()).into_owned();
    (status, loc.unwrap_or(body))
}

#[tokio::test]
async fn bat_web_rust_roi_lui_ve_node_bang_tep_so_huu() {
    let out = tmp("out");
    std::fs::write(
        out.join("login.html"),
        "<html><head></head><body>trang dang nhap</body></html>",
    )
    .unwrap();
    let file = tmp("own").join("ownership.json");
    let rules = r#"{"prefix": "/api/v1/ping", "owner": "rust"}"#;
    std::fs::write(&file, format!(r#"{{"routes": [{rules}], "web": "rust"}}"#)).unwrap();
    let table = Arc::new(OwnershipTable::from_file(&file).unwrap());
    let app = app(table.clone(), out.clone());

    // web: rust ⇒ trang do Rust phục vụ, luật điều hướng áp dụng, API vẫn đi router của Rust.
    let (s, body) = call(&app, "/login", None).await;
    assert_eq!((s, body.contains("trang dang nhap")), (StatusCode::OK, true));
    let (s, loc) = call(&app, "/", None).await;
    assert_eq!((s, loc.as_str()), (StatusCode::TEMPORARY_REDIRECT, "/login"));
    let (s, loc) = call(&app, "/", Some("has_session=1")).await;
    assert_eq!((s, loc.as_str()), (StatusCode::TEMPORARY_REDIRECT, "/dashboard"));
    let (s, body) = call(&app, "/api/v1/ping", None).await;
    assert_eq!((s, body.as_str()), (StatusCode::OK, "pong"));
    // /api/v1/khac không thuộc Rust và không phải trang ⇒ chuyển tiếp sang Node (không chạy ⇒ 502).
    let (s, _) = call(&app, "/api/v1/khac", None).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);

    // Lui: đổi `web` về `node` rồi nạp lại (SIGHUP làm đúng việc này) ⇒ trang lại chuyển tiếp sang Next/Node.
    std::fs::write(&file, format!(r#"{{"routes": [{rules}], "web": "node"}}"#)).unwrap();
    assert!(table.reload().unwrap());
    let (s, _) = call(&app, "/login", None).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    let (s, body) = call(&app, "/api/v1/ping", None).await;
    assert_eq!((s, body.as_str()), (StatusCode::OK, "pong"));

    // Bật lại.
    std::fs::write(&file, format!(r#"{{"routes": [{rules}], "web": "rust"}}"#)).unwrap();
    assert!(table.reload().unwrap());
    let (s, _) = call(&app, "/login", None).await;
    assert_eq!(s, StatusCode::OK);
    let _ = std::fs::remove_dir_all(out);
}

#[tokio::test]
async fn chay_mot_minh_rust_nhan_moi_route_van_phuc_vu_trang() {
    let out = tmp("alone");
    std::fs::write(out.join("login.html"), "<html><head></head><body>x</body></html>").unwrap();
    let own = trinity_kernel::ownership::Ownership::parse(
        r#"{"routes": [{"prefix": "/", "owner": "rust"}], "web": "rust"}"#,
        "t",
    )
    .unwrap();
    let app = app(Arc::new(OwnershipTable::fixed(own)), out.clone());
    let (s, _) = call(&app, "/login", None).await;
    assert_eq!(s, StatusCode::OK);
    // Đường dẫn dành cho API không bao giờ rơi vào web tĩnh.
    let (s, body) = call(&app, "/api/v1/ping", None).await;
    assert_eq!((s, body.as_str()), (StatusCode::OK, "pong"));
    let _ = std::fs::remove_dir_all(out);
}
