//! Bảng route của M05 (K14), so với `contracts/routes.json` ở test cuối file.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 5 route `/api-keys`, `POST /public/auth/login` (`ApiKeyGuard` + `@Public()`), 2 route `/auth/teams`.
pub fn routes() -> Vec<RouteSpec> {
    let keys = Access::Can(&["settings.integrations"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/api-keys", keys).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/api-keys/:id", keys)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/api-keys", keys).status_ok(201),
        RouteSpec::new(Method::POST, "/api/v1/api-keys/:id/rotate", keys)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/api-keys/:id", keys)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/public/auth/login", Access::Public)
            .status_ok(200)
            .guards(&["ApiKeyGuard"]),
        RouteSpec::new(Method::GET, "/api/v1/auth/teams", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/auth/teams", Access::Can(&["org.manage"])).status_ok(201),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 8);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 8);
    }
}
