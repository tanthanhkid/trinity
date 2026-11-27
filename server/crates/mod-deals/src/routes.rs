//! Bảng route của M08 (K14), so với `contracts/routes.json` ở test cuối file.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 1 route hoạt động theo khách, 6 route `/deals`, 3 route `/interactions`.
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["deals.view"]);
    let manage = Access::Can(&["deals.manage"]);
    let delete = Access::Can(&["deals.delete"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/contacts/:contactId/activities", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(&["param.contactId:ParseIntPipe"]),
        RouteSpec::new(Method::GET, "/api/v1/deals", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/deals", manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/deals/search-sales", manage).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/deals/:id", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/deals/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/deals/:id", delete)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/interactions", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/interactions/stats", Access::AuthOnly).status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/interactions/comments/:id/thread",
            Access::AuthOnly,
        )
        .status_ok(200),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 10);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 10);
    }
}
