//! Cổng tương thích (#597): cùng router phục vụ ở hai listener, tắt êm cùng một tín hiệu.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::extract::ConnectInfo;
use axum::routing::get;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use trinity_http::serve::{DEFAULT_GRACE, compat_listen_host, serve};

async fn get_path(addr: SocketAddr, path: &str) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

#[test]
fn dia_chi_nghe_cong_tuong_thich() {
    assert_eq!(compat_listen_host(&env(&[]), true), "0.0.0.0");
    assert_eq!(compat_listen_host(&env(&[]), false), "127.0.0.1");
    assert_eq!(
        compat_listen_host(&env(&[("TRUSTED_PROXY", "cloudflare-tunnel")]), true),
        "127.0.0.1"
    );
    assert_eq!(compat_listen_host(&env(&[("TRUSTED_PROXY", "caddy")]), true), "0.0.0.0");
}

#[tokio::test]
async fn hai_cong_cung_router_va_tat_em_cung_tin_hieu() {
    // Router giả: /api/v1/health trả IP peer mà serve gắn vào ConnectInfo (cùng đường xác định IP ở cả hai cổng).
    let app = Router::new().route(
        "/api/v1/health",
        get(|ConnectInfo(p): ConnectInfo<SocketAddr>| async move { format!("ok {}", p.ip()) }),
    );
    let main = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let compat = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (main_addr, compat_addr) = (main.local_addr().unwrap(), compat.local_addr().unwrap());
    assert_ne!(main_addr.port(), compat_addr.port());
    let (tx, rx) = tokio::sync::watch::channel(false);
    let (mut r1, mut r2) = (rx.clone(), rx);
    let h1 = tokio::spawn(serve(
        main,
        app.clone(),
        None,
        async move {
            let _ = r1.wait_for(|v| *v).await;
        },
        DEFAULT_GRACE,
    ));
    let h2 = tokio::spawn(serve(
        compat,
        app,
        None,
        async move {
            let _ = r2.wait_for(|v| *v).await;
        },
        DEFAULT_GRACE,
    ));

    for addr in [main_addr, compat_addr] {
        let r = get_path(addr, "/api/v1/health").await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.ends_with("ok 127.0.0.1"), "{r}");
    }

    tx.send(true).unwrap();
    for h in [h1, h2] {
        tokio::time::timeout(Duration::from_secs(5), h)
            .await
            .expect("dừng trong 5 giây")
            .unwrap()
            .unwrap();
    }
    assert!(
        TcpStream::connect(compat_addr).await.is_err(),
        "cổng tương thích đã đóng"
    );
}
