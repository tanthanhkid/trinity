//! Bảng route của M24 (K14), so với `contracts/routes.json` ở test cuối file.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const LEAD: &str = "lead_scoring";
const STALE: &str = "stale_reminders";

/// 4 route `/lead-scoring` (cờ `lead_scoring`) và 4 route `/stale-work` (cờ `stale_reminders`).
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["contacts.view"]);
    let catalog = Access::Can(&["contacts.catalog"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/lead-scoring/rules", view)
            .status_ok(200)
            .org_feature(LEAD),
        RouteSpec::new(Method::PUT, "/api/v1/lead-scoring/rules", catalog)
            .status_ok(200)
            .org_feature(LEAD),
        RouteSpec::new(Method::POST, "/api/v1/lead-scoring/recompute-all", catalog)
            .status_ok(200)
            .org_feature(LEAD),
        RouteSpec::new(Method::POST, "/api/v1/lead-scoring/contacts/:id/recompute", view)
            .status_ok(200)
            .org_feature(LEAD)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/stale-work/summary", Access::AuthOnly)
            .status_ok(200)
            .org_feature(STALE),
        RouteSpec::new(Method::GET, "/api/v1/stale-work/config", Access::AuthOnly)
            .status_ok(200)
            .org_feature(STALE),
        RouteSpec::new(Method::PUT, "/api/v1/stale-work/config", catalog)
            .status_ok(200)
            .org_feature(STALE),
        RouteSpec::new(Method::POST, "/api/v1/stale-work/run", catalog)
            .status_ok(200)
            .org_feature(STALE),
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
