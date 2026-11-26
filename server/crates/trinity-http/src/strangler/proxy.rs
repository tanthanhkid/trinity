//! Chuyển tiếp một request sang Node/Next qua loopback: stream không đệm, nâng cấp WebSocket, timeout, header IP có chữ ký.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{CONNECTION, UPGRADE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::Response;
use http_body::{Body as HttpBody, Frame, SizeHint};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use tokio::sync::watch;
use trinity_kernel::error::HttpError;

use crate::edge::body::error_response;
use crate::edge::client_ip::{CLIENT_IP_HEADER, ClientIp, UNTRUSTED_CLIENT_IP, sign_client_ip};

/// Header do client gửi mà Node/Next không được thấy: IP chỉ tới Node qua `x-trinity-client-ip` có chữ ký.
const STRIPPED: &[&str] = &[
    "x-real-ip",
    "x-forwarded-for",
    "forwarded",
    "cf-connecting-ip",
    CLIENT_IP_HEADER,
    "x-trinity-peer-ip",
];

/// Header theo từng chặng (RFC 9110 mục 7.6.1), không chuyển tiếp.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "proxy-connection",
];

/// Đường dẫn luôn đi Node (API, tệp tải lên, socket, tài liệu); phần còn lại là trang, đi Next nếu có cấu hình.
const NODE_PREFIXES: &[&str] = &["/api", "/notif-ws", "/uploads", "/.well-known", "/docs"];

#[derive(Debug, Clone, Copy)]
pub struct ProxyTimeouts {
    /// Chờ response đầu tiên sau khi gửi xong request (route handler hiện tại: 15 giây).
    pub response: Duration,
    /// Như trên cho `/export` (120 giây).
    pub export: Duration,
    /// Kết nối tới Node/Next.
    pub connect: Duration,
}

impl Default for ProxyTimeouts {
    fn default() -> Self {
        Self {
            response: Duration::from_secs(15),
            export: Duration::from_secs(120),
            connect: Duration::from_secs(5),
        }
    }
}

pub struct NodeProxy {
    client: Client<HttpConnector, TrackedBody>,
    node: Uri,
    web: Option<Uri>,
    secret: Option<String>,
    timeouts: ProxyTimeouts,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// Body bọc: báo khi request đã gửi hết (để tính hạn chờ response từ lúc đó, không phải từ lúc bắt đầu tải lên).
struct TrackedBody {
    inner: Body,
    done: watch::Sender<bool>,
}

impl TrackedBody {
    fn new(inner: Body) -> (Self, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        if inner.is_end_stream() {
            let _ = tx.send(true);
        }
        (Self { inner, done: tx }, rx)
    }
}

impl HttpBody for TrackedBody {
    type Data = <Body as HttpBody>::Data;
    type Error = <Body as HttpBody>::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let r = std::pin::Pin::new(&mut self.inner).poll_frame(cx);
        if matches!(r, std::task::Poll::Ready(None)) || self.inner.is_end_stream() {
            let _ = self.done.send(true);
        }
        r
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn gateway(status: u16, message: &str, label: &str) -> Response {
    error_response(&HttpError::with_label(status, message, label))
}

impl NodeProxy {
    /// `node`: `NODE_FALLBACK_URL` (ví dụ `http://127.0.0.1:4000`). `web`: Next, nếu có. `secret`: bí mật nội bộ ký
    /// `x-trinity-client-ip` (không có thì chỉ gửi dấu `untrusted`, Node chỉ nhận từ loopback).
    pub fn new(node: Uri, web: Option<Uri>, secret: Option<String>, timeouts: ProxyTimeouts) -> Self {
        let mut http = HttpConnector::new();
        http.set_nodelay(true);
        http.set_connect_timeout(Some(timeouts.connect));
        let client = Client::builder(TokioExecutor::new()).build(http);
        Self {
            client,
            node,
            web,
            secret,
            timeouts,
            clock: Arc::new(system_secs),
        }
    }

    /// Chỉ cho test: đồng hồ (giây Unix) dùng để ký.
    #[must_use]
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    fn upstream(&self, path: &str) -> &Uri {
        let is_node = NODE_PREFIXES
            .iter()
            .any(|p| path == *p || path.strip_prefix(p).is_some_and(|r| r.starts_with('/')));
        match (&self.web, is_node) {
            (Some(web), false) => web,
            _ => &self.node,
        }
    }

    fn is_export(path: &str) -> bool {
        path.split('/').any(|s| s == "export")
    }

    fn sign(&self, ip: Option<&ClientIp>) -> Option<HeaderValue> {
        let value = ip
            .and_then(|c| c.ip)
            .map_or_else(|| UNTRUSTED_CLIENT_IP.to_owned(), |i| i.to_string());
        let header = match &self.secret {
            Some(s) => sign_client_ip(&value, s, (self.clock)()),
            // Không có bí mật: không ký được. `untrusted` không chữ ký chỉ được Node nhận khi peer là loopback.
            None => UNTRUSTED_CLIENT_IP.to_owned(),
        };
        HeaderValue::from_str(&header).ok()
    }

    /// Chuyển tiếp `req` (đã qua `client_ip_layer`) và trả response của upstream.
    pub async fn forward(&self, mut req: Request) -> Response {
        let path = req.uri().path().to_owned();
        let base = self.upstream(&path).clone();
        let Some(uri) = rebuild_uri(&base, req.uri()) else {
            return gateway(502, "Bad Gateway", "Bad Gateway");
        };
        let ip = req.extensions().get::<ClientIp>().cloned();
        let is_upgrade = is_websocket(req.headers());
        let client_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut req));

        let (parts, body) = req.into_parts();
        let mut headers = parts.headers;
        sanitize(&mut headers, is_upgrade);
        // Ký NGAY trước khi gửi header (Node kiểm lúc nhận header, nên body chậm không làm chữ ký hết hạn).
        if let Some(v) = self.sign(ip.as_ref()) {
            headers.insert(HeaderName::from_static(CLIENT_IP_HEADER), v);
        }
        let (body, sent) = TrackedBody::new(body);
        let mut out = hyper::Request::new(body);
        *out.method_mut() = parts.method;
        *out.uri_mut() = uri;
        *out.version_mut() = axum::http::Version::HTTP_11;
        *out.headers_mut() = headers;

        let limit = if Self::is_export(&path) {
            self.timeouts.export
        } else {
            self.timeouts.response
        };
        let fut = self.client.request(out);
        // Hạn chờ tính từ lúc request gửi xong (upload 200 MB không bị cắt giữa chừng).
        let deadline = async {
            let mut sent = sent;
            let _ = sent.wait_for(|done| *done).await;
            tokio::time::sleep(limit).await;
        };
        let mut resp = tokio::select! {
            r = fut => match r {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("[strangler] {path}: {e}");
                    return gateway(502, "Bad Gateway", "Bad Gateway");
                }
            },
            () = deadline => return gateway(504, "Gateway Timeout", "Gateway Timeout"),
        };

        if is_upgrade && resp.status() == StatusCode::SWITCHING_PROTOCOLS {
            let node_upgrade = hyper::upgrade::on(&mut resp);
            if let Some(client_upgrade) = client_upgrade {
                tokio::spawn(async move {
                    let (Ok(c), Ok(n)) = (client_upgrade.await, node_upgrade.await) else {
                        return;
                    };
                    let (mut c, mut n) = (hyper_util::rt::TokioIo::new(c), hyper_util::rt::TokioIo::new(n));
                    let _ = tokio::io::copy_bidirectional(&mut c, &mut n).await;
                });
            }
            let (rp, _) = resp.into_parts();
            // Giữ Connection/Upgrade của upstream: client cần chúng để hoàn tất bắt tay.
            return Response::from_parts(rp, Body::empty());
        }

        let (mut rp, rbody) = resp.into_parts();
        for h in HOP_BY_HOP {
            rp.headers.remove(*h);
        }
        Response::from_parts(rp, Body::new(rbody))
    }
}

fn system_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn is_websocket(h: &HeaderMap) -> bool {
    let has = |name: HeaderName, token: &str| {
        h.get_all(name)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
    };
    has(CONNECTION, "upgrade") && has(UPGRADE, "websocket")
}

fn sanitize(h: &mut HeaderMap, keep_upgrade: bool) {
    for name in STRIPPED {
        h.remove(*name);
    }
    for name in HOP_BY_HOP {
        h.remove(*name);
    }
    if keep_upgrade {
        h.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        h.insert(UPGRADE, HeaderValue::from_static("websocket"));
    }
    // `Host` gốc được giữ (Node/Next dựng URL tuyệt đối từ nó); thiếu thì hyper lấy từ URI.
}

fn rebuild_uri(base: &Uri, orig: &Uri) -> Option<Uri> {
    let pq = orig.path_and_query().map_or("/", |p| p.as_str());
    Uri::builder()
        .scheme(base.scheme()?.clone())
        .authority(base.authority()?.clone())
        .path_and_query(pq)
        .build()
        .ok()
}
