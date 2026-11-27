//! Router social qua HTTP (K14 thật, quyền thật, kho tệp đĩa thật, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-social --test router_pg -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9801..9899 và mọi dòng mang tiền tố `x53`.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_channel_guard::ChannelGuard;
use mod_facebook::config::Env;
use mod_social::jobs::{JobDeps, Runner};
use mod_social::media::MediaStore;
use mod_social::router::{SocialState, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::router::{AccessDeps, FeatureFuture, OrgFeatureGate};
use trinity_rbac::{PermissionService, RbacCache};
use trinity_storage::LocalDiskDriver;

const JWT: &str = "x53-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/social";
const POSTER: i32 = 9801; // social.post
const MANAGER: i32 = 9802; // social.post + social.manage
const NOBODY: i32 = 9803;

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

fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("trinity-x53-store-{}", std::process::id()))
}

async fn app(feature_on: bool) -> Router {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache);
    let local = LocalDiskDriver::new(root());
    local.init().await.unwrap();
    let env: Env = Arc::new(|k| match k {
        "JWT_SECRET" => Some(JWT.to_owned()),
        _ => None,
    });
    let guard = ChannelGuard::new(db.clone(), platform.clone());
    let graph_env = env.clone();
    let graph_guard = guard.clone();
    // Không đăng nền thật trong test: `owns_publish = false` ⇒ `kick`/`kick_if_due` không làm gì.
    let runner = Runner::new(JobDeps {
        db: db.clone(),
        platform: platform.clone(),
        env: env.clone(),
        store: Arc::new(MediaStore::Local(LocalDiskDriver::new(root()))),
        guard: guard.clone(),
        graph_for: mod_facebook::routes::graph_factory(graph_env.clone(), graph_guard.clone()),
        before_publish: None,
        owns_publish: Some(Arc::new(|| false)),
    });
    let state = Arc::new(SocialState {
        db: db.clone(),
        platform,
        env,
        graph_for: mod_facebook::routes::graph_factory(graph_env, graph_guard),
        guard,
        store: MediaStore::Local(local),
        runner,
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: Some(Arc::new(Gate(feature_on))),
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 50);
    router.with_state(state)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@x53.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
    headers: axum::http::HeaderMap,
}

async fn send(app: &Router, method: Method, path: &str, user: Option<i32>, ct: Option<&str>, body: Vec<u8>) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    if let Some(ct) = ct {
        b = b.header("content-type", ct);
    }
    let resp = app.clone().oneshot(b.body(Body::from(body)).unwrap()).await.unwrap();
    let (status, headers) = (resp.status(), resp.headers().clone());
    let raw = axum::body::to_bytes(resp.into_body(), 64 << 20).await.unwrap().to_vec();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
        headers,
    }
}

async fn call(app: &Router, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
    match body {
        Some(v) => {
            send(
                app,
                method,
                path,
                user,
                Some("application/json"),
                v.to_string().into_bytes(),
            )
            .await
        }
        None => send(app, method, path, user, None, Vec::new()).await,
    }
}

const BOUNDARY: &str = "----x53boundary";

fn multipart(field: &str, file: &str, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{file}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(data);
    out.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    out
}

async fn teardown() {
    exec(
        "DELETE FROM social_media_assets WHERE name LIKE 'x53%';
          DELETE FROM social_drafts WHERE title LIKE 'x53%';
          DELETE FROM social_snippets WHERE name LIKE 'x53%';
          DELETE FROM user_roles WHERE user_id BETWEEN 9801 AND 9899;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9801 AND 9899;
          DELETE FROM roles WHERE id BETWEEN 9801 AND 9899;
          DELETE FROM users WHERE id BETWEEN 9801 AND 9899",
    )
    .await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [(POSTER, "Soạn bài"), (MANAGER, "Quản lý kênh"), (NOBODY, "Không quyền")] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@x53.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9801, 'x53-poster', false, now()), (9802, 'x53-manager', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9801, 'social.post', NULL), (9802, 'social.post', NULL), (9802, 'social.manage', NULL);
          INSERT INTO user_roles (user_id, role_id) VALUES (9801, 9801), (9802, 9802)")
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn quyen_va_tinh_nang_to_chuc() {
    setup().await;
    let a = app(true).await;
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/accounts"), None, None).await.status,
        401
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/accounts"), Some(NOBODY), None)
            .await
            .status,
        403
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/accounts"), Some(POSTER), None)
            .await
            .status,
        200
    );
    // `social.manage` mới được liên kết/gỡ kênh.
    let url = format!("{B}/accounts/connect-url");
    let body = Some(json!({ "network": "facebook" }));
    assert_eq!(
        call(&a, Method::POST, &url, Some(POSTER), body.clone()).await.status,
        403
    );
    let r = call(
        &a,
        Method::DELETE,
        &format!("{B}/targets/0/remote"),
        Some(MANAGER),
        None,
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["message"].as_str()),
        (400, Some("id không hợp lệ"))
    );
    // Tính năng tổ chức tắt ⇒ 403 cho cả người có quyền.
    let off = app(false).await;
    assert_eq!(
        call(&off, Method::GET, &format!("{B}/accounts"), Some(POSTER), None)
            .await
            .status,
        403
    );
    // Callback công khai không cần đăng nhập, luôn chuyển hướng về trang kênh.
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/oauth/callback/facebook?error=access_denied"),
        None,
        None,
    )
    .await;
    assert_eq!(r.status.as_u16(), 302);
    let loc = r.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        loc.contains("/social?tab=channels&social=cancelled&network=facebook"),
        "{loc}"
    );
    // Link media sai chữ ký ⇒ 404.
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/media-link/khong-hop-le/a.png"),
        None,
        None,
    )
    .await;
    assert_eq!(r.status.as_u16(), 404);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn nhap_mau_chu_va_hang_doi() {
    setup().await;
    let a = app(true).await;
    // Mẫu chữ: tạo 201, danh sách `{ data }`, sửa, xoá 204.
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/snippets"),
        Some(POSTER),
        Some(json!({ "kind": "hashtags", "name": "x53 bộ một", "content": "#mot #hai" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    let id = r.body["data"]["id"].as_i64().unwrap();
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/snippets?kind=hashtags"),
        Some(POSTER),
        None,
    )
    .await;
    assert_eq!(r.status.as_u16(), 200);
    assert!(
        r.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"].as_i64() == Some(id))
    );
    // Trường lạ ⇒ 400 (whitelist).
    let r = call(
        &a,
        Method::PATCH,
        &format!("{B}/snippets/{id}"),
        Some(POSTER),
        Some(json!({ "la": 1 })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 400);
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/snippets/{id}"), Some(POSTER), None)
            .await
            .status,
        204
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/snippets/{id}"), Some(POSTER), None)
            .await
            .status,
        404
    );
    // Nháp được thiếu mọi trường.
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/drafts"),
        Some(POSTER),
        Some(json!({ "title": "x53 nháp" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    let did = r.body["data"]["id"].as_i64().unwrap();
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/drafts/{did}"), Some(POSTER), None)
            .await
            .status,
        200
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/drafts/{did}"), Some(POSTER), None)
            .await
            .status,
        204
    );
    // Hàng đợi: đặt khung rồi đọc lại; `count` rác ⇒ 1 khung.
    let r = call(
        &a,
        Method::PUT,
        &format!("{B}/queue/slots"),
        Some(POSTER),
        Some(json!({ "slots": [{ "weekday": 1, "minute": 540 }] })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/queue/next?count=abc"),
        Some(POSTER),
        None,
    )
    .await;
    assert_eq!(r.body["data"].as_array().map(Vec::len), Some(1));
    call(
        &a,
        Method::PUT,
        &format!("{B}/queue/slots"),
        Some(POSTER),
        Some(json!({ "slots": [] })),
    )
    .await;
    // Bài lặp: danh sách rỗng được `{ data: [] }`.
    let r = call(&a, Method::GET, &format!("{B}/recurrences"), Some(POSTER), None).await;
    assert_eq!((r.status.as_u16(), r.body["data"].is_array()), (200, true));
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tai_media_va_tai_theo_phan() {
    setup().await;
    let a = app(true).await;
    let ct = format!("multipart/form-data; boundary={BOUNDARY}");
    // Thiếu tệp ⇒ 400; đuôi lạ ⇒ 400; ảnh hợp lệ ⇒ 201 + thư viện + xem trước + ẩn.
    let r = send(
        &a,
        Method::POST,
        &format!("{B}/media"),
        Some(POSTER),
        Some(&ct),
        format!("--{BOUNDARY}--\r\n").into_bytes(),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["message"].as_str()),
        (400, Some("Thiếu tệp"))
    );
    let r = send(
        &a,
        Method::POST,
        &format!("{B}/media"),
        Some(POSTER),
        Some(&ct),
        multipart("file", "x53.pdf", b"x"),
    )
    .await;
    assert_eq!(r.status.as_u16(), 400);
    let r = send(
        &a,
        Method::POST,
        &format!("{B}/media"),
        Some(POSTER),
        Some(&ct),
        multipart("khac", "x53.png", b"x"),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["message"].as_str()),
        (400, Some("Unexpected field"))
    );
    let png = vec![7_u8; 1500];
    let r = send(
        &a,
        Method::POST,
        &format!("{B}/media"),
        Some(POSTER),
        Some(&ct),
        multipart("file", "x53.png", &png),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    assert_eq!(
        (r.body["type"].as_str(), r.body["size"].as_u64()),
        (Some("image"), Some(1500))
    );
    let r = call(&a, Method::GET, &format!("{B}/media?q=x53"), Some(POSTER), None).await;
    let id = r.body["data"][0]["id"].as_i64().unwrap();
    let r = call(&a, Method::GET, &format!("{B}/media/{id}/file"), Some(POSTER), None).await;
    assert_eq!(r.status.as_u16(), 200);
    assert_eq!(r.headers.get("content-type").unwrap(), "image/png");
    assert_eq!(r.headers.get("content-length").unwrap(), "1500");
    let r = call(&a, Method::POST, &format!("{B}/media/{id}/hide"), Some(POSTER), None).await;
    assert_eq!((r.status.as_u16(), r.body["hidden"].as_bool()), (200, Some(true)));
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/media/{id}/file"), Some(POSTER), None)
            .await
            .status,
        404
    );
    // Tải theo phần: khai báo ảnh bị từ chối, video thì có phiên; phiên lạ ⇒ 404 hoặc 4xx, không 500.
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/media/uploads"),
        Some(POSTER),
        Some(json!({ "file_name": "x53.png", "size": 10 })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 400, "{}", r.body);
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/media/uploads"),
        Some(POSTER),
        Some(json!({ "file_name": "x53.mp4", "size": 5 })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    let uid = r.body["upload_id"].as_str().unwrap().to_owned();
    let r = send(
        &a,
        Method::PUT,
        &format!("{B}/media/uploads/{uid}/parts/0"),
        Some(POSTER),
        Some("application/octet-stream"),
        vec![1_u8; 5],
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["size"].as_u64()),
        (200, Some(5)),
        "{}",
        r.body
    );
    let r = call(&a, Method::GET, &format!("{B}/media/uploads/{uid}"), Some(POSTER), None).await;
    assert_eq!(r.body["received"], json!([0]));
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/media/uploads/{uid}/complete"),
        Some(POSTER),
        None,
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body["type"].as_str()),
        (201, Some("video")),
        "{}",
        r.body
    );
    let r = call(
        &a,
        Method::DELETE,
        &format!("{B}/media/uploads/khong-co"),
        Some(POSTER),
        None,
    )
    .await;
    assert!(r.status == 204 || r.status == 404, "{}", r.status);
    let _ = std::fs::remove_dir_all(root());
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn thong_ke_tick_so_lieu_va_dang_nhap() {
    setup().await;
    let a = app(true).await;
    // Quyền: `social.post` cho cả năm route mới.
    for (m, p) in [
        (Method::GET, "/stats"),
        (Method::POST, "/tick"),
        (Method::POST, "/posts/sync"),
        (Method::POST, "/posts/1/metrics"),
        (Method::POST, "/drafts/1/publish"),
    ] {
        let path = format!("{B}{p}");
        assert_eq!(call(&a, m.clone(), &path, None, None).await.status, 401, "{p}");
        assert_eq!(call(&a, m, &path, Some(NOBODY), None).await.status, 403, "{p}");
    }
    // Thống kê: khoảng không có bài ⇒ số 0, `views` null; khoảng ngược hoặc quá 1 năm ⇒ 400.
    let r = call(
        &a,
        Method::GET,
        &format!("{B}/stats?from=2000-01-01&to=2000-02-01&top=3"),
        Some(POSTER),
        None,
    )
    .await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    assert_eq!(r.body["totals"]["published"], 0);
    assert_eq!(r.body["totals"]["views"], Value::Null);
    assert_eq!(r.body["top"], json!([]));
    assert_eq!(r.body["by_account"], json!([]));
    assert_eq!(r.body["updated_at"], Value::Null);
    assert_eq!(r.body["from"], "2000-01-01T00:00:00.000Z");
    for q in ["from=2001-01-01&to=2000-01-01", "from=2000-01-01&to=2002-01-01"] {
        let r = call(&a, Method::GET, &format!("{B}/stats?{q}"), Some(POSTER), None).await;
        assert_eq!(r.status.as_u16(), 400, "{q}");
    }
    // Mặc định 30 ngày gần nhất vẫn trả 200.
    let r = call(&a, Method::GET, &format!("{B}/stats"), Some(POSTER), None).await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    // `tick`: không đăng nền trong test nên `due` luôn false; `next_at` có khoá (null hoặc giờ ISO).
    let r = call(&a, Method::POST, &format!("{B}/tick"), Some(POSTER), None).await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    assert_eq!(r.body["due"], false);
    assert!(r.body.get("next_at").is_some());
    // `posts/sync` trả hai số đếm.
    let r = call(&a, Method::POST, &format!("{B}/posts/sync"), Some(POSTER), None).await;
    assert_eq!(r.status.as_u16(), 200, "{}", r.body);
    assert!(r.body["checked"].is_u64() && r.body["removed"].is_u64());
    // Lấy số bài không có ⇒ 404.
    let r = call(&a, Method::POST, &format!("{B}/posts/2147483000/metrics"), Some(POSTER), None).await;
    assert_eq!(r.status.as_u16(), 404);
    // Đăng nháp: không có nháp ⇒ 404; body sai ⇒ 400; nháp đã đổi so với bản xem ⇒ 409.
    let none = format!("{B}/drafts/2147483000/publish");
    assert_eq!(call(&a, Method::POST, &none, Some(POSTER), None).await.status.as_u16(), 404);
    let r = call(&a, Method::POST, &none, Some(POSTER), Some(json!({ "la": 1, "use_queue": "x" }))).await;
    assert_eq!(r.status.as_u16(), 400);
    let r = call(
        &a,
        Method::POST,
        &format!("{B}/drafts"),
        Some(POSTER),
        Some(json!({ "title": "x53 đăng nháp", "content": "Nội dung thử" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 201, "{}", r.body);
    let did = r.body["data"]["id"].as_i64().unwrap();
    let publish = format!("{B}/drafts/{did}/publish");
    let r = call(
        &a,
        Method::POST,
        &publish,
        Some(POSTER),
        Some(json!({ "expected_updated_at": "2000-01-01T00:00:00Z" })),
    )
    .await;
    assert_eq!(r.status.as_u16(), 409, "{}", r.body);
    // Nháp chưa có kênh ⇒ lỗi 4xx của bước kiểm bài, và chỗ giữ được trả lại: nháp vẫn mở, sửa/đăng lại được.
    let r = call(&a, Method::POST, &publish, Some(POSTER), Some(json!({}))).await;
    assert!(r.status.is_client_error(), "{} {}", r.status, r.body);
    assert_ne!(r.status.as_u16(), 409, "{}", r.body);
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/drafts/{did}"), Some(POSTER), None)
            .await
            .status
            .as_u16(),
        200
    );
    teardown().await;
}
