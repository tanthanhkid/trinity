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

/// 13 route của M30b: 9 route phiếu lương không trả tệp (`PayslipsController`) và 4 route `employees` của payroll.
/// `/payslips/me`, `/addable`, `/generate`, `/add-to-period` là đường tĩnh nên không bị `:id` nuốt (axum ưu tiên đường tĩnh).
pub fn payslip_specs() -> Vec<RouteSpec> {
    let view = Access::Can(&["payroll.view"]);
    let manage = Access::Can(&["payroll.manage"]);
    let approve = Access::CanAny(&["payroll.approve_team", "payroll.approve_final"]);
    let emp_view = Access::Can(&["employees.view"]);
    let emp_manage = Access::Can(&["employees.manage"]);
    let r = |m: Method, path: &'static str, a: Access, ok: u16| RouteSpec::new(m, path, a).status_ok(ok);
    let by_id = |m: Method, path: &'static str, a: Access| r(m, path, a, 200).param_pipes(ID);
    vec![
        r(Method::GET, "/api/v1/payslips/me", Access::AuthOnly, 200),
        r(Method::GET, "/api/v1/payslips", view, 200),
        r(Method::GET, "/api/v1/payslips/addable", manage, 200),
        by_id(Method::GET, "/api/v1/payslips/:id", view),
        r(Method::POST, "/api/v1/payslips/generate", manage, 201),
        r(Method::POST, "/api/v1/payslips/add-to-period", manage, 201),
        by_id(Method::PATCH, "/api/v1/payslips/:id/approve", approve),
        by_id(Method::PATCH, "/api/v1/payslips/:id", manage),
        by_id(Method::DELETE, "/api/v1/payslips/:id", manage),
        r(Method::GET, "/api/v1/employees", emp_view, 200),
        r(Method::POST, "/api/v1/employees", emp_manage, 201),
        by_id(Method::GET, "/api/v1/employees/:id", emp_view),
        by_id(Method::PATCH, "/api/v1/employees/:id", emp_manage),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m30b_khop_hop_dong_routes_json() {
        let table = payslip_specs();
        assert_eq!(table.len(), 13);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 13);
    }

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 23);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 23);
    }
}
