//! Phục vụ HTTP cho cổng chính (PLAN 4.2, 4.13, K19): `TLS_MODE=off` (sau Cloudflare Tunnel hoặc proxy) hoặc `files`
//! (tệp PEM, vd Cloudflare Origin Certificate). Không ACME: TLS công khai do Cloudflare lo.
//!
//! Tắt máy êm: khi tín hiệu dừng tới, ngừng nhận kết nối mới ngay, các kết nối đang có được báo "đóng sau request
//! hiện tại" (HTTP/1: `Connection: close`, HTTP/2: GOAWAY) và request dở được chạy xong, tối đa `grace`.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::ConnectInfo;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::GracefulShutdown;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;

/// Thời gian chờ request dở khi tắt máy nếu không cấu hình khác.
pub const DEFAULT_GRACE: Duration = Duration::from_secs(30);

/// Bắt tay TLS quá lâu thì bỏ kết nối.
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Đọc xong header của một request (kể cả request kế tiếp trên kết nối keep-alive) quá lâu thì đóng (chống slowloris).
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// HTTP/2: gửi PING mỗi chừng này khi im lặng; không trả lời sau `H2_KEEP_ALIVE_TIMEOUT` thì đóng.
const H2_KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(30);
const H2_KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(20);

/// Địa chỉ nghe của cổng tương thích `COMPAT_API_PORT` (X06, #597): trong container nghe mọi giao diện (compose chỉ công
/// bố ra loopback của host); ngoài Docker, hoặc khi `TRUSTED_PROXY=cloudflare-tunnel` (tunnel tin `cf-connecting-ip` của
/// mọi peer, chỉ trỏ cổng chính), chỉ nghe loopback.
pub fn compat_listen_host(env: &std::collections::BTreeMap<String, String>, in_container: bool) -> &'static str {
    let tunnel = env
        .get("TRUSTED_PROXY")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("cloudflare-tunnel"));
    if in_container && !tunnel {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
}

/// Tiến trình đang chạy trong container (cùng các dấu hiệu với dò mạng của `edge::client_ip`).
pub fn running_in_container() -> bool {
    Path::new("/.dockerenv").exists()
        || Path::new("/run/.containerenv").exists()
        || std::fs::read_to_string("/proc/1/cgroup").is_ok_and(|c| {
            ["docker", "kubepods", "containerd", "libpod"]
                .iter()
                .any(|k| c.contains(k))
        })
}

/// Lỗi nạp chứng chỉ TLS (lỗi cấu hình: tiến trình phải dừng khi khởi động).
#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("TLS_CERT_FILE '{path}' không đọc được: {reason}")]
    Cert { path: String, reason: String },
    #[error("TLS_KEY_FILE '{path}' không đọc được: {reason}")]
    Key { path: String, reason: String },
    #[error("chứng chỉ và khoá không khớp hoặc không dùng được: {0}")]
    Config(String),
}

/// Nạp chuỗi chứng chỉ và khoá riêng (PEM) thành bộ chấp nhận TLS (HTTP/2 và HTTP/1.1). Cần provider `ring` của
/// rustls: `main` cài một lần lúc khởi động; chưa cài thì hàm này tự dùng provider `ring` cho cấu hình này.
pub fn load_tls_acceptor(cert: &Path, key: &Path) -> Result<TlsAcceptor, TlsError> {
    let cert_err = |reason: String| TlsError::Cert {
        path: cert.display().to_string(),
        reason,
    };
    let certs = CertificateDer::pem_file_iter(cert)
        .map_err(|e| cert_err(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| cert_err(e.to_string()))?;
    if certs.is_empty() {
        return Err(cert_err("không có chứng chỉ PEM nào".to_owned()));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| TlsError::Key {
        path: key.display().to_string(),
        reason: e.to_string(),
    })?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| TlsError::Config(e.to_string()))?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| TlsError::Config(e.to_string()))?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

/// Chạy `app` trên `listener` tới khi `shutdown` xong, rồi chờ request dở tối đa `grace`. `tls = None` ⇒ HTTP thường.
/// Trả `Ok` cả khi hết `grace` mà còn kết nối (ghi cảnh báo, kết nối bị cắt khi tiến trình thoát). Lỗi `accept`
/// nghiêm trọng thì cũng drain có hạn như khi tắt máy rồi mới trả lỗi.
///
/// Mỗi request mang `ConnectInfo<SocketAddr>` (địa chỉ peer TCP) trong extensions, nơi `edge::client_ip` đọc.
///
/// WebSocket và các kết nối đã nâng cấp (`/notif-ws`) KHÔNG được drain: chúng bị cắt khi hết `grace`, client phải nối
/// lại sau khi khởi động lại.
pub async fn serve(
    listener: TcpListener,
    app: Router,
    tls: Option<TlsAcceptor>,
    shutdown: impl Future<Output = ()> + Send,
    grace: Duration,
) -> io::Result<()> {
    let graceful = GracefulShutdown::new();
    tokio::pin!(shutdown);
    let mut fatal = None;
    loop {
        let (stream, peer) = tokio::select! {
            () = &mut shutdown => break,
            res = listener.accept() => match res {
                Ok(v) => v,
                Err(e) if is_transient_accept_error(&e) => {
                    tracing::warn!("accept lỗi tạm thời: {e}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
                Err(e) => {
                    fatal = Some(e);
                    break;
                }
            },
        };
        let _ = stream.set_nodelay(true);
        let app = app.clone();
        let svc = service_fn(move |mut req: hyper::Request<Incoming>| {
            req.extensions_mut().insert(ConnectInfo::<SocketAddr>(peer));
            app.clone().oneshot(req)
        });
        let watcher = graceful.watcher();
        let tls = tls.clone();
        tokio::spawn(async move {
            let mut builder = Builder::new(TokioExecutor::new());
            builder
                .http1()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_READ_TIMEOUT);
            builder
                .http2()
                .timer(TokioTimer::new())
                .keep_alive_interval(Some(H2_KEEP_ALIVE_INTERVAL))
                .keep_alive_timeout(H2_KEEP_ALIVE_TIMEOUT);
            let res = match tls {
                None => {
                    let conn = builder.serve_connection_with_upgrades(TokioIo::new(stream), svc);
                    watcher.watch(conn.into_owned()).await
                }
                Some(acceptor) => {
                    let tls_stream = match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                        Ok(Ok(s)) => s,
                        Ok(Err(e)) => {
                            tracing::debug!("bắt tay TLS với {peer} lỗi: {e}");
                            return;
                        }
                        Err(_) => {
                            tracing::debug!("bắt tay TLS với {peer} quá {}s, bỏ", TLS_HANDSHAKE_TIMEOUT.as_secs());
                            return;
                        }
                    };
                    let conn = builder.serve_connection_with_upgrades(TokioIo::new(tls_stream), svc);
                    watcher.watch(conn.into_owned()).await
                }
            };
            if let Err(e) = res {
                tracing::debug!("kết nối {peer} kết thúc có lỗi: {e}");
            }
        });
    }
    drop(listener);
    tokio::select! {
        () = graceful.shutdown() => {}
        () = tokio::time::sleep(grace) => {
            tracing::warn!("hết {}s chờ tắt máy êm, còn request dở bị cắt", grace.as_secs());
        }
    }
    match fatal {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn is_transient_accept_error(e: &io::Error) -> bool {
    if matches!(
        e.kind(),
        io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted
    ) {
        return true;
    }
    // Hết bộ mô tả tệp (EMFILE, ENFILE): chờ rồi thử lại.
    #[cfg(unix)]
    if matches!(e.raw_os_error(), Some(libc::EMFILE | libc::ENFILE)) {
        return true;
    }
    false
}

/// Xong khi nhận SIGTERM hoặc SIGINT (Unix) / Ctrl-C (nơi khác).
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
            tracing::warn!("không cài được trình bắt tín hiệu, chờ vô hạn");
            std::future::pending::<()>().await;
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use axum::routing::get;
    use tokio::sync::oneshot;

    use super::*;

    fn self_signed(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf, Vec<u8>) {
        let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let (c, k) = (dir.join("cert.pem"), dir.join("key.pem"));
        std::fs::write(&c, ck.cert.pem()).unwrap();
        std::fs::write(&k, ck.signing_key.serialize_pem()).unwrap();
        (c, k, ck.cert.der().to_vec())
    }

    fn app() -> Router {
        Router::new().route("/hi", get(|| async { "xin chào" })).route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(800)).await;
                "xong"
            }),
        )
    }

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("trinity-tls-{}", uuid_like()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    }

    #[tokio::test]
    async fn bat_tay_tls_voi_chung_chi_tu_ky_va_h2() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = tmp();
        let (c, k, der) = self_signed(&dir);
        let acceptor = load_tls_acceptor(&c, &k).unwrap();
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        let srv = tokio::spawn(serve(
            l,
            app(),
            Some(acceptor),
            async {
                let _ = rx.await;
            },
            Duration::from_secs(5),
        ));

        let client = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_der(&der).unwrap())
            .resolve("localhost", ([127, 0, 0, 1], port).into())
            .build()
            .unwrap();
        let r = client.get(format!("https://localhost:{port}/hi")).send().await.unwrap();
        assert_eq!((r.status().as_u16(), r.version()), (200, reqwest::Version::HTTP_2));
        assert_eq!(r.text().await.unwrap(), "xin chào");
        // Không tin chứng chỉ ⇒ bắt tay thất bại.
        let strict = reqwest::Client::builder()
            .resolve("localhost", ([127, 0, 0, 1], port).into())
            .build()
            .unwrap();
        assert!(strict.get(format!("https://localhost:{port}/hi")).send().await.is_err());
        // Bắt tay hỏng ở kết nối trước không làm sập server: kết nối sau vẫn phục vụ.
        assert!(client.get(format!("https://localhost:{port}/hi")).send().await.is_ok());

        tx.send(()).unwrap();
        srv.await.unwrap().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn tep_chung_chi_sai_bao_loi_ro() {
        let dir = tmp();
        let (c, k, _) = self_signed(&dir);
        assert!(matches!(
            load_tls_acceptor(&dir.join("nope.pem"), &k),
            Err(TlsError::Cert { .. })
        ));
        assert!(matches!(
            load_tls_acceptor(&c, &dir.join("nope.pem")),
            Err(TlsError::Key { .. })
        ));
        let empty = dir.join("empty.pem");
        std::fs::write(&empty, "").unwrap();
        assert!(matches!(load_tls_acceptor(&empty, &k), Err(TlsError::Cert { .. })));
        // Khoá của chứng chỉ khác ⇒ không khớp.
        let other = rcgen::generate_simple_self_signed(vec!["x".to_owned()]).unwrap();
        let k2 = dir.join("k2.pem");
        std::fs::write(&k2, other.signing_key.serialize_pem()).unwrap();
        assert!(matches!(load_tls_acceptor(&c, &k2), Err(TlsError::Config(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sigterm_giua_request_dai_khong_rot_request() {
        for use_tls in [false, true] {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let dir = tmp();
            let (c, k, der) = self_signed(&dir);
            let acceptor = use_tls.then(|| load_tls_acceptor(&c, &k).unwrap());
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = l.local_addr().unwrap().port();
            let (tx, rx) = oneshot::channel::<()>();
            let srv = tokio::spawn(serve(
                l,
                app(),
                acceptor,
                async {
                    let _ = rx.await;
                },
                Duration::from_secs(10),
            ));
            let scheme = if use_tls { "https" } else { "http" };
            let client = reqwest::Client::builder()
                .add_root_certificate(reqwest::Certificate::from_der(&der).unwrap())
                .resolve("localhost", ([127, 0, 0, 1], port).into())
                .build()
                .unwrap();
            let url = format!("{scheme}://localhost:{port}/slow");
            let started = Instant::now();
            let req = tokio::spawn({
                let client = client.clone();
                async move { client.get(url).send().await.unwrap().text().await.unwrap() }
            });
            tokio::time::sleep(Duration::from_millis(250)).await;
            tx.send(()).unwrap(); // "SIGTERM" giữa lúc request đang chạy
            assert_eq!(req.await.unwrap(), "xong", "request dở phải hoàn tất (tls={use_tls})");
            assert!(started.elapsed() >= Duration::from_millis(700));
            srv.await.unwrap().unwrap();
            // Sau khi tắt: không nhận kết nối mới.
            assert!(
                client
                    .get(format!("{scheme}://localhost:{port}/hi"))
                    .send()
                    .await
                    .is_err()
            );
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn request_mang_connect_info_cua_peer() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let app = Router::new().route(
            "/ip",
            get(|ConnectInfo(a): ConnectInfo<SocketAddr>| async move { a.to_string() }),
        );
        let dir = tmp();
        let (c, k, der) = self_signed(&dir);
        for tls in [None, Some(load_tls_acceptor(&c, &k).unwrap())] {
            let https = tls.is_some();
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = l.local_addr().unwrap().port();
            let (tx, rx) = oneshot::channel::<()>();
            let srv = tokio::spawn(serve(
                l,
                app.clone(),
                tls,
                async {
                    let _ = rx.await;
                },
                Duration::from_secs(5),
            ));
            let client = reqwest::Client::builder()
                .add_root_certificate(reqwest::Certificate::from_der(&der).unwrap())
                .resolve("localhost", ([127, 0, 0, 1], port).into())
                .build()
                .unwrap();
            let scheme = if https { "https" } else { "http" };
            let body = client
                .get(format!("{scheme}://localhost:{port}/ip"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            let peer: SocketAddr = body.parse().unwrap();
            assert!(peer.ip().is_loopback() && peer.port() != port, "{body}");
            tx.send(()).unwrap();
            srv.await.unwrap().unwrap();
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn het_han_cho_thi_van_thoat() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (started_tx, started_rx) = oneshot::channel::<()>();
        let started = std::sync::Arc::new(std::sync::Mutex::new(Some(started_tx)));
        let app = Router::new().route(
            "/slow",
            get(move || {
                if let Some(t) = started.lock().ok().and_then(|mut g| g.take()) {
                    let _ = t.send(());
                }
                async {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    "xong"
                }
            }),
        );
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        let srv = tokio::spawn(serve(
            l,
            app,
            None,
            async {
                let _ = rx.await;
            },
            Duration::from_millis(200),
        ));
        let req = tokio::spawn(async move { reqwest::get(format!("http://127.0.0.1:{port}/slow")).await });
        started_rx.await.unwrap(); // handler đã chạy thật rồi mới "SIGTERM"
        tx.send(()).unwrap();
        let t = Instant::now();
        srv.await.unwrap().unwrap();
        assert!(
            t.elapsed() < Duration::from_millis(700),
            "phải thoát sau grace, không chờ request"
        );
        drop(req);
    }
}
