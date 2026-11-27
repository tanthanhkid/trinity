//! M14a phần 4 qua HTTP (router K14 thật, quyền thật, Postgres thật): sổ chấm công (danh sách, chi tiết, sửa, xoá, hôm nay, vắng,
//! ma trận công, ảnh selfie). `public` đã migrate:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-attendance --test records_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9831..9839 (và mọi dòng liên quan).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_attendance::check::CheckCtx;
use mod_attendance::routes::{proof_router, router};
use mod_hr::contracts::ContractStore;
use mod_hr::employees::Ctx;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_storage::{LocalDiskDriver, LocalUploadsStore};

const JWT: &str = "m14a4-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/management/attendance";
const MGR: i32 = 9831; // attendance.view + attendance.manage, phạm vi all
const EMP: i32 = 9832; // nhân viên, không quyền nào
const OTHER: i32 = 9833; // nhân viên khác, không quyền nào
const STORE: &str = "trinity-m14a4-uploads";

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

async fn scalar<T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin>(
    sql: &str,
) -> T {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut c)
        .await
        .expect(sql)
}

fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(STORE)
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
    let ip = Arc::new(
        ClientIpResolver::from_env(
            &BTreeMap::new(),
            NetProbe::Fixed {
                route_table: None,
                in_container: false,
            },
        )
        .unwrap(),
    );
    let cc = Arc::new(CheckCtx {
        ctx: ctx.clone(),
        store: ContractStore::Local(store),
        ip,
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (r, _table) = router(deps.clone()).into_parts();
    let (p, table) = proof_router(deps).into_parts();
    assert_eq!(table.len(), 1);
    r.with_state(ctx).merge(p.with_state(cc))
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m14a4.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
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
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 4 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
    }
}

async fn teardown() {
    exec(
        "DELETE FROM attendance_records WHERE user_id BETWEEN 9831 AND 9839;
          DELETE FROM employees WHERE user_id BETWEEN 9831 AND 9839;
          DELETE FROM user_roles WHERE user_id BETWEEN 9831 AND 9839;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9831 AND 9839;
          DELETE FROM roles WHERE id BETWEEN 9831 AND 9839;
          DELETE FROM users WHERE id BETWEEN 9831 AND 9839",
    )
    .await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [(MGR, "Quản lý"), (EMP, "Nhân viên"), (OTHER, "Nhân viên khác")] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@m14a4.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec("INSERT INTO employees (user_id, position, status, joined_at) VALUES (9832, 'Nhân viên', 'active', now()), (9833, 'Nhân viên', 'active', now());
          INSERT INTO roles (id, name, is_system, updated_at) VALUES (9831, 'm14a4-mgr', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9831, 'attendance.view', 'all'), (9831, 'attendance.manage', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9831, 9831)")
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn so_cham_cong_danh_sach_chi_tiet_sua_xoa() {
    setup().await;
    let a = app().await;
    exec("INSERT INTO attendance_records (user_id, work_date, check_in_at, check_out_at, status, updated_at)
          VALUES (9832, '2026-06-17', '2026-06-17 01:30:00+00', '2026-06-17 10:30:00+00', 'present', now())")
        .await;
    let id: i32 = scalar("SELECT id FROM attendance_records WHERE user_id = 9832 AND work_date = '2026-06-17'").await;

    // Không đăng nhập 401; không quyền 403.
    assert_eq!(call(&a, Method::GET, B, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, B, Some(EMP), None).await.status, 403);
    assert_eq!(call(&a, Method::GET, &format!("{B}/{id}"), Some(EMP), None).await.status, 403);
    assert_eq!(call(&a, Method::DELETE, &format!("{B}/{id}"), Some(EMP), None).await.status, 403);
    assert_eq!(call(&a, Method::GET, &format!("{B}/workdays-matrix"), Some(EMP), None).await.status, 403);

    // Query sai: trường lạ, ngày sai dạng, user_id không phải số ⇒ 400.
    for q in ["la=1", "date_from=17-06-2026", "user_id=abc", "page=x"] {
        let r = call(&a, Method::GET, &format!("{B}?{q}"), Some(MGR), None).await;
        assert_eq!(r.status, 400, "{q}: {:?}", r.body);
    }

    // Danh sách: lọc theo user, có phân trang.
    let l = call(&a, Method::GET, &format!("{B}?user_id=9832&date_from=2026-06-01&date_to=2026-06-30"), Some(MGR), None).await;
    assert_eq!(l.status, 200, "{:?}", l.body);
    assert_eq!(l.body["data"].as_array().unwrap().len(), 1);
    assert_eq!(l.body["data"][0]["id"], id);
    assert_eq!(l.body["pagination"]["total"], 1);

    // Chi tiết: 200; id không tồn tại 404; id không toàn chữ số không khớp route (404).
    let d = call(&a, Method::GET, &format!("{B}/{id}"), Some(MGR), None).await;
    assert_eq!(d.status, 200, "{:?}", d.body);
    assert_eq!(d.body["id"], id);
    assert_eq!(call(&a, Method::GET, &format!("{B}/2000000000"), Some(MGR), None).await.status, 404);
    assert_eq!(call(&a, Method::GET, &format!("{B}/abc"), Some(MGR), None).await.status, 404);

    // Sửa: DTO strict (trường lạ, kiểu sai ⇒ 400); sửa ghi chú ⇒ 200.
    for bad in [json!({ "la": 1 }), json!({ "late_minutes": "x" }), json!({ "status": 5 })] {
        let r = call(&a, Method::PATCH, &format!("{B}/{id}"), Some(MGR), Some(bad.clone())).await;
        assert_eq!(r.status, 400, "{bad}: {:?}", r.body);
    }
    let p = call(&a, Method::PATCH, &format!("{B}/{id}"), Some(MGR), Some(json!({ "check_in_note": "sửa tay" }))).await;
    assert_eq!(p.status, 200, "{:?}", p.body);
    assert_eq!(p.body["check_in_note"], "sửa tay");

    // Xoá: 200 rồi 404.
    let del = call(&a, Method::DELETE, &format!("{B}/{id}"), Some(MGR), None).await;
    assert_eq!(del.status, 200, "{:?}", del.body);
    assert_eq!(del.body["ok"], true);
    assert_eq!(call(&a, Method::DELETE, &format!("{B}/{id}"), Some(MGR), None).await.status, 404);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn hom_nay_vang_ma_tran_va_anh() {
    setup().await;
    let a = app().await;
    exec("INSERT INTO attendance_records (user_id, work_date, check_in_at, status, updated_at, check_in_proof_key)
          VALUES (9832, '2026-06-17', '2026-06-17 01:30:00+00', 'incomplete', now(), 'attendance/9832/2026-06-17/in_test.jpg')")
        .await;
    let id: i32 = scalar("SELECT id FROM attendance_records WHERE user_id = 9832 AND work_date = '2026-06-17'").await;

    // /today: đăng nhập là đủ; người không quyền thấy bản ghi của mình, người xem tất cả thấy số liệu; ngày sai ⇒ 400.
    let t = format!("{B}/today?date=2026-06-17");
    assert_eq!(call(&a, Method::GET, &t, None, None).await.status, 401);
    let mine = call(&a, Method::GET, &t, Some(EMP), None).await;
    assert_eq!(mine.status, 200, "{:?}", mine.body);
    assert_eq!(mine.body["record"]["id"], id);
    let all = call(&a, Method::GET, &t, Some(MGR), None).await;
    assert_eq!(all.status, 200);
    assert_eq!(all.body["checked_in"], 1);
    assert_eq!(call(&a, Method::GET, &format!("{B}/today?date=17/06/2026"), Some(MGR), None).await.status, 400);
    assert_eq!(call(&a, Method::GET, &format!("{B}/today?la=1"), Some(MGR), None).await.status, 400);

    // /absent: 403 không quyền; người chưa chấm (OTHER) nằm trong danh sách, người đã chấm (EMP) thì không; date sai ⇒ hôm nay.
    let ab = format!("{B}/absent?date=2026-06-17");
    assert_eq!(call(&a, Method::GET, &ab, Some(EMP), None).await.status, 403);
    let r = call(&a, Method::GET, &ab, Some(MGR), None).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["absent_date"], "2026-06-17");
    let ids: Vec<i64> = r.body["absent_employees"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["user_id"].as_i64())
        .collect();
    assert!(ids.contains(&i64::from(OTHER)) && !ids.contains(&i64::from(EMP)), "{ids:?}");
    let fallback = call(&a, Method::GET, &format!("{B}/absent?date=khong-phai-ngay&sort_by=chen_sql"), Some(MGR), None).await;
    assert_eq!(fallback.status, 200);
    assert_ne!(fallback.body["absent_date"], "khong-phai-ngay");

    // /workdays-matrix: 200, có hàng của EMP.
    let m = call(&a, Method::GET, &format!("{B}/workdays-matrix?date_from=2026-06-01&date_to=2026-06-30&user_id=9832"), Some(MGR), None).await;
    assert_eq!(m.status, 200, "{:?}", m.body);
    assert_eq!(m.body["rows"].as_array().unwrap().len(), 1);

    // Ảnh selfie: slot sai 400; không quyền 403; có khoá mà tệp chưa có 404; chưa có ảnh ra (out) 404; ghi tệp thật thì stream 200.
    let proof = |slot: &str| format!("{B}/{id}/proof/{slot}");
    assert_eq!(call(&a, Method::GET, &proof("in"), Some(EMP), None).await.status, 403);
    assert_eq!(call(&a, Method::GET, &proof("xx"), Some(MGR), None).await.status, 400);
    assert_eq!(call(&a, Method::GET, &proof("out"), Some(MGR), None).await.status, 404);
    assert_eq!(call(&a, Method::GET, &proof("in"), Some(MGR), None).await.status, 404);
    let file = root().join("attendance/9832/2026-06-17/in_test.jpg");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"\xff\xd8\xff").unwrap();
    let req = Request::builder()
        .uri(proof("in"))
        .header("authorization", format!("Bearer {}", token(MGR)))
        .body(Body::empty())
        .unwrap();
    let resp = a.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-disposition"], "inline");
    let raw = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    assert_eq!(raw.as_ref(), b"\xff\xd8\xff");
    teardown().await;
}
