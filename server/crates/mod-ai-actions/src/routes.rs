//! Bảng route và handler (K14): 7 route `/api/v1/integrations/ai-actions`, khớp `contracts/routes.json`.

use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use trinity_db::CompanyRef;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::service::status_ok;
use crate::{ActionUser, AiActionsCtx};

const BASE: &str = "/api/v1/integrations/ai-actions";
const ID: &[&str] = &["param.id:ParseIntPipe"];

pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::GET, BASE, Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/integrations/ai-actions/:id", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(
            Method::POST,
            "/api/v1/integrations/ai-actions/:id/approve",
            Access::AuthOnly,
        )
        .status_ok(200)
        .param_pipes(ID),
        RouteSpec::new(
            Method::POST,
            "/api/v1/integrations/ai-actions/:id/reject",
            Access::AuthOnly,
        )
        .status_ok(200)
        .param_pipes(ID),
        RouteSpec::new(
            Method::GET,
            "/api/v1/integrations/ai-actions/pending-count",
            Access::AuthOnly,
        )
        .status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/integrations/ai-actions/settings",
            Access::AuthOnly,
        )
        .status_ok(200),
        RouteSpec::new(
            Method::PATCH,
            "/api/v1/integrations/ai-actions/settings",
            Access::Can(&["integrations.ai_admin"]),
        )
        .status_ok(200),
    ]
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
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

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "statusCode": 404, "message": "Not Found" })),
    )
        .into_response()
}

/// Người duyệt; công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
fn who(u: &CurrentUser) -> Result<ActionUser, Response> {
    let company = CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))?;
    Ok(ActionUser {
        user_id: u.user.user_id,
        email: u.user.email.clone(),
        is_admin: u.is_admin(),
        grants: u.grants.grants.clone(),
        company,
    })
}

/// Cờ tắt ⇒ 404; id ngoài INT32 hoặc < 1 ⇒ 404 như id không tồn tại.
fn gate(ctx: &AiActionsCtx, id: Option<&str>) -> Result<Option<i32>, Response> {
    if !ctx.enabled {
        return Err(not_found());
    }
    match id {
        None => Ok(None),
        Some(raw) => match raw.parse::<i32>() {
            Ok(n) if n >= 1 => Ok(Some(n)),
            _ => Err(not_found()),
        },
    }
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

/// `Number(s)` của JS cho chuỗi: rỗng ⇒ 0; tiền tố `0x`/`0b`/`0o`; chỉ `Infinity` (không phải `inf`/`nan` của Rust); còn lại NaN.
fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'-' => (-1.0, &t[1..]),
        b'+' => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = match body.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0b" | "0B") => Some(2),
        Some("0o" | "0O") => Some(8),
        _ => None,
    };
    if let Some(r) = radix {
        // Số có tiền tố không nhận dấu (`-0x1` là NaN).
        return if t.len() == body.len() && body.len() > 2 {
            u128::from_str_radix(&body[2..], r).map_or(f64::NAN, |n| n as f64)
        } else {
            f64::NAN
        };
    }
    if !body
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

async fn list(
    State(c): State<Arc<AiActionsCtx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Err(r) = gate(&c, None) {
        return r;
    }
    let status = q.get("status").map(String::as_str);
    if status.is_some_and(|s| !status_ok(s)) {
        return fail(HttpError::bad_request("status không hợp lệ"));
    }
    // `limit`: Number(limit) || 20, kẹp 1..50 (phần lẻ bỏ).
    let n = q.get("limit").map_or(f64::NAN, |l| js_number(l));
    let limit = if n.is_nan() || n == 0.0 {
        20
    } else {
        n.clamp(1.0, 50.0).floor() as i64
    };
    // `cursor` rỗng = không có; còn lại phải là số nguyên trong INT32 và >= 1.
    let cursor = match q.get("cursor").filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => {
            let n = js_number(s);
            if n.fract() != 0.0 || !(1.0..=f64::from(i32::MAX)).contains(&n) {
                return fail(HttpError::bad_request("cursor không hợp lệ"));
            }
            Some(n as i32)
        }
    };
    ok(c.list(user.company, user.user_id, status, cursor, limit).await)
}

async fn settings(State(c): State<Arc<AiActionsCtx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Err(r) = gate(&c, None) {
        return r;
    }
    Json(json!({ "require_approval": c.requires_approval(user.company).await })).into_response()
}

async fn update_settings(
    State(c): State<Arc<AiActionsCtx>>,
    Extension(u): Extension<CurrentUser>,
    req: Request,
) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Err(r) = gate(&c, None) {
        return r;
    }
    let b = match body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    match validate_value("UpdateAiActionSettingsDto", &b, Mode::Strict) {
        Ok(v) => {
            let on = v.get("require_approval").and_then(Value::as_bool).unwrap_or(false);
            ok(c.set_require_approval(user.company, on, user.user_id).await)
        }
        Err(e) => fail(e),
    }
}

async fn pending_count(State(c): State<Arc<AiActionsCtx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Err(r) = gate(&c, None) {
        return r;
    }
    ok(c.pending_count(user.company, user.user_id)
        .await
        .map(|n| json!({ "pending": n })))
}

async fn get_one(
    State(c): State<Arc<AiActionsCtx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    match gate(&c, Some(&id)) {
        Ok(Some(id)) => ok(c.get(user.company, user.user_id, id).await),
        Ok(None) => not_found(),
        Err(r) => r,
    }
}

async fn approve(
    State(c): State<Arc<AiActionsCtx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let id = match gate(&c, Some(&id)) {
        Ok(Some(id)) => id,
        Ok(None) => return not_found(),
        Err(r) => return r,
    };
    let b = match body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    match validate_value("ApproveAiActionDto", &b, Mode::Strict) {
        Ok(v) => ok(c
            .approve(&user, id, v.get("confirm_text").and_then(Value::as_str))
            .await),
        Err(e) => fail(e),
    }
}

async fn reject(
    State(c): State<Arc<AiActionsCtx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let user = match who(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    match gate(&c, Some(&id)) {
        Ok(Some(id)) => ok(c.reject(user.company, user.user_id, id).await),
        Ok(None) => not_found(),
        Err(r) => r,
    }
}

/// Router của module; người gọi gắn state `Arc<AiActionsCtx>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<AiActionsCtx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, BASE), list)
        .route(spec(&Method::GET, "/api/v1/integrations/ai-actions/settings"), settings)
        .route(
            spec(&Method::PATCH, "/api/v1/integrations/ai-actions/settings"),
            update_settings,
        )
        .route(
            spec(&Method::GET, "/api/v1/integrations/ai-actions/pending-count"),
            pending_count,
        )
        .route(spec(&Method::GET, "/api/v1/integrations/ai-actions/:id"), get_one)
        .route(
            spec(&Method::POST, "/api/v1/integrations/ai-actions/:id/approve"),
            approve,
        )
        .route(
            spec(&Method::POST, "/api/v1/integrations/ai-actions/:id/reject"),
            reject,
        )
}

#[cfg(test)]
mod tests {
    use super::js_number;

    #[test]
    fn number_nhu_js() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("  12 "), 12.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("0b11"), 3.0);
        assert_eq!(js_number("0o7"), 7.0);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_number("1e2"), 100.0);
        assert_eq!(js_number(".5"), 0.5);
        for bad in [
            "inf", "nan", "NaN", "infinity", "-0x1", "0x", "0xg", "abc", "1_0", "1,5", "12px",
        ] {
            assert!(js_number(bad).is_nan(), "{bad}");
        }
    }
}
