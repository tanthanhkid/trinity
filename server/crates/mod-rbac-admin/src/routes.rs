//! Bảng route của M04 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 11 route của `RolesController`, `UserRolesController`, `RbacAuditController` và `RbacCatalogController`.
pub fn routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["roles.manage"]);
    vec![
        RouteSpec::new(
            Method::GET,
            "/api/v1/roles",
            Access::CanAny(&["roles.manage", "users.manage", "kanban.boards"]),
        )
        .status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/roles/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/roles", manage).status_ok(201),
        RouteSpec::new(Method::POST, "/api/v1/roles/:id/clone", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/roles/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PUT, "/api/v1/roles/:id/grants", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/roles/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/roles/:id/members", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PUT, "/api/v1/users/:id/roles", Access::Can(&["users.manage"]))
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/rbac/audit", manage).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/rbac/catalog", Access::AuthOnly).status_ok(200),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 11);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 11);
    }
}
