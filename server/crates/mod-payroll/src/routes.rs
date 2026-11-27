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

/// 8 route xuất/nhập/PDF của `PayslipsController` (M31). Tệp trả về do handler tự đặt mã (`status_ok = null`); hai route nhập
/// (multipart) trả 201 như `@Post`. `excel-bulk`, `excel-list`, `import-template`, `import/*` là đường tĩnh nên không bị `:id`
/// nuốt (axum ưu tiên đường tĩnh).
pub fn file_specs() -> Vec<RouteSpec> {
    let export = Access::Can(&["payroll.export"]);
    let manage = Access::Can(&["payroll.manage"]);
    let raw = |m: Method, path: &'static str, a: Access| RouteSpec::new(m, path, a);
    vec![
        raw(Method::GET, "/api/v1/payslips/excel-bulk", export),
        raw(Method::GET, "/api/v1/payslips/excel-list", export),
        raw(Method::POST, "/api/v1/payslips/excel-list", export),
        raw(Method::GET, "/api/v1/payslips/import-template", manage),
        RouteSpec::new(Method::POST, "/api/v1/payslips/import/preview", manage).status_ok(201),
        RouteSpec::new(Method::POST, "/api/v1/payslips/import/apply", manage).status_ok(201),
        raw(Method::GET, "/api/v1/payslips/:id/pdf", export).param_pipes(ID),
        raw(Method::GET, "/api/v1/payslips/:id/excel", export).param_pipes(ID),
    ]
}

/// 3 route của `ReportsController` (M31): chi phí lương toàn công ty, chỉ `payroll.manage`.
pub fn report_specs() -> Vec<RouteSpec> {
    let manage = Access::Can(&["payroll.manage"]);
    let r = |path: &'static str| RouteSpec::new(Method::GET, path, manage).status_ok(200);
    vec![
        r("/api/v1/reports/summary"),
        r("/api/v1/reports/by-department"),
        r("/api/v1/reports/comparison"),
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
    fn m31_khop_hop_dong_routes_json() {
        let files = file_specs();
        assert_eq!(files.len(), 8);
        let rep = trinity_http::router::check::check_embedded(&files, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 8);
        let reports = report_specs();
        assert_eq!(reports.len(), 3);
        let rep = trinity_http::router::check::check_embedded(&reports, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 3);
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
