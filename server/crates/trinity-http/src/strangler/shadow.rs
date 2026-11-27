//! So sánh shadow (K28, docs/rust/PLAN.md mục 4.14): với route Node đang phục vụ mà `safe_for_shadow = true`, sau khi Node đã trả
//! response, theo tỉ lệ lấy mẫu Rust tính response của MÌNH rồi so; chỉ ghi đường dẫn khác biệt, KHÔNG ghi giá trị.
//!
//! Ba hàng rào (cờ `trinity_kernel::shadow`): phiên DB chỉ đọc, chặn gọi mạng, bỏ qua cache đếm. Vi phạm ⇒ route được ghi
//! "không shadow được" và không thử lại. Không làm chậm response chính: response của Node được truyền tiếp NGUYÊN trạng (một
//! bản sao thân được giữ lại, tối đa `max_body`), phần việc của Rust chạy ở task riêng, có hạn thời gian và giới hạn song song.
//!
//! Route có `cached: true` chỉ so HÌNH DẠNG trên lưu lượng thật (response của Node có thể đến từ cache tới 60 giây); so chặt
//! các route này làm ở X13 với cache tắt ở cả hai bên.

use std::collections::{BTreeMap, BTreeSet};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{CONTENT_ENCODING, CONTENT_TYPE};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tower::ServiceExt;
use trinity_kernel::shadow::ShadowRun;

use crate::edge::client_ip::ClientIp;

/// Cấu hình (`SHADOW_SAMPLE_RATE`: 0..=1, mặc định 0 = tắt hoàn toàn).
#[derive(Debug, Clone)]
pub struct ShadowConfig {
    pub sample_rate: f64,
    /// Thân tối đa giữ lại để so (cả hai bên); lớn hơn ⇒ bỏ mẫu.
    pub max_body: usize,
    /// Số lần shadow chạy song song; hết chỗ ⇒ bỏ mẫu (không xếp hàng, không chậm ai).
    pub concurrency: usize,
    /// Hạn cho phần việc của Rust.
    pub timeout: Duration,
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            sample_rate: 0.0,
            max_body: 1024 * 1024,
            concurrency: 4,
            timeout: Duration::from_secs(10),
        }
    }
}

impl ShadowConfig {
    /// Đọc `SHADOW_SAMPLE_RATE`; vắng, rỗng hoặc không hợp lệ ⇒ 0 (tắt), giá trị ngoài 0..=1 bị kẹp.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let rate = match get("SHADOW_SAMPLE_RATE")
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
        {
            None => 0.0,
            Some(s) => match s.parse::<f64>() {
                Ok(v) if v.is_finite() => v.clamp(0.0, 1.0),
                _ => {
                    tracing::warn!("SHADOW_SAMPLE_RATE không hợp lệ, shadow tắt");
                    0.0
                }
            },
        };
        Self {
            sample_rate: rate,
            ..Self::default()
        }
    }
}

/// Một route trong hợp đồng.
#[derive(Debug, Clone)]
struct RouteMeta {
    key: String,
    segments: Vec<Seg>,
    literals: usize,
    safe: bool,
    cached: bool,
    min_samples: u64,
}

#[derive(Debug, Clone)]
enum Seg {
    Lit(String),
    Param,
}

/// Bảng route GET của hợp đồng (`routes.json`): khớp theo mẫu, nhiều đoạn cố định hơn thắng (`/users/export` trước `/users/:id`).
#[derive(Debug, Clone, Default)]
pub struct ShadowRoutes {
    routes: Vec<RouteMeta>,
}

impl ShadowRoutes {
    /// Từ nội dung `routes.json` (`{ "routes": [...] }`). Chỉ giữ GET chưa bỏ.
    pub fn from_contract(json: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| format!("routes.json hỏng: {e}"))?;
        let rows = v
            .get("routes")
            .and_then(Value::as_array)
            .ok_or("routes.json thiếu `routes`")?;
        let mut routes = Vec::new();
        for r in rows {
            let (Some(method), Some(path)) = (r["method"].as_str(), r["path"].as_str()) else {
                continue;
            };
            if method != "GET" || r["deprecated"].as_bool() == Some(true) {
                continue;
            }
            let segments: Vec<Seg> = path
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| {
                    if s.starts_with(':') {
                        Seg::Param
                    } else {
                        Seg::Lit(s.to_owned())
                    }
                })
                .collect();
            let literals = segments.iter().filter(|s| matches!(s, Seg::Lit(_))).count();
            routes.push(RouteMeta {
                key: format!("GET {path}"),
                segments,
                literals,
                safe: r["safe_for_shadow"].as_bool() == Some(true),
                cached: r["cached"].as_bool() == Some(true),
                min_samples: r["min_samples"].as_u64().unwrap_or(50),
            });
        }
        Ok(Self { routes })
    }

    fn find(&self, path: &str) -> Option<&RouteMeta> {
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        self.routes
            .iter()
            .filter(|r| {
                r.segments.len() == segs.len()
                    && r.segments.iter().zip(&segs).all(|(m, s)| match m {
                        Seg::Lit(l) => l == s,
                        Seg::Param => true,
                    })
            })
            .max_by_key(|r| (r.literals, std::cmp::Reverse(r.segments.len())))
    }
}

#[derive(Debug, Default)]
struct RouteStats {
    samples: u64,
    equal: u64,
    different: u64,
    status_mismatch: u64,
    skipped: u64,
    unshadowable: Option<String>,
    diff_paths: BTreeMap<String, u64>,
}

/// Mẫu đã được chọn: giữ chỗ song song cho tới khi so xong.
pub struct Plan {
    key: String,
    cached: bool,
    _permit: OwnedSemaphorePermit,
}

pub struct Shadow {
    cfg: ShadowConfig,
    routes: ShadowRoutes,
    stats: Mutex<BTreeMap<String, RouteStats>>,
    sem: Arc<Semaphore>,
    sampler: Box<dyn Fn() -> f64 + Send + Sync>,
}

/// Số ngẫu nhiên [0,1) rẻ tiền (xorshift), đủ cho lấy mẫu.
fn default_sampler() -> Box<dyn Fn() -> f64 + Send + Sync> {
    let seed = AtomicU64::new(u64::try_from(Utc::now().timestamp_nanos_opt().unwrap_or(1)).unwrap_or(1) | 1);
    Box::new(move || {
        let mut x = seed.load(Ordering::Relaxed);
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        seed.store(x, Ordering::Relaxed);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

/// Kết quả một bên đã ghi lại.
struct Captured {
    status: StatusCode,
    content_type: String,
    bytes: Vec<u8>,
    overflow: bool,
}

impl Shadow {
    pub fn new(cfg: ShadowConfig, routes: ShadowRoutes) -> Arc<Self> {
        let sem = Arc::new(Semaphore::new(cfg.concurrency.max(1)));
        Arc::new(Self {
            cfg,
            routes,
            stats: Mutex::default(),
            sem,
            sampler: default_sampler(),
        })
    }

    /// Thay bộ lấy mẫu (test).
    pub fn with_sampler(self: Arc<Self>, f: impl Fn() -> f64 + Send + Sync + 'static) -> Arc<Self> {
        let mut s = Arc::try_unwrap(self).unwrap_or_else(|_| panic!("with_sampler gọi trước khi chia sẻ"));
        s.sampler = Box::new(f);
        Arc::new(s)
    }

    pub fn enabled(&self) -> bool {
        self.cfg.sample_rate > 0.0
    }

    fn with_stats<T>(&self, key: &str, f: impl FnOnce(&mut RouteStats) -> T) -> T {
        let mut g = self.stats.lock().unwrap_or_else(PoisonError::into_inner);
        f(g.entry(key.to_owned()).or_default())
    }

    /// Có nên shadow request này không? Tắt (tỉ lệ 0) thì trả `None` NGAY, không làm gì thêm. Chỉ GET, route `safe_for_shadow`,
    /// chưa bị đánh "không shadow được", trúng mẫu và còn chỗ song song.
    pub fn plan(&self, method: &Method, path: &str) -> Option<Plan> {
        if !self.enabled() || method != Method::GET {
            return None;
        }
        let r = self.routes.find(path).filter(|r| r.safe)?;
        if self.with_stats(&r.key, |s| s.unshadowable.is_some()) {
            return None;
        }
        if (self.sampler)() >= self.cfg.sample_rate {
            return None;
        }
        let Ok(permit) = self.sem.clone().try_acquire_owned() else {
            self.with_stats(&r.key, |s| s.skipped += 1);
            return None;
        };
        Some(Plan {
            key: r.key.clone(),
            cached: r.cached,
            _permit: permit,
        })
    }

    /// Báo cáo số mẫu theo route (mọi route `safe_for_shadow`, kể cả chưa có mẫu): đủ để kiểm `min_samples` ở tiêu chí bật đợt.
    pub fn report(&self) -> Value {
        let g = self.stats.lock().unwrap_or_else(PoisonError::into_inner);
        let rows: Vec<Value> = self
            .routes
            .routes
            .iter()
            .filter(|r| r.safe)
            .map(|r| {
                let empty = RouteStats::default();
                let s = g.get(&r.key).unwrap_or(&empty);
                json!({
                    "route": r.key,
                    "cached": r.cached,
                    "min_samples": r.min_samples,
                    "samples": s.samples,
                    "reached_min_samples": s.samples >= r.min_samples,
                    "equal": s.equal,
                    "different": s.different,
                    "status_mismatch": s.status_mismatch,
                    "skipped": s.skipped,
                    "unshadowable": s.unshadowable,
                    "diff_paths": s.diff_paths,
                })
            })
            .collect();
        json!({ "sample_rate": self.cfg.sample_rate, "routes": rows })
    }
}

/// Response của Node bọc lại: truyền nguyên từng khung, giữ một bản sao thân; hết thân thì gửi bản ghi cho task so sánh. Bỏ giữa
/// chừng (client ngắt) ⇒ không gửi gì (task đếm `skipped`).
struct Tee {
    inner: Body,
    buf: Vec<u8>,
    cap: usize,
    overflow: bool,
    status: StatusCode,
    content_type: String,
    tx: Option<oneshot::Sender<Captured>>,
}

impl HttpBody for Tee {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(d) = frame.data_ref()
                    && !this.overflow
                {
                    if this.buf.len() + d.len() > this.cap {
                        this.overflow = true;
                        this.buf = Vec::new();
                    } else {
                        this.buf.extend_from_slice(d);
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(None) => {
                if let Some(tx) = this.tx.take() {
                    let _ = tx.send(Captured {
                        status: this.status,
                        content_type: std::mem::take(&mut this.content_type),
                        bytes: std::mem::take(&mut this.buf),
                        overflow: this.overflow,
                    });
                }
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(e))) => {
                this.tx = None;
                Poll::Ready(Some(Err(e)))
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn content_type_of(resp: &Response) -> String {
    resp.headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

impl Shadow {
    /// Bọc response của Node để lấy bản sao và khởi chạy phần việc của Rust sau khi thân đã trả hết. `rust_req` là GET đã nhân
    /// bản trước khi chuyển tiếp. Response mã hoá (nén) hoặc nâng cấp giao thức thì không so (đếm `skipped`).
    pub fn attach(self: &Arc<Self>, plan: Plan, rust: Router, rust_req: Request, node: Response) -> Response {
        let skip = node.headers().contains_key(CONTENT_ENCODING)
            || node.status() == StatusCode::SWITCHING_PROTOCOLS
            || content_type_of(&node) == "text/event-stream";
        if skip {
            self.with_stats(&plan.key, |s| s.skipped += 1);
            return node;
        }
        let (parts, body) = node.into_parts();
        let (tx, rx) = oneshot::channel();
        let tee = Tee {
            inner: body,
            buf: Vec::new(),
            cap: self.cfg.max_body,
            overflow: false,
            status: parts.status,
            content_type: parts
                .headers
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase(),
            tx: Some(tx),
        };
        let me = self.clone();
        tokio::spawn(async move { me.run(plan, rust, rust_req, rx).await });
        Response::from_parts(parts, Body::new(tee))
    }

    async fn run(self: Arc<Self>, plan: Plan, rust: Router, req: Request, rx: oneshot::Receiver<Captured>) {
        let Ok(node) = rx.await else {
            self.with_stats(&plan.key, |s| s.skipped += 1);
            return;
        };
        if node.overflow {
            self.with_stats(&plan.key, |s| s.skipped += 1);
            return;
        }
        let run = ShadowRun::new();
        let cap = self.cfg.max_body;
        let timeout = self.cfg.timeout;
        let res = trinity_kernel::shadow::scope(run.clone(), async move {
            let resp = tokio::time::timeout(timeout, rust.oneshot(req)).await.ok()?;
            let Ok(resp) = resp;
            let status = resp.status();
            let content_type = content_type_of(&resp);
            let bytes = tokio::time::timeout(timeout, axum::body::to_bytes(resp.into_body(), cap))
                .await
                .ok()?
                .ok();
            Some(Captured {
                status,
                content_type,
                overflow: bytes.is_none(),
                bytes: bytes.map(|b| b.to_vec()).unwrap_or_default(),
            })
        })
        .await;
        // Vi phạm hàng rào ⇒ "không shadow được", không so, không thử lại.
        if let Some(reason) = run.violation() {
            tracing::warn!(route = %plan.key, %reason, "shadow: route không shadow được");
            self.with_stats(&plan.key, |s| {
                s.unshadowable.get_or_insert(reason);
            });
            return;
        }
        let Some(rust) = res.filter(|r| !r.overflow) else {
            self.with_stats(&plan.key, |s| s.skipped += 1);
            return;
        };
        let diff = compare(&node, &rust, plan.cached, Utc::now());
        if !diff.paths.is_empty() || diff.status_mismatch {
            // Chỉ đường dẫn và mã trạng thái, KHÔNG giá trị (tránh đưa dữ liệu khách vào log).
            tracing::warn!(
                route = %plan.key,
                node_status = node.status.as_u16(),
                rust_status = rust.status.as_u16(),
                paths = ?diff.paths,
                "shadow: khác biệt"
            );
        }
        self.with_stats(&plan.key, |s| {
            s.samples += 1;
            if diff.status_mismatch {
                s.status_mismatch += 1;
            }
            if diff.paths.is_empty() && !diff.status_mismatch {
                s.equal += 1;
            } else {
                s.different += 1;
                for p in diff.paths {
                    if s.diff_paths.len() < 200 || s.diff_paths.contains_key(&p) {
                        *s.diff_paths.entry(p).or_default() += 1;
                    }
                }
            }
        });
    }
}

/// Khác biệt giữa hai response: mã trạng thái và danh sách đường dẫn JSON (mảng thu về `[]`).
pub struct Diff {
    pub status_mismatch: bool,
    pub paths: Vec<String>,
}

const MAX_PATHS: usize = 50;

fn compare(node: &Captured, rust: &Captured, shape_only: bool, now: DateTime<Utc>) -> Diff {
    let mut paths = BTreeSet::new();
    let is_json = |c: &str| c == "application/json" || c.ends_with("+json");
    if node.content_type != rust.content_type {
        paths.insert("<content-type>".to_owned());
    }
    let parsed = if is_json(&node.content_type) && is_json(&rust.content_type) {
        serde_json::from_slice::<Value>(&node.bytes)
            .ok()
            .zip(serde_json::from_slice::<Value>(&rust.bytes).ok())
    } else {
        None
    };
    match parsed {
        Some((a, b)) => diff_json(&a, &b, "$", shape_only, now, &mut paths),
        // Không phải JSON (xuất tệp, ảnh): chỉ biết giống hay không, không có đường dẫn để chỉ.
        None if !shape_only && node.bytes != rust.bytes => {
            paths.insert("<body>".to_owned());
        }
        None => {}
    }
    Diff {
        status_mismatch: node.status != rust.status,
        paths: paths.into_iter().take(MAX_PATHS).collect(),
    }
}

fn kind(v: &Value) -> u8 {
    match v {
        Value::Null => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 2,
        Value::String(_) => 3,
        Value::Array(_) => 4,
        Value::Object(_) => 5,
    }
}

/// Hai chuỗi là cùng một thời điểm "vừa rồi" (cách nhau ≤ 2 giây và gần hiện tại ≤ 10 phút): giờ máy chủ, không phải dữ liệu.
fn same_recent_instant(a: &str, b: &str, now: DateTime<Utc>) -> bool {
    let (Ok(x), Ok(y)) = (DateTime::parse_from_rfc3339(a), DateTime::parse_from_rfc3339(b)) else {
        return false;
    };
    let (x, y) = (x.with_timezone(&Utc), y.with_timezone(&Utc));
    (x - y).num_seconds().abs() <= 2 && (now - x).num_minutes().abs() <= 10
}

fn diff_json(a: &Value, b: &Value, path: &str, shape: bool, now: DateTime<Utc>, out: &mut BTreeSet<String>) {
    if out.len() >= MAX_PATHS {
        return;
    }
    if kind(a) != kind(b) {
        out.insert(path.to_owned());
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys()).collect::<BTreeSet<_>>() {
                let p = format!("{path}.{k}");
                match (x.get(k), y.get(k)) {
                    (Some(l), Some(r)) => diff_json(l, r, &p, shape, now, out),
                    _ => {
                        out.insert(p);
                    }
                }
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            let p = format!("{path}[]");
            // Hình dạng: số phần tử đổi theo dữ liệu nên không tính; so từng cặp phần tử chung.
            if !shape && x.len() != y.len() {
                out.insert(p.clone());
            }
            for (l, r) in x.iter().zip(y) {
                diff_json(l, r, &p, shape, now, out);
            }
        }
        (Value::Number(x), Value::Number(y)) if !shape => {
            if x.as_f64() != y.as_f64() {
                out.insert(path.to_owned());
            }
        }
        (Value::String(x), Value::String(y)) if !shape => {
            if x != y && !same_recent_instant(x, y, now) {
                out.insert(path.to_owned());
            }
        }
        (Value::Bool(x), Value::Bool(y)) if !shape && x != y => {
            out.insert(path.to_owned());
        }
        _ => {}
    }
}

/// Nhân bản GET để chạy ở Rust: cùng URI, header (gồm `Authorization`) và IP khách đã xác định; không thân.
pub fn clone_get(req: &Request) -> Request {
    let mut b = Request::builder().method(Method::GET).uri(req.uri().clone());
    if let Some(h) = b.headers_mut() {
        *h = req.headers().clone();
    }
    let mut out = b.body(Body::empty()).unwrap_or_else(|_| Request::new(Body::empty()));
    if let Some(ip) = req.extensions().get::<ClientIp>() {
        out.extensions_mut().insert(ip.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(ct: &str, body: &str) -> Captured {
        Captured {
            status: StatusCode::OK,
            content_type: ct.to_owned(),
            bytes: body.as_bytes().to_vec(),
            overflow: false,
        }
    }

    fn paths(a: &str, b: &str, shape: bool) -> Vec<String> {
        compare(
            &cap("application/json", a),
            &cap("application/json", b),
            shape,
            Utc::now(),
        )
        .paths
    }

    #[test]
    fn dieu_kien_khac_biet_chi_la_duong_dan() {
        assert!(paths(r#"{"a":1,"b":[1,2]}"#, r#"{"b":[1,2],"a":1.0}"#, false).is_empty()); // thứ tự khoá, 1 == 1.0
        assert_eq!(
            paths(
                r#"{"data":[{"x":1,"y":"a"}]}"#,
                r#"{"data":[{"x":2,"y":"a","z":1}]}"#,
                false
            ),
            ["$.data[].x", "$.data[].z"]
        );
        assert_eq!(paths(r#"{"a":[1,2,3]}"#, r#"{"a":[1,2]}"#, false), ["$.a[]"]);
        assert_eq!(paths(r#"{"a":null}"#, r#"{"a":"x"}"#, false), ["$.a"]);
    }

    #[test]
    fn route_cached_chi_so_hinh_dang() {
        // Số khác, độ dài mảng khác: không phải khác biệt; kiểu khác hoặc thiếu khoá thì có.
        assert!(
            paths(
                r#"{"total":10,"rows":[{"a":1}]}"#,
                r#"{"total":99,"rows":[{"a":2},{"a":3}]}"#,
                true
            )
            .is_empty()
        );
        assert_eq!(paths(r#"{"total":10}"#, r#"{"total":"10"}"#, true), ["$.total"]);
        assert_eq!(paths(r#"{"total":10}"#, r#"{}"#, true), ["$.total"]);
    }

    #[test]
    fn gio_may_chu_vua_roi_khong_phai_khac_biet() {
        let now = Utc::now();
        let a = now.to_rfc3339();
        let b = (now + chrono::Duration::milliseconds(900)).to_rfc3339();
        assert!(
            compare(
                &cap("application/json", &format!(r#"{{"at":"{a}"}}"#)),
                &cap("application/json", &format!(r#"{{"at":"{b}"}}"#)),
                false,
                now
            )
            .paths
            .is_empty()
        );
        // Thời điểm xa hiện tại là dữ liệu: khác là khác.
        assert_eq!(
            paths(
                r#"{"at":"2020-01-01T00:00:00Z"}"#,
                r#"{"at":"2020-01-01T00:00:01Z"}"#,
                false
            ),
            ["$.at"]
        );
    }

    #[test]
    fn khong_phai_json_va_trang_thai() {
        let d = compare(
            &cap("application/octet-stream", "abc"),
            &cap("application/octet-stream", "abd"),
            false,
            Utc::now(),
        );
        assert_eq!(d.paths, ["<body>"]);
        let mut r = cap("application/json", "{}");
        r.status = StatusCode::NOT_FOUND;
        let d = compare(&cap("application/json", "{}"), &r, false, Utc::now());
        assert!(d.status_mismatch && d.paths.is_empty());
        let d = compare(
            &cap("application/json", "{}"),
            &cap("text/plain", "{}"),
            false,
            Utc::now(),
        );
        assert_eq!(d.paths, ["<content-type>"]);
    }

    #[test]
    fn cau_hinh_tu_env() {
        let cfg = |v: Option<&str>| ShadowConfig::from_lookup(|_| v.map(str::to_owned)).sample_rate;
        assert_eq!(cfg(None), 0.0);
        assert_eq!(cfg(Some("")), 0.0);
        assert_eq!(cfg(Some("0.25")), 0.25);
        assert_eq!(cfg(Some("7")), 1.0);
        assert_eq!(cfg(Some("-1")), 0.0);
        assert_eq!(cfg(Some("abc")), 0.0);
        assert_eq!(cfg(Some("NaN")), 0.0);
    }

    #[test]
    fn khop_route_theo_mau_dai_nhat() {
        let r = ShadowRoutes::from_contract(
            r#"{"routes":[
              {"method":"GET","path":"/api/v1/users/:id","safe_for_shadow":false,"cached":false,"min_samples":50},
              {"method":"GET","path":"/api/v1/users/export","safe_for_shadow":true,"cached":true,"min_samples":10},
              {"method":"POST","path":"/api/v1/users","safe_for_shadow":true},
              {"method":"GET","path":"/api/v1/old","safe_for_shadow":true,"deprecated":true}]}"#,
        )
        .unwrap();
        assert_eq!(
            r.find("/api/v1/users/export")
                .map(|m| (m.safe, m.cached, m.min_samples)),
            Some((true, true, 10))
        );
        assert_eq!(r.find("/api/v1/users/7").map(|m| m.safe), Some(false));
        assert!(r.find("/api/v1/users").is_none());
        assert!(r.find("/api/v1/old").is_none());
    }

    #[test]
    fn tat_hoan_toan_khi_ty_le_0() {
        let r =
            ShadowRoutes::from_contract(r#"{"routes":[{"method":"GET","path":"/api/v1/a","safe_for_shadow":true}]}"#)
                .unwrap();
        let s = Shadow::new(ShadowConfig::default(), r);
        assert!(!s.enabled());
        assert!(s.plan(&Method::GET, "/api/v1/a").is_none());
        // Không có thống kê nào phát sinh.
        assert_eq!(s.report()["routes"][0]["samples"], 0);
    }
}
