//! Bảng route của M26 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Quyền nhóm bán hàng `pos.sell`; ghi cấu hình `pos.manage`; báo cáo `pos.report`.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseInt4Pipe"];

/// 25 route của `PosLayoutController`, `PosCatalogController`, `PosShiftsController` (M26) và `PosOrdersController` (M27).
pub fn routes() -> Vec<RouteSpec> {
    let sell = Access::Can(&["pos.sell"]);
    let manage = Access::Can(&["pos.manage"]);
    let report = Access::Can(&["pos.report"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/pos/areas", sell).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/pos/areas", manage).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/pos/areas/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/pos/tables", sell).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/pos/tables", manage).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/pos/tables/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/pos/modifiers", sell).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/pos/modifiers", manage).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/pos/modifiers/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/pos/settings", sell).status_ok(200),
        RouteSpec::new(Method::PATCH, "/api/v1/pos/settings", manage).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/pos/menu", sell).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/pos/shifts/open", sell).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/pos/shifts/current", sell).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/pos/shifts", sell).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/pos/shifts/:id/summary", sell)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/pos/shifts/:id/close", sell)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/pos/reports/daily", report).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/pos/orders", sell).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/pos/orders", sell).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/pos/orders/:id", sell)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/pos/orders/:id", sell)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/pos/orders/:id/pay", sell)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/pos/orders/:id/qr", sell)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/pos/orders/:id/void", sell)
            .status_ok(201)
            .param_pipes(ID),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 25);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 25);
    }
}
