//! `POST /api/fe-logging` (công khai): nhận lỗi frontend do `apps/web/src/lib/fe-logger.ts` gửi (trước đây là route handler của
//! Next, nay web là static export nên Rust nhận).
//!
//! - Thân JSON tối đa 16 KB (quá ⇒ 413); mỗi IP tối đa 30 lượt/phút (quá ⇒ 429 kèm `Retry-After`).
//! - Ghi `tracing::warn!(target: "fe", ...)` với các trường đã cắt ngắn; có Sentry thì gửi thêm một event mức warning.
//! - Trả 204 không thân.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, Request};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use trinity_http::edge::client_ip::ClientIp;
use trinity_http::rate_limit::{FixedWindowLimiter, now_ms};

/// Giới hạn thân request.
pub const BODY_MAX_BYTES: usize = 16 * 1024;
/// Số lượt tối đa mỗi IP trong một cửa sổ.
pub const PER_MINUTE: u32 = 30;

const MESSAGE_MAX: usize = 500;
const STACK_MAX: usize = 2000;
const FIELD_MAX: usize = 200;

pub fn limiter() -> Arc<FixedWindowLimiter> {
    FixedWindowLimiter::new(PER_MINUTE, 60_000)
}

/// Cắt theo số ký tự (không cắt giữa ký tự UTF-8).
pub(crate) fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

fn field(v: &Value, k: &str, max: usize) -> String {
    match v.get(k) {
        Some(Value::String(s)) => clip(s, max),
        Some(Value::Null) | None => String::new(),
        Some(o) => clip(&o.to_string(), max),
    }
}

fn reply(status: StatusCode, message: &str, retry_after: Option<u64>) -> Response {
    let mut res = (status, Json(json!({"statusCode": status.as_u16(), "message": message}))).into_response();
    if let Some(s) = retry_after
        && let Ok(v) = HeaderValue::from_str(&s.to_string())
    {
        res.headers_mut().insert(header::RETRY_AFTER, v);
    }
    res
}

pub async fn handle(limiter: Arc<FixedWindowLimiter>, client: Option<Extension<ClientIp>>, req: Request) -> Response {
    let key = client.map_or_else(|| "unknown".to_owned(), |Extension(c)| c.rate_key);
    let hit = limiter.hit(&key, now_ms());
    if !hit.allowed {
        return reply(
            StatusCode::TOO_MANY_REQUESTS,
            "Quá nhiều yêu cầu, vui lòng thử lại sau",
            Some(hit.retry_after_sec),
        );
    }
    if req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n > BODY_MAX_BYTES)
    {
        return reply(StatusCode::PAYLOAD_TOO_LARGE, "Thân request quá lớn", None);
    }
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), BODY_MAX_BYTES).await else {
        return reply(StatusCode::PAYLOAD_TOO_LARGE, "Thân request quá lớn", None);
    };
    let Ok(v @ Value::Object(_)) = serde_json::from_slice::<Value>(&bytes) else {
        return reply(StatusCode::BAD_REQUEST, "Thân phải là JSON object", None);
    };
    let (level, message, stack) = (
        field(&v, "level", 16),
        field(&v, "message", MESSAGE_MAX),
        field(&v, "stack", STACK_MAX),
    );
    let (url, component) = (field(&v, "url", FIELD_MAX), field(&v, "component", FIELD_MAX));
    tracing::warn!(target: "fe", level = %level, component = %component, url = %url, stack = %stack, "{message}");
    trinity_obs::report_frontend_warning(&message, &level, &component, &url);
    StatusCode::NO_CONTENT.into_response()
}
