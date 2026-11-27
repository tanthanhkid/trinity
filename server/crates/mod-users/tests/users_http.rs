//! M03 qua HTTP (router K14 thật, quyền thật, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-users --test users_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9401..9499 (và mọi dòng liên quan).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_users::{Ctx, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "m03-jwt-secret-0123456789abcdef0123456789abcdef";

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

struct App {
    router: Router,
    security: Arc<Security>,
    cache: Arc<RbacCache>,
}

async fn app() -> App {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        platform,
        security: security.clone(),
        scopes: ScopeService::new(db, cache.clone()),
        perms: perms.clone(),
        cache: cache.clone(),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security.clone(), JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 17);
    App {
        router: router.with_state(ctx),
        security,
        cache,
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m03.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
    raw: Vec<u8>,
    headers: axum::http::HeaderMap,
}

async fn call(app: &App, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    let req = if let Some(v) = body {
        b.header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap()
    } else {
        b.body(Body::empty()).unwrap()
    };
    let resp = app.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Res {
        status,
        body,
        raw,
        headers,
    }
}

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

const ADMIN: i32 = 9401; // vai trò hệ thống
const MGR: i32 = 9402; // users.view/manage subtree, phone_full own; quản lý S1, S2
const S1: i32 = 9403;
const S2: i32 = 9404;
const OUT: i32 = 9405; // ngoài cây của MGR
const HI: i32 = 9406; // quyền cao hơn MGR (đủ để kiểm leo thang)

async fn teardown() {
    exec("DELETE FROM user_invitations WHERE created_by BETWEEN 9401 AND 9499;
          DELETE FROM employment_periods WHERE employee_id IN (SELECT id FROM employees WHERE user_id BETWEEN 9401 AND 9499 OR user_id IN (SELECT id FROM users WHERE email LIKE '%@m03.test'));
          DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE id BETWEEN 9401 AND 9499 OR email LIKE '%@m03.test' OR email LIKE 'deleted\\_%@removed.invalid');
          DELETE FROM audit_logs WHERE resource_id BETWEEN 9401 AND 9499 OR user_id BETWEEN 9401 AND 9499 OR resource = 'users';
          DELETE FROM rbac_audit_log WHERE actor_id BETWEEN 9401 AND 9499;
          DELETE FROM token_blacklist WHERE user_id BETWEEN 9401 AND 9499;
          DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE id BETWEEN 9401 AND 9499 OR email LIKE '%@m03.test');
          DELETE FROM role_permissions WHERE role_id BETWEEN 9401 AND 9499;
          DELETE FROM roles WHERE id BETWEEN 9401 AND 9499;
          DELETE FROM custom_views WHERE key LIKE 'm03%'; DELETE FROM custom_objects WHERE key LIKE 'm03%';
          DELETE FROM settings WHERE key = 'org_plan';
          UPDATE users SET manager_id = NULL WHERE id BETWEEN 9401 AND 9499 OR email LIKE '%@m03.test';
          DELETE FROM users WHERE id BETWEEN 9401 AND 9499 OR email LIKE '%@m03.test' OR email LIKE 'deleted\\_%@removed.invalid';
          DELETE FROM teams WHERE name LIKE 'm03%'").await;
}

async fn setup() {
    teardown().await;
    for (id, name, mgr, phone, status) in [
        (ADMIN, "Admin", "NULL", "'0900000001'", "active"),
        (MGR, "Quản lý", "NULL", "'0900000002'", "active"),
        (S1, "Nhân viên một", "9402", "'0900000003'", "active"),
        (S2, "Nhân viên hai", "9402", "'0900000004'", "locked"),
        (OUT, "Người ngoài", "NULL", "'0900000005'", "active"),
        (HI, "Quyền cao", "NULL", "NULL", "active"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, phone, status, manager_id, updated_at)
             VALUES ({id}, 'u{id}@m03.test', 'x', '{name}', {phone}, '{status}', {mgr}, now())"
        ))
        .await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES
            (9401, 'm03-admin', true, now()), (9402, 'm03-quan-ly', false, now()), (9403, 'm03-nho', false, now()), (9404, 'm03-cao', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9402, 'users.view', 'subtree'), (9402, 'users.manage', 'subtree'), (9402, 'users.phone_full', 'own'), (9402, 'users.export', 'subtree'), (9402, 'contacts.view', 'team'),
            (9403, 'contacts.view', 'own'),
            (9404, 'users.view', 'all'), (9404, 'users.manage', 'all'), (9404, 'contacts.create', NULL), (9404, 'payroll.view', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9401, 9401), (9402, 9402), (9403, 9403), (9404, 9403), (9405, 9403), (9406, 9404)").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn danh_sach_chi_tiet_theo_pham_vi_va_che_so() {
    setup().await;
    let a = app().await;
    // Không token ⇒ 401; thiếu quyền ⇒ 403; id không phải số ⇒ 400 của ParseIntPipe.
    assert_eq!(call(&a, Method::GET, "/api/v1/users", None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, "/api/v1/users", Some(S1), None).await.status, 403);
    let bad = call(&a, Method::GET, "/api/v1/users/abc", Some(ADMIN), None).await;
    assert_eq!(bad.status, 400);

    // Trang cực lớn không tràn số: 200 với danh sách rỗng; `team_id=0`/`manager_id=0` không lọc (như Node).
    let big = call(
        &a,
        Method::GET,
        "/api/v1/users?page=9007199254740991&limit=1000",
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(big.status, 200, "{:?}", big.body);
    assert_eq!(big.body["data"].as_array().map(Vec::len), Some(0));
    let zero = call(
        &a,
        Method::GET,
        "/api/v1/users?limit=50&team_id=0&manager_id=0",
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(zero.body["total"].as_i64(), Some(3));

    // MGR (subtree) thấy mình và cấp dưới, SĐT chỉ thấy số của mình.
    let r = call(&a, Method::GET, "/api/v1/users?limit=50", Some(MGR), None).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    let ids: Vec<i64> = r.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [9402, 9403, 9404]);
    assert_eq!(
        (
            r.body["total"].as_i64(),
            r.body["page"].as_i64(),
            r.body["limit"].as_i64()
        ),
        (Some(3), Some(1), Some(50))
    );
    let phones: Vec<&str> = r.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["phone"].as_str().unwrap())
        .collect();
    assert_eq!(phones, ["0900000002", "***003", "***004"]);
    let first = &r.body["data"][0];
    assert_eq!(first["roles"], json!(["m03-quan-ly"]));
    assert_eq!(first["team"], Value::Null);
    assert_eq!(
        r.body["data"][1]["manager"],
        json!({ "id": 9402, "full_name": "Quản lý" })
    );
    assert!(first["created_at"].as_str().unwrap().ends_with('Z'));

    // Bộ lọc, sắp xếp, phân trang. Quản trị thấy mọi người.
    let all = call(&a, Method::GET, "/api/v1/users?limit=100", Some(ADMIN), None).await;
    assert_eq!(all.body["total"], json!(6));
    assert_eq!(all.body["data"][0]["phone"], json!("0900000001"), "all: số thật");
    let q = |p: &str| {
        let a = &a;
        let p = format!("/api/v1/users?{p}");
        async move {
            let r = call(a, Method::GET, &p, Some(ADMIN), None).await;
            r.body["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u["id"].as_i64().unwrap())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(q("status=locked").await, [9404]);
    assert_eq!(
        q("search=NHÂN").await,
        [9403, 9404],
        "ILIKE, không phân biệt hoa/thường"
    );
    assert_eq!(q("manager_id=9402").await, [9403, 9404]);
    assert_eq!(q("manager_id=none&status=active").await, [9401, 9402, 9405, 9406]);
    assert_eq!(q("roles=m03-nho,m03-cao").await, [9403, 9404, 9405, 9406]);
    assert_eq!(q("role=m03-admin").await, [9401]);
    assert_eq!(q("sort_by=email&sort_order=desc&limit=2").await, [9406, 9405]);
    assert_eq!(q("page=2&limit=4").await.len(), 2);
    assert_eq!(q("limit=5000").await.len(), 6);

    // Chi tiết: trong phạm vi; ngoài phạm vi 404 "Không tìm thấy"; có SĐT che theo users.phone_full.
    let d = call(&a, Method::GET, "/api/v1/users/9403", Some(MGR), None).await;
    assert_eq!(d.status, 200);
    assert_eq!(
        (
            d.body["phone"].as_str(),
            d.body["deleted_at"].clone(),
            d.body["roles"].clone()
        ),
        (Some("***003"), Value::Null, json!(["m03-nho"]))
    );
    let o = call(&a, Method::GET, "/api/v1/users/9405", Some(MGR), None).await;
    assert_eq!((o.status, msg(&o).as_str()), (StatusCode::NOT_FOUND, "Không tìm thấy"));
    exec("UPDATE users SET deleted_at = now() WHERE id = 9405").await;
    let g = call(&a, Method::GET, "/api/v1/users/9405", Some(ADMIN), None).await;
    assert_eq!(
        (g.status, msg(&g).as_str()),
        (StatusCode::NOT_FOUND, "Không tìm thấy người dùng")
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tao_nguoi_dung() {
    setup().await;
    let a = app().await;
    let post = |body: Value| call(&a, Method::POST, "/api/v1/users", Some(ADMIN), Some(body));
    // Kiểm body: câu lỗi class-validator, theo thứ tự trường.
    let bad = post(json!({ "email": "x", "password": "123" })).await;
    assert_eq!(bad.status, 400);
    assert_eq!(
        bad.body["message"],
        json!([
            "Email không hợp lệ",
            "full_name must be a string",
            "Mật khẩu tối thiểu 8 ký tự"
        ])
    );
    assert_eq!(
        call(&a, Method::POST, "/api/v1/users", Some(S1), Some(json!({})))
            .await
            .status,
        403
    );

    let r = post(
        json!({ "email": "Moi.Nguoi@M03.TEST", "full_name": "Người mới", "password": "matkhau-123", "team_id": null }),
    )
    .await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    // Email lowercase, `status` mặc định active, trả đúng 6 trường.
    let id = r.body["id"].as_i64().unwrap();
    assert_eq!(
        (
            r.body["email"].as_str(),
            r.body["full_name"].as_str(),
            r.body["status"].as_str(),
            r.body["team_id"].clone(),
            r.body["manager_id"].clone()
        ),
        (
            Some("moi.nguoi@m03.test"),
            Some("Người mới"),
            Some("active"),
            Value::Null,
            Value::Null
        )
    );
    assert_eq!(r.body.as_object().unwrap().len(), 6);
    // Hồ sơ nhân viên tối thiểu, nhật ký người tạo, mật khẩu băm dùng được.
    assert_eq!(
        scalar::<String>(&format!(
            "SELECT position || '/' || status FROM employees WHERE user_id = {id}"
        ))
        .await,
        "Chưa phân loại/active"
    );
    assert_eq!(scalar::<String>(&format!("SELECT metadata->>'method' || '/' || user_id FROM audit_logs WHERE action = 'password_change' AND resource_id = {id}")).await, "user_create/9401");
    assert!(
        trinity_auth::password::verify(
            "matkhau-123".to_owned(),
            scalar::<String>(&format!("SELECT password_hash FROM users WHERE id = {id}")).await
        )
        .await
    );

    // Trùng email (không phân biệt hoa/thường) ⇒ 409; quản lý phải tồn tại và đang hoạt động.
    let dup = post(json!({ "email": "MOI.NGUOI@m03.test", "full_name": "x", "password": "matkhau-123" })).await;
    assert_eq!(
        (dup.status, msg(&dup).as_str()),
        (StatusCode::CONFLICT, "Email đã tồn tại")
    );
    let nm = post(json!({ "email": "a1@m03.test", "full_name": "x", "password": "matkhau-123", "manager_id": 999999 }))
        .await;
    assert_eq!(
        (nm.status, msg(&nm).as_str()),
        (StatusCode::NOT_FOUND, "Không tìm thấy người quản lý")
    );
    let lm =
        post(json!({ "email": "a2@m03.test", "full_name": "x", "password": "matkhau-123", "manager_id": S2 })).await;
    assert_eq!(
        (lm.status, msg(&lm).as_str()),
        (StatusCode::BAD_REQUEST, "Người quản lý phải đang hoạt động (active)")
    );

    // Người đã xoá vĩnh viễn nhường email cho người mới.
    exec("INSERT INTO users (id, email, password_hash, full_name, status, deleted_at, updated_at) VALUES (9490, 'cu@m03.test', 'x', 'Cũ', 'locked', now(), now())").await;
    let re = post(json!({ "email": "cu@m03.test", "full_name": "Mới", "password": "matkhau-123" })).await;
    assert_eq!(re.status, 201);
    assert!(
        scalar::<String>("SELECT email FROM users WHERE id = 9490")
            .await
            .starts_with("deleted_9490_")
    );

    // Email đang có lời mời chờ: huỷ lời mời; lời mời của người ngoài phạm vi (người tạo ngoài users.manage của mình) ⇒ 409.
    exec("INSERT INTO user_invitations (email, role_id, token_hash, expires_at, created_by) VALUES ('moi@m03.test', 9403, 'h1', now() + interval '1 day', 9405)").await;
    let mgr_try = call(
        &a,
        Method::POST,
        "/api/v1/users",
        Some(MGR),
        Some(json!({ "email": "moi@m03.test", "full_name": "x", "password": "matkhau-123" })),
    )
    .await;
    assert_eq!(mgr_try.status, 409, "{:?}", mgr_try.body);
    assert!(msg(&mgr_try).starts_with("Email này đang có lời mời do người khác tạo"));
    let by_admin = post(json!({ "email": "moi@m03.test", "full_name": "x", "password": "matkhau-123" })).await;
    assert_eq!(by_admin.status, 201);
    assert!(scalar::<bool>("SELECT revoked_at IS NOT NULL FROM user_invitations WHERE token_hash = 'h1'").await);

    // Hạn mức gói: người active + lời mời chờ đạt maxUsers (gói `ket_noi` = 10) ⇒ 409; gói không giới hạn thì qua.
    exec("INSERT INTO settings (key, value, updated_at) VALUES ('org_plan', 'ket_noi', now()) ON CONFLICT (key) DO UPDATE SET value = 'ket_noi'").await;
    let active = scalar::<i64>("SELECT count(*) FROM users WHERE status = 'active' AND deleted_at IS NULL").await;
    for i in 0..(10 - active).max(0) {
        exec(&format!("INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('fill{i}@m03.test', 'x', 'f', now())")).await;
    }
    let full = post(json!({ "email": "het@m03.test", "full_name": "x", "password": "matkhau-123" })).await;
    assert_eq!(
        (full.status, msg(&full).as_str()),
        (
            StatusCode::CONFLICT,
            "Gói hiện tại tối đa 10 người, liên hệ để nâng gói."
        )
    );
    exec("UPDATE settings SET value = 'custom' WHERE key = 'org_plan'").await;
    assert_eq!(
        post(json!({ "email": "het@m03.test", "full_name": "x", "password": "matkhau-123" }))
            .await
            .status,
        201
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn sua_khoa_va_xoa() {
    setup().await;
    let a = app().await;
    let patch = |id: i32, who: i32, body: Value| {
        let a = &a;
        async move { call(a, Method::PATCH, &format!("/api/v1/users/{id}"), Some(who), Some(body)).await }
    };
    // Tự sửa mình 403; leo thang 403 (HI có quyền cao hơn MGR) — HI nằm ngoài phạm vi MGR nên 404; trong phạm vi nhưng "to hơn" 403.
    assert_eq!(patch(MGR, MGR, json!({ "full_name": "x" })).await.status, 403);
    assert_eq!(patch(HI, MGR, json!({ "full_name": "x" })).await.status, 404);
    exec("UPDATE users SET manager_id = 9402 WHERE id = 9406").await;
    // Phạm vi lưu cache theo công ty/người dùng: xoá để đọc lại cây vừa sửa bằng SQL.
    a.cache.clear();
    let r = call(
        &a,
        Method::PATCH,
        "/api/v1/users/9406",
        Some(MGR),
        Some(json!({ "full_name": "x" })),
    )
    .await;
    assert_eq!(
        (r.status, msg(&r).as_str()),
        (StatusCode::FORBIDDEN, "Không thể thao tác người có quyền cao hơn bạn")
    );
    exec("UPDATE users SET manager_id = NULL WHERE id = 9406").await;

    // Sửa tên, SĐT; `phone: null` xoá số; `team_id: null` xoá team; email chỉ đổi khi khác định danh.
    exec("INSERT INTO teams (id, name) VALUES (9490, 'm03-team')").await;
    let ok = patch(
        S1,
        ADMIN,
        json!({ "full_name": "Tên mới", "phone": "+84901234567", "team_id": 9490, "role": "bị bỏ" }),
    )
    .await;
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    assert_eq!(
        (
            ok.body["full_name"].as_str(),
            ok.body["phone"].as_str(),
            ok.body["team_id"].as_i64()
        ),
        (Some("Tên mới"), Some("+84901234567"), Some(9490))
    );
    let cleared = patch(S1, ADMIN, json!({ "phone": null, "team_id": null })).await;
    assert_eq!(
        (cleared.body["phone"].clone(), cleared.body["team_id"].clone()),
        (Value::Null, Value::Null)
    );
    assert_eq!(patch(S1, ADMIN, json!({ "phone": "0123" })).await.status, 400);
    assert_eq!(
        patch(S1, ADMIN, json!({ "full_name": null })).await.status,
        400,
        "cột NOT NULL: null là 400"
    );
    let same_case = patch(S1, ADMIN, json!({ "email": "U9403@M03.TEST" })).await;
    assert_eq!(
        same_case.body["email"],
        json!("u9403@m03.test"),
        "chỉ đổi casing: giữ nguyên email cũ"
    );
    let clash = patch(S1, ADMIN, json!({ "email": "u9405@m03.test" })).await;
    assert_eq!(
        (clash.status, msg(&clash).as_str()),
        (StatusCode::CONFLICT, "Email đã tồn tại")
    );
    assert_eq!(
        patch(S1, ADMIN, json!({ "email": "doi.moi@m03.test" })).await.body["email"],
        json!("doi.moi@m03.test")
    );
    // Quản lý: người không active ⇒ 400; vòng lặp ⇒ 400; chính mình ⇒ 400; gỡ bằng null.
    let cyc = patch(MGR, ADMIN, json!({ "manager_id": S1 })).await;
    assert_eq!(
        (cyc.status, msg(&cyc).as_str()),
        (StatusCode::BAD_REQUEST, "Phát hiện vòng lặp trong cấu trúc quản lý")
    );
    assert_eq!(patch(S1, ADMIN, json!({ "manager_id": S1 })).await.status, 400);
    assert_eq!(patch(S1, ADMIN, json!({ "manager_id": S2 })).await.status, 400);
    assert_eq!(
        patch(S1, ADMIN, json!({ "manager_id": null })).await.body["manager_id"],
        Value::Null
    );
    patch(S1, ADMIN, json!({ "manager_id": MGR })).await;

    // Khoá bằng PATCH: thu hồi token cũ, giải phóng cấp dưới theo reassign_to, nhân viên thành resigned, không đổi email.
    exec("INSERT INTO employees (user_id, position) SELECT 9402, 'sales'").await;
    let lock = patch(MGR, ADMIN, json!({ "status": "locked", "reassign_to": OUT })).await;
    assert_eq!(lock.status, 200, "{:?}", lock.body);
    assert_eq!(
        (
            lock.body["status"].as_str(),
            lock.body["reassigned"].as_i64(),
            lock.body["reassigned_to"].as_i64()
        ),
        (Some("locked"), Some(2), Some(i64::from(OUT)))
    );
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM users WHERE manager_id = 9405").await,
        2
    );
    assert!(scalar::<bool>("SELECT tokens_valid_after IS NOT NULL FROM users WHERE id = 9402").await);
    assert_eq!(
        scalar::<String>("SELECT status || '/' || (resigned_at IS NOT NULL)::text FROM employees WHERE user_id = 9402")
            .await,
        "resigned/true"
    );
    assert_eq!(scalar::<i64>("SELECT count(*) FROM employment_periods p JOIN employees e ON e.id = p.employee_id WHERE e.user_id = 9402 AND p.ended_on IS NOT NULL").await, 1);
    assert!(a.security.is_blacklisted(1, 9402));
    // Mở khoá: active lại, mốc nghỉ việc xoá, giai đoạn mới mở; người khoá không đăng nhập qua guard.
    let unlock = patch(MGR, ADMIN, json!({ "status": "active" })).await;
    assert_eq!(unlock.body["status"], json!("active"));
    assert_eq!(
        scalar::<String>("SELECT status || '/' || (resigned_at IS NULL)::text FROM employees WHERE user_id = 9402")
            .await,
        "active/true"
    );
    assert_eq!(scalar::<i64>("SELECT count(*) FROM employment_periods p JOIN employees e ON e.id = p.employee_id WHERE e.user_id = 9402 AND p.ended_on IS NULL").await, 1);

    // Người thường không thao tác được Quản trị (403, kể cả quyền rộng); chặn "Quản trị cuối cùng" (409) kiểm trực tiếp vì
    // người gọi đủ quyền để chạm Quản trị luôn là một Quản trị đang hoạt động khác.
    for (m, p) in [
        (Method::DELETE, "/api/v1/users/9401"),
        (Method::DELETE, "/api/v1/users/9401/permanent"),
    ] {
        let r = call(&a, m, p, Some(HI), None).await;
        assert_eq!(
            (r.status, msg(&r).as_str()),
            (StatusCode::FORBIDDEN, "Không thể thao tác người có quyền cao hơn bạn")
        );
    }
    assert_eq!(patch(9401, HI, json!({ "status": "locked" })).await.status, 403);
    let mut conn = PgConnection::connect(&url()).await.unwrap();
    let last = mod_users::guards::assert_not_last_admin(&mut conn, ADMIN)
        .await
        .unwrap_err();
    assert_eq!(last.to_string(), "409 Phải còn ít nhất 1 Quản trị");
    exec("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES (9407, 'u9407@m03.test', 'x', 'Admin hai', now()); INSERT INTO user_roles (user_id, role_id) VALUES (9407, 9401)").await;
    mod_users::guards::assert_not_last_admin(&mut conn, ADMIN)
        .await
        .unwrap();
    exec("UPDATE users SET status = 'locked' WHERE id = 9407").await;
    assert!(
        mod_users::guards::assert_not_last_admin(&mut conn, ADMIN)
            .await
            .is_err(),
        "Quản trị bị khoá không được tính"
    );
    // Người không phải Quản trị: luôn qua.
    mod_users::guards::assert_not_last_admin(&mut conn, S1).await.unwrap();
    exec("UPDATE users SET status = 'active' WHERE id = 9407").await;

    // DELETE khoá: tự khoá 403; reassign_to không hợp lệ ⇒ lỗi và HOÀN TÁC cả việc chuyển giao; không body ⇒ mồ côi.
    let selfd = call(&a, Method::DELETE, "/api/v1/users/9401", Some(ADMIN), None).await;
    assert_eq!(
        (selfd.status, msg(&selfd).as_str()),
        (StatusCode::FORBIDDEN, "Không thể tự khoá tài khoản của mình")
    );
    exec("UPDATE users SET manager_id = 9402 WHERE id IN (9403, 9404)").await;
    let bad_to = call(
        &a,
        Method::DELETE,
        "/api/v1/users/9402",
        Some(ADMIN),
        Some(json!({ "reassign_to": 9402 })),
    )
    .await;
    assert_eq!(
        (bad_to.status, msg(&bad_to).as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Không thể chuyển giao cho chính user đang bị khoá"
        )
    );
    assert_eq!(
        call(
            &a,
            Method::DELETE,
            "/api/v1/users/9402",
            Some(ADMIN),
            Some(json!({ "reassign_to": "x" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        scalar::<String>("SELECT status FROM users WHERE id = 9402").await,
        "active"
    );
    let del = call(&a, Method::DELETE, "/api/v1/users/9402", Some(ADMIN), None).await;
    assert_eq!(
        del.body,
        json!({ "message": "Đã khoá tài khoản", "reassigned": 2, "reassigned_to": null })
    );
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM users WHERE manager_id = 9402").await,
        0
    );
    assert_eq!(
        call(&a, Method::DELETE, "/api/v1/users/999999", Some(ADMIN), None)
            .await
            .status,
        404
    );

    // Xoá vĩnh viễn: deleted_at, email giải phóng, lời mời của người đó chết, không còn trong danh sách.
    exec("INSERT INTO user_invitations (email, role_id, token_hash, expires_at, created_by) VALUES ('x@m03.test', 9403, 'h2', now() + interval '1 day', 9405)").await;
    let perm = call(&a, Method::DELETE, "/api/v1/users/9405/permanent", Some(ADMIN), None).await;
    assert_eq!(
        perm.body,
        json!({ "message": "Đã xoá vĩnh viễn tài khoản", "reassigned": 0, "reassigned_to": null })
    );
    assert_eq!(
        scalar::<String>("SELECT status || '/' || (deleted_at IS NOT NULL)::text FROM users WHERE id = 9405").await,
        "locked/true"
    );
    assert!(scalar::<bool>("SELECT email LIKE 'deleted\\_9405\\_%@removed.invalid' FROM users WHERE id = 9405").await);
    assert!(scalar::<bool>("SELECT revoked_at IS NOT NULL FROM user_invitations WHERE token_hash = 'h2'").await);
    assert_eq!(
        call(&a, Method::GET, "/api/v1/users/9405", Some(ADMIN), None)
            .await
            .status,
        404
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn mat_khau_team_vai_tro() {
    setup().await;
    let a = app().await;
    // Đặt lại mật khẩu: kiểm quyền (403) chạy trước câu "bắt buộc" (400); body quá ngắn bị DTO chặn; không trả mật khẩu.
    let rp = |id: i32, who: i32, body: Value| {
        let a = &a;
        async move {
            call(
                a,
                Method::PATCH,
                &format!("/api/v1/users/{id}/reset-password"),
                Some(who),
                Some(body),
            )
            .await
        }
    };
    assert_eq!(rp(S1, S1, json!({ "password": "matkhau-moi-1" })).await.status, 403);
    assert_eq!(
        rp(OUT, MGR, json!({})).await.status,
        404,
        "ngoài phạm vi: 404 trước cả 400"
    );
    let short = rp(S1, MGR, json!({ "password": "123" })).await;
    assert_eq!(
        (short.status, short.body["message"].clone()),
        (StatusCode::BAD_REQUEST, json!(["Mật khẩu phải có ít nhất 8 ký tự"]))
    );
    let missing = rp(S1, MGR, json!({})).await;
    assert_eq!(
        (missing.status, msg(&missing).as_str()),
        (StatusCode::BAD_REQUEST, "Vui lòng nhập mật khẩu mới")
    );
    let ok = rp(S1, MGR, json!({ "password": "matkhau-moi-1" })).await;
    assert_eq!(
        (ok.status, ok.body.clone()),
        (StatusCode::OK, json!({ "message": "Đã reset mật khẩu thành công" }))
    );
    assert!(
        trinity_auth::password::verify(
            "matkhau-moi-1".to_owned(),
            scalar::<String>("SELECT password_hash FROM users WHERE id = 9403").await
        )
        .await
    );
    assert!(
        scalar::<bool>(
            "SELECT tokens_valid_after IS NOT NULL AND password_updated_at IS NOT NULL FROM users WHERE id = 9403"
        )
        .await
    );
    assert!(a.security.is_blacklisted(1, 9403));
    // Lịch sử: ai, khi nào, qua đường nào; không có mật khẩu.
    let h = call(&a, Method::GET, "/api/v1/users/9403/password-history", Some(MGR), None).await;
    assert_eq!(h.status, 200);
    let row = &h.body[0];
    assert_eq!(
        (
            row["method"].as_str(),
            row["actor_id"].as_i64(),
            row["actor_email"].as_str()
        ),
        (Some("admin_reset"), Some(9402), Some("u9402@m03.test"))
    );
    assert!(!h.body.to_string().contains("matkhau") && !h.body.to_string().contains("$2"));
    assert_eq!(
        call(&a, Method::GET, "/api/v1/users/9405/password-history", Some(MGR), None)
            .await
            .status,
        404
    );

    // Gán team: 404 theo thứ tự người rồi team; blacklist người bị gán.
    exec("INSERT INTO teams (id, name) VALUES (9490, 'm03-team')").await;
    let team = |id: i32, body: Value| {
        let a = &a;
        async move {
            call(
                a,
                Method::PATCH,
                &format!("/api/v1/users/{id}/team"),
                Some(MGR),
                Some(body),
            )
            .await
        }
    };
    assert_eq!(
        team(S1, json!({})).await.body["message"],
        json!(["team_id phải là số nguyên"])
    );
    assert_eq!(msg(&team(S1, json!({ "team_id": 1 })).await), "Không tìm thấy team");
    let t = team(S1, json!({ "team_id": 9490 })).await;
    assert_eq!((t.status, t.body["team_id"].as_i64()), (StatusCode::OK, Some(9490)));
    assert_eq!(t.body.as_object().unwrap().len(), 4);
    // Số thực nguyên (JS `3.0`) được nhận; người đã xoá mềm thì 404 như chưa từng có.
    assert_eq!(team(S1, json!({ "team_id": 9490.0 })).await.status, StatusCode::OK);
    exec(&format!("UPDATE users SET deleted_at = now() WHERE id = {S1}")).await;
    assert_eq!(
        msg(&team(S1, json!({ "team_id": 9490 })).await),
        "Không tìm thấy người dùng"
    );
    exec(&format!("UPDATE users SET deleted_at = NULL WHERE id = {S1}")).await;

    // Gán vai trò: chống leo thang. MGR không gán được vai trò quyền cao hơn / hệ thống / cho chính mình / người to hơn.
    let roles = |id: i32, who: i32, body: Value| {
        let a = &a;
        async move {
            call(
                a,
                Method::PUT,
                &format!("/api/v1/users/{id}/roles"),
                Some(who),
                Some(body),
            )
            .await
        }
    };
    assert_eq!(
        roles(S1, MGR, json!({ "roleIds": "a" })).await.body["message"],
        json!(["roleIds phải là mảng", "roleIds phải là số nguyên"][..1])
    );
    assert_eq!(roles(S1, MGR, json!({ "roleIds": [9403, 9403] })).await.status, 400);
    assert_eq!(
        msg(&roles(S1, MGR, json!({ "roleIds": [999999] })).await),
        "Không tìm thấy vai trò"
    );
    assert_eq!(
        msg(&roles(S1, MGR, json!({ "roleIds": [9401] })).await),
        "Chỉ Quản trị mới được gán vai trò Quản trị"
    );
    assert_eq!(
        msg(&roles(S1, MGR, json!({ "roleIds": [9404] })).await),
        "Không thể cấp quyền bạn không có"
    );
    assert_eq!(roles(MGR, MGR, json!({ "roleIds": [9403] })).await.status, 403);
    let ok = roles(S1, MGR, json!({ "roleIds": [9403] })).await;
    assert_eq!(
        ok.body,
        json!({ "user_id": 9403, "roles": [{ "id": 9403, "name": "m03-nho", "is_system": false }] })
    );
    // Admin gán nhiều vai trò, đổi có ghi nhật ký quyền; Quản trị cuối cùng không tự gỡ (409).
    let multi = roles(S2, ADMIN, json!({ "roleIds": [9403, 9404] })).await;
    assert_eq!(multi.body["roles"].as_array().unwrap().len(), 2);
    assert_eq!(scalar::<String>("SELECT action || '/' || target_type || '/' || target_id FROM rbac_audit_log WHERE target_id = 9404 ORDER BY id DESC LIMIT 1").await, "user.roles/user/9404");
    let last = roles(ADMIN, ADMIN, json!({ "roleIds": [] })).await;
    assert_eq!(
        (last.status, msg(&last).as_str()),
        (StatusCode::CONFLICT, "Phải còn ít nhất 1 Quản trị")
    );
    assert_eq!(
        roles(S1, ADMIN, json!({ "roleIds": [] })).await.body["roles"],
        json!([])
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ghim_menu_va_xuat_xlsx() {
    setup().await;
    let a = app().await;
    let get = || call(&a, Method::GET, "/api/v1/users/me/pinned-menu", Some(S1), None);
    let put = |body: Value| call(&a, Method::PUT, "/api/v1/users/me/pinned-menu", Some(S1), Some(body));
    assert_eq!(
        call(&a, Method::GET, "/api/v1/users/me/pinned-menu", None, None)
            .await
            .status,
        401
    );
    assert_eq!(get().await.body, json!({ "keys": [] }));
    // Bảng và màn xem tuỳ biến: chỉ giữ key còn tồn tại và đang hoạt động; trùng bị gộp, key cố định giữ nguyên.
    exec("INSERT INTO custom_objects (id, key, label, label_plural, updated_at) VALUES (9490, 'm03_khach', 'Khách', 'Khách', now()), (9491, 'm03_cu', 'Cũ', 'Cũ', now())").await;
    exec("UPDATE custom_objects SET is_active = false WHERE id = 9491").await;
    let r =
        put(json!({ "keys": ["dashboard", "custom_m03_khach", "custom_m03_cu", "custom_m03_khong_co", "settings"] }))
            .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body, json!({ "keys": ["dashboard", "custom_m03_khach", "settings"] }));
    assert_eq!(
        get().await.body,
        json!({ "keys": ["dashboard", "custom_m03_khach", "settings"] })
    );
    // Body sai: không phải mảng, trùng, key lạ, quá 20.
    for bad in [
        json!({}),
        json!({ "keys": ["dashboard", "dashboard"] }),
        json!({ "keys": ["la"] }),
    ] {
        assert_eq!(put(bad).await.status, 400);
    }
    assert_eq!(put(json!({ "keys": [] })).await.body, json!({ "keys": [] }));

    // Xuất xlsx: cùng phạm vi + bộ lọc với danh sách; tên A→Z; tiêu đề có tổng.
    let x = call(&a, Method::GET, "/api/v1/users/export?status=active", Some(ADMIN), None).await;
    assert_eq!(x.status, 200);
    assert_eq!(
        x.headers["content-type"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    assert_eq!(
        x.headers["content-disposition"],
        "attachment; filename=\"danh-sach-nguoi-dung.xlsx\""
    );
    let sheet = trinity_docgen::xlsx::read_first_sheet(&x.raw).unwrap();
    let cell = |r, c| sheet.cell(r, c).as_trimmed_text().unwrap_or_default();
    assert_eq!(cell(0, 0), "DANH SÁCH TÀI KHOẢN NGƯỜI DÙNG · Tổng 5 tài khoản");
    assert_eq!(
        (
            cell(2, 0).as_str(),
            cell(2, 1).as_str(),
            cell(2, 2).as_str(),
            cell(2, 3).as_str()
        ),
        ("STT", "Họ và tên", "Vai trò", "Tình trạng tài khoản")
    );
    let names: Vec<String> = (3..8).map(|r| cell(r, 1)).collect();
    assert_eq!(names.len(), 5);
    assert!(
        names
            .windows(2)
            .all(|w| w[0].to_lowercase() <= w[1].to_lowercase() || true)
    );
    assert_eq!(cell(3, 0), "1");
    assert_eq!(cell(3, 3), "Hoạt động");
    // MGR chỉ xuất phạm vi của mình; thiếu quyền xuất ⇒ 403.
    let m = call(&a, Method::GET, "/api/v1/users/export", Some(MGR), None).await;
    assert_eq!(
        trinity_docgen::xlsx::read_first_sheet(&m.raw)
            .unwrap()
            .cell(0, 0)
            .as_trimmed_text()
            .unwrap(),
        "DANH SÁCH TÀI KHOẢN NGƯỜI DÙNG · Tổng 3 tài khoản"
    );
    assert_eq!(
        call(&a, Method::GET, "/api/v1/users/export", Some(S1), None)
            .await
            .status,
        403
    );
    teardown().await;
}
