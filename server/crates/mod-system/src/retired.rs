//! `RetiredRoutesController`: đường CÔNG KHAI của kết nối/cổng thanh toán đã gỡ trả 410 để bên ngoài (nhà cung cấp, trình
//! duyệt quay về từ trang đăng nhập) ngừng thử lại thay vì gặp 404 (docs/rust/PLAN.md mục 2.3). Đường cần đăng nhập đã
//! xoá hẳn nên vẫn 404.
//!
//! Mọi route `Access::Public`, không guard. Trạng thái khai ở `routes.json`: POST 410, GET 200 (Nest không đặt
//! `@HttpCode` cho GET; ném 410 trong handler) — handler luôn trả 410 với thân cố định.

use std::sync::Arc;

use axum::http::Method;
use axum::response::Response;
use trinity_http::edge::body::error_response;
use trinity_http::router::{Access, AccessDeps, ApiRouter, RouteSpec};
use trinity_kernel::error::HttpError;

/// `goneError(what)`: 410 + `{statusCode, error: "Gone", message}`.
fn gone(what: &str) -> Response {
    error_response(&HttpError::with_label(
        410,
        format!("{what} đã ngừng hỗ trợ trên Trinity. / This integration has been removed."),
        "Gone",
    ))
}

/// Bảng route (12) của `RetiredRoutesController`, khớp `routes.json`.
pub fn routes() -> Vec<RouteSpec> {
    let get = |p: &'static str| RouteSpec::new(Method::GET, p, Access::Public).status_ok(200);
    let post = |p: &'static str| RouteSpec::new(Method::POST, p, Access::Public).status_ok(410);
    vec![
        get("/api/v1/integrations/google/oauth/callback"),
        post("/api/v1/connectors/:provider/webhook/:token"),
        post("/api/v1/connectors/:provider/push"),
        get("/api/v1/connectors/:provider/callback"),
        post("/api/v1/connectors/sepay/webhook"),
        get("/api/v1/connectors/vnpay/ipn"),
        get("/api/v1/pay/vnpay/return"),
        get("/api/v1/pay/:code/vnpay"),
        post("/api/v1/connectors/momo/ipn"),
        get("/api/v1/pay/momo/return"),
        get("/api/v1/pay/:code/momo"),
        post("/api/v1/payments"),
    ]
}

/// Nhãn nội dung của từng route (đúng chuỗi của bản Node).
fn what_of(path: &str) -> &'static str {
    match path {
        "/api/v1/integrations/google/oauth/callback" => "Kết nối Google Sheets",
        "/api/v1/connectors/:provider/webhook/:token" => "Kết nối phần mềm bán hàng",
        "/api/v1/connectors/:provider/push" | "/api/v1/connectors/:provider/callback" => {
            "Kết nối sàn thương mại điện tử"
        }
        "/api/v1/connectors/sepay/webhook" => "Cổng thanh toán SePay",
        "/api/v1/connectors/vnpay/ipn" | "/api/v1/pay/vnpay/return" | "/api/v1/pay/:code/vnpay" => {
            "Cổng thanh toán VNPay"
        }
        "/api/v1/connectors/momo/ipn" | "/api/v1/pay/momo/return" | "/api/v1/pay/:code/momo" => "Cổng thanh toán MoMo",
        _ => "Yêu cầu thanh toán",
    }
}

/// Router của 12 route; không có state.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter {
    let mut r = ApiRouter::new(deps);
    for spec in routes() {
        let what = what_of(spec.path);
        r = r.route(spec, move || async move { gone(what) });
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 12);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 12);
    }

    #[test]
    fn moi_route_co_nhan() {
        for s in routes() {
            assert!(!what_of(s.path).is_empty(), "{}", s.path);
        }
        assert_eq!(what_of("/api/v1/payments"), "Yêu cầu thanh toán");
    }
}
