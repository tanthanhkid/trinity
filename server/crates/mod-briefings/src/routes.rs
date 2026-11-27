//! Bảng route và router của `BriefingsController` (M23): 6 route `/api/v1/briefings`, quyền, cờ `ai_briefing` và mã thành
//! công khớp `contracts/routes.json`. Logic ở [`crate::service`]; phần RBAC cài bằng [`RbacPorts`].
//!
//! `GET /briefings/preview` trả thân rỗng (HTTP 200) khi người gọi không có phạm vi, đúng như Nest (`null` ⇒ `res.send()`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value};
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError};

use crate::ports::{FEATURE, RbacPorts};
use crate::service::{self, Error};
use crate::types::Slot;

const BASE: &str = "/api/v1/briefings";
const VIEW: Access = Access::Can(&["reports.overview"]);
const MANAGE: Access = Access::Can(&["settings.integrations"]);
const ID: &[&str] = &["param.id:ParseIntPipe"];

/// Trạng thái dùng chung của router bản tin.
pub struct Ctx {
    pub db: Db,
}

/// 6 route của `BriefingsController` (bảng so với `routes.json` bởi `trinity check-routes`).
pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::GET, BASE, VIEW).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/briefings/config", MANAGE).status_ok(200),
        RouteSpec::new(Method::PATCH, "/api/v1/briefings/config", MANAGE).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/briefings/preview", VIEW)
            .status_ok(200)
            .org_feature(FEATURE),
        RouteSpec::new(Method::POST, "/api/v1/briefings/run-now", MANAGE)
            .status_ok(201)
            .org_feature(FEATURE),
        RouteSpec::new(Method::GET, "/api/v1/briefings/:id", VIEW)
            .status_ok(200)
            .param_pipes(ID),
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

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

fn app_err(e: Error) -> AppError {
    match e {
        Error::Http(h) => (*h).into(),
        Error::Internal(m) => AppError::internal(m),
    }
}

/// Công ty của người gọi (token sai ⇒ 401, không rơi về công ty mặc định) và kết nối công ty đó.
async fn tenant(c: &Ctx, u: &CurrentUser) -> Result<(TenantDb, RbacPorts), AppError> {
    let Ok(company) = CompanyRef::new(i64::from(u.user.company_id)) else {
        return Err(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn").into());
    };
    let t = c.db.tenant(company).await.map_err(AppError::internal)?;
    Ok((t, RbacPorts::new(company, c.db.multi_tenant())))
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản tin nào.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found("Không tìm thấy").into())
}

/// `SlotQueryDto` (`forbidNonWhitelisted`): khoá lạ báo trước, rồi `slot` phải là `morning`/`evening`.
fn slot_param(q: &HashMap<String, String>) -> Result<Option<&str>, AppError> {
    let mut errs: Vec<String> = q
        .keys()
        .filter(|k| k.as_str() != "slot")
        .map(|k| format!("property {k} should not exist"))
        .collect();
    errs.sort();
    let slot = q.get("slot").map(String::as_str);
    if slot.is_some_and(|s| Slot::parse(s).is_none()) {
        errs.push("slot must be one of the following values: morning, evening".to_owned());
    }
    if errs.is_empty() {
        Ok(slot)
    } else {
        Err(HttpError::validation(errs).into())
    }
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
        let bytes: Bytes = to_bytes(req.into_body(), 5 * 1024 * 1024)
            .await
            .map_err(|_| fail(HttpError::payload_too_large("request entity too large")))?;
        if !is_json || bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(Value::Object(Map::new())));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Self(v)),
            _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
        }
    }
}

async fn get_config(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let res = async {
        let (t, ports) = tenant(&c, &u).await?;
        service::get_config(&t, &ports).await.map_err(app_err)
    }
    .await;
    ok(res)
}

async fn update_config(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let (t, _) = tenant(&c, &u).await?;
        service::update_config(&t, &body, u.user.user_id).await.map_err(app_err)
    }
    .await;
    ok(res)
}

async fn run_now(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let res = async {
        let slot = slot_param(&q)?;
        let (t, ports) = tenant(&c, &u).await?;
        service::run_now(&t, &ports, slot, Utc::now()).await.map_err(app_err)
    }
    .await;
    ok(res)
}

async fn preview(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let res = async {
        let slot = slot_param(&q)?;
        let (t, ports) = tenant(&c, &u).await?;
        service::preview(&t, &ports, u.user.user_id, &u.user.email, slot, Utc::now())
            .await
            .map_err(app_err)
    }
    .await;
    match res {
        // Không có phạm vi: Nest trả `null` ⇒ thân rỗng.
        Ok(None) => StatusCode::OK.into_response(),
        Ok(Some(p)) => Json(p).into_response(),
        Err(e) => fail(e),
    }
}

async fn list(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let res = async {
        let (t, _) = tenant(&c, &u).await?;
        service::list(&t, u.user.user_id).await.map_err(app_err)
    }
    .await;
    ok(res)
}

async fn one(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let res = async {
        let id = id_of(&id)?;
        let (t, _) = tenant(&c, &u).await?;
        service::one(&t, u.user.user_id, id).await.map_err(app_err)
    }
    .await;
    ok(res)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Cờ `ai_briefing` do `AccessDeps.features` kiểm
/// trước handler (403), nên `deps.features` phải có cổng tính năng.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, BASE), list)
        .route(spec(&Method::GET, "/api/v1/briefings/config"), get_config)
        .route(spec(&Method::PATCH, "/api/v1/briefings/config"), update_config)
        .route(spec(&Method::GET, "/api/v1/briefings/preview"), preview)
        .route(spec(&Method::POST, "/api/v1/briefings/run-now"), run_now)
        .route(spec(&Method::GET, "/api/v1/briefings/:id"), one)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(e: AppError) -> Vec<String> {
        match e {
            AppError::Http(h) => match h.body().message {
                trinity_kernel::error::Message::Many(m) => m,
                trinity_kernel::error::Message::One(m) => vec![m],
            },
            other => vec![other.to_string()],
        }
    }

    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 6);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 6);
    }

    #[test]
    fn tham_so_slot_dung_cau_loi_class_validator() {
        assert_eq!(slot_param(&q(&[])).unwrap(), None);
        assert_eq!(slot_param(&q(&[("slot", "evening")])).unwrap(), Some("evening"));
        let e = slot_param(&q(&[("slot", "noon")])).unwrap_err();
        assert_eq!(
            messages(e),
            ["slot must be one of the following values: morning, evening"]
        );
        let e = slot_param(&q(&[("slot", ""), ("x", "1")])).unwrap_err();
        assert_eq!(
            messages(e),
            [
                "property x should not exist",
                "slot must be one of the following values: morning, evening"
            ]
        );
    }

    #[test]
    fn id_ngoai_int4_la_404() {
        assert_eq!(id_of("12").unwrap(), 12);
        assert!(id_of("99999999999").is_err());
    }
}
