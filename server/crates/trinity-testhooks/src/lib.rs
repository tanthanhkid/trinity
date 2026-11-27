//! API điều khiển test ở bản Rust (K34), cùng các đường với C18 của bản TS:
//! `POST /internal/test/jobs/{name}/run` và `POST /internal/test/cache/flush` (người gọi gắn tiền tố `/api/v1`), cộng
//! `POST /internal/test/queue/drain` (chỉ có ở Rust: xả hàng đợi `platform.jobs`).
//!
//! **Trạng thái: nền móng, CHƯA mount.** Server `serve` (K12/D01) chưa lắp ráp trên `main`, nên `TestHooks::router` chưa được
//! gọi ở đâu. Việc nối khi có `serve`: dựng `TestHooks` từ các thành phần đã có của server (`Authenticator`, `Platform`,
//! `Scheduler`, `Worker`), đăng ký job có `now` và bộ xoá cache của từng module (`timed_job`, `on_flush`), rồi
//! `if let Some(r) = hooks.router(|k| std::env::var(k).ok()) { app = app.merge(Router::new().nest("/api/v1", r)) }` và chỉ khi
//! build có `--features test-hooks`.
//!
//! - **Chỉ có khi bật cờ biên dịch `test-hooks`** (không bật ⇒ crate rỗng, binary phát hành không chứa route) **và** khi chạy
//!   cần `TRINITY_TEST_HOOKS=1` với `NODE_ENV` là `test`/`development` ([`enabled`]); ngoài điều kiện đó [`TestHooks::router`]
//!   trả `None` nên route không tồn tại (404).
//! - Cần header `x-service-secret` (`Authenticator::check_service_secret`).
//! - Bật thì scheduler và worker hàng đợi không tự chạy (`trinity_jobs::test_hooks`): job chỉ chạy khi ca test gọi.
//! - Không có giờ giả toàn cục, không có đường đổi cấu hình lúc chạy. `now` (ISO-8601 có múi giờ, đúng mẫu của bản Node) chỉ nhận
//!   cho job có tên trong [`NOW_JOBS`] (7 việc mà mã Node đã nhận giờ làm đối số), khai bằng [`TestHooks::timed_job`].
#![cfg(feature = "test-hooks")]

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use trinity_auth::Authenticator;
use trinity_db::CompanyRef;
use trinity_db::platform::Platform;
use trinity_jobs::{Scheduler, Worker};

/// Các việc nhận tham số `now`: những việc mà mã đã nhận giờ làm đối số (như `NOW_JOBS` của bản Node). `stale-work` còn nhận
/// `force` trong body.
pub const NOW_JOBS: [&str; 7] = [
    "notification.reap-stuck",
    "briefings.collect",
    "briefings.run-due",
    "stale-work",
    "oauth-purge",
    "ai-action-expiry",
    "facebook-broadcasts",
];

/// Hạn chạy một job có `now` (job của scheduler dùng `budget` của chính nó).
pub const TEST_JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Trần số việc xả mỗi lần gọi `queue/drain` (chống vòng lặp vô hạn khi việc tự đẻ việc).
pub const DRAIN_MAX: usize = 10_000;

/// Bật không (cùng luật `trinity_jobs::test_hooks::enabled`).
pub use trinity_jobs::test_hooks::enabled;

type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type TimedFn = Arc<dyn Fn(CompanyRef, DateTime<Utc>, Value) -> BoxFut<Result<Value, String>> + Send + Sync>;
type CompanyFn = Arc<dyn Fn(i64) -> BoxFut<Option<CompanyRef>> + Send + Sync>;
type Flusher = (String, Arc<dyn Fn() + Send + Sync>);

/// Bảng việc và bộ xoá cache mà API điều khiển gọi tới. Module nào có cache/job thì đăng ký ở đây lúc dựng server.
pub struct TestHooks {
    auth: Arc<Authenticator>,
    scheduler: Option<Scheduler>,
    worker: Option<Worker>,
    timeout: std::time::Duration,
    timed: BTreeMap<String, TimedFn>,
    /// Job không nhận `now` (khác `timed`): `now` trong body ⇒ 400. Dùng cho việc mà bản Node chạy được theo tên nhưng không có giờ giả.
    plain: BTreeMap<String, TimedFn>,
    flushers: Vec<Flusher>,
    company: CompanyFn,
    multi_tenant: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum HooksError {
    #[error("`now` chỉ nhận cho {NOW_JOBS:?}, không nhận cho \"{0}\"")]
    NowNotAllowed(String),
}

impl TestHooks {
    /// `multi_tenant=false` ⇒ `company_id` bỏ trống hoặc 1; `true` ⇒ bắt buộc và phải là công ty đang hoạt động (`platform`).
    pub fn new(auth: Arc<Authenticator>, platform: Platform, multi_tenant: bool) -> Self {
        let company: CompanyFn = Arc::new(move |id| {
            let platform = platform.clone();
            Box::pin(async move { platform.active_company(id).await.ok().flatten() })
        });
        Self::with_company_lookup(auth, company, multi_tenant)
    }

    /// Như [`Self::new`] nhưng tự cấp hàm tra công ty (dùng cho test không có DB).
    pub fn with_company_lookup(auth: Arc<Authenticator>, company: CompanyFn, multi_tenant: bool) -> Self {
        Self {
            auth,
            scheduler: None,
            worker: None,
            timeout: TEST_JOB_TIMEOUT,
            timed: BTreeMap::new(),
            plain: BTreeMap::new(),
            flushers: Vec::new(),
            company,
            multi_tenant,
        }
    }

    /// Mọi job của scheduler chạy được theo tên (chạy ngay cho đúng một công ty, không nhận lượt qua bảng).
    #[must_use]
    pub fn scheduler(mut self, s: Scheduler) -> Self {
        self.scheduler = Some(s);
        self
    }

    /// Job có nhận giờ: chỉ tên trong [`NOW_JOBS`]. `f(công ty, now, body)`; `now` luôn có (thiếu thì dùng giờ thật).
    pub fn timed_job<F, Fut>(mut self, name: &str, f: F) -> Result<Self, HooksError>
    where
        F: Fn(CompanyRef, DateTime<Utc>, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        if !NOW_JOBS.contains(&name) {
            return Err(HooksError::NowNotAllowed(name.to_owned()));
        }
        self.timed
            .insert(name.to_owned(), Arc::new(move |c, n, b| Box::pin(f(c, n, b))));
        Ok(self)
    }

    /// Job chạy theo tên nhưng KHÔNG nhận `now` (`now` trong body ⇒ 400). `f(công ty, body)`.
    #[must_use]
    pub fn plain_job<F, Fut>(mut self, name: &str, f: F) -> Self
    where
        F: Fn(CompanyRef, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        self.plain
            .insert(name.to_owned(), Arc::new(move |c, _now, b| Box::pin(f(c, b))));
        self
    }

    /// Hàm xoá một cache trong RAM (quyền, đếm, dashboard, blacklist, giới hạn tốc độ…); `name` hiện trong kết quả của
    /// `cache/flush` (Node trả mảng tên: `permissions`, `read-cache`, `token-blacklist`, `rate-limits`).
    #[must_use]
    pub fn on_flush(mut self, name: &str, f: impl Fn() + Send + Sync + 'static) -> Self {
        self.flushers.push((name.to_owned(), Arc::new(f)));
        self
    }

    /// Đổi hạn chạy job có `now` (mặc định [`TEST_JOB_TIMEOUT`]).
    #[must_use]
    pub fn with_timeout(mut self, d: std::time::Duration) -> Self {
        self.timeout = d;
        self
    }

    /// Worker hàng đợi để `queue/drain` xả (chạy `run_once` tới khi hết việc). Worker này KHÔNG tự chạy ở chế độ test.
    #[must_use]
    pub fn worker(mut self, w: Worker) -> Self {
        self.worker = Some(w);
        self
    }

    /// Router của hai đường, hoặc `None` khi không đủ điều kiện bật ([`enabled`]) ⇒ route không tồn tại.
    pub fn router(self, get_env: impl Fn(&str) -> Option<String>) -> Option<Router> {
        if !enabled(get_env) {
            return None;
        }
        tracing::warn!(
            "API ĐIỀU KHIỂN TEST ĐANG BẬT (TRINITY_TEST_HOOKS=1): mọi lịch tự động đã tắt; KHÔNG dùng ở môi trường thật"
        );
        Some(
            Router::new()
                .route("/internal/test/jobs/{name}/run", post(run_job))
                .route("/internal/test/cache/flush", post(flush))
                .route("/internal/test/queue/drain", post(drain))
                .with_state(Arc::new(self)),
        )
    }
}

fn err(status: StatusCode, message: impl Into<String>) -> Response {
    let reason = status.canonical_reason().unwrap_or("");
    (
        status,
        axum::Json(json!({"statusCode": status.as_u16(), "message": message.into(), "error": reason})),
    )
        .into_response()
}

fn check_secret(h: &TestHooks, headers: &HeaderMap) -> Result<(), Box<Response>> {
    let provided = headers.get("x-service-secret").and_then(|v| v.to_str().ok());
    h.auth
        .check_service_secret(provided)
        .map_err(|e| Box::new(err(StatusCode::UNAUTHORIZED, e.message())))
}

async fn run_job(
    State(h): State<Arc<TestHooks>>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err(r) = check_secret(&h, &headers) {
        return *r;
    }
    let body: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v @ Value::Object(_)) => v,
            _ => return err(StatusCode::BAD_REQUEST, "body phải là một object JSON"),
        }
    };
    let now_job = h.timed.get(&name).cloned();
    let timed = now_job.clone().or_else(|| h.plain.get(&name).cloned());
    let sched_has = h.scheduler.as_ref().is_some_and(|s| s.job_names().contains(&name));
    if timed.is_none() && !sched_has {
        let mut names: Vec<String> = h.timed.keys().chain(h.plain.keys()).cloned().collect();
        if let Some(s) = &h.scheduler {
            names.extend(s.job_names());
        }
        names.sort();
        return err(
            StatusCode::BAD_REQUEST,
            format!("Job không tồn tại: {name}. Có: {}", names.join(", ")),
        );
    }
    let now = match body.get("now") {
        None => None,
        // `null` hay không phải chuỗi cũng là 400 (Node: `body.now !== undefined` rồi kiểm kiểu).
        Some(_) if now_job.is_none() => {
            return err(
                StatusCode::BAD_REQUEST,
                format!("`now` chỉ nhận cho: {}", NOW_JOBS.join(", ")),
            );
        }
        Some(v) => match v.as_str().and_then(parse_now) {
            Some(t) => Some(t),
            None => {
                return err(
                    StatusCode::BAD_REQUEST,
                    "`now` phải là chuỗi ISO-8601 có múi giờ (vd 2026-01-01T00:00:00Z)",
                );
            }
        },
    };
    let company = match company_of(&h, &body).await {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let result = if let Some(f) = timed {
        // Task riêng + hạn: panic hay quá hạn thành 500 có thông điệp, không treo yêu cầu.
        let mut task = tokio::spawn(f(company, now.unwrap_or_else(Utc::now), body));
        match tokio::time::timeout(h.timeout, &mut task).await {
            Ok(Ok(r)) => r,
            Ok(Err(join)) => Err(format!("job dừng bất thường: {join}")),
            Err(_) => {
                task.abort();
                Err(format!("quá hạn {} ms", h.timeout.as_millis()))
            }
        }
    } else if let Some(s) = &h.scheduler {
        match s.run_job_for(&name, company).await {
            Ok(r) => r.map(|()| Value::Null),
            Err(e) => return err(StatusCode::BAD_REQUEST, e.to_string()),
        }
    } else {
        unreachable!("đã kiểm job tồn tại")
    };
    match result {
        Ok(v) => (StatusCode::OK, axum::Json(json!({"job": name, "result": v}))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, format!("job {name} lỗi: {e}")),
    }
}

/// Một công ty: bỏ qua `company_id` như Node (`if (!isMultiTenant()) return exec()`). Đa công ty: bắt buộc, số nguyên ≥ 1, phải
/// là công ty đang hoạt động.
async fn company_of(h: &TestHooks, body: &Value) -> Result<CompanyRef, Box<Response>> {
    if !h.multi_tenant {
        return Ok(CompanyRef::DEFAULT);
    }
    let id = match body.get("company_id") {
        Some(Value::Number(n)) => n.as_i64().filter(|i| *i >= 1),
        _ => None,
    };
    let Some(id) = id else {
        return Err(Box::new(err(
            StatusCode::BAD_REQUEST,
            "company_id (số nguyên ≥ 1) bắt buộc khi MULTI_TENANT=true",
        )));
    };
    (h.company)(id).await.ok_or_else(|| {
        Box::new(err(
            StatusCode::BAD_REQUEST,
            format!("company_id {id} không tồn tại hoặc không hoạt động"),
        ))
    })
}

/// `now` đúng mẫu của bản Node (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$`) và là ngày hợp lệ.
fn parse_now(s: &str) -> Option<DateTime<Utc>> {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|x| x.iter().all(u8::is_ascii_digit));
    let sep = |i: usize, c: u8| b.get(i) == Some(&c);
    if !(digits(0..4)
        && sep(4, b'-')
        && digits(5..7)
        && sep(7, b'-')
        && digits(8..10)
        && sep(10, b'T')
        && digits(11..13)
        && sep(13, b':')
        && digits(14..16))
    {
        return None;
    }
    let mut i = 16;
    let mut secs = false;
    if sep(i, b':') && digits(i + 1..i + 3) {
        secs = true;
        i += 3;
        if sep(i, b'.') {
            let start = i + 1;
            let mut j = start;
            while b.get(j).is_some_and(u8::is_ascii_digit) {
                j += 1;
            }
            if j == start {
                return None;
            }
            i = j;
        }
    }
    let tz = &s[i..];
    let tz_ok = tz == "Z"
        || (tz.len() == 6
            && matches!(tz.as_bytes()[0], b'+' | b'-')
            && tz.as_bytes()[3] == b':'
            && tz
                .bytes()
                .enumerate()
                .all(|(k, c)| matches!(k, 0 | 3) || c.is_ascii_digit()));
    if !tz_ok {
        return None;
    }
    // chrono đòi có giây: thêm `:00` khi mẫu Node cho phép bỏ giây.
    let norm = if secs {
        s.to_owned()
    } else {
        format!("{}:00{tz}", &s[..16])
    };
    DateTime::parse_from_rfc3339(&norm).ok().map(|t| t.with_timezone(&Utc))
}

async fn flush(State(h): State<Arc<TestHooks>>, headers: HeaderMap) -> Response {
    if let Err(r) = check_secret(&h, &headers) {
        return *r;
    }
    let mut names = Vec::with_capacity(h.flushers.len());
    for (name, f) in &h.flushers {
        f();
        names.push(name.clone());
    }
    (StatusCode::OK, axum::Json(json!({"flushed": names}))).into_response()
}

/// Xả hàng đợi: `run_once` tới khi hết việc (hoặc [`DRAIN_MAX`]). Việc lỗi thì đã được worker ghi `failed`/thử lại như thường.
async fn drain(State(h): State<Arc<TestHooks>>, headers: HeaderMap) -> Response {
    if let Err(r) = check_secret(&h, &headers) {
        return *r;
    }
    let Some(worker) = h.worker.clone() else {
        return err(StatusCode::BAD_REQUEST, "không có worker hàng đợi được đăng ký");
    };
    let mut processed = 0usize;
    loop {
        if processed >= DRAIN_MAX {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("xả quá {DRAIN_MAX} việc mà hàng đợi chưa rỗng"),
            );
        }
        match worker.run_once().await {
            Ok(true) => processed += 1,
            Ok(false) => break,
            Err(e) => {
                return err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("hàng đợi lỗi sau {processed} việc: {e}"),
                );
            }
        }
    }
    (StatusCode::OK, axum::Json(json!({"processed": processed}))).into_response()
}

#[cfg(test)]
mod tests;
