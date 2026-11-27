//! Bảng route của M53a (K14): mỗi route khai `Access` bắt buộc; so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`. `social.post` cho xem, `social.manage` cho liên kết/bật/gỡ kênh; callback OAuth công khai và xác thực
//! bằng `state` ký HMAC. Media thuộc M53b; nháp, hàng đợi, mẫu chữ thuộc M55a; bài thuộc M54a, bài lặp và CSV thuộc M55b (8 route kế tiếp), thống kê và `tick` (M54b).

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
        // Media (M53b). `POST /social/media/upload-token` chỉ còn kiểm trước khi tải (luôn 400/413, #612); phần Vercel Blob đã gỡ (G11).
        r(Method::POST, "/api/v1/social/media/upload-token", post, 200),
        r(Method::GET, "/api/v1/social/media", post, 200),
        r(Method::POST, "/api/v1/social/media", post, 201),
        r(Method::GET, "/api/v1/social/media/:id/file", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/media/:id/hide", post, 200).param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/social/media-link/:token/:name", Access::Public).status_ok(200),
        // Bài đăng (M54a).
        r(Method::GET, "/api/v1/social/posts", post, 200),
        r(Method::POST, "/api/v1/social/posts", post, 201),
        r(Method::POST, "/api/v1/social/posts/preview", post, 200),
        r(Method::GET, "/api/v1/social/posts/:id", post, 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/social/posts/:id", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/posts/sync", post, 200),
        r(Method::POST, "/api/v1/social/posts/:id/metrics", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/posts/:id/reschedule", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/posts/:id/cancel", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/targets/:id/retry", post, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/social/targets/:id/remote", manage, 200).param_pipes(ID),
        // Nháp, khung giờ hàng đợi, mẫu chữ (M55a). `POST /social/drafts/:id/publish` đi qua `draft_publish` (tạo bài M54a).
        r(Method::GET, "/api/v1/social/drafts", post, 200),
        r(Method::POST, "/api/v1/social/drafts", post, 201),
        r(Method::GET, "/api/v1/social/drafts/:id", post, 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/social/drafts/:id", post, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/social/drafts/:id", post, 204).param_pipes(ID),
        r(Method::POST, "/api/v1/social/drafts/:id/publish", post, 200).param_pipes(ID),
        r(Method::GET, "/api/v1/social/snippets", post, 200),
        r(Method::POST, "/api/v1/social/snippets", post, 201),
        r(Method::PATCH, "/api/v1/social/snippets/:id", post, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/social/snippets/:id", post, 204).param_pipes(ID),
        r(Method::GET, "/api/v1/social/queue/slots", post, 200),
        r(Method::PUT, "/api/v1/social/queue/slots", post, 200),
        r(Method::GET, "/api/v1/social/queue/next", post, 200),
        // Thống kê và đăng định kỳ (M54b).
        r(Method::GET, "/api/v1/social/stats", post, 200),
        r(Method::POST, "/api/v1/social/tick", post, 200),
        // Bài lặp và nhập CSV (M55b).
        r(Method::POST, "/api/v1/social/posts/import/plan", post, 200),
        r(Method::POST, "/api/v1/social/posts/import", post, 200),
        r(Method::GET, "/api/v1/social/recurrences", post, 200),
        r(Method::POST, "/api/v1/social/recurrences", post, 201),
        r(Method::PATCH, "/api/v1/social/recurrences/:id", post, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/social/recurrences/:id", post, 204).param_pipes(ID),
        r(Method::POST, "/api/v1/social/recurrences/:id/pause", post, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/social/recurrences/:id/resume", post, 200).param_pipes(ID),
    ]
}

/// 5 route tải video theo phần (X15a, [`crate::chunked`]). Route CHỈ CÓ Ở RUST (không có trong `routes.json`) nên tách khỏi
/// [`routes`]; khai ở `RUST_ONLY_AUTHED_ROUTES` của `trinity-http` (cần `social.post`) và gộp vào bảng của binary.
pub fn upload_routes() -> Vec<RouteSpec> {
    let post = Access::Can(&["social.post"]);
    let r =
        |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, post).status_ok(ok).org_feature("social_posting");
    vec![
        r(Method::POST, "/api/v1/social/media/uploads", 201),
        r(Method::GET, "/api/v1/social/media/uploads/:id", 200),
        r(Method::PUT, "/api/v1/social/media/uploads/:id/parts/:index", 200).param_pipes(&["param.index:ParseIntPipe"]),
        r(Method::POST, "/api/v1/social/media/uploads/:id/complete", 201),
        r(Method::DELETE, "/api/v1/social/media/uploads/:id", 204),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 46);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 46);
    }

    #[test]
    fn route_tai_theo_phan_khong_trung_hop_dong() {
        let t = upload_routes();
        assert_eq!(t.len(), 5);
        // Chưa có trong `routes.json` (chỉ có ở Rust); không được trùng route đã khai ở `routes()`.
        let declared: Vec<_> = routes().iter().map(|r| (r.method.clone(), r.path)).collect();
        assert!(t.iter().all(|r| !declared.contains(&(r.method.clone(), r.path))));
    }

    #[test]
    fn bang_gop_voi_route_tai_theo_phan_khop_hop_dong() {
        let mut table = routes();
        table.extend(upload_routes());
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 46);
    }
}
