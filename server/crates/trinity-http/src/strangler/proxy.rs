//! Chuyển tiếp một request sang Node/Next qua loopback: stream không đệm, nâng cấp WebSocket, timeout, header IP có chữ ký.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{CONNECTION, HOST, UPGRADE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::Response;
use http_body::{Body as HttpBody, Frame, SizeHint};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use tokio::sync::watch;
use tokio::time::Sleep;
use trinity_kernel::error::HttpError;

use crate::edge::body::error_response;
use crate::edge::client_ip::{CLIENT_IP_HEADER, ClientIp, UNTRUSTED_CLIENT_IP, sign_client_ip};

/// Header do client gửi mà Node/Next không được thấy: IP chỉ tới Node qua `x-trinity-client-ip` có chữ ký, giao thức và
/// host gốc do Rust đặt lại.
const STRIPPED: &[&str] = &[
    "x-real-ip",
    "x-forwarded-for",
    "forwarded",
    "cf-connecting-ip",
    "true-client-ip",
    "x-cluster-client-ip",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-server",
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

/// Đường dẫn của Node: API (`/api/v1`), socket, tệp tải lên, tài liệu. Mọi thứ khác (kể cả `/api/build-id`,
/// `/api/fe-logging`, route handler của Next) là của Next; không có Next cấu hình thì rơi về Node.
const NODE_PREFIXES: &[&str] = &["/api/v1", "/notif-ws", "/uploads", "/docs"];

/// `/.well-known/*` là rewrite của Next sang Node (`apps/web/next.config`): Node chỉ có chúng dưới `/api/v1/oauth`.
/// Rust làm đúng rewrite đó rồi gửi thẳng Node, nên không phụ thuộc Next.
const WELL_KNOWN: &[(&str, &str)] = &[
    (
        "/.well-known/oauth-authorization-server",
        "/api/v1/oauth/.well-known/oauth-authorization-server",
    ),
    (
        "/.well-known/oauth-protected-resource",
        "/api/v1/oauth/protected-resource",
    ),
];

#[derive(Debug, Clone, Copy)]
pub struct ProxyTimeouts {
    /// Chờ response đầu tiên sau khi gửi xong request (route handler hiện tại: 15 giây).
    pub response: Duration,
    /// Như trên cho `/export` (120 giây).
    pub export: Duration,
    /// Kết nối tới Node/Next.
    pub connect: Duration,
    /// Im lặng tối đa giữa hai mảnh body (request đang tải lên hoặc response đang tải xuống); quá hạn thì cắt, không treo
    /// vô hạn khi một bên ngừng gửi.
    pub body_idle: Duration,
}

impl Default for ProxyTimeouts {
    fn default() -> Self {
        Self {
            response: Duration::from_secs(15),
            export: Duration::from_secs(120),
            connect: Duration::from_secs(5),
            body_idle: Duration::from_secs(120),
        }
    }
}

/// Giao thức của listener thật của Rust (`X-Forwarded-Proto` gửi cho Node/Next).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenerScheme {
    Http,
    Https,
}

impl ListenerScheme {
    fn as_str(self) -> &'static str {
        match self {
            ListenerScheme::Http => "http",
            ListenerScheme::Https => "https",
        }
    }
}

/// Node đóng kết nối rảnh sau 5 giây (`keepAliveTimeout` mặc định); ta bỏ kết nối rảnh sớm hơn để không dùng nhầm kết nối
/// vừa bị đóng (lỗi "connection reset" ngẫu nhiên ở request đầu sau một khoảng nghỉ).
const POOL_IDLE: Duration = Duration::from_secs(4);

pub struct NodeProxy {
    client: Client<HttpConnector, TrackedBody>,
    node: Uri,
    web: Option<Uri>,
    secret: Option<String>,
    timeouts: ProxyTimeouts,
    scheme: ListenerScheme,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// Body bọc cho request: (1) báo khi gửi hết, để hạn chờ response tính từ lúc đó; (2) ngắt khi im lặng quá `idle`.
struct TrackedBody {
    inner: Body,
    done: watch::Sender<bool>,
    idle: Pin<Box<Sleep>>,
    idle_for: Duration,
}

impl TrackedBody {
    fn new(inner: Body, idle_for: Duration) -> (Self, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        if inner.is_end_stream() {
            let _ = tx.send(true);
        }
        (
            Self {
                inner,
                done: tx,
                idle: Box::pin(tokio::time::sleep(idle_for)),
                idle_for,
            },
            rx,
        )
    }
}

impl HttpBody for TrackedBody {
    type Data = <Body as HttpBody>::Data;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Ready(r) => {
                let deadline = tokio::time::Instant::now() + self.idle_for;
                self.idle.as_mut().reset(deadline);
                if r.is_none() || self.inner.is_end_stream() {
                    let _ = self.done.send(true);
                }
                Poll::Ready(r.map(|f| f.map_err(Into::into)))
            }
            Poll::Pending => {
                if self.idle.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Some(Err("client ngừng gửi body quá hạn".into())));
                }
                Poll::Pending
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Body response bọc: ngắt khi upstream im lặng quá `idle` giữa hai mảnh.
struct IdleBody<B> {
    inner: B,
    idle: Pin<Box<Sleep>>,
    idle_for: Duration,
}

impl<B: HttpBody + Unpin> HttpBody for IdleBody<B>
where
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    type Data = B::Data;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Ready(r) => {
                let deadline = tokio::time::Instant::now() + self.idle_for;
                self.idle.as_mut().reset(deadline);
                Poll::Ready(r.map(|f| f.map_err(Into::into)))
            }
            Poll::Pending => {
                if self.idle.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Some(Err("upstream ngừng gửi body quá hạn".into())));
                }
                Poll::Pending
            }
        }
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
        let client = Client::builder(TokioExecutor::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(POOL_IDLE)
            .build(http);
        Self {
            client,
            node,
            web,
            secret,
            timeouts,
            scheme: ListenerScheme::Http,
            clock: Arc::new(system_secs),
        }
    }

    /// Giao thức của listener thật (mặc định `http`; `https` khi `TLS_MODE=files`).
    #[must_use]
    pub fn with_scheme(mut self, scheme: ListenerScheme) -> Self {
        self.scheme = scheme;
        self
    }

    /// Chỉ cho test: đồng hồ (giây Unix) dùng để ký.
    #[must_use]
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    /// Đích và đường dẫn gửi đi (đã rewrite `.well-known`).
    fn target(&self, uri: &Uri) -> (&Uri, String) {
        let path = uri.path();
        let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
        for (from, to) in WELL_KNOWN {
            if path == *from || path.strip_prefix(from).is_some_and(|r| r.starts_with('/')) {
                return (&self.node, format!("{to}{query}"));
            }
        }
        let is_node = NODE_PREFIXES
            .iter()
            .any(|p| path == *p || path.strip_prefix(p).is_some_and(|r| r.starts_with('/')));
        let base = match (&self.web, is_node) {
            (Some(web), false) => web,
            _ => &self.node,
        };
        (base, format!("{path}{query}"))
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
        let (base, pq) = self.target(req.uri());
        let base = base.clone();
        let export = Self::is_export(req.uri().path());
        let Some(uri) = build_uri(&base, &pq) else {
            return gateway(502, "Bad Gateway", "Bad Gateway");
        };
        // HTTP/2 không có `Host`: lấy từ authority của URI TRƯỚC khi URI bị thay bằng địa chỉ upstream.
        let host = req.headers().get(HOST).cloned().or_else(|| {
            req.uri()
                .authority()
                .and_then(|a| HeaderValue::from_str(a.as_str()).ok())
        });
        let ip = req.extensions().get::<ClientIp>().cloned();
        let is_upgrade = is_websocket(req.headers());
        let client_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut req));

        let (parts, body) = req.into_parts();
        let method = parts.method;
        let mut headers = parts.headers;
        sanitize(&mut headers, is_upgrade);
        if let Some(h) = host {
            // `Host` gốc được giữ (Node/Next dựng URL tuyệt đối từ nó); `X-Forwarded-Host` và `-Proto` do Rust đặt lại.
            headers.insert(HOST, h.clone());
            headers.insert(HeaderName::from_static("x-forwarded-host"), h);
        }
        headers.insert(
            HeaderName::from_static("x-forwarded-proto"),
            HeaderValue::from_static(self.scheme.as_str()),
        );
        // Ký NGAY trước khi gửi header (Node kiểm lúc nhận header, nên body chậm không làm chữ ký hết hạn).
        if let Some(v) = self.sign(ip.as_ref()) {
            headers.insert(HeaderName::from_static(CLIENT_IP_HEADER), v);
        }
        let (body, sent) = TrackedBody::new(body, self.timeouts.body_idle);
        let mut out = hyper::Request::new(body);
        *out.method_mut() = method.clone();
        *out.uri_mut() = uri;
        *out.version_mut() = axum::http::Version::HTTP_11;
        *out.headers_mut() = headers;

        let limit = if export {
            self.timeouts.export
        } else {
            self.timeouts.response
        };
        let fut = self.client.request(out);
        // Hạn chờ tính từ lúc request gửi xong (upload 200 MB không bị cắt giữa chừng); body im lặng quá `body_idle` thì
        // chính body báo lỗi.
        let deadline = async {
            let mut sent = sent;
            let _ = sent.wait_for(|done| *done).await;
            tokio::time::sleep(limit).await;
        };
        let mut resp = tokio::select! {
            r = fut => match r {
                Ok(r) => r,
                Err(e) => {
                    // Không ghi đường dẫn: có thể chứa token (liên kết mời, OAuth).
                    tracing::warn!("[strangler] {method}: upstream lỗi: {e}");
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
        remove_hop_headers(&mut rp.headers);
        let idle_for = self.timeouts.body_idle;
        Response::from_parts(
            rp,
            Body::new(IdleBody {
                inner: rbody,
                idle: Box::pin(tokio::time::sleep(idle_for)),
                idle_for,
            }),
        )
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

/// Bỏ header theo từng chặng, kể cả các header mà `Connection` liệt kê (RFC 9110 mục 7.6.1).
fn remove_hop_headers(h: &mut HeaderMap) {
    let listed: Vec<String> = h
        .get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| {
            v.split(',')
                .map(|t| t.trim().to_ascii_lowercase())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
        })
        .collect();
    for name in listed {
        h.remove(name.as_str());
    }
    for name in HOP_BY_HOP {
        h.remove(*name);
    }
}

fn sanitize(h: &mut HeaderMap, keep_upgrade: bool) {
    for name in STRIPPED {
        h.remove(*name);
    }
    remove_hop_headers(h);
    if keep_upgrade {
        h.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        h.insert(UPGRADE, HeaderValue::from_static("websocket"));
    }
}

fn build_uri(base: &Uri, path_and_query: &str) -> Option<Uri> {
    Uri::builder()
        .scheme(base.scheme()?.clone())
        .authority(base.authority()?.clone())
        .path_and_query(path_and_query)
        .build()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(web: bool) -> NodeProxy {
        NodeProxy::new(
            "http://127.0.0.1:4000".parse().unwrap(),
            web.then(|| "http://127.0.0.1:3000".parse().unwrap()),
            None,
            ProxyTimeouts::default(),
        )
    }

    fn t(p: &NodeProxy, u: &str) -> (String, String) {
        let (base, pq) = p.target(&u.parse().unwrap());
        (base.to_string(), pq)
    }

    #[test]
    fn chi_api_v1_va_cac_duong_dan_node_sang_node_con_lai_sang_next() {
        let p = proxy(true);
        for u in [
            "/api/v1/contacts?x=1",
            "/api/v1",
            "/notif-ws/?EIO=4",
            "/uploads/a.png",
            "/docs",
        ] {
            assert_eq!(t(&p, u).0, "http://127.0.0.1:4000/", "{u}");
        }
        for u in [
            "/api/build-id",
            "/api/fe-logging",
            "/trang",
            "/",
            "/api/v10/x",
            "/uploads-x",
        ] {
            assert_eq!(t(&p, u).0, "http://127.0.0.1:3000/", "{u}");
        }
        // Không có Next cấu hình: mọi thứ rơi về Node.
        assert_eq!(t(&proxy(false), "/api/build-id").0, "http://127.0.0.1:4000/");
    }

    #[test]
    fn well_known_rewrite_sang_duong_dan_node_nhu_next() {
        for web in [true, false] {
            let p = proxy(web);
            assert_eq!(
                t(&p, "/.well-known/oauth-authorization-server?a=1"),
                (
                    "http://127.0.0.1:4000/".into(),
                    "/api/v1/oauth/.well-known/oauth-authorization-server?a=1".into()
                )
            );
            assert_eq!(
                t(&p, "/.well-known/oauth-protected-resource/api/v1/mcp").1,
                "/api/v1/oauth/protected-resource"
            );
            // Đường dẫn khác dưới /.well-known không có ở Node: đi Next khi có, không thì Node nguyên đường dẫn.
            let other = t(&p, "/.well-known/security.txt");
            assert_eq!(
                other.0,
                if web {
                    "http://127.0.0.1:3000/"
                } else {
                    "http://127.0.0.1:4000/"
                }
            );
        }
    }

    #[test]
    fn bo_header_duoc_connection_nem_ra() {
        let mut h = HeaderMap::new();
        h.insert(CONNECTION, HeaderValue::from_static("close, X-Secret-Hop"));
        h.insert("x-secret-hop", HeaderValue::from_static("1"));
        h.insert("x-giu-lai", HeaderValue::from_static("2"));
        remove_hop_headers(&mut h);
        assert!(h.get("x-secret-hop").is_none() && h.get(CONNECTION).is_none());
        assert!(h.get("x-giu-lai").is_some());
    }
}
