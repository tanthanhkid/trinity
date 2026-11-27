//! Bảng route của M52 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Kết nối, ngắt và ZNS cần `integrations.webhooks`; hộp thư (xem, trả lời, ghép khách) cần
//! `contacts.update`. Cờ/gói `zalo_oa` tắt ⇒ 403 (`org_feature`, kèm `OrgFeatureGuard`); callback OAuth và webhook công khai
//! (xác thực bằng `state` và chữ ký), webhook luôn 200 sau khi kiểm chữ ký để Zalo không gửi lại.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 11 route của `ZaloOaController`.
pub fn routes() -> Vec<RouteSpec> {
    let inbox = Access::Can(&["contacts.update"]);
    let manage = Access::Can(&["integrations.webhooks"]);
    let r =
        |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok).org_feature("zalo_oa");
    vec![
        r(Method::GET, "/api/v1/zalo-oa/status", inbox, 200),
        r(Method::POST, "/api/v1/zalo-oa/connect", manage, 200),
        RouteSpec::new(Method::GET, "/api/v1/zalo-oa/oauth/callback", Access::Public),
        r(Method::DELETE, "/api/v1/zalo-oa/connection", manage, 204),
        r(Method::GET, "/api/v1/zalo-oa/threads", inbox, 200),
        r(Method::GET, "/api/v1/zalo-oa/threads/:id/messages", inbox, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/messages", inbox, 201).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/read", inbox, 204).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/threads/:id/link", inbox, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/zalo-oa/zns", manage, 200),
        RouteSpec::new(Method::POST, "/api/v1/zalo-oa/webhook", Access::Public).status_ok(200),
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
