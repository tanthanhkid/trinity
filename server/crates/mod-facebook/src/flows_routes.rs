//! Tầng route của kịch bản nhắn tin (M50b): 6 route `flows`. Bảng route nằm ở [`crate::flows::flow_routes`]; chat-links, `go/:code`
//! và `tick` đã ở [`crate::routes::api_router`]. Ở đây chỉ nối handler vào [`ApiRouter`].
//! Mount ở `trinity-bin/src/serve.rs` thành MỘT khối liền, dùng chung `FacebookState` với router kết nối.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use http::Method;
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser};
use trinity_kernel::error::{AppError, HttpError};

use crate::flows::{FlowInput, flow_routes};
use crate::routes::{FacebookState, JsonBody, company, fail, ok};

/// Id đường dẫn (`ParseIntPipe` đã chạy ở router): số ngoài int4 thì không có bản ghi nào ⇒ 404.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
}

fn flow_id(raw: &str) -> Result<i32, AppError> {
    id_of(raw, "kịch bản")
}

async fn flows_list(State(s): State<Arc<FacebookState>>, Extension(u): Extension<CurrentUser>) -> Response {
    let company = company!(u);
    ok(s.ingest.list_flows(company).await)
}

async fn flows_get(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    match flow_id(&id) {
        Ok(id) => ok(s.ingest.get_flow(company, id).await),
        Err(e) => fail(e),
    }
}

async fn flows_create(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match FlowInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    ok(s.ingest.create_flow(company, &input, u.user.user_id).await)
}

async fn flows_update(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let company = company!(u);
    let input = match FlowInput::from_json(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    match flow_id(&id) {
        Ok(id) => ok(s.ingest.update_flow(company, id, &input).await),
        Err(e) => fail(e),
    }
}

async fn flows_delete(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let company = company!(u);
    let id = match flow_id(&id) {
        Ok(id) => id,
        Err(e) => return fail(e),
    };
    match s.ingest.delete_flow(company, id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

async fn flows_runs(
    State(s): State<Arc<FacebookState>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let company = company!(u);
    match flow_id(&id) {
        Ok(id) => ok(s
            .ingest
            .flow_runs(company, id, q.get("limit").map(String::as_str))
            .await),
        Err(e) => fail(e),
    }
}

/// Router của kịch bản nhắn tin: spec lấy từ bảng route nên quyền và mã thành công khớp `routes.json`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<FacebookState>> {
    let table = flow_routes();
    let spec = |m: &Method, p: &str| {
        table
            .iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let flows = "/api/v1/facebook/flows";
    ApiRouter::new(deps)
        .route(spec(&Method::GET, flows), flows_list)
        .route(spec(&Method::POST, flows), flows_create)
        .route(spec(&Method::GET, "/api/v1/facebook/flows/:id"), flows_get)
        .route(spec(&Method::GET, "/api/v1/facebook/flows/:id/runs"), flows_runs)
        .route(spec(&Method::PATCH, "/api/v1/facebook/flows/:id"), flows_update)
        .route(spec(&Method::DELETE, "/api/v1/facebook/flows/:id"), flows_delete)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;

    #[test]
    fn id_ngoai_int4_la_404() {
        assert_eq!(flow_id("12").unwrap(), 12);
        assert!(flow_id("99999999999").is_err());
        assert!(id_of("abc", "x").is_err());
    }

    #[test]
    fn json_dung_dang_phan_hoi_xoa() {
        // `Json` dùng cho 200/201; xoá trả 204 không thân.
        let r = Json(serde_json::json!({ "a": 1 })).into_response();
        assert_eq!(r.status(), StatusCode::OK);
    }
}
