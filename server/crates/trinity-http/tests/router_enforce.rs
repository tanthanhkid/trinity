//! K14: lớp thực thi `Access` của router. Ca không cần DB chạy mặc định; ca có Postgres (`--ignored`):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-http --test router_enforce -- --ignored --test-threads=1`
//! (schema `public` đã migrate bằng Prisma). Test tự tạo và xoá user/vai trò 9301..9399.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::Extension;
use axum::http::{Method, Request, StatusCode};
use axum::response::IntoResponse;
use serde_json::Value;
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::router::{
    Access, AccessDeps, ApiRouter, CurrentUser, FeatureFuture, GuardFuture, NamedGuard, OrgFeatureGate, RouteSpec,
};
use trinity_rbac::{PermissionService, RbacCache};

const JWT: &str = "k14-jwt-secret-0123456789abcdef0123456789abcdef";
const SVC: &str = "k14-service-secret";

struct Gate(bool);

impl OrgFeatureGate for Gate {
    fn enabled<'a>(&'a self, _c: CompanyRef, _f: &'a str) -> FeatureFuture<'a> {
        let on = self.0;
        Box::pin(async move { on })
    }
}

/// Guard giả: chặn khi thiếu header `x-k14-guard: ok`.
struct HeaderGuard;

impl NamedGuard for HeaderGuard {
    fn check<'a>(&'a self, req: &'a mut axum::extract::Request) -> GuardFuture<'a> {
        let ok = req.headers().get("x-k14-guard").is_some_and(|v| v == "ok");
        Box::pin(async move {
            if ok {
                Ok(())
            } else {
                Err(trinity_kernel::error::HttpError::forbidden("guard chặn"))
            }
        })
    }
}

fn deps(url: &str, gate_on: bool) -> Arc<AccessDeps> {
    let db = Db::connect_lazy(&DbConfig::new(url)).unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security.clone());
    Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[SVC])),
        permissions: PermissionService::new(db, cache),
        features: Some(Arc::new(Gate(gate_on))),
        guards: [("TestGuard", Arc::new(HeaderGuard) as Arc<dyn NamedGuard>)]
            .into_iter()
            .collect(),
    })
}

async fn app(url: &str, gate_on: bool) -> Router {
    let deps = deps(url, gate_on);
    async fn ok() -> &'static str {
        "ok"
    }
    async fn me(Extension(u): Extension<CurrentUser>) -> impl IntoResponse {
        format!("{}:{}", u.user.user_id, u.is_admin())
    }
    let (router, table) = ApiRouter::new(deps)
        .route(RouteSpec::new(Method::GET, "/api/v1/pub", Access::Public), ok)
        .route(RouteSpec::new(Method::POST, "/api/v1/internal", Access::Internal), ok)
        .route(RouteSpec::new(Method::GET, "/api/v1/auth", Access::AuthOnly), me)
        .route(
            RouteSpec::new(
                Method::GET,
                "/api/v1/can/{id}",
                Access::Can(&["contacts.view", "contacts.create"]),
            ),
            me,
        )
        .route(
            RouteSpec::new(Method::DELETE, "/api/v1/can/{id}", Access::Can(&["contacts.delete"])),
            ok,
        )
        .route(
            RouteSpec::new(
                Method::GET,
                "/api/v1/any",
                Access::CanAny(&["contacts.delete", "contacts.create"]),
            ),
            ok,
        )
        .route(
            RouteSpec::new(Method::GET, "/api/v1/zalo", Access::Can(&["contacts.view"])).org_feature("zalo_oa"),
            ok,
        )
        .route(
            RouteSpec::new(Method::GET, "/api/v1/guarded", Access::Public).guards(&["TestGuard"]),
            ok,
        )
        .route(
            RouteSpec::new(Method::POST, "/api/v1/created", Access::Public).status_ok(201),
            ok,
        )
        .route(
            RouteSpec::new(Method::GET, "/api/v1/int/{id}", Access::Public).param_pipes(&["param.id:ParseIntPipe"]),
            ok,
        )
        .route(
            RouteSpec::new(Method::GET, "/api/v1/int4/{id}", Access::Public).param_pipes(&["param.id:ParseInt4Pipe"]),
            ok,
        )
        .route(
            RouteSpec::new(Method::GET, "/api/v1/uuid/{id}", Access::Public).param_pipes(&["param.id:ParseUUIDPipe"]),
            ok,
        )
        .into_parts();
    assert_eq!(table.len(), 12);
    router
}

async fn call(app: &Router, method: Method, path: &str, headers: &[(&str, String)]) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        b = b.header(*k, v);
    }
    let resp = app.clone().oneshot(b.body(Body::empty()).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    )
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn bearer(user: i64) -> (&'static str, String) {
    (
        "authorization",
        format!(
            "Bearer {}",
            jwt::sign(&Claims::access(user, "k14@example.test", None, None, now()), JWT).unwrap()
        ),
    )
}

#[tokio::test]
async fn public_internal_va_401_khong_can_db() {
    let app = app("postgresql://u@localhost:1/x", true).await;
    assert_eq!(
        call(&app, Method::GET, "/api/v1/pub", &[]).await,
        (StatusCode::OK, Value::String("ok".into()))
    );
    let (s, b) = call(&app, Method::POST, "/api/v1/internal", &[]).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("Thiếu hoặc sai x-service-secret"))
    );
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/internal",
        &[("x-service-secret", "sai".into())],
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/internal",
        &[("x-service-secret", SVC.into())],
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    for path in ["/api/v1/auth", "/api/v1/can/5", "/api/v1/any", "/api/v1/zalo"] {
        let (s, b) = call(&app, Method::GET, path, &[]).await;
        assert_eq!(
            (s, b["message"].as_str()),
            (StatusCode::UNAUTHORIZED, Some("Token không được cung cấp")),
            "{path}"
        );
    }
    let (s, b) = call(
        &app,
        Method::GET,
        "/api/v1/auth",
        &[("authorization", "Bearer rac".into())],
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("Token không hợp lệ hoặc đã hết hạn"))
    );
}

#[tokio::test]
async fn phuong_thuc_va_duong_dan_la_404_nhu_nest_truoc_moi_guard() {
    let app = app("postgresql://u@localhost:1/x", true).await;
    // Đường dẫn có GET và DELETE (cần đăng nhập) nhưng PUT không khai: 404, không phải 401 của guard route cuối.
    for (m, p) in [
        (Method::PUT, "/api/v1/can/1"),
        (Method::PATCH, "/api/v1/internal"),
        (Method::PUT, "/api/v1/pub"),
        (Method::GET, "/api/v1/khong-co"),
    ] {
        let (s, b) = call(&app, m.clone(), p, &[]).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{m} {p}");
        assert_eq!(b["message"], format!("Cannot {m} {p}"));
        assert_eq!(b["error"], "Not Found");
    }
}

#[tokio::test]
async fn guard_rieng_pipe_tham_so_va_ma_thanh_cong_duoc_thuc_thi() {
    let app = app("postgresql://u@localhost:1/x", true).await;
    let (s, b) = call(&app, Method::GET, "/api/v1/guarded", &[]).await;
    assert_eq!((s, b["message"].as_str()), (StatusCode::FORBIDDEN, Some("guard chặn")));
    assert_eq!(
        call(&app, Method::GET, "/api/v1/guarded", &[("x-k14-guard", "ok".into())])
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, Method::POST, "/api/v1/created", &[]).await.0,
        StatusCode::CREATED
    );
    let msg = |b: &Value| b["message"].as_str().map(str::to_owned);
    let (s, b) = call(&app, Method::GET, "/api/v1/int/abc", &[]).await;
    assert_eq!(
        (s, msg(&b).as_deref()),
        (
            StatusCode::BAD_REQUEST,
            Some("Validation failed (numeric string is expected)")
        )
    );
    assert_eq!(call(&app, Method::GET, "/api/v1/int/42", &[]).await.0, StatusCode::OK);
    let (s, b) = call(&app, Method::GET, "/api/v1/int4/99999999999", &[]).await;
    assert_eq!(
        (s, msg(&b).as_deref()),
        (StatusCode::BAD_REQUEST, Some("id vượt giới hạn số nguyên 32-bit"))
    );
    assert_eq!(
        call(&app, Method::GET, "/api/v1/int4/0", &[]).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(call(&app, Method::GET, "/api/v1/int4/7", &[]).await.0, StatusCode::OK);
    assert_eq!(
        call(&app, Method::GET, "/api/v1/uuid/xyz", &[]).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            Method::GET,
            "/api/v1/uuid/123e4567-e89b-12d3-a456-426614174000",
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
}

fn route_panics(f: impl FnOnce() + std::panic::UnwindSafe) -> String {
    let e = std::panic::catch_unwind(f).expect_err("phải dừng lúc khai báo");
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_default()
}

#[tokio::test]
async fn khai_bao_chua_co_cai_dat_thi_dung_luc_khoi_dong() {
    async fn ok() {}
    let d = || deps("postgresql://u@localhost:1/x", true);
    let m = route_panics(|| {
        let _ = ApiRouter::<()>::new(d()).route(
            RouteSpec::new(Method::GET, "/a", Access::Public).guards(&["ApiKeyGuard"]),
            ok,
        );
    });
    assert!(m.contains("ApiKeyGuard"), "{m}");
    let m = route_panics(|| {
        let _ = ApiRouter::<()>::new(d()).route(
            RouteSpec::new(Method::GET, "/a/{id}", Access::Public).param_pipes(&["param.id:PipeLa"]),
            ok,
        );
    });
    assert!(m.contains("PipeLa"), "{m}");
    for access in [Access::Public, Access::Internal] {
        let m = route_panics(|| {
            let _ =
                ApiRouter::<()>::new(d()).route(RouteSpec::new(Method::GET, "/a", access).org_feature("zalo_oa"), ok);
        });
        assert!(m.contains("org_feature"), "{m}");
    }
    let m = route_panics(|| {
        let _ = ApiRouter::<()>::new(d())
            .route(RouteSpec::new(Method::GET, "/a", Access::Public), ok)
            .route(RouteSpec::new(Method::GET, "/a", Access::Public), ok);
    });
    assert!(m.contains("hai lần"), "{m}");
}

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(sql: &str) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut c)
        .await
        .unwrap();
}

async fn teardown() {
    exec("DELETE FROM user_roles WHERE user_id BETWEEN 9301 AND 9399").await;
    exec("DELETE FROM role_permissions WHERE role_id BETWEEN 9301 AND 9399").await;
    exec("DELETE FROM roles WHERE id BETWEEN 9301 AND 9399").await;
    exec("DELETE FROM users WHERE id BETWEEN 9301 AND 9399").await;
}

async fn setup() {
    teardown().await;
    for id in 9301..=9305 {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({id}, 'k14-{id}@example.test', 'x', 'K14 {id}', now())")).await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9301, 'k14-view', false, now()), (9302, 'k14-create', false, now()), (9303, 'k14-admin', true, now())").await;
    exec("INSERT INTO role_permissions (role_id, permission, scope) VALUES (9301, 'contacts.view', 'own'), (9302, 'contacts.view', 'own'), (9302, 'contacts.create', NULL)").await;
    // 9301 chỉ xem; 9302 xem + tạo; 9303 admin; 9304 không vai trò.
    exec("INSERT INTO user_roles (user_id, role_id) VALUES (9301, 9301), (9302, 9302), (9303, 9303)").await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn can_all_any_auth_admin_va_cong_tinh_nang() {
    setup().await;
    let on = app(&url(), true).await;
    let forbidden = Some("Bạn không có quyền thực hiện thao tác này");
    // AuthOnly: ai đăng nhập cũng qua, handler thấy CurrentUser.
    assert_eq!(
        call(&on, Method::GET, "/api/v1/auth", &[bearer(9304)]).await,
        (StatusCode::OK, Value::String("9304:false".into()))
    );
    // Can (mode all): cần đủ cả hai quyền.
    let (s, b) = call(&on, Method::GET, "/api/v1/can/1", &[bearer(9301)]).await;
    assert_eq!((s, b["message"].as_str()), (StatusCode::FORBIDDEN, forbidden));
    assert_eq!(
        call(&on, Method::GET, "/api/v1/can/1", &[bearer(9302)]).await.0,
        StatusCode::OK
    );
    // Admin qua hết.
    assert_eq!(
        call(&on, Method::GET, "/api/v1/can/1", &[bearer(9303)]).await,
        (StatusCode::OK, Value::String("9303:true".into()))
    );
    assert_eq!(
        call(&on, Method::DELETE, "/api/v1/can/1", &[bearer(9303)]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&on, Method::DELETE, "/api/v1/can/1", &[bearer(9302)]).await.0,
        StatusCode::FORBIDDEN
    );
    // CanAny: một trong hai là đủ.
    assert_eq!(
        call(&on, Method::GET, "/api/v1/any", &[bearer(9302)]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&on, Method::GET, "/api/v1/any", &[bearer(9301)]).await.0,
        StatusCode::FORBIDDEN
    );
    // Không vai trò: mọi route cần quyền bị chặn, người không tồn tại thì 401.
    assert_eq!(
        call(&on, Method::GET, "/api/v1/can/1", &[bearer(9304)]).await.0,
        StatusCode::FORBIDDEN
    );
    let (s, b) = call(&on, Method::GET, "/api/v1/auth", &[bearer(9399)]).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("Tài khoản không tồn tại"))
    );
    // Cổng tính năng chạy SAU phân quyền: thiếu quyền vẫn là 403 quyền; tắt tính năng là 403 câu tính năng.
    assert_eq!(
        call(&on, Method::GET, "/api/v1/zalo", &[bearer(9301)]).await.0,
        StatusCode::OK
    );
    let off = app(&url(), false).await;
    let (s, b) = call(&off, Method::GET, "/api/v1/zalo", &[bearer(9301)]).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (
            StatusCode::FORBIDDEN,
            Some("Tính năng \"Zalo OA\" chưa bật hoặc không có trong gói hiện tại.")
        )
    );
    let (_, b) = call(&off, Method::GET, "/api/v1/zalo", &[bearer(9304)]).await;
    assert_eq!(b["message"].as_str(), forbidden);
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn loi_db_khi_nap_quyen_la_500_khong_phai_401() {
    setup().await;
    let on = app(&url(), true).await;
    // Hỏng bảng vai trò sau khi xác thực qua được: nạp quyền lỗi ⇒ 500 (như Node, nằm ngoài try/catch của JwtAuthGuard).
    exec("ALTER TABLE user_roles RENAME TO user_roles_k14_off").await;
    let (s, b) = call(&on, Method::GET, "/api/v1/can/1", &[bearer(9302)]).await;
    exec("ALTER TABLE user_roles_k14_off RENAME TO user_roles").await;
    assert_eq!(
        (s, b["statusCode"].as_u64()),
        (StatusCode::INTERNAL_SERVER_ERROR, Some(500))
    );
    assert_eq!(b["message"], "Internal Server Error");
    teardown().await;
}
