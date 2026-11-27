//! Bảng route của M53a (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. `social.post` cho xem, `social.manage` cho liên kết/bật/gỡ kênh; callback OAuth công khai và xác thực
//! bằng `state` ký HMAC. Media thuộc M53b; bài, nháp, hàng đợi, mẫu chữ thuộc M54a trở đi.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 5 route của `SocialController` (tài khoản) và `SocialPublicController.callback`.
pub fn routes() -> Vec<RouteSpec> {
    let post = Access::Can(&["social.post"]);
    let manage = Access::Can(&["social.manage"]);
    // Tính năng tổ chức `social_posting` (kèm `OrgFeatureGuard`) áp cho mọi route quản trị; callback công khai không có.
    let r = |m: Method, p: &'static str, a: Access, ok: u16| {
        RouteSpec::new(m, p, a).status_ok(ok).org_feature("social_posting")
    };
    vec![
        r(Method::GET, "/api/v1/social/networks", post, 200),
        r(Method::GET, "/api/v1/social/accounts", post, 200),
        r(Method::POST, "/api/v1/social/accounts/connect-url", manage, 200),
        r(Method::POST, "/api/v1/social/accounts/:id/enable", manage, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/social/accounts/:id", manage, 204).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/social/oauth/callback/:network", Access::Public),
        // Media (M53b). `POST /social/media/upload-token` đã gỡ cùng Vercel Blob (G11).
        r(Method::GET, "/api/v1/social/media", post, 200),
        r(Method::POST, "/api/v1/social/media", post, 201),
        r(Method::GET, "/api/v1/social/media/:id/file", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/media/:id/hide", post, 200).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/social/media-link/:token/:name", Access::Public),
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
