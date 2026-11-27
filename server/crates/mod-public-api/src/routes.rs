//! Bảng route và handler (K14): 5 route công khai, mỗi route khai guard `ApiKeyGuard` + `PublicApiRateLimiterGuard`.

use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use trinity_http::router::{Access, AccessDeps, ApiRouter, RouteSpec};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::PublicCtx;
use crate::guards::{KeyInfo, RateBlocked};
use crate::service;

const GUARDS: &[&str] = &["ApiKeyGuard", "PublicApiRateLimiterGuard"];

pub fn specs() -> Vec<RouteSpec> {
    let r = |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, Access::Public).status_ok(ok).guards(GUARDS);
    vec![
        r(Method::POST, "/api/v1/public/contacts", 201),
        r(Method::GET, "/api/v1/public/contacts/sources", 200),
        r(Method::POST, "/api/v1/public/deals", 201),
        r(Method::POST, "/api/v1/public/tasks", 201),
        r(Method::GET, "/api/v1/public/tasks/columns", 200),
    ]
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(false);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn ok(r: Result<Value, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// 429 của `PublicApiRateLimiterGuard`: `{ statusCode, message, retryAfter }` (đối tượng thuần của `HttpException`).
fn blocked(req: &Request) -> Option<Response> {
    req.extensions().get::<RateBlocked>().map(|b| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "statusCode": 429,
                "message": "Quá nhiều request, vui lòng thử lại sau.",
                "retryAfter": b.retry_after_sec,
            })),
        )
            .into_response()
    })
}

/// Thân như body-parser: JSON, rỗng hoặc loại khác ⇒ `{}`; hỏng ⇒ 400.
async fn body(req: Request) -> Result<Value, Response> {
    let is_json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    let bytes: Bytes = to_bytes(req.into_body(), 5 * 1024 * 1024)
        .await
        .map_err(|_| fail(HttpError::payload_too_large("request entity too large")))?;
    if !is_json || bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Object(Map::new()));
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(v),
        _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
    }
}

/// Kiểm thân theo DTO rồi trả đối tượng đã chuyển kiểu.
fn dto(name: &str, v: &Value) -> Result<Map<String, Value>, Response> {
    match validate_value(name, v, Mode::Strict) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Ok(Map::new()),
        Err(e) => Err(fail(e)),
    }
}

macro_rules! prelude {
    ($req:expr) => {
        if let Some(r) = blocked(&$req) {
            return r;
        }
    };
}

async fn create_contact(State(c): State<Arc<PublicCtx>>, Extension(k): Extension<KeyInfo>, req: Request) -> Response {
    prelude!(req);
    let b = match body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    match dto("PublicCreateContactDto", &b) {
        Ok(d) => {
            let res = service::create_contact(&c, &k, &d).await;
            if res.is_ok()
                && let Some(f) = &c.contact_created
            {
                f(k.company);
            }
            ok(res)
        }
        Err(r) => r,
    }
}

async fn sources(State(c): State<Arc<PublicCtx>>, Extension(k): Extension<KeyInfo>, req: Request) -> Response {
    prelude!(req);
    ok(service::list_sources(&c, &k).await)
}

async fn create_deal(State(c): State<Arc<PublicCtx>>, Extension(k): Extension<KeyInfo>, req: Request) -> Response {
    prelude!(req);
    let b = match body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    match dto("PublicCreateDealDto", &b) {
        Ok(d) => ok(service::create_deal(&c, &k, &d).await),
        Err(r) => r,
    }
}

async fn create_task(State(c): State<Arc<PublicCtx>>, Extension(k): Extension<KeyInfo>, req: Request) -> Response {
    prelude!(req);
    let b = match body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    match dto("PublicCreateTaskDto", &b) {
        Ok(d) => ok(service::create_task(&c, &k, &d).await),
        Err(r) => r,
    }
}

async fn columns(State(c): State<Arc<PublicCtx>>, Extension(k): Extension<KeyInfo>, req: Request) -> Response {
    prelude!(req);
    ok(service::columns(&c, &k).await)
}

/// Router của module; người gọi gắn state `Arc<PublicCtx>` và đăng ký [`crate::named_guards`] vào `AccessDeps::guards`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<PublicCtx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::POST, "/api/v1/public/contacts"), create_contact)
        .route(spec(&Method::GET, "/api/v1/public/contacts/sources"), sources)
        .route(spec(&Method::POST, "/api/v1/public/deals"), create_deal)
        .route(spec(&Method::POST, "/api/v1/public/tasks"), create_task)
        .route(spec(&Method::GET, "/api/v1/public/tasks/columns"), columns)
}
