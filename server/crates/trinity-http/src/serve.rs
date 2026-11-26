//! Phục vụ HTTP cho cổng chính (PLAN 4.2, 4.13, K19): `TLS_MODE=off` (sau Cloudflare Tunnel hoặc proxy) hoặc `files`
//! (tệp PEM, vd Cloudflare Origin Certificate). Không ACME: TLS công khai do Cloudflare lo.
//!
//! Tắt máy êm: khi tín hiệu dừng tới, ngừng nhận kết nối mới ngay, các kết nối đang có được báo "đóng sau request
//! hiện tại" (HTTP/1: `Connection: close`, HTTP/2: GOAWAY) và request dở được chạy xong, tối đa `grace`.

use std::future::Future;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

/// Thời gian chờ request dở khi tắt máy nếu không cấu hình khác.
pub const DEFAULT_GRACE: Duration = Duration::from_secs(30);

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
/// Trả `Ok` cả khi hết `grace` mà còn kết nối (ghi cảnh báo, kết nối bị cắt khi tiến trình thoát).
pub async fn serve(
    listener: TcpListener,
    app: Router,
    tls: Option<TlsAcceptor>,
    shutdown: impl Future<Output = ()> + Send,
    grace: Duration,
) -> io::Result<()> {
    let graceful = GracefulShutdown::new();
    tokio::pin!(shutdown);
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
                Err(e) => return Err(e),
            },
        };
        let _ = stream.set_nodelay(true);
        let svc = TowerToHyperService::new(app.clone());
        let watcher = graceful.watcher();
        let tls = tls.clone();
        tokio::spawn(async move {
            let builder = Builder::new(TokioExecutor::new());
            let res = match tls {
                None => {
                    let conn = builder.serve_connection_with_upgrades(TokioIo::new(stream), svc);
                    watcher.watch(conn.into_owned()).await
                }
                Some(acceptor) => {
                    let tls_stream = match acceptor.accept(stream).await {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::debug!("bắt tay TLS với {peer} lỗi: {e}");
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
    Ok(())
}

fn is_transient_accept_error(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted
    ) || matches!(e.raw_os_error(), Some(23 | 24)) // ENFILE, EMFILE
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
    async fn het_han_cho_thi_van_thoat() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        let srv = tokio::spawn(serve(
            l,
            app(),
            None,
            async {
                let _ = rx.await;
            },
            Duration::from_millis(200),
        ));
        let req = tokio::spawn(async move { reqwest::get(format!("http://127.0.0.1:{port}/slow")).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
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
