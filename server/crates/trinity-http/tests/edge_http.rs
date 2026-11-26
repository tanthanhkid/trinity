//! Biên HTTP (K16): CORS, giới hạn body, raw body, multipart, stream 200 MB và IP khách, qua socket thật.

use std::net::SocketAddr;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::{Multipart, Request, State};
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use trinity_http::edge::body::{
    self, JSON_LIMIT, ParsedBody, STREAM_LIMIT, body_limit_layer, collect_multipart, error_response, limit_stream,
};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe, client_ip_layer, resolve_client_ip, sign_client_ip};
use trinity_http::edge::cors::{CorsConfig, cors_layer};
use trinity_kernel::config::EnvMap;

const SECRET: &str = "s3cret-for-tests-s3cret-for-tests-0123456789";
const NOW: u64 = 1_800_000_000;

struct Server {
    addr: SocketAddr,
    clock: Arc<AtomicU64>,
}

async fn ip_handler(State(r): State<Arc<ClientIpResolver>>, req: Request) -> Response {
    let c = resolve_client_ip(&r, &req);
    format!("{}|{}", c.ip.map_or("null".to_owned(), |i| i.to_string()), c.rate_key).into_response()
}

async fn json_handler(ParsedBody { value, raw }: ParsedBody<Value>) -> Response {
    let raw_len = raw.as_ref().map_or(-1, |b| b.len() as i64);
    axum::Json(serde_json::json!({ "value": value, "rawLen": raw_len })).into_response()
}

async fn stream_handler(req: Request) -> Response {
    let max = body::limit_of(&req);
    let mut s = limit_stream(req.into_body(), max);
    let mut n = 0usize;
    while let Some(c) = s.next_chunk().await {
        match c {
            Ok(b) => n += b.len(),
            Err(e) => return error_response(&e.into()),
        }
    }
    n.to_string().into_response()
}

async fn multipart_handler(mp: Multipart) -> Response {
    match collect_multipart(mp, 4 * 1024 * 1024).await {
        Ok(fields) => fields
            .iter()
            .map(|(n, f, d)| format!("{n}:{}:{}", f.clone().unwrap_or_default(), d.len()))
            .collect::<Vec<_>>()
            .join(",")
            .into_response(),
        Err(e) => error_response(&e),
    }
}

async fn start(trusted_proxy: &str, production: bool, cors_origin: &str) -> Server {
    let mut env = EnvMap::new();
    env.insert("INTERNAL_SERVICE_SECRET".into(), SECRET.into());
    if !trusted_proxy.is_empty() {
        env.insert("TRUSTED_PROXY".into(), trusted_proxy.into());
    }
    let clock = Arc::new(AtomicU64::new(NOW * 1000));
    let c2 = clock.clone();
    let probe = NetProbe::Fixed {
        route_table: None,
        in_container: false,
    };
    let resolver = Arc::new(
        ClientIpResolver::from_env(&env, probe)
            .unwrap()
            .with_clock(move || c2.load(Ordering::Relaxed)),
    );

    let json_routes = Router::new()
        .route("/json", post(json_handler))
        .layer(from_fn(|r, n| body_limit_layer(JSON_LIMIT, r, n)));
    let small_stream = Router::new()
        .route("/small-stream", post(stream_handler))
        .layer(from_fn(|r, n| body_limit_layer(1024 * 1024, r, n)));
    let big_stream = Router::new()
        .route("/stream", post(stream_handler))
        .layer(from_fn(|r, n| body_limit_layer(STREAM_LIMIT, r, n)));
    let multipart = Router::new()
        .route("/upload", post(multipart_handler))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024));
    let app = Router::new()
        .route("/ip", get(ip_handler).post(ip_handler))
        .with_state(resolver.clone())
        .merge(json_routes)
        .merge(small_stream)
        .merge(big_stream)
        .merge(multipart)
        .layer(from_fn_with_state(resolver, client_ip_layer))
        .layer(from_fn_with_state(
            Arc::new(CorsConfig::new(cors_origin, production)),
            cors_layer,
        ));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    Server { addr, clock }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn all(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
            .collect()
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
        "{method} {path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    // Server có thể trả 413 và đóng khi body còn đang gửi: bỏ qua lỗi ghi.
    let _ = s.write_all(body).await;
    read_reply(&mut s).await
}

// --- CORS --------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn cors_wildcard_subdomain_va_origin_cau_hinh() {
    let s = start("", true, "*.example.org,https://crm.example.com").await;
    for (origin, ok) in [
        ("https://crm.example.com", true),
        ("https://a.example.org", true),
        ("https://evil.com", false),
        ("http://localhost:5173", false),
    ] {
        let r = send(s.addr, "GET", "/ip", &[("Origin", origin)], b"").await;
        assert_eq!(r.header("access-control-allow-origin").is_some(), ok, "{origin}");
        if ok {
            assert_eq!(r.header("access-control-allow-origin"), Some(origin));
            assert_eq!(r.header("access-control-allow-credentials"), Some("true"));
        }
        assert!(r.all("vary").iter().any(|v| v.contains("Origin")));
    }
}

#[tokio::test]
async fn cors_localhost_chi_ngoai_production_va_khong_origin_khong_header() {
    let dev = start("", false, "https://crm.example.com").await;
    let r = send(dev.addr, "GET", "/ip", &[("Origin", "http://localhost:5173")], b"").await;
    assert_eq!(r.header("access-control-allow-origin"), Some("http://localhost:5173"));
    let prod = start("", true, "https://crm.example.com").await;
    let r = send(prod.addr, "GET", "/ip", &[("Origin", "http://localhost:5173")], b"").await;
    assert_eq!(r.header("access-control-allow-origin"), None);
    let r = send(prod.addr, "GET", "/ip", &[], b"").await;
    assert_eq!((r.status, r.header("access-control-allow-origin")), (200, None));
}

#[tokio::test]
async fn cors_preflight_204_phan_chieu_header() {
    let s = start("", true, "https://crm.example.com").await;
    let h = [
        ("Origin", "https://crm.example.com"),
        ("Access-Control-Request-Method", "POST"),
        ("Access-Control-Request-Headers", "authorization,content-type"),
    ];
    let r = send(s.addr, "OPTIONS", "/json", &h, b"").await;
    assert_eq!(r.status, 204);
    assert_eq!(r.header("access-control-allow-origin"), Some("https://crm.example.com"));
    assert_eq!(
        r.header("access-control-allow-headers"),
        Some("authorization,content-type")
    );
    assert_eq!(
        r.header("access-control-allow-methods"),
        Some("GET,HEAD,PUT,PATCH,POST,DELETE")
    );
    assert_eq!(
        r.all("access-control-allow-origin").len(),
        1,
        "chỉ một Access-Control-Allow-Origin"
    );
}

// --- Giới hạn body, raw body -------------------------------------------------------------------------------------

#[tokio::test]
async fn json_5mb_vuot_thi_413_dang_nest_va_dung_han_thi_qua() {
    let s = start("", false, "").await;
    let over = vec![b'a'; JSON_LIMIT + 1];
    let r = send(s.addr, "POST", "/json", &[("Content-Type", "application/json")], &over).await;
    assert_eq!(r.status, 413);
    let v: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        (v["statusCode"].as_u64(), v["message"].as_str()),
        (Some(413), Some("request entity too large"))
    );
    let mut exact = vec![b'"'];
    exact.extend(std::iter::repeat_n(b'a', JSON_LIMIT - 2));
    exact.push(b'"');
    assert_eq!(exact.len(), JSON_LIMIT);
    let r = send(s.addr, "POST", "/json", &[("Content-Type", "application/json")], &exact).await;
    assert_eq!(r.status, 200, "{}", &r.body[..r.body.len().min(200)]);
}

#[tokio::test]
async fn body_chunked_vuot_han_muc_thi_413_khong_can_content_length() {
    let s = start("", false, "").await;
    let mut c = TcpStream::connect(s.addr).await.unwrap();
    c.write_all(b"POST /small-stream HTTP/1.1\r\nHost: t\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n")
        .await
        .unwrap();
    let chunk = vec![b'x'; 64 * 1024];
    for _ in 0..32 {
        if c.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).await.is_err()
            || c.write_all(&chunk).await.is_err()
            || c.write_all(b"\r\n").await.is_err()
        {
            break;
        }
    }
    let _ = c.write_all(b"0\r\n\r\n").await;
    assert_eq!(read_reply(&mut c).await.status, 413);
}

#[tokio::test]
async fn raw_body_giu_nguyen_byte_cho_json_va_khong_cho_urlencoded() {
    let s = start("", false, "").await;
    let payload = br#"{ "a" : 1,  "b":"x" }"#;
    let r = send(
        s.addr,
        "POST",
        "/json",
        &[("Content-Type", "application/json; charset=utf-8")],
        payload,
    )
    .await;
    let v: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        (v["rawLen"].as_i64(), v["value"]["a"].as_i64()),
        (Some(payload.len() as i64), Some(1))
    );
    let r = send(
        s.addr,
        "POST",
        "/json",
        &[("Content-Type", "application/x-www-form-urlencoded")],
        b"a=1&a=2&u%5Bname%5D=T%C3%A2m&t%5B%5D=x",
    )
    .await;
    let v: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(v["rawLen"], -1);
    assert_eq!(
        v["value"],
        serde_json::json!({ "a": ["1", "2"], "u": { "name": "Tâm" }, "t": ["x"] })
    );
    let r = send(
        s.addr,
        "POST",
        "/json",
        &[("Content-Type", "application/json")],
        b"{oops",
    )
    .await;
    assert_eq!(r.status, 400);
    let r = send(s.addr, "POST", "/json", &[("Content-Type", "application/json")], b"").await;
    assert_eq!(
        (
            r.status,
            serde_json::from_str::<Value>(&r.body).unwrap()["value"].clone()
        ),
        (200, serde_json::json!({}))
    );
}

// --- Multipart ---------------------------------------------------------------------------------------------------

fn multipart_body(boundary: &str, file_len: usize) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nhello\r\n").as_bytes(),
    );
    b.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
    );
    b.extend(std::iter::repeat_n(7u8, file_len));
    b.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    b
}

#[tokio::test]
async fn multipart_tep_trong_han_qua_va_vuot_han_truong_thi_413() {
    let s = start("", false, "").await;
    let ct = "multipart/form-data; boundary=XB";
    let r = send(
        s.addr,
        "POST",
        "/upload",
        &[("Content-Type", ct)],
        &multipart_body("XB", 3 * 1024 * 1024),
    )
    .await;
    assert_eq!((r.status, r.body.as_str()), (200, "title::5,file:a.bin:3145728"));
    let r = send(
        s.addr,
        "POST",
        "/upload",
        &[("Content-Type", ct)],
        &multipart_body("XB", 5 * 1024 * 1024),
    )
    .await;
    assert_eq!(r.status, 413);
    assert!(r.body.contains("File too large"));
}

// --- Stream 200 MB, RSS ------------------------------------------------------------------------------------------

fn rss_kb() -> u64 {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

async fn upload_zeros(addr: SocketAddr, total: usize) -> Reply {
    let mut c = TcpStream::connect(addr).await.unwrap();
    let head = format!("POST /stream HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: {total}\r\n\r\n");
    c.write_all(head.as_bytes()).await.unwrap();
    let chunk = vec![0u8; 64 * 1024];
    let mut sent = 0;
    while sent < total {
        let n = chunk.len().min(total - sent);
        c.write_all(&chunk[..n]).await.unwrap();
        sent += n;
    }
    read_reply(&mut c).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tai_200mb_khong_lam_rss_tang_qua_20mb() {
    let s = start("", false, "").await;
    // Làm nóng bộ cấp phát bằng một lượt nhỏ rồi mới đo mức nền.
    assert_eq!(
        upload_zeros(s.addr, 8 * 1024 * 1024).await.body,
        (8 * 1024 * 1024).to_string()
    );
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
    let r = upload_zeros(s.addr, STREAM_LIMIT).await; // đúng 200 MB
    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    assert_eq!((r.status, r.body), (200, STREAM_LIMIT.to_string()));
    let grew_mb = peak.load(Ordering::Relaxed).saturating_sub(base) as f64 / 1024.0;
    assert!(
        grew_mb <= 20.0,
        "RSS tăng {grew_mb:.1} MB khi tải 200 MB (hạn mức 20 MB)"
    );
    // 200 MB + 1 byte khai trong Content-Length ⇒ 413 trước khi đọc body
    let mut c = TcpStream::connect(s.addr).await.unwrap();
    c.write_all(
        format!(
            "POST /stream HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            STREAM_LIMIT + 1
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    assert_eq!(read_reply(&mut c).await.status, 413);
}

// --- IP thật ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn ip_qua_ham_chung_sau_caddy_cung_may() {
    let s = start("cidr:127.0.0.1/32", false, "").await;
    let r = send(
        s.addr,
        "GET",
        "/ip",
        &[
            ("X-Forwarded-For", "203.0.113.108, 203.0.113.50"),
            ("X-Real-IP", "203.0.113.108"),
        ],
        b"",
    )
    .await;
    assert_eq!(r.body, "203.0.113.50|203.0.113.50");
    // none sau Caddy: không tin được ⇒ ip null, khoá = peer, không khoá ai
    let n = start("none", false, "").await;
    let r = send(n.addr, "GET", "/ip", &[("X-Forwarded-For", "203.0.113.50")], b"").await;
    assert_eq!(r.body, "null|127.0.0.1");
}

#[tokio::test]
async fn cloudflare_gia_qua_caddy_voi_cloudflare_behind() {
    let s = start("cloudflare-behind:127.0.0.1/32", false, "").await;
    let r = send(
        s.addr,
        "GET",
        "/ip",
        &[("X-Forwarded-For", "172.70.1.1"), ("CF-Connecting-IP", "203.0.113.50")],
        b"",
    )
    .await;
    assert_eq!(r.body, "203.0.113.50|203.0.113.50");
    let r = send(
        s.addr,
        "GET",
        "/ip",
        &[
            ("X-Forwarded-For", "198.51.100.9"),
            ("CF-Connecting-IP", "203.0.113.108"),
        ],
        b"",
    )
    .await;
    assert_eq!(
        r.body, "198.51.100.9|198.51.100.9",
        "CF-Connecting-IP giả từ ngoài dải Cloudflare bị bỏ"
    );
}

#[tokio::test]
async fn chu_ky_sai_thi_400_truoc_khi_doc_body() {
    let s = start("", false, "").await;
    let bad = sign_client_ip("203.0.113.50", "bi-mat-khac", NOW);
    let r = send(
        s.addr,
        "POST",
        "/json",
        &[("Content-Type", "application/json"), ("x-trinity-client-ip", &bad)],
        b"{}",
    )
    .await;
    assert_eq!(r.status, 400);
    assert!(r.body.contains("Chữ ký x-trinity-client-ip không hợp lệ"));
    let old = sign_client_ip("203.0.113.50", SECRET, NOW - 61);
    assert_eq!(
        send(s.addr, "GET", "/ip", &[("x-trinity-client-ip", &old)], b"")
            .await
            .status,
        400
    );
    let good = sign_client_ip("203.0.113.50", SECRET, NOW);
    let r = send(
        s.addr,
        "GET",
        "/ip",
        &[("x-trinity-client-ip", &good), ("X-Real-IP", "203.0.113.108")],
        b"",
    )
    .await;
    assert_eq!(r.body, "203.0.113.50|203.0.113.50");
}

#[tokio::test]
async fn body_nho_giot_61_giay_van_dung_ip_vi_kiem_luc_nhan_header() {
    let s = start("", false, "").await;
    let good = sign_client_ip("203.0.113.50", SECRET, NOW);
    let mut c = TcpStream::connect(s.addr).await.unwrap();
    let head = format!(
        "POST /ip HTTP/1.1\r\nHost: t\r\nConnection: close\r\nx-trinity-client-ip: {good}\r\nContent-Length: 4\r\n\r\nab"
    );
    c.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    s.clock.store((NOW + 61) * 1000, Ordering::Relaxed); // body tới 61 giây sau khi header đã kiểm
    c.write_all(b"cd").await.unwrap();
    let r = read_reply(&mut c).await;
    assert_eq!((r.status, r.body.as_str()), (200, "203.0.113.50|203.0.113.50"));
    // header mới gửi lúc đồng hồ đã lệch 61 giây thì bị từ chối
    assert_eq!(
        send(s.addr, "GET", "/ip", &[("x-trinity-client-ip", &good)], b"")
            .await
            .status,
        400
    );
}
