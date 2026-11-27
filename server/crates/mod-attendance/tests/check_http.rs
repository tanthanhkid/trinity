//! M13b qua HTTP (router K14 thật, Postgres thật): chấm công vào/ra, kiểm IP văn phòng, `X-Real-IP` giả. `public` đã migrate:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-attendance --test check_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/văn phòng 9901..9999.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode};
use mod_attendance::check::CheckCtx;
use mod_attendance::routes::check_router;
use mod_hr::contracts::ContractStore;
use mod_hr::employees::Ctx;
use serde_json::Value;
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};
use trinity_storage::{LocalDiskDriver, LocalUploadsStore};

const JWT: &str = "m13b-jwt-secret-0123456789abcdef0123456789abcdef";
const PATH: &str = "/api/v1/management/attendance";
const EMP: i32 = 9901;
const OFFICE_IP: &str = "203.0.113.77";
const BOUNDARY: &str = "XBOUNDARYX";

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
    std::env::temp_dir().join("trinity-m13b-uploads")
}

async fn app() -> Router {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        platform,
        scopes: ScopeService::new(db, cache.clone()),
        perms: perms.clone(),
        cache,
        uploads: LocalUploadsStore::new(root()),
    });
    let store = LocalDiskDriver::new(root());
    store.init().await.unwrap();
    let mut env = BTreeMap::new();
    // Chỉ tin proxy ở 127.0.0.1, đọc IP khách từ X-Real-IP do proxy đặt.
    env.insert("TRUSTED_PROXY".to_owned(), "cidr:127.0.0.1/32;header=x-real-ip".to_owned());
    let ip = Arc::new(
        ClientIpResolver::from_env(
            &env,
            NetProbe::Fixed {
                route_table: None,
                in_container: false,
            },
        )
        .unwrap(),
    );
    let cc = Arc::new(CheckCtx {
        ctx,
        store: ContractStore::Local(store),
        ip,
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (r, table) = check_router(deps).into_parts();
    assert_eq!(table.len(), 2);
    r.with_state(cc)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m13b.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

fn multipart(device: &str, selfie: Option<(&str, &str)>) -> Vec<u8> {
    let mut b = String::new();
    b.push_str(&format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"device_id\"\r\n\r\n{device}\r\n"
    ));
    if let Some((mime, data)) = selfie {
        b.push_str(&format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"selfie\"; filename=\"s.jpg\"\r\nContent-Type: {mime}\r\n\r\n{data}\r\n"
        ));
    }
    b.push_str(&format!("--{BOUNDARY}--\r\n"));
    b.into_bytes()
}

/// Gọi từ `peer` (địa chỉ TCP), kèm header `X-Real-IP` nếu có.
async fn post(
    app: &Router,
    path: &str,
    peer: [u8; 4],
    real_ip: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let mut b = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("authorization", format!("Bearer {}", token(EMP)))
        .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"));
    if let Some(ip) = real_ip {
        b = b.header("x-real-ip", ip);
    }
    let mut req = b.body(Body::from(body)).unwrap();
    req.extensions_mut().insert(ConnectInfo(SocketAddr::from((peer, 5555))));
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 4 << 20).await.unwrap();
    (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
}

async fn setup() {
    exec("DELETE FROM attendance_records WHERE user_id BETWEEN 9901 AND 9999;
          DELETE FROM attendance_offices WHERE name LIKE 'm13b%';
          DELETE FROM employees WHERE user_id BETWEEN 9901 AND 9999;
          DELETE FROM users WHERE id BETWEEN 9901 AND 9999")
        .await;
    exec(&format!(
        "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES ({EMP}, 'u{EMP}@m13b.test', 'x', 'Nhân viên', 'active', now());
         INSERT INTO employees (user_id, position, status, joined_at) VALUES ({EMP}, 'Nhân viên', 'active', now());
         INSERT INTO attendance_offices (name, ips, is_active, is_demo, updated_at)
           VALUES ('m13b Hà Nội', ARRAY['{OFFICE_IP}'], true, false, now())"
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cham_cong_vao_ra_va_kiem_ip() {
    setup().await;
    let a = app().await;
    let (cin, cout) = (format!("{PATH}/check-in"), format!("{PATH}/check-out"));
    let jpeg = ("image/jpeg", "fakejpeg");

    // Proxy tin cậy (127.0.0.1) báo IP văn phòng: qua.
    let (s, b) = post(&a, &cin, [127, 0, 0, 1], Some(OFFICE_IP), multipart("dev-1", Some(jpeg))).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(b["already"], false);
    assert_eq!(b["office"], "m13b Hà Nội");
    assert_eq!(b["record"]["check_in_ip"], OFFICE_IP);
    assert_eq!(b["record"]["status"], "incomplete");

    // Idempotent: lần hai trả `already`, không cần ảnh.
    let (s, b) = post(&a, &cin, [127, 0, 0, 1], Some(OFFICE_IP), multipart("dev-1", None)).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(b["already"], true);

    // Check-out thiếu ảnh ⇒ 400; đủ ảnh ⇒ 201; lần hai ⇒ already.
    let (s, _) = post(&a, &cout, [127, 0, 0, 1], Some(OFFICE_IP), multipart("dev-1", None)).await;
    assert_eq!(s, 400);
    let (s, b) = post(&a, &cout, [127, 0, 0, 1], Some(OFFICE_IP), multipart("dev-1", Some(jpeg))).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(b["already"], false);
    assert!(b["record"]["check_out_at"].is_string());
    let (s, b) = post(&a, &cout, [127, 0, 0, 1], Some(OFFICE_IP), multipart("dev-1", None)).await;
    assert_eq!(s, 201);
    assert_eq!(b["already"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn x_real_ip_gia_khong_qua_kiem_ip() {
    setup().await;
    let a = app().await;
    let cin = format!("{PATH}/check-in");
    let jpeg = ("image/jpeg", "fakejpeg");

    // Peer KHÔNG phải proxy tin cậy gửi X-Real-IP = IP văn phòng ⇒ header bị bỏ qua, IP là IP peer ⇒ 400.
    let (s, b) = post(&a, &cin, [198, 51, 100, 9], Some(OFFICE_IP), multipart("dev-1", Some(jpeg))).await;
    assert_eq!(s, 400, "{b}");
    assert!(b["message"].as_str().unwrap_or("").contains("198.51.100.9"), "{b}");

    // Proxy tin cậy báo một IP lạ ⇒ 400.
    let (s, _) = post(&a, &cin, [127, 0, 0, 1], Some("8.8.8.8"), multipart("dev-1", Some(jpeg))).await;
    assert_eq!(s, 400);

    // Định dạng ảnh sai ⇒ 400; thiếu device_id ⇒ 400.
    let (s, _) = post(
        &a,
        &cin,
        [127, 0, 0, 1],
        Some(OFFICE_IP),
        multipart("dev-1", Some(("image/gif", "x"))),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = post(&a, &cin, [127, 0, 0, 1], Some(OFFICE_IP), multipart("", Some(jpeg))).await;
    assert_eq!(s, 400);
}
