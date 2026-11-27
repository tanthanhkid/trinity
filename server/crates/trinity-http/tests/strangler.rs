//! K17: strangler proxy qua socket thật, với một "Node" giả nghe loopback.

use std::net::SocketAddr;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use trinity_http::edge::client_ip::{ClientIpResolver, Decision, NetProbe, Parts, UNTRUSTED_CLIENT_IP};
use trinity_http::edge::cors::{CorsConfig, cors_layer};
use trinity_http::strangler::{
    NodeProxy, OwnershipTable, ProxyTimeouts, dispatcher, initial_from_routes_env, spawn_sighup_reloader,
};
use trinity_kernel::config::EnvMap;

const SVC: &str = "k17-service-secret-0123456789";
const NOW: u64 = 1_800_000_000;
const REAL: &str = "203.0.113.50";
const FAKE: &str = "203.0.113.108";

fn env(extra: &[(&str, &str)]) -> EnvMap {
    let mut m: EnvMap = [("INTERNAL_SERVICE_SECRET".to_owned(), SVC.to_owned())]
        .into_iter()
        .collect();
    m.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    m
}

fn resolver(extra: &[(&str, &str)]) -> Arc<ClientIpResolver> {
    let probe = NetProbe::Fixed {
        route_table: None,
        in_container: false,
    };
    Arc::new(ClientIpResolver::from_env(&env(extra), probe).unwrap())
}

/// Node giả. Kiểm `x-trinity-client-ip` bằng cùng thuật toán của Node (đồng hồ của `clock`) ngay khi nhận header.
struct Node {
    addr: SocketAddr,
    uploaded: Arc<AtomicU64>,
    hits: Arc<AtomicUsize>,
}

async fn start_node(clock: Arc<AtomicU64>) -> Node {
    let uploaded = Arc::new(AtomicU64::new(0));
    let hits = Arc::new(AtomicUsize::new(0));
    // Node nhận header có chữ ký từ proxy: peer là loopback, TRUSTED_PROXY mặc định `none`.
    let node_ip = Arc::new(
        ClientIpResolver::from_env(
            &env(&[]),
            NetProbe::Fixed {
                route_table: None,
                in_container: false,
            },
        )
        .unwrap()
        .with_clock({
            let c = clock.clone();
            move || c.load(Ordering::Relaxed) * 1000
        }),
    );
    let (up, h) = (uploaded.clone(), hits.clone());
    let ni = node_ip.clone();
    let echo = move |req: Request| {
        let ni = ni.clone();
        async move {
            let headers = req.headers().clone();
            // Kiểm LÚC NHẬN header (như middleware của Node, trước body-parser).
            let verdict = match ni.determine(&Parts {
                headers: &headers,
                peer: Some("127.0.0.1".parse().unwrap()),
            }) {
                Decision::Ok(c) => format!("ok:{}", c.ip.map_or("null".to_owned(), |i| i.to_string())),
                Decision::Bad { error, .. } => format!("bad:{error}"),
            };
            let bytes = axum::body::to_bytes(req.into_body(), 64 << 20).await.unwrap();
            let seen: serde_json::Map<String, Value> = [
                "x-real-ip",
                "x-forwarded-for",
                "forwarded",
                "cf-connecting-ip",
                "x-trinity-peer-ip",
                "host",
                "x-trinity-client-ip",
                "true-client-ip",
                "x-forwarded-proto",
                "x-forwarded-host",
                "x-secret-hop",
            ]
            .iter()
            .map(|n| {
                (
                    (*n).to_owned(),
                    headers
                        .get(*n)
                        .map_or(Value::Null, |v| Value::String(v.to_str().unwrap_or("").to_owned())),
                )
            })
            .collect();
            axum::Json(
                serde_json::json!({ "verdict": verdict, "len": bytes.len(), "body": String::from_utf8_lossy(&bytes), "headers": seen }),
            )
        }
    };
    let app = Router::new()
        .route("/api/v1/echo", any(echo))
        .route(
            "/api/v1/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                "node-slow"
            }),
        )
        .route(
            "/api/v1/oauth/protected-resource",
            get(|| async { "node-oauth-resource" }),
        )
        .route(
            "/api/v1/hop",
            get(|| async {
                (
                    [("connection", "x-node-hop"), ("x-node-hop", "1"), ("x-giu-lai", "2")],
                    "hop",
                )
            }),
        )
        .route(
            "/api/v1/stall",
            post(|req: Request| async move {
                // Đọc body; client ngừng gửi thì proxy phải cắt (không treo vô hạn).
                if axum::body::to_bytes(req.into_body(), 1 << 20).await.is_err() {
                    "body-error"
                } else {
                    "body-ok"
                }
            }),
        )
        .route(
            "/api/v1/export/big",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(400)).await;
                "node-export"
            }),
        )
        .route(
            "/api/v1/cors",
            any(|| async {
                // Node tự thêm CORS: đúng một giá trị.
                (
                    [("access-control-allow-origin", "https://app.example.com")],
                    StatusCode::NO_CONTENT,
                )
            }),
        )
        .route(
            "/api/v1/upload",
            post(move |req: Request| {
                let up = up.clone();
                async move {
                    use http_body_util::BodyExt;
                    let mut body = req.into_body();
                    while let Some(f) = body.frame().await {
                        if let Ok(d) = f.unwrap().into_data() {
                            up.fetch_add(d.len() as u64, Ordering::Relaxed);
                        }
                    }
                    "uploaded"
                }
            }),
        )
        .route(
            "/notif-ws/",
            get(|mut req: Request| async move {
                let on = hyper::upgrade::on(&mut req);
                tokio::spawn(async move {
                    let Ok(up) = on.await else { return };
                    let mut io = hyper_util::rt::TokioIo::new(up);
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = io.read(&mut buf).await {
                        if n == 0 || io.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
                Response::builder()
                    .status(StatusCode::SWITCHING_PROTOCOLS)
                    .header("connection", "Upgrade")
                    .header("upgrade", "websocket")
                    .body(Body::empty())
                    .unwrap()
            }),
        )
        .fallback(|| async { (StatusCode::OK, "node-fallback") })
        .layer(axum::middleware::from_fn(
            move |req: Request, next: axum::middleware::Next| {
                let h = h.clone();
                async move {
                    h.fetch_add(1, Ordering::Relaxed);
                    next.run(req).await
                }
            },
        ));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Node { addr, uploaded, hits }
}

struct Front {
    addr: SocketAddr,
    node: Node,
    table: Arc<OwnershipTable>,
    file: std::path::PathBuf,
    clock: Arc<AtomicU64>,
}

fn write_atomic(path: &std::path::Path, text: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

async fn front(tp: &str, timeouts: ProxyTimeouts, ownership: &str) -> Front {
    let clock = Arc::new(AtomicU64::new(NOW));
    let node = start_node(clock.clone()).await;
    let dir = std::env::temp_dir().join(format!("trinity-k17-{}-{}", std::process::id(), node.addr.port()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("ownership.json");
    write_atomic(&file, ownership);
    let table = Arc::new(OwnershipTable::from_file(&file).unwrap());

    let rust = Router::new()
        .route(
            "/api/v1/rust",
            get(|| async { "rust" }).options(|| async { "rust-opts" }),
        )
        .layer(from_fn_with_state(
            Arc::new(CorsConfig::new("https://app.example.com", true)),
            cors_layer,
        ));
    let c2 = clock.clone();
    let proxy = NodeProxy::new(
        format!("http://{}", node.addr).parse().unwrap(),
        None,
        Some(SVC.to_owned()),
        timeouts,
    )
    .with_clock(move || c2.load(Ordering::Relaxed));
    let tp_pairs: Vec<(&str, &str)> = if tp.is_empty() {
        vec![]
    } else {
        vec![("TRUSTED_PROXY", tp)]
    };
    let app = dispatcher(table.clone(), rust, proxy, resolver(&tp_pairs));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(trinity_http::serve::serve(
        listener,
        app,
        None,
        std::future::pending(),
        Duration::from_secs(1),
    ));
    Front {
        addr,
        node,
        table,
        file,
        clock,
    }
}

const ALL_NODE: &str = r#"{ "routes": [] }"#;

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn all(&self, n: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(n))
            .map(|(_, v)| v.as_str())
            .collect()
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("{e}: {}", self.body))
    }
}

async fn read_reply(s: &mut TcpStream) -> Reply {
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf).await;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_owned()
    };
    Reply { status, headers, body }
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = s.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        s = rest.get(n + 2..).unwrap_or("");
    }
    out
}

async fn send(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: crm.test\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let _ = s.write_all(body).await;
    read_reply(&mut s).await
}

fn timeouts_fast() -> ProxyTimeouts {
    ProxyTimeouts {
        response: Duration::from_secs(15),
        export: Duration::from_secs(120),
        connect: Duration::from_secs(2),
        body_idle: Duration::from_secs(30),
    }
}

#[tokio::test]
async fn chia_theo_bang_so_huu_va_giu_nguyen_byte_body() {
    let f = front(
        "",
        timeouts_fast(),
        r#"{ "routes": [ { "prefix": "/api/v1/rust", "owner": "rust" } ] }"#,
    )
    .await;
    let r = send(f.addr, "GET", "/api/v1/rust", &[], b"").await;
    assert_eq!((r.status, r.body.as_str()), (200, "rust"));
    assert_eq!(f.node.hits.load(Ordering::Relaxed), 0, "route của Rust không chạm Node");
    // Body có khoảng trắng lạ và UTF-8: Node nhận đúng từng byte (chữ ký webhook tính trên byte gốc).
    let payload = "{ \"a\" : 1,\t\"ten\":\"Trần Văn Ý\" }  ";
    let r = send(
        f.addr,
        "POST",
        "/api/v1/echo",
        &[("Content-Type", "application/json")],
        payload.as_bytes(),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["body"], payload);
    assert_eq!(r.json()["len"], payload.len());
    // Node phục vụ, kể cả đường dẫn không phải API (không có Next ⇒ Node).
    assert_eq!(send(f.addr, "GET", "/trang-chu", &[], b"").await.body, "node-fallback");
    assert_eq!(
        send(f.addr, "GET", "/uploads/a.png", &[], b"").await.body,
        "node-fallback"
    );
}

#[tokio::test]
async fn header_ip_gia_bi_xoa_va_node_thay_ip_that_co_chu_ky() {
    // Rust sau Caddy cùng máy: peer loopback, `TRUSTED_PROXY=cidr:127.0.0.1/32`, IP thật là phần tử phải cùng của XFF.
    let f = front("cidr:127.0.0.1/32", timeouts_fast(), ALL_NODE).await;
    let r = send(
        f.addr,
        "POST",
        "/api/v1/echo",
        &[
            ("X-Forwarded-For", &format!("{FAKE}, {REAL}")),
            ("X-Real-IP", FAKE),
            ("CF-Connecting-IP", FAKE),
            ("Forwarded", &format!("for={FAKE}")),
            ("X-Trinity-Peer-IP", FAKE),
        ],
        b"x",
    )
    .await;
    let j = r.json();
    assert_eq!(
        j["verdict"],
        format!("ok:{REAL}"),
        "Node thấy IP thật theo chữ ký của Rust: {j}"
    );
    for h in [
        "x-real-ip",
        "x-forwarded-for",
        "forwarded",
        "cf-connecting-ip",
        "x-trinity-peer-ip",
    ] {
        assert_eq!(j["headers"][h], Value::Null, "{h} phải bị xoá");
    }
    assert_eq!(j["headers"]["host"], "crm.test", "Host gốc được giữ");
    // IP không tin được (TRUSTED_PROXY=none sau proxy cùng máy) ⇒ Node nhận dấu không tin được, không phải IP giả.
    let f = front("none", timeouts_fast(), ALL_NODE).await;
    let r = send(
        f.addr,
        "POST",
        "/api/v1/echo",
        &[("X-Real-IP", FAKE), ("CF-Connecting-IP", FAKE)],
        b"x",
    )
    .await;
    assert_eq!(r.json()["verdict"], "ok:null");
    assert!(
        r.json()["headers"]["x-trinity-client-ip"]
            .as_str()
            .unwrap()
            .starts_with(UNTRUSTED_CLIENT_IP)
    );
}

#[tokio::test]
async fn chu_ky_ky_luc_gui_header_nen_body_nho_giot_van_dung() {
    let f = front("cidr:127.0.0.1/32", timeouts_fast(), ALL_NODE).await;
    let mut s = TcpStream::connect(f.addr).await.unwrap();
    s.write_all(format!("POST /api/v1/echo HTTP/1.1\r\nHost: t\r\nConnection: close\r\nX-Forwarded-For: {REAL}\r\nContent-Length: 6\r\n\r\nabc").as_bytes()).await.unwrap();
    // Body tới chậm: đồng hồ của Node nhảy 61 giây SAU khi header đã kiểm. Node kiểm lúc nhận header nên vẫn đúng.
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.clock.store(NOW + 61, Ordering::Relaxed);
    s.write_all(b"def").await.unwrap();
    let r = read_reply(&mut s).await;
    assert_eq!(r.json()["verdict"], format!("ok:{REAL}"));
    assert_eq!(r.json()["body"], "abcdef");
    // Request MỚI sau khi đồng hồ nhảy vẫn được ký lại theo giờ hiện tại của proxy (cùng đồng hồ trong test) ⇒ hợp lệ.
    let r = send(f.addr, "POST", "/api/v1/echo", &[("X-Forwarded-For", REAL)], b"x").await;
    assert_eq!(r.json()["verdict"], format!("ok:{REAL}"));
}

#[tokio::test]
async fn preflight_qua_proxy_chi_co_mot_access_control_allow_origin() {
    let f = front(
        "",
        timeouts_fast(),
        r#"{ "routes": [ { "prefix": "/api/v1/rust", "owner": "rust" } ] }"#,
    )
    .await;
    let h = [
        ("Origin", "https://app.example.com"),
        ("Access-Control-Request-Method", "POST"),
    ];
    let node = send(f.addr, "OPTIONS", "/api/v1/cors", &h, b"").await;
    assert_eq!(node.status, 204);
    assert_eq!(
        node.all("access-control-allow-origin"),
        ["https://app.example.com"],
        "chỉ giá trị của Node"
    );
    let rust = send(f.addr, "OPTIONS", "/api/v1/rust", &h, b"").await;
    assert_eq!(
        rust.all("access-control-allow-origin"),
        ["https://app.example.com"],
        "chỉ giá trị của lớp CORS Rust"
    );
}

#[tokio::test]
async fn websocket_notif_ws_di_qua_proxy_hai_chieu() {
    let f = front("", timeouts_fast(), ALL_NODE).await;
    let mut s = TcpStream::connect(f.addr).await.unwrap();
    s.write_all(b"GET /notif-ws/?EIO=4&transport=websocket HTTP/1.1\r\nHost: t\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").await.unwrap();
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut b).await.unwrap();
        head.push(b[0]);
    }
    let head = String::from_utf8_lossy(&head).to_lowercase();
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(head.contains("upgrade: websocket"), "{head}");
    s.write_all(b"xin chao socket").await.unwrap();
    let mut got = vec![0u8; "xin chao socket".len()];
    tokio::time::timeout(Duration::from_secs(3), s.read_exact(&mut got))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got, b"xin chao socket");
}

#[tokio::test]
async fn sighup_doi_so_huu_khi_dang_co_request_dai_khong_rot() {
    let f = front("", timeouts_fast(), ALL_NODE).await;
    let _reloader = spawn_sighup_reloader(f.table.clone()).unwrap();
    // Request dài (Node ngủ 1,5 giây) đang chạy qua proxy.
    let addr = f.addr;
    let slow = tokio::spawn(async move { send(addr, "GET", "/api/v1/slow", &[], b"").await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Ghi tệp mới (đổi tên nguyên tử) rồi SIGHUP: /api/v1/rust sang Rust (chưa có handler Rust cho /slow nên chỉ kiểm bảng).
    write_atomic(
        &f.file,
        r#"{ "routes": [ { "prefix": "/api/v1/slow", "owner": "rust" } ] }"#,
    );
    let status = Command::new("kill")
        .args(["-HUP", &std::process::id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    for _ in 0..50 {
        if f.table.current().route("GET", "/api/v1/slow").owner == trinity_kernel::ownership::Owner::Rust {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        f.table.current().route("GET", "/api/v1/slow").owner,
        trinity_kernel::ownership::Owner::Rust,
        "SIGHUP đổi bảng"
    );
    // Request đang chạy vẫn hoàn tất bằng Node.
    let r = slow.await.unwrap();
    assert_eq!((r.status, r.body.as_str()), (200, "node-slow"));
    // Request mới tới Rust (Rust không có route /slow ⇒ 404 của Rust, chứng tỏ không còn tới Node).
    let hits = f.node.hits.load(Ordering::Relaxed);
    let r = send(f.addr, "GET", "/api/v1/slow", &[], b"").await;
    assert_ne!(r.body, "node-slow");
    assert_eq!(f.node.hits.load(Ordering::Relaxed), hits, "request mới không chạm Node");
}

#[tokio::test]
async fn tep_hong_giu_bang_cu_va_tep_hop_le_duoc_nap() {
    let f = front(
        "",
        timeouts_fast(),
        r#"{ "routes": [ { "prefix": "/api/v1/rust", "owner": "rust" } ] }"#,
    )
    .await;
    write_atomic(&f.file, r#"{ "routes": [ { "prefix": "/x", "owner": "rust" "#);
    assert!(f.table.reload().is_err());
    assert_eq!(
        f.table.current().route("GET", "/api/v1/rust").owner,
        trinity_kernel::ownership::Owner::Rust,
        "giữ bảng cũ"
    );
    assert_eq!(send(f.addr, "GET", "/api/v1/rust", &[], b"").await.body, "rust");
    write_atomic(&f.file, ALL_NODE);
    assert!(f.table.reload().unwrap());
    assert_eq!(
        f.table.current().route("GET", "/api/v1/rust").owner,
        trinity_kernel::ownership::Owner::Node
    );
}

#[tokio::test]
async fn tep_khong_ton_tai_luc_khoi_dong_va_env_khoi_tao() {
    assert!(OwnershipTable::from_file(std::path::Path::new("/khong/co/tep.json")).is_err());
    let own = initial_from_routes_env(Some("/api/v1/settings, /api/v1/kanban")).unwrap();
    let t = OwnershipTable::fixed(own);
    assert_eq!(
        t.current().route("GET", "/api/v1/kanban/1").owner,
        trinity_kernel::ownership::Owner::Rust
    );
    assert_eq!(
        t.current().route("GET", "/api/v1/contacts").owner,
        trinity_kernel::ownership::Owner::Node
    );
    assert!(!t.reload().unwrap(), "bảng cố định không có gì để nạp lại");
    assert!(initial_from_routes_env(Some("khong-bat-dau-bang-gach")).is_err());
    assert_eq!(
        initial_from_routes_env(None).unwrap().route("GET", "/api/v1/x").owner,
        trinity_kernel::ownership::Owner::Node
    );
}

#[tokio::test]
async fn timeout_response_va_export_dai_hon() {
    let t = ProxyTimeouts {
        response: Duration::from_millis(500),
        export: Duration::from_secs(5),
        connect: Duration::from_secs(2),
        body_idle: Duration::from_secs(30),
    };
    let f = front("", t, ALL_NODE).await;
    // /slow ngủ 1,5 giây > 500 ms ⇒ 504; /export/big ngủ 0,4 giây nhưng hạn 5 giây ⇒ qua.
    assert_eq!(send(f.addr, "GET", "/api/v1/slow", &[], b"").await.status, 504);
    assert_eq!(
        send(f.addr, "GET", "/api/v1/export/big", &[], b"").await.body,
        "node-export"
    );
    // Node chết ⇒ 502.
    let dead = ProxyTimeouts::default();
    let proxy = NodeProxy::new("http://127.0.0.1:1".parse().unwrap(), None, None, dead);
    let app = dispatcher(
        Arc::new(OwnershipTable::fixed(Default::default())),
        Router::new(),
        proxy,
        resolver(&[]),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(trinity_http::serve::serve(
        listener,
        app,
        None,
        std::future::pending(),
        Duration::from_secs(1),
    ));
    assert_eq!(send(addr, "GET", "/api/v1/x", &[], b"").await.status, 502);
}

fn rss_kb() -> u64 {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_200mb_stream_qua_proxy_khong_dem_vao_ram() {
    let t = ProxyTimeouts {
        response: Duration::from_secs(30),
        export: Duration::from_secs(120),
        connect: Duration::from_secs(2),
        body_idle: Duration::from_secs(30),
    };
    let f = front("", t, ALL_NODE).await;
    let total: usize = 200 * 1024 * 1024;
    let upload = |n: usize| {
        let addr = f.addr;
        async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(
                format!("POST /api/v1/upload HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: {n}\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
            let chunk = vec![0u8; 64 * 1024];
            let mut sent = 0;
            while sent < n {
                let k = chunk.len().min(n - sent);
                c.write_all(&chunk[..k]).await.unwrap();
                sent += k;
            }
            read_reply(&mut c).await
        }
    };
    assert_eq!(upload(8 << 20).await.body, "uploaded");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let base = rss_kb();
    let peak = Arc::new(AtomicU64::new(base));
    let stop = Arc::new(AtomicBool::new(false));
    let (p2, s2) = (peak.clone(), stop.clone());
    let sampler = std::thread::spawn(move || {
        while !s2.load(Ordering::Relaxed) {
            p2.fetch_max(rss_kb(), Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    f.node.uploaded.store(0, Ordering::Relaxed);
    let r = upload(total).await;
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    assert_eq!((r.status, r.body.as_str()), (200, "uploaded"));
    assert_eq!(f.node.uploaded.load(Ordering::Relaxed), total as u64);
    let grew = peak.load(Ordering::Relaxed).saturating_sub(base) as f64 / 1024.0;
    assert!(grew <= 20.0, "RSS tăng {grew:.1} MB khi chuyển 200 MB qua proxy");
}

#[allow(dead_code)]
fn _unused(_: HeaderMap) -> impl IntoResponse {
    StatusCode::OK
}

#[tokio::test]
async fn well_known_rewrite_sang_node_va_chi_api_v1_sang_node_khi_co_next() {
    let f = front("", timeouts_fast(), ALL_NODE).await;
    // Rewrite như Next: /.well-known/oauth-protected-resource -> /api/v1/oauth/protected-resource của Node.
    assert_eq!(
        send(f.addr, "GET", "/.well-known/oauth-protected-resource", &[], b"")
            .await
            .body,
        "node-oauth-resource"
    );
    // Có Next: `/api/build-id` và trang đi Next, `/api/v1/...` đi Node.
    let next = start_node(Arc::new(AtomicU64::new(NOW))).await;
    let node = start_node(Arc::new(AtomicU64::new(NOW))).await;
    let proxy = NodeProxy::new(
        format!("http://{}", node.addr).parse().unwrap(),
        Some(format!("http://{}", next.addr).parse().unwrap()),
        None,
        timeouts_fast(),
    );
    let app = dispatcher(
        Arc::new(OwnershipTable::fixed(Default::default())),
        Router::new(),
        proxy,
        resolver(&[]),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(trinity_http::serve::serve(
        listener,
        app,
        None,
        std::future::pending(),
        Duration::from_secs(1),
    ));
    for p in ["/api/build-id", "/api/fe-logging", "/trang"] {
        send(addr, "GET", p, &[], b"").await;
    }
    assert_eq!(
        (next.hits.load(Ordering::Relaxed), node.hits.load(Ordering::Relaxed)),
        (3, 0)
    );
    send(addr, "GET", "/api/v1/oauth/protected-resource", &[], b"").await;
    send(addr, "GET", "/.well-known/oauth-protected-resource", &[], b"").await;
    assert_eq!(
        (next.hits.load(Ordering::Relaxed), node.hits.load(Ordering::Relaxed)),
        (3, 2)
    );
}

#[tokio::test]
async fn forwarded_proto_host_do_rust_dat_lai_va_header_connection_bi_bo() {
    let f = front("", timeouts_fast(), ALL_NODE).await;
    let r = send(
        f.addr,
        "POST",
        "/api/v1/echo",
        &[
            ("X-Forwarded-Proto", "https"),
            ("X-Forwarded-Host", "evil.example"),
            ("True-Client-IP", FAKE),
            ("Connection", "close, X-Secret-Hop"),
            ("X-Secret-Hop", "1"),
        ],
        b"x",
    )
    .await;
    let h = &r.json()["headers"];
    assert_eq!(
        h["x-forwarded-proto"], "http",
        "đặt lại theo listener thật, không tin client"
    );
    assert_eq!(h["x-forwarded-host"], "crm.test", "host gốc");
    assert_eq!(h["true-client-ip"], Value::Null);
    assert_eq!(h["x-secret-hop"], Value::Null, "header Connection liệt kê bị bỏ");
    // Response: header Node liệt kê trong Connection cũng bị bỏ, header khác giữ.
    let r = send(f.addr, "GET", "/api/v1/hop", &[], b"").await;
    assert!(
        r.all("x-node-hop").is_empty() && r.all("x-giu-lai") == ["2"],
        "{:?}",
        r.headers
    );
}

#[tokio::test]
async fn tep_chua_co_luc_khoi_dong_giu_env_va_nap_khi_tep_xuat_hien() {
    let dir = std::env::temp_dir().join(format!("trinity-k17-late-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("ownership.json");
    let _ = std::fs::remove_file(&file);
    let initial = initial_from_routes_env(Some("/api/v1/settings")).unwrap();
    let t = OwnershipTable::new(Some(&file), initial.clone()).unwrap();
    let owner = |t: &OwnershipTable, p: &str| t.current().route("GET", p).owner;
    assert_eq!(
        owner(&t, "/api/v1/settings"),
        trinity_kernel::ownership::Owner::Rust,
        "dùng TRINITY_RUST_ROUTES"
    );
    assert!(!t.reload().unwrap(), "chưa có tệp: giữ bảng, không lỗi");
    assert_eq!(owner(&t, "/api/v1/settings"), trinity_kernel::ownership::Owner::Rust);
    write_atomic(
        &file,
        r#"{ "routes": [ { "prefix": "/api/v1/kanban", "owner": "rust" } ] }"#,
    );
    assert!(t.reload().unwrap());
    assert_eq!(owner(&t, "/api/v1/kanban"), trinity_kernel::ownership::Owner::Rust);
    assert_eq!(
        owner(&t, "/api/v1/settings"),
        trinity_kernel::ownership::Owner::Node,
        "tệp thay hẳn giá trị khởi tạo"
    );
    // Tệp bị xoá sau đó: giữ bảng đang dùng.
    std::fs::remove_file(&file).unwrap();
    assert!(!t.reload().unwrap());
    assert_eq!(owner(&t, "/api/v1/kanban"), trinity_kernel::ownership::Owner::Rust);
    // Tệp có mà hỏng lúc khởi động: lỗi.
    write_atomic(&file, "{ khong phai json");
    assert!(OwnershipTable::new(Some(&file), initial).is_err());
}

#[tokio::test]
async fn client_ngung_gui_body_thi_proxy_cat_khong_treo_vo_han() {
    let t = ProxyTimeouts {
        response: Duration::from_secs(15),
        export: Duration::from_secs(120),
        connect: Duration::from_secs(2),
        body_idle: Duration::from_millis(600),
    };
    let f = front("", t, ALL_NODE).await;
    let mut s = TcpStream::connect(f.addr).await.unwrap();
    s.write_all(b"POST /api/v1/stall HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: 100\r\n\r\nabc")
        .await
        .unwrap();
    // Gửi 3/100 byte rồi im: không đóng kết nối. Phải có phản hồi (hoặc đóng) trong vài giây.
    let r = tokio::time::timeout(Duration::from_secs(5), read_reply(&mut s)).await;
    assert!(r.is_ok(), "proxy treo khi client ngừng gửi body");
}
