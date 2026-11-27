//! K28: so sánh shadow qua dispatcher thật với một "Node" giả nghe loopback và router Rust giả.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::strangler::{
    NodeProxy, OwnershipTable, ProxyTimeouts, Shadow, ShadowConfig, ShadowRoutes, dispatcher_with_shadow,
};
use trinity_kernel::config::EnvMap;

const CONTRACT: &str = r#"{"routes":[
  {"method":"GET","path":"/api/v1/things","safe_for_shadow":true,"cached":false,"min_samples":2},
  {"method":"GET","path":"/api/v1/things/:id","safe_for_shadow":true,"cached":false,"min_samples":2},
  {"method":"GET","path":"/api/v1/counts","safe_for_shadow":true,"cached":true,"min_samples":2},
  {"method":"GET","path":"/api/v1/unsafe","safe_for_shadow":false,"cached":false,"min_samples":50},
  {"method":"GET","path":"/api/v1/slow","safe_for_shadow":true,"cached":false,"min_samples":1},
  {"method":"GET","path":"/api/v1/net","safe_for_shadow":true,"cached":false,"min_samples":1},
  {"method":"POST","path":"/api/v1/things","safe_for_shadow":true}]}"#;

fn json_resp(v: Value) -> axum::response::Response {
    axum::Json(v).into_response()
}

async fn serve(app: Router) -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    addr
}

struct Harness {
    app: Router,
    shadow: Arc<Shadow>,
    rust_hits: Arc<AtomicUsize>,
    node_hits: Arc<AtomicUsize>,
}

/// Node trả `{"v":"node-secret","n":1}`, Rust trả `rust_body` (đổi được). `/net` ở Rust gọi mạng (bị chặn), `/slow` ở Rust ngủ 800ms.
async fn harness(rate: f64, rust_body: Value, sampler: Option<f64>) -> Harness {
    let node_hits = Arc::new(AtomicUsize::new(0));
    let nh = node_hits.clone();
    let node_handler = move || {
        let nh = nh.clone();
        async move {
            nh.fetch_add(1, Ordering::SeqCst);
            json_resp(json!({ "v": "node-secret", "n": 1 }))
        }
    };
    let node = Router::new()
        .route("/api/v1/things", get(node_handler.clone()).post(node_handler.clone()))
        .route("/api/v1/things/{id}", get(node_handler.clone()))
        .route("/api/v1/counts", get(node_handler.clone()))
        .route("/api/v1/unsafe", get(node_handler.clone()))
        .route("/api/v1/slow", get(node_handler.clone()))
        .route("/api/v1/net", get(node_handler));
    let addr = serve(node).await;

    let rust_hits = Arc::new(AtomicUsize::new(0));
    let (rh, body) = (rust_hits.clone(), rust_body);
    let echo = move || {
        let (rh, body) = (rh.clone(), body.clone());
        async move {
            rh.fetch_add(1, Ordering::SeqCst);
            json_resp(body)
        }
    };
    let rh2 = rust_hits.clone();
    let net = move || {
        let rh = rh2.clone();
        async move {
            rh.fetch_add(1, Ordering::SeqCst);
            // Handler "GET có tác dụng phụ ra mạng": trong shadow bị từ chối và ghi vi phạm.
            match trinity_kernel::shadow::forbid_outbound("graph") {
                Ok(()) => json_resp(json!({ "sent": true })),
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "denied").into_response(),
            }
        }
    };
    let rh3 = rust_hits.clone();
    let slow = move || {
        let rh = rh3.clone();
        async move {
            rh.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(800)).await;
            json_resp(json!({ "v": "node-secret", "n": 1 }))
        }
    };
    let rust = Router::new()
        .route("/api/v1/things", get(echo.clone()).post(echo.clone()))
        .route("/api/v1/things/{id}", get(echo.clone()))
        .route("/api/v1/counts", get(echo.clone()))
        .route("/api/v1/unsafe", get(echo))
        .route("/api/v1/slow", get(slow))
        .route("/api/v1/net", get(net))
        .route("/api/v1/post-only", post(|| async { "x" }));

    let cfg = ShadowConfig {
        sample_rate: rate,
        ..ShadowConfig::default()
    };
    let mut shadow = Shadow::new(cfg, ShadowRoutes::from_contract(CONTRACT).unwrap());
    if let Some(s) = sampler {
        shadow = shadow.with_sampler(move || s);
    }
    let probe = NetProbe::Fixed {
        route_table: None,
        in_container: false,
    };
    let ip = Arc::new(ClientIpResolver::from_env(&EnvMap::default(), probe).unwrap());
    let proxy = NodeProxy::new(
        format!("http://{addr}").parse().unwrap(),
        None,
        None,
        ProxyTimeouts::default(),
    );
    // Mọi thứ thuộc Node (bảng rỗng ⇒ Node): shadow chạy Rust cho GET `safe_for_shadow`.
    let app = dispatcher_with_shadow(
        Arc::new(OwnershipTable::fixed(Default::default())),
        rust,
        proxy,
        ip,
        Some(shadow.clone()),
    );
    Harness {
        app,
        shadow,
        rust_hits,
        node_hits,
    }
}

async fn get_body(h: &Harness, method: &str, path: &str) -> (StatusCode, String, Duration) {
    let t = Instant::now();
    let req = Request::builder().method(method).uri(path).body(Body::empty()).unwrap();
    let resp = h.app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned(), t.elapsed())
}

/// Chờ shadow ghi xong `n` mẫu cho route.
async fn wait_samples(h: &Harness, route: &str, n: u64) -> Value {
    for _ in 0..100 {
        let rep = h.shadow.report();
        let row = rep["routes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["route"] == route)
            .cloned()
            .unwrap();
        if row["samples"].as_u64().unwrap() >= n || row["unshadowable"].is_string() {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("shadow không ghi đủ mẫu cho {route}: {}", h.shadow.report());
}

#[tokio::test]
async fn giong_nhau_dem_mau_theo_route_va_response_chinh_khong_doi() {
    let h = harness(1.0, json!({ "v": "node-secret", "n": 1 }), None).await;
    let (st, body, _) = get_body(&h, "GET", "/api/v1/things/7").await;
    assert_eq!(st, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({ "v": "node-secret", "n": 1 })
    );
    get_body(&h, "GET", "/api/v1/things/8").await;
    let row = wait_samples(&h, "GET /api/v1/things/:id", 2).await;
    assert_eq!(
        (
            row["samples"].as_u64(),
            row["equal"].as_u64(),
            row["different"].as_u64()
        ),
        (Some(2), Some(2), Some(0))
    );
    assert_eq!(row["reached_min_samples"], true);
    // Báo cáo liệt kê cả route chưa có mẫu.
    let rep = h.shadow.report();
    let none = rep["routes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["route"] == "GET /api/v1/things")
        .unwrap();
    assert_eq!(
        (none["samples"].as_u64(), none["reached_min_samples"].as_bool()),
        (Some(0), Some(false))
    );
}

#[tokio::test]
async fn khac_biet_chi_ghi_duong_dan_khong_ghi_gia_tri() {
    let h = harness(1.0, json!({ "v": "rust-khac-gia-tri", "n": 1, "extra": "x" }), None).await;
    get_body(&h, "GET", "/api/v1/things").await;
    let row = wait_samples(&h, "GET /api/v1/things", 1).await;
    assert_eq!(row["different"], 1);
    assert_eq!(row["diff_paths"], json!({ "$.extra": 1, "$.v": 1 }));
    let dump = h.shadow.report().to_string();
    for secret in ["node-secret", "rust-khac-gia-tri"] {
        assert!(!dump.contains(secret), "báo cáo không được chứa giá trị: {dump}");
    }
}

#[tokio::test]
async fn route_cached_chi_so_hinh_dang_tren_luu_luong_that() {
    // Số khác nhau (cache của Node cũ tới 60 giây) KHÔNG phải khác biệt; kiểu khác thì có.
    let h = harness(1.0, json!({ "v": "node-secret", "n": 999 }), None).await;
    get_body(&h, "GET", "/api/v1/counts").await;
    let row = wait_samples(&h, "GET /api/v1/counts", 1).await;
    assert_eq!((row["equal"].as_u64(), row["different"].as_u64()), (Some(1), Some(0)));
    let h = harness(1.0, json!({ "v": "node-secret", "n": "1" }), None).await;
    get_body(&h, "GET", "/api/v1/counts").await;
    let row = wait_samples(&h, "GET /api/v1/counts", 1).await;
    assert_eq!(row["diff_paths"], json!({ "$.n": 1 }));
}

#[tokio::test]
async fn ty_le_0_tat_hoan_toan() {
    let h = harness(0.0, json!({}), None).await;
    for _ in 0..5 {
        assert_eq!(get_body(&h, "GET", "/api/v1/things").await.0, 200);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.rust_hits.load(Ordering::SeqCst), 0, "Rust không được chạy lần nào");
    assert_eq!(h.node_hits.load(Ordering::SeqCst), 5);
    assert!(
        h.shadow.report()["routes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["samples"] == 0 && r["skipped"] == 0)
    );
}

#[tokio::test]
async fn chi_get_va_chi_route_an_toan_va_lay_mau_theo_ty_le() {
    let h = harness(0.3, json!({ "v": "node-secret", "n": 1 }), Some(0.5)).await; // 0.5 >= 0.3 ⇒ không trúng mẫu
    get_body(&h, "GET", "/api/v1/things").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(h.rust_hits.load(Ordering::SeqCst), 0);
    let h = harness(0.3, json!({ "v": "node-secret", "n": 1 }), Some(0.1)).await; // trúng mẫu
    get_body(&h, "GET", "/api/v1/unsafe").await; // route không an toàn
    get_body(&h, "POST", "/api/v1/things").await; // không phải GET
    get_body(&h, "GET", "/api/v1/khong-co-trong-hop-dong").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.rust_hits.load(Ordering::SeqCst), 0);
    get_body(&h, "GET", "/api/v1/things").await;
    wait_samples(&h, "GET /api/v1/things", 1).await;
    assert_eq!(h.rust_hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn khong_lam_cham_response_chinh() {
    let h = harness(1.0, json!({}), None).await;
    let (st, _, took) = get_body(&h, "GET", "/api/v1/slow").await; // Rust ngủ 800 ms
    assert_eq!(st, 200);
    assert!(took < Duration::from_millis(400), "response chính chậm {took:?}");
    let row = wait_samples(&h, "GET /api/v1/slow", 1).await;
    assert_eq!(row["samples"], 1);
}

#[tokio::test]
async fn vi_pham_mang_danh_dau_khong_shadow_duoc_va_khong_thu_lai() {
    let h = harness(1.0, json!({}), None).await;
    let (st, body, _) = get_body(&h, "GET", "/api/v1/net").await;
    assert_eq!((st.as_u16(), body.contains("node-secret")), (200, true)); // khách vẫn nhận response của Node
    let row = wait_samples(&h, "GET /api/v1/net", 1).await;
    assert_eq!(row["unshadowable"], "mạng: graph");
    assert_eq!(row["samples"], 0, "mẫu vi phạm không tính vào so sánh");
    assert_eq!(h.rust_hits.load(Ordering::SeqCst), 1);
    // Không thử lại: request sau không chạy Rust nữa.
    get_body(&h, "GET", "/api/v1/net").await;
    get_body(&h, "GET", "/api/v1/net").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.rust_hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rust_thieu_khoa_la_khac_biet_cung_trang_thai() {
    let h = harness(1.0, json!({}), None).await;
    let (st, _, _) = get_body(&h, "GET", "/api/v1/things").await;
    assert_eq!(st, 200);
    let row = wait_samples(&h, "GET /api/v1/things", 1).await;
    // `{}` của Rust thiếu hai khoá của Node: hai đường dẫn khác, cùng trạng thái 200.
    assert_eq!(
        (row["status_mismatch"].as_u64(), row["different"].as_u64()),
        (Some(0), Some(1))
    );
    assert_eq!(row["diff_paths"], json!({ "$.n": 1, "$.v": 1 }));
}
