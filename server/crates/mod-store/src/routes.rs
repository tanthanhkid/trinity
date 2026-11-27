//! Bảng route của M56 (K14), so với `contracts/routes.json` bởi `trinity check-routes`: 4 route quản trị cần tính năng tổ chức
//! `online_store` (`OrgFeatureGuard`), 3 route công khai.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

pub fn specs() -> Vec<RouteSpec> {
    const ID: &[&str] = &["param.id:ParseIntPipe"];
    let feature =
        |m: Method, p: &'static str, a: Access| RouteSpec::new(m, p, a).status_ok(200).org_feature("online_store");
    vec![
        feature(Method::GET, "/api/v1/store/orders", Access::Can(&["deals.view"])),
        feature(
            Method::PATCH,
            "/api/v1/store/orders/:id",
            Access::Can(&["deals.manage"]),
        )
        .param_pipes(ID),
        feature(Method::GET, "/api/v1/store/settings", Access::Can(&["pos.manage"])),
        feature(Method::PUT, "/api/v1/store/settings", Access::Can(&["pos.manage"])),
        RouteSpec::new(Method::GET, "/api/v1/store/public/:slug", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/store/public/:slug/orders", Access::Public).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/store/public/:slug/orders/:code", Access::Public).status_ok(200),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 7);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 7);
    }
}
