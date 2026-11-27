//! Router Facebook qua HTTP (K14 thật, quyền thật, Postgres thật): hộp thư, bình luận và luật, link chat, `go/:code` công khai,
//! gửi hàng loạt và `tick`. `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test router_pg -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9701..9799 và mọi dòng mang tiền tố `xrf`. Không gọi Graph.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_channel_guard::ChannelGuard;
use mod_facebook::config::Env;
use mod_facebook::routes::{FacebookState, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::router::{AccessDeps, FeatureFuture, OrgFeatureGate};
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "xrf-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/facebook";
const ADMIN: i32 = 9701; // integrations.webhooks
const NOBODY: i32 = 9702;

struct Gate(bool);

impl OrgFeatureGate for Gate {
    fn enabled<'a>(&'a self, _company: CompanyRef, _feature: &'a str) -> FeatureFuture<'a> {
        let on = self.0;
        Box::pin(async move { on })
    }
}

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(sql: &str) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut c)
        .await
        .expect(sql);
}

async fn app(feature_on: bool) -> Router {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let env: Env = Arc::new(|k| match k {
        "JWT_SECRET" => Some(JWT.to_owned()),
        _ => None,
    });
    let features: Arc<dyn OrgFeatureGate> = Arc::new(Gate(feature_on));
    let state = Arc::new(FacebookState::new(
        db.clone(),
        platform.clone(),
        env,
        ScopeService::new(db.clone(), cache),
        ChannelGuard::new(db, platform),
        features.clone(),
    ));
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: Some(features),
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 34);
    router.with_state(state)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@xrf.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
    headers: axum::http::HeaderMap,
}

async fn call(app: &Router, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (resp.status(), resp.headers().clone());
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
        headers,
    }
}

async fn teardown() {
    exec(
        "DELETE FROM facebook_broadcast_recipients WHERE broadcast_id IN (SELECT id FROM facebook_broadcasts WHERE page_id LIKE 'xrf%');
         DELETE FROM facebook_broadcasts WHERE page_id LIKE 'xrf%';
         DELETE FROM facebook_chat_links WHERE page_id LIKE 'xrf%';
         DELETE FROM facebook_comment_rules WHERE name LIKE 'xrf%';
         DELETE FROM facebook_pages WHERE page_id LIKE 'xrf%';
         DELETE FROM setting_options WHERE value LIKE 'xrf%';
         DELETE FROM user_roles WHERE user_id BETWEEN 9701 AND 9799;
         DELETE FROM role_permissions WHERE role_id BETWEEN 9701 AND 9799;
         DELETE FROM roles WHERE id BETWEEN 9701 AND 9799;
         DELETE FROM users WHERE id BETWEEN 9701 AND 9799",
    )
    .await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [(ADMIN, "Quản trị kênh"), (NOBODY, "Không quyền")] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@xrf.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES (9701, 'xrf-admin', false, now());
         INSERT INTO role_permissions (role_id, permission, scope) VALUES (9701, 'integrations.webhooks', NULL);
         INSERT INTO user_roles (user_id, role_id) VALUES (9701, 9701);
         INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'xrf_fb', 'Facebook', now());
         INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, contact_source_id, connected_by, updated_at)
         SELECT 'xrfp', 'Quán XRF', 'x', true, 'active', true, 9701, id, 9701, now() FROM setting_options WHERE value = 'xrf_fb'",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn quyen_va_tinh_nang_to_chuc() {
    setup().await;
    let a = app(true).await;
    for path in ["conversations", "comments", "comment-rules", "chat-links", "broadcasts"] {
        let u = format!("{B}/{path}");
        assert_eq!(call(&a, Method::GET, &u, None, None).await.status, 401, "{path}");
        assert_eq!(
            call(&a, Method::GET, &u, Some(NOBODY), None).await.status,
            403,
            "{path}"
        );
        assert_eq!(call(&a, Method::GET, &u, Some(ADMIN), None).await.status, 200, "{path}");
    }
    let off = app(false).await;
    assert_eq!(
        call(&off, Method::GET, &format!("{B}/broadcasts"), Some(ADMIN), None)
            .await
            .status,
        403
    );
    // Hội thoại không có ⇒ 404; id ngoài int4 bị ParseIntPipe chặn 400.
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/conversations/2147483647/messages"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(r.status.as_u16(), 404);
    let r = call(&a, Method::GET, &format!("{B}/broadcasts/abc"), Some(ADMIN), None).await;
    assert_eq!(r.status.as_u16(), 400);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn link_chat_va_go_cong_khai() {
    setup().await;
    let a = app(true).await;
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/chat-links"),
        Some(ADMIN),
        Some(json!({ "name": "xrf quầy", "page_id": "xrfp" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    let (id, code) = (
        r.body["id"].as_i64().unwrap(),
        r.body["code"].as_str().unwrap().to_owned(),
    );
    // Công khai, không đăng nhập: 302 sang Messenger, không lưu đệm, đếm lượt mở.
    let go = call(&a, Method::GET, &format!("{B}/go/{code}"), None, None).await;
    assert_eq!(go.status.as_u16(), 302);
    assert_eq!(go.headers.get("cache-control").unwrap(), "no-store");
    let loc = go.headers.get("location").unwrap().to_str().unwrap();
    assert!(loc.contains("xrfp") && loc.contains(&code), "{loc}");
    let list = call(&a, Method::GET, &format!("{B}/chat-links"), Some(ADMIN), None).await;
    assert_eq!(list.body["data"][0]["clicks"], 1);
    // Mã lạ ⇒ 404.
    let none = call(&a, Method::GET, &format!("{B}/go/khongco"), None, None).await;
    assert_eq!(none.status.as_u16(), 404);
    let r = call(
        &a,
        Method::PATCH,
        &format!("{B}/chat-links/{id}"),
        Some(ADMIN),
        Some(json!({ "name": "xrf quầy 2", "is_active": false })),
    )
    .await;
    assert_eq!((r.status.as_u16(), r.body["name"].as_str()), (200, Some("xrf quầy 2")));
    let r = call(&a, Method::DELETE, &format!("{B}/chat-links/{id}"), Some(ADMIN), None).await;
    assert_eq!(r.status.as_u16(), 204);
    let r = call(&a, Method::DELETE, &format!("{B}/chat-links/{id}"), Some(ADMIN), None).await;
    assert_eq!(r.status.as_u16(), 404);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn luat_binh_luan_va_gui_hang_loat() {
    setup().await;
    let a = app(true).await;
    // Luật bình luận: tạo 201 (mặc định chế độ thử), thử khớp, xoá 204.
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/comment-rules"),
        Some(ADMIN),
        Some(json!({ "name": "xrf giá", "keywords": ["giá"] })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    assert_eq!(r.body["mode"], "test");
    let rule = r.body["id"].as_i64().unwrap();
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/comment-rules/dry-run"),
        Some(ADMIN),
        Some(json!({ "message": "cho mình xin giá", "page_id": "xrfp" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/comment-rules/dry-run"),
        Some(ADMIN),
        Some(json!({})),
    )
    .await;
    assert_eq!(r.status.as_u16(), 400);
    let r = call(
        &a,
        Method::DELETE,
        &format!("{B}/comment-rules/{rule}"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(r.status.as_u16(), 204);

    // Gửi hàng loạt: nháp 201, xem trước, xoá 204; thiếu Page ⇒ 400.
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/broadcasts"),
        Some(ADMIN),
        Some(json!({ "name": "xrf báo lịch", "page_id": "xrfp", "text": "Chào {ten}" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    let id = r.body["id"].as_i64().unwrap();
    assert_eq!(r.body["status"], "draft");
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/broadcasts/preview"),
        Some(ADMIN),
        Some(json!({ "page_id": "xrfp" })),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["eligible"].as_i64()),
        (200, Some(0)),
        "{}",
        r.body
    );
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/broadcasts"),
        Some(ADMIN),
        Some(json!({ "name": "xrf thiếu" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 400);
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/broadcasts/{id}/recipients"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["data"].as_array().map(Vec::len)),
        (200, Some(0))
    );
    let r = call(&a, Method::DELETE, &format!("{B}/broadcasts/{id}"), Some(ADMIN), None).await;
    assert_eq!(r.status.as_u16(), 204);

    // tick: 200 `{ due, next_at }`; không có lượt nào ⇒ không tới giờ.
    let r = call(&a, Method::POST, &format!("{B}/tick"), Some(ADMIN), None).await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    assert_eq!(r.body["due"], false);
    assert!(r.body["next_at"].is_null(), "{}", r.body);
    teardown().await;
}
