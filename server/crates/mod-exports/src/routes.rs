//! Route xuất nền: xếp việc, hỏi trạng thái, tải tệp.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use mod_contacts::Scopes;
use mod_contacts::list::ListQuery;
use serde::Deserialize;
use serde_json::json;
use trinity_db::{CompanyRef, Db};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidQuery};
use trinity_jobs::{NewJob, Queue};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::ScopeService;

use crate::store::{ExportStatus, Store, StoreError};
use crate::worker::MAX_ATTEMPTS;
use crate::{JOB_KIND, contacts};

const BASE: &str = "/api/v1/exports";
const ID: &[&str] = &["param.id:ParseIntPipe"];
const CONTACTS_EXPORT: Access = Access::Can(&["contacts.export"]);

/// Trạng thái dùng chung của router xuất nền.
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
    pub queue: Queue,
    pub store: Store,
}

/// 3 route (không có trong `routes.json`, xem tài liệu crate).
pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::POST, "/api/v1/exports/contacts", CONTACTS_EXPORT).status_ok(202),
        RouteSpec::new(Method::GET, "/api/v1/exports/:id", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/exports/:id/download", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

/// Query của `POST /exports/contacts` = query của `GET /contacts/export` (cùng DTO, cùng kiểm tra).
#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct QueryContactDto(ListQuery);

impl Dto for QueryContactDto {
    const NAME: &'static str = "QueryContactDto";
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn store_err(e: StoreError) -> AppError {
    AppError::internal(e)
}

/// Công ty của token; sai ⇒ 401 (không rơi về công ty mặc định).
fn company_of(u: &CurrentUser) -> Result<CompanyRef, AppError> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| AppError::Http(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

fn id_of(raw: &str) -> Result<i64, AppError> {
    raw.parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| AppError::Http(HttpError::bad_request("Validation failed (numeric string is expected)")))
}

fn not_found() -> AppError {
    AppError::Http(HttpError::not_found("Không tìm thấy tệp xuất (có thể đã hết hạn)"))
}

async fn enqueue_contacts(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidQuery(QueryContactDto(q)): ValidQuery<QueryContactDto>,
) -> Response {
    let res = async {
        let company = company_of(&u)?;
        let scopes = Scopes::resolve(&c.scopes, company, u.user.user_id, &u.grants.grants).await?;
        let company_id = u.user.company_id;
        let id = c
            .store
            .create(company_id, u.user.user_id, contacts::KIND)
            .await
            .map_err(store_err)?
            .ok_or_else(|| {
                AppError::Http(HttpError::new(
                    429,
                    "Bạn đang có quá nhiều tệp xuất đang chạy, chờ xong rồi thử lại",
                ))
            })?;
        let queued = async {
            let payload = contacts::payload(id, &q.filters, &scopes).map_err(|e| e.to_string())?;
            c.queue
                .enqueue(NewJob::new(company_id, JOB_KIND, payload).max_attempts(MAX_ATTEMPTS))
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        if let Err(msg) = queued {
            // Ghi phụ: không che lỗi chính.
            let _ = c.store.fail(id, company_id, &msg).await;
            return Err(AppError::internal(msg));
        }
        Ok(id)
    }
    .await;
    match res {
        Ok(id) => (StatusCode::ACCEPTED, Json(json!({ "id": id, "status": "queued" }))).into_response(),
        Err(e) => fail(e),
    }
}

async fn status_of(c: &Ctx, u: &CurrentUser, raw_id: &str) -> Result<ExportStatus, AppError> {
    let id = id_of(raw_id)?;
    company_of(u)?;
    c.store
        .status(id, u.user.company_id, u.user.user_id)
        .await
        .map_err(store_err)?
        .ok_or_else(not_found)
}

async fn get_status(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    match status_of(&c, &u, &id).await {
        Ok(s) => Json(s).into_response(),
        Err(e) => fail(e),
    }
}

async fn download(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let st = status_of(&c, &u, &id).await?;
        match st.status.as_str() {
            "done" => {}
            "failed" => {
                return Err(AppError::Http(HttpError::new(
                    409,
                    format!("Xuất tệp thất bại: {}", st.error.as_deref().unwrap_or("lỗi không rõ")),
                )));
            }
            _ => return Err(AppError::Http(HttpError::new(409, "Tệp chưa sẵn sàng"))),
        }
        c.store
            .file(st.id, u.user.company_id, u.user.user_id)
            .await
            .map_err(store_err)?
            .ok_or_else(not_found)
    }
    .await;
    match res {
        Ok(f) => {
            let len = f.data.len();
            let mut resp = Response::new(Body::from(f.data));
            let h = resp.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&f.content_type) {
                h.insert(header::CONTENT_TYPE, v);
            }
            if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", f.filename.replace('"', ""))) {
                h.insert(header::CONTENT_DISPOSITION, v);
            }
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            resp
        }
        Err(e) => fail(e),
    }
}

/// Router của module; người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::POST, "/api/v1/exports/contacts"), enqueue_contacts)
        .route(spec(&Method::GET, "/api/v1/exports/:id"), get_status)
        .route(spec(&Method::GET, "/api/v1/exports/:id/download"), download)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ba_route_xuat_nen_khai_quyen_dung() {
        let t = specs();
        assert_eq!(t.len(), 3);
        assert!(t.iter().all(|s| s.path.starts_with(BASE)));
        let post = t.iter().find(|s| s.method == Method::POST).unwrap();
        assert_eq!(post.access, CONTACTS_EXPORT);
        assert!(t.iter().filter(|s| s.method == Method::GET).all(|s| s.access == Access::AuthOnly));
    }

    #[test]
    fn id_phai_la_so_nguyen_duong() {
        assert_eq!(id_of("12").unwrap(), 12);
        for bad in ["", "0", "-3", "abc", "1.5", "99999999999999999999"] {
            assert!(id_of(bad).is_err(), "{bad}");
        }
    }
}
