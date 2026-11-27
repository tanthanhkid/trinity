//! Bảng route của M46 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Quyền `integrations.webhooks` cho mọi route trừ callback OAuth, công khai và xác thực bằng `state`
//! ký HMAC gắn với người bấm "Kết nối". Webhook, link mở chat, tin nhắn, bình luận… thuộc M47a trở đi.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 7 route của `FacebookController` (kết nối) và `FacebookPublicController.callback`.
pub fn routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["integrations.webhooks"]);
    // Tính năng tổ chức `facebook_page` (kèm `OrgFeatureGuard`) áp cho mọi route quản trị; callback công khai không có.
    let r =
        |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, manage).status_ok(ok).org_feature("facebook_page");
    vec![
        r(Method::GET, "/api/v1/facebook/status", 200),
        r(Method::POST, "/api/v1/facebook/connect-url", 200),
        r(Method::GET, "/api/v1/facebook/pages", 200),
        r(Method::PATCH, "/api/v1/facebook/pages/:id", 200).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/pages/:id/check", 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/facebook/pages/:id", 204).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/facebook/oauth/callback", Access::Public),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 7);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 7);
    }
}
