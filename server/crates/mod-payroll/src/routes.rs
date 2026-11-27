//! Bảng route của M29 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Cấu hình lương chỉ dành cho người giữ `payroll.manage` (không phân đọc/ghi/xoá riêng); riêng
//! `GET /kpi` ("KPI của tôi") chỉ cần đăng nhập.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 23 route của `SalaryComponentsController`, `InsuranceSettingsController`, `TaxConfigController`, `SalaryRulesController`
/// và `KpiController`.
pub fn routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["payroll.manage"]);
    let r = |m: Method, path: &'static str, ok: u16| RouteSpec::new(m, path, manage).status_ok(ok);
    let by_id = |m: Method, path: &'static str| r(m, path, 200).param_pipes(ID);
    vec![
        r(Method::GET, "/api/v1/salary-components", 200),
        r(Method::POST, "/api/v1/salary-components", 201),
        by_id(Method::PATCH, "/api/v1/salary-components/:id"),
        by_id(Method::DELETE, "/api/v1/salary-components/:id"),
        r(Method::GET, "/api/v1/insurance-settings", 200),
        r(Method::POST, "/api/v1/insurance-settings", 201),
        by_id(Method::PATCH, "/api/v1/insurance-settings/:id"),
        by_id(Method::DELETE, "/api/v1/insurance-settings/:id"),
        r(Method::GET, "/api/v1/tax-config", 200),
        r(Method::POST, "/api/v1/tax-config/brackets", 201),
        by_id(Method::PATCH, "/api/v1/tax-config/brackets/:id"),
        by_id(Method::DELETE, "/api/v1/tax-config/brackets/:id"),
        r(Method::POST, "/api/v1/tax-config/settings", 201),
        by_id(Method::PATCH, "/api/v1/tax-config/settings/:id"),
        r(Method::GET, "/api/v1/salary-rules", 200),
        r(Method::POST, "/api/v1/salary-rules", 201),
        by_id(Method::GET, "/api/v1/salary-rules/:id"),
        by_id(Method::PATCH, "/api/v1/salary-rules/:id"),
        r(Method::GET, "/api/v1/kpi/configs", 200),
        r(Method::POST, "/api/v1/kpi/configs", 201),
        r(Method::POST, "/api/v1/kpi/calculate", 201),
        r(Method::POST, "/api/v1/kpi/close-month", 201),
        RouteSpec::new(Method::GET, "/api/v1/kpi", Access::AuthOnly).status_ok(200),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 23);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 23);
    }
}
