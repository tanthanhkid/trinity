//! Bảng route và handler (K14) của 13 route thuộc M19: 11 route `/api/v1/setup/…` và 2 route mẫu bảng
//! `/api/v1/custom-objects/templates…` mà M17 để lại. Quyền, mã thành công và chế độ kiểm dữ liệu (strict) khớp `contracts/routes.json`.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use trinity_http::edge::body::read_limited;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::extract::query_to_json;
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::build::BuildInput;
use crate::{Actor, Ctx, build, connect, status, templates, wizard};

const BUILD: Access = Access::Can(&["custom_objects.manage", "settings.features"]);
const MANAGE: Access = Access::Can(&["custom_objects.manage"]);
const FEATURES: Access = Access::Can(&["settings.features"]);

/// 13 dòng của bảng route, so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let s = |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok);
    vec![
        s(Method::GET, "/api/v1/setup/status", Access::AuthOnly, 200),
        s(Method::GET, "/api/v1/setup/connect-prompt", Access::AuthOnly, 200),
        s(Method::GET, "/api/v1/setup/onboarding", Access::AuthOnly, 200),
        s(Method::POST, "/api/v1/setup/onboarding/seen", Access::AuthOnly, 200),
        s(Method::POST, "/api/v1/setup/complete", MANAGE, 200),
        s(Method::POST, "/api/v1/setup/build", BUILD, 200),
        s(Method::GET, "/api/v1/setup/wizard", Access::AuthOnly, 200),
        s(Method::GET, "/api/v1/setup/wizard/config", FEATURES, 200),
        s(Method::PUT, "/api/v1/setup/wizard/config", FEATURES, 200),
        s(Method::POST, "/api/v1/setup/wizard/confirm", Access::AuthOnly, 200),
        s(Method::POST, "/api/v1/setup/wizard/skip", Access::AuthOnly, 200),
        s(Method::GET, "/api/v1/custom-objects/templates", MANAGE, 200),
        s(
            Method::POST,
            "/api/v1/custom-objects/templates/:template/apply",
            MANAGE,
            201,
        ),
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

/// Công ty trong token không hợp lệ ⇒ 401 như guard (không đoán công ty 1).
fn actor(u: &CurrentUser) -> Result<Actor, Response> {
    match trinity_db::CompanyRef::new(i64::from(u.user.company_id)) {
        Ok(company) => Ok(Actor {
            user_id: u.user.user_id,
            company,
            grants: u.grants.grants.clone(),
            is_admin: u.grants.is_admin,
        }),
        Err(_) => Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn"))),
    }
}

macro_rules! ac {
    ($u:expr) => {
        match actor(&$u) {
            Ok(a) => a,
            Err(r) => return r,
        }
    };
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`.
struct JsonBody(Value);

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &S) -> Result<Self, Response> {
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
        // Quá hạn mức ⇒ 413; lỗi đọc body khác ⇒ 400.
        let bytes: Bytes = read_limited(req.into_body(), 5 * 1024 * 1024).await.map_err(fail)?;
        if !is_json || bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(Value::Object(Map::new())));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Self(v)),
            _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
        }
    }
}

fn dto(name: &str, body: &Value) -> Result<Value, AppError> {
    validate_value(name, body, Mode::Strict)
}

fn step_of(v: &Value) -> String {
    v.get("step").and_then(Value::as_str).unwrap_or_default().to_owned()
}

async fn get_status(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(status::status(&c, &ac!(u)).await)
}

async fn get_connect(State(c): State<Arc<Ctx>>, Extension(_u): Extension<CurrentUser>, uri: Uri) -> Response {
    let q = query_to_json(uri.query().unwrap_or(""));
    ok(connect::get(&c, q.get("agent").and_then(Value::as_str)))
}

async fn get_onboarding(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(status::onboarding(&c, &ac!(u)).await)
}

async fn post_seen(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(status::mark_seen(&c, &ac!(u)).await)
}

async fn post_complete(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(status::complete(&c, &ac!(u)).await)
}

async fn post_build(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(b): JsonBody,
) -> Response {
    let a = ac!(u);
    let v = match dto("BuildSystemDto", &b) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let mut r = match build::build(&c, &a, &BuildInput::from_validated(&v)).await {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    // Dựng xong đã ghi; xem wizard là phần phụ: lỗi ở đây không được biến một lần dựng thành công thành 500.
    let w = match wizard::view(&c, &a).await {
        Ok(w) => w.to_json(),
        Err(e) => {
            tracing::warn!("dựng xong nhưng không đọc được wizard: {e}");
            Value::Null
        }
    };
    if let Some(o) = r.as_object_mut() {
        o.insert("wizard".to_owned(), w);
    }
    Json(r).into_response()
}

async fn get_wizard(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(wizard::view(&c, &ac!(u)).await.map(|w| w.to_json()))
}

async fn get_wizard_config(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(wizard::config(&c, &ac!(u)).await)
}

async fn put_wizard_config(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(b): JsonBody,
) -> Response {
    let a = ac!(u);
    match dto("WizardConfigDto", &b) {
        Ok(v) => ok(wizard::set_config(&c, &a, &v).await),
        Err(e) => fail(e),
    }
}

async fn post_confirm(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(b): JsonBody,
) -> Response {
    let a = ac!(u);
    match dto("WizardStepDto", &b) {
        Ok(v) => ok(wizard::confirm(&c, &a, &step_of(&v)).await),
        Err(e) => fail(e),
    }
}

async fn post_skip(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, JsonBody(b): JsonBody) -> Response {
    let a = ac!(u);
    match dto("WizardStepDto", &b) {
        Ok(v) => ok(wizard::skip(&c, &a, &step_of(&v)).await),
        Err(e) => fail(e),
    }
}

async fn list_templates(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(templates::list(&c, &ac!(u)).await)
}

async fn apply_template(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(template): Path<String>,
    JsonBody(b): JsonBody,
) -> Response {
    let a = ac!(u);
    match dto("ApplyTemplateDto", &b) {
        Ok(v) => {
            let with = v.get("with_sample_data").and_then(Value::as_bool) == Some(true);
            ok(templates::apply(&c, &a, &template, with).await)
        }
        Err(e) => fail(e),
    }
}

/// Router của module (người gọi gắn state `Arc<Ctx>` khi lắp `serve`).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/setup/status"), get_status)
        .route(spec(&Method::GET, "/api/v1/setup/connect-prompt"), get_connect)
        .route(spec(&Method::GET, "/api/v1/setup/onboarding"), get_onboarding)
        .route(spec(&Method::POST, "/api/v1/setup/onboarding/seen"), post_seen)
        .route(spec(&Method::POST, "/api/v1/setup/complete"), post_complete)
        .route(spec(&Method::POST, "/api/v1/setup/build"), post_build)
        .route(spec(&Method::GET, "/api/v1/setup/wizard"), get_wizard)
        .route(spec(&Method::GET, "/api/v1/setup/wizard/config"), get_wizard_config)
        .route(spec(&Method::PUT, "/api/v1/setup/wizard/config"), put_wizard_config)
        .route(spec(&Method::POST, "/api/v1/setup/wizard/confirm"), post_confirm)
        .route(spec(&Method::POST, "/api/v1/setup/wizard/skip"), post_skip)
        .route(spec(&Method::GET, "/api/v1/custom-objects/templates"), list_templates)
        .route(
            spec(&Method::POST, "/api/v1/custom-objects/templates/:template/apply"),
            apply_template,
        )
}
