//! API điều khiển test ở bản Rust (K34), cùng hai đường với C18 của bản TS:
//! `POST /internal/test/jobs/{name}/run` và `POST /internal/test/cache/flush` (người gọi gắn tiền tố `/api/v1`).
//!
//! - **Chỉ có khi bật cờ biên dịch `test-hooks`** (không bật ⇒ crate rỗng, binary phát hành không chứa route) **và** khi chạy
//!   cần `TRINITY_TEST_HOOKS=1` với `NODE_ENV` là `test`/`development` ([`enabled`]); ngoài điều kiện đó [`TestHooks::router`]
//!   trả `None` nên route không tồn tại (404).
//! - Cần header `x-service-secret` (`Authenticator::check_service_secret`).
//! - Bật thì scheduler và worker hàng đợi không tự chạy (`trinity_jobs::test_hooks`): job chỉ chạy khi ca test gọi.
//! - Không có giờ giả toàn cục, không có đường đổi cấu hình lúc chạy. `now` (ISO-8601 có múi giờ) chỉ nhận cho job khai bằng
//!   [`TestHooks::timed_job`] có tên trong [`NOW_JOBS`] (đúng hai việc mà mã Node đã nhận giờ làm đối số).
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
use trinity_jobs::Scheduler;

/// Hai việc duy nhất nhận tham số `now` (như C18): `reapStuckProcessing(NOW)` và `BriefingAggregatorService.collect(…, NOW)`.
pub const NOW_JOBS: [&str; 2] = ["notification.reap-stuck", "briefings.collect"];

/// Bật không (cùng luật `trinity_jobs::test_hooks::enabled`).
pub use trinity_jobs::test_hooks::enabled;

type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type TimedFn = Arc<dyn Fn(CompanyRef, DateTime<Utc>, Value) -> BoxFut<Result<Value, String>> + Send + Sync>;
type CompanyFn = Arc<dyn Fn(i64) -> BoxFut<Option<CompanyRef>> + Send + Sync>;
type Flusher = Arc<dyn Fn() + Send + Sync>;

/// Bảng việc và bộ xoá cache mà API điều khiển gọi tới. Module nào có cache/job thì đăng ký ở đây lúc dựng server.
pub struct TestHooks {
    auth: Arc<Authenticator>,
    scheduler: Option<Scheduler>,
    timed: BTreeMap<String, TimedFn>,
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
            timed: BTreeMap::new(),
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

    /// Hàm xoá một cache trong RAM (quyền, đếm, dashboard, blacklist, giới hạn tốc độ…).
    #[must_use]
    pub fn on_flush(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
        self.flushers.push(Arc::new(f));
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
    let timed = h.timed.get(&name).cloned();
    let sched_has = h.scheduler.as_ref().is_some_and(|s| s.job_names().contains(&name));
    if timed.is_none() && !sched_has {
        let mut names: Vec<String> = h.timed.keys().cloned().collect();
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
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if timed.is_some() => match DateTime::parse_from_rfc3339(s) {
            Ok(t) => Some(t.with_timezone(&Utc)),
            Err(_) => {
                return err(
                    StatusCode::BAD_REQUEST,
                    "`now` phải là chuỗi ISO-8601 có múi giờ (vd 2026-01-01T00:00:00Z)",
                );
            }
        },
        Some(_) if timed.is_none() => {
            return err(
                StatusCode::BAD_REQUEST,
                format!("`now` chỉ nhận cho: {}", NOW_JOBS.join(", ")),
            );
        }
        Some(_) => return err(StatusCode::BAD_REQUEST, "`now` phải là chuỗi ISO-8601 có múi giờ"),
    };
    let company = match company_of(&h, &body).await {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let result = if let Some(f) = timed {
        f(company, now.unwrap_or_else(Utc::now), body).await
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

async fn company_of(h: &TestHooks, body: &Value) -> Result<CompanyRef, Box<Response>> {
    let id = match body.get("company_id") {
        None | Some(Value::Null) if !h.multi_tenant => return Ok(CompanyRef::DEFAULT),
        Some(Value::Number(n)) => n.as_i64().filter(|i| *i >= 1),
        _ => None,
    };
    let Some(id) = id else {
        return Err(Box::new(err(
            StatusCode::BAD_REQUEST,
            if h.multi_tenant {
                "company_id (số nguyên ≥ 1) bắt buộc khi MULTI_TENANT=true"
            } else {
                "company_id phải là số nguyên ≥ 1"
            },
        )));
    };
    if !h.multi_tenant {
        return if id == 1 {
            Ok(CompanyRef::DEFAULT)
        } else {
            Err(Box::new(err(
                StatusCode::BAD_REQUEST,
                "một công ty: company_id chỉ có thể là 1",
            )))
        };
    }
    (h.company)(id).await.ok_or_else(|| {
        Box::new(err(
            StatusCode::BAD_REQUEST,
            format!("company_id {id} không tồn tại hoặc không hoạt động"),
        ))
    })
}

async fn flush(State(h): State<Arc<TestHooks>>, headers: HeaderMap) -> Response {
    if let Err(r) = check_secret(&h, &headers) {
        return *r;
    }
    for f in &h.flushers {
        f();
    }
    (StatusCode::OK, axum::Json(json!({"flushed": h.flushers.len()}))).into_response()
}

#[cfg(test)]
mod tests;
