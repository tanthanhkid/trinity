//! Chuyển từ `services/crm/src/integrations/oauth/__tests__/safe-http-get.spec.ts`, thêm ca DNS rebinding đi trọn
//! đường client (bộ phân giải của `reqwest` là bộ kiểm SSRF) và ca tải media.

use std::io;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use trinity_http::outbound::safe_get::{SafeGetOptions, safe_get_json, safe_get_media};
use trinity_http::outbound::ssrf::{HostResolver, LookupFuture, SsrfPolicy, SystemResolver};

const PROD: SsrfPolicy = SsrfPolicy { allow_private: false };
const DEV: SsrfPolicy = SsrfPolicy { allow_private: true };

fn opts(policy: SsrfPolicy, resolver: Arc<dyn HostResolver>) -> SafeGetOptions {
    SafeGetOptions {
        policy,
        resolver,
        timeout: Duration::from_secs(5),
        max_bytes: 64 * 1024,
    }
}

/// Máy chủ HTTP/1.1 tối giản trên 127.0.0.1, trả lời theo đường dẫn. `/slow` không bao giờ trả lời.
async fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf);
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let big = format!("{{\"x\":\"{}\"}}", "a".repeat(70_000));
                let (status, headers, body): (&str, &str, Vec<u8>) = match path.as_str() {
                    "/ok" => (
                        "200 OK",
                        "Content-Type: application/json; charset=utf-8\r\nCache-Control: public, max-age=120\r\n",
                        b"{\"a\":1}".to_vec(),
                    ),
                    "/redir" => ("302 Found", "Location: http://169.254.169.254/\r\n", Vec::new()),
                    "/ctype" => ("200 OK", "Content-Type: text/html\r\n", b"{\"a\":1}".to_vec()),
                    "/bad" => ("200 OK", "Content-Type: application/json\r\n", b"{nope".to_vec()),
                    "/big" => ("200 OK", "Content-Type: application/json\r\n", big.into_bytes()),
                    "/img" => (
                        "200 OK",
                        "Content-Type: Image/PNG; x=1\r\n",
                        vec![0x89, b'P', b'N', b'G'],
                    ),
                    "/slow" => {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    _ => ("404 Not Found", "", Vec::new()),
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            });
        }
    });
    format!("http://{addr}")
}

struct Fake {
    answers: Vec<Vec<&'static str>>,
    calls: AtomicUsize,
}

impl HostResolver for Fake {
    fn lookup<'a>(&'a self, _host: &'a str) -> LookupFuture<'a> {
        let i = self.calls.fetch_add(1, Ordering::SeqCst).min(self.answers.len() - 1);
        let a = self.answers[i].clone();
        Box::pin(async move { Ok::<_, io::Error>(a.iter().map(|s| s.parse::<IpAddr>().expect("ip")).collect()) })
    }
}

async fn err(url: &str, o: &SafeGetOptions) -> String {
    safe_get_json(url, o).await.expect_err(url).to_string()
}

#[tokio::test]
async fn ssrf_moi_dia_chi_noi_bo_bi_chan_khi_khong_bat_co_dev() {
    let o = opts(PROD, Arc::new(SystemResolver));
    for u in [
        "https://127.0.0.1/a",
        "https://10.1.2.3/a",
        "https://169.254.169.254/a",
        "https://[::1]/a",
        "https://[::ffff:127.0.0.1]/a",
        "https://0.0.0.0/a",
        "http://example.com/a",
        "https://example.com:22/a",
    ] {
        assert_eq!(err(u, &o).await, "blocked_target", "{u}");
    }
}

#[tokio::test]
async fn tron_ip_noi_bo_vao_dap_an_bi_chan() {
    let fake = Arc::new(Fake {
        answers: vec![vec!["93.184.216.34", "10.0.0.1"]],
        calls: AtomicUsize::new(0),
    });
    assert_eq!(
        err("https://rebind.example.com/c.json", &opts(PROD, fake)).await,
        "blocked_target"
    );
}

#[tokio::test]
async fn dns_rebinding_bi_chan_tren_duong_client_that() {
    // Bước kiểm thấy IP công cộng; lần phân giải lúc client nối socket là 127.0.0.1 → bộ phân giải của client từ chối,
    // không có kết nối nào tới địa chỉ nội bộ.
    let fake = Arc::new(Fake {
        answers: vec![vec!["93.184.216.34"], vec!["127.0.0.1"]],
        calls: AtomicUsize::new(0),
    });
    assert_eq!(
        err("https://rebind.example.com/c.json", &opts(PROD, fake.clone())).await,
        "network_error"
    );
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        2,
        "client phải phân giải qua bộ kiểm SSRF"
    );
}

#[tokio::test]
async fn json_hop_le_va_max_age() {
    let origin = serve().await;
    let r = safe_get_json(&format!("{origin}/ok"), &opts(DEV, Arc::new(SystemResolver)))
        .await
        .expect("ok");
    assert_eq!(r.status, 200);
    assert_eq!(r.max_age_sec, Some(120));
    assert_eq!(r.json, serde_json::json!({ "a": 1 }));
}

#[tokio::test]
async fn khong_theo_chuyen_huong_va_cac_loi() {
    let origin = serve().await;
    let o = opts(DEV, Arc::new(SystemResolver));
    assert_eq!(err(&format!("{origin}/redir"), &o).await, "redirect_not_followed");
    assert_eq!(err(&format!("{origin}/missing"), &o).await, "http_404");
    assert_eq!(err(&format!("{origin}/ctype"), &o).await, "not_json");
    assert_eq!(err(&format!("{origin}/bad"), &o).await, "invalid_json");
    assert_eq!(err(&format!("{origin}/big"), &o).await, "too_large");
}

#[tokio::test]
async fn het_han() {
    let origin = serve().await;
    let mut o = opts(DEV, Arc::new(SystemResolver));
    o.timeout = Duration::from_millis(150);
    assert_eq!(err(&format!("{origin}/slow"), &o).await, "timeout");
}

#[tokio::test]
async fn tai_media() {
    let origin = serve().await;
    let o = opts(DEV, Arc::new(SystemResolver));
    let m = safe_get_media(&format!("{origin}/img"), &o).await.expect("ảnh");
    assert_eq!(m.content_type, "image/png");
    assert_eq!(m.body, [0x89, b'P', b'N', b'G']);
    assert_eq!(
        safe_get_media(&format!("{origin}/ok"), &o)
            .await
            .expect_err("json")
            .to_string(),
        "not_media"
    );
}
