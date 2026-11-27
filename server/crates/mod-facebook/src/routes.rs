//! Bảng route của M46 (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. Quyền `integrations.webhooks` cho mọi route trừ callback OAuth, công khai và xác thực bằng `state`
//! ký HMAC gắn với người bấm "Kết nối". Webhook, link mở chat, tin nhắn, bình luận… thuộc M47a trở đi.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 7 route của `FacebookController` (kết nối) và `callback`, 2 route webhook (M47a), 3 route hộp thư (M48).
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
        // Hộp thư Messenger (M48).
        r(Method::GET, "/api/v1/facebook/conversations", 200),
        r(Method::GET, "/api/v1/facebook/conversations/:id/messages", 200).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/conversations/:id/messages", 201).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/facebook/oauth/callback", Access::Public),
        // Webhook của Meta (M47a): công khai, xác thực bằng verify token (GET) và chữ ký `X-Hub-Signature-256` (POST).
        RouteSpec::new(Method::GET, "/api/v1/facebook/webhook", Access::Public).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/facebook/webhook", Access::Public).status_ok(200),
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
