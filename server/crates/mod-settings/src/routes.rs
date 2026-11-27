//! Bảng route của M06 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Hai đường `settings/channel-guard` thuộc M45.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const PLAN_GUARD: &[&str] = &["PlanTokenGuard"];

/// 12 route của `SettingsOptionsController` (4), `SettingsController` (4, không kể `client-ip/alerts`),
/// `OrgFeaturesController` (2) và `UsageController` (2).
pub fn routes() -> Vec<RouteSpec> {
    let catalog = Access::Can(&["contacts.catalog"]);
    let features = Access::Can(&["settings.features"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/settings/options", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/settings/options", catalog).status_ok(201),
        RouteSpec::new(Method::PATCH, "/api/v1/settings/options/:id", catalog)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/settings/options/:id", catalog)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/settings/notification-sound", Access::AuthOnly).status_ok(200),
        RouteSpec::new(
            Method::PATCH,
            "/api/v1/settings/notification-sound",
            Access::Can(&["settings.integrations"]),
        )
        .status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/settings/departments", Access::AuthOnly).status_ok(200),
        RouteSpec::new(
            Method::PATCH,
            "/api/v1/settings/departments",
            Access::Can(&["org.manage"]),
        )
        .status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/settings/org-features", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::PUT, "/api/v1/settings/org-features", features).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/settings/usage", features).status_ok(200),
        RouteSpec::new(Method::PUT, "/api/v1/settings/plan", features)
            .status_ok(200)
            .guards(PLAN_GUARD),
    ]
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
}
