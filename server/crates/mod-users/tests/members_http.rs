//! Trang Thành viên (ba vai trò cố định) qua HTTP: router K14 thật, quyền thật, Postgres thật.
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-users --test members_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user 9501..9599, khách/deal 9501xx và vai trò Thành viên cố định.

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

const JWT: &str = "mem-jwt-secret-0123456789abcdef0123456789abcdef";

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
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@mem.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
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
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Res { status, body }
}

const OWNER: i32 = 9501;
const ADMIN2: i32 = 9502;
const MEMBER: i32 = 9503;
const MEMBER2: i32 = 9504;

async fn teardown() {
    exec("DELETE FROM kanban_card_assignees WHERE user_id BETWEEN 9501 AND 9599;
          DELETE FROM deals WHERE id BETWEEN 950100 AND 950199;
          DELETE FROM contacts WHERE id BETWEEN 950100 AND 950199;
          DELETE FROM user_invitations WHERE created_by BETWEEN 9501 AND 9599;
          DELETE FROM employment_periods WHERE employee_id IN (SELECT id FROM employees WHERE user_id BETWEEN 9501 AND 9599);
          DELETE FROM employees WHERE user_id BETWEEN 9501 AND 9599;
          DELETE FROM audit_logs WHERE user_id BETWEEN 9501 AND 9599 OR resource_id BETWEEN 9501 AND 9599;
          DELETE FROM rbac_audit_log WHERE actor_id BETWEEN 9501 AND 9599;
          DELETE FROM token_blacklist WHERE user_id BETWEEN 9501 AND 9599;
          DELETE FROM user_roles WHERE user_id BETWEEN 9501 AND 9599;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9501 AND 9599;
          DELETE FROM roles WHERE id BETWEEN 9501 AND 9599;
          DELETE FROM settings WHERE key IN ('owner_user_id', 'org_plan');
          UPDATE users SET manager_id = NULL WHERE id BETWEEN 9501 AND 9599;
          DELETE FROM users WHERE id BETWEEN 9501 AND 9599 OR email LIKE 'deleted\\_%@removed.invalid';").await;
}

/// Hai Quản trị (OWNER là chủ), hai Thành viên. Vai trò hệ thống riêng của test (id 9501) và Thành viên cố định (9502).
async fn setup() {
    teardown().await;
    exec(&format!(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES (9501, 'mem-admin', true, now());
         INSERT INTO roles (id, name, description, is_system, updated_at) VALUES (9502, 'mem-thanh-vien', '{}', false, now());
         INSERT INTO role_permissions (role_id, permission, scope) VALUES {};",
        trinity_rbac::fixed_roles::MEMBER_ROLE_MARK,
        trinity_rbac::fixed_roles::MEMBER_GRANTS
            .iter()
            .map(|(p, s)| format!("(9502, '{p}', {})", s.map_or("NULL".to_owned(), |s| format!("'{s}'"))))
            .collect::<Vec<_>>()
            .join(", ")
    ))
    .await;
    for (id, name) in [
        (OWNER, "Chủ"),
        (ADMIN2, "Quản trị hai"),
        (MEMBER, "Thành viên một"),
        (MEMBER2, "Thành viên hai"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@mem.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec(&format!(
        "INSERT INTO user_roles (user_id, role_id) VALUES ({OWNER}, 9501), ({ADMIN2}, 9501), ({MEMBER}, 9502), ({MEMBER2}, 9502);
         INSERT INTO settings (key, value, updated_at) VALUES ('owner_user_id', '{OWNER}', now()) ON CONFLICT (key) DO UPDATE SET value = '{OWNER}';"
    ))
    .await;
}

fn role_of(list: &Value, id: i32) -> Value {
    list["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"].as_i64() == Some(i64::from(id)))
        .map_or(Value::Null, |m| m["role"].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn danh_sach_ba_vai_tro_va_thanh_vien_khong_goi_duoc_api_quan_tri() {
    setup().await;
    let a = app().await;
    assert_eq!(call(&a, Method::GET, "/api/v1/members", None, None).await.status, 401);

    let r = call(&a, Method::GET, "/api/v1/members", Some(OWNER), None).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(role_of(&r.body, OWNER), json!("owner"));
    assert_eq!(role_of(&r.body, ADMIN2), json!("admin"));
    assert_eq!(role_of(&r.body, MEMBER), json!("member"));
    assert_eq!(r.body["me"], json!({ "id": OWNER, "role": "owner" }));
    assert_eq!(r.body["owner_id"], json!(OWNER));
    let row = r.body["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == json!(MEMBER))
        .unwrap();
    assert_eq!(row["status"], json!("active"));
    assert!(row["joined_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(row["email"], json!(format!("u{MEMBER}@mem.test")));

    // Thành viên xem được danh sách nhưng không thấy email người khác; mọi API quản trị trả 403.
    let m = call(&a, Method::GET, "/api/v1/members", Some(MEMBER), None).await;
    assert_eq!(m.status, 200);
    assert_eq!(m.body["me"]["role"], json!("member"));
    let other = m.body["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(MEMBER2))
        .unwrap();
    assert_eq!(other["email"], Value::Null);
    let denied = [
        (
            Method::PUT,
            format!("/api/v1/members/{MEMBER2}/role"),
            Some(json!({ "role": "admin" })),
        ),
        (
            Method::DELETE,
            format!("/api/v1/members/{MEMBER2}"),
            Some(json!({ "reassign_to": MEMBER })),
        ),
        (
            Method::POST,
            "/api/v1/members/transfer-owner".to_owned(),
            Some(json!({ "user_id": MEMBER })),
        ),
        (
            Method::PATCH,
            format!("/api/v1/users/{MEMBER2}/reset-password"),
            Some(json!({ "password": "matkhau-moi-1" })),
        ),
        (
            Method::PATCH,
            format!("/api/v1/users/{MEMBER2}"),
            Some(json!({ "status": "locked" })),
        ),
        (Method::DELETE, format!("/api/v1/users/{MEMBER2}"), None),
        (
            Method::PUT,
            format!("/api/v1/users/{MEMBER2}/roles"),
            Some(json!({ "roleIds": [9501] })),
        ),
    ];
    for (method, path, body) in denied {
        let r = call(&a, method.clone(), &path, Some(MEMBER), body).await;
        assert_eq!(r.status, 403, "{method} {path}: {:?}", r.body);
    }
    // Không có gì bị đổi.
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM user_roles WHERE user_id = {MEMBER2} AND role_id = 9502"
        ))
        .await,
        1
    );
    teardown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn doi_vai_tro_giua_quan_tri_va_thanh_vien() {
    setup().await;
    let a = app().await;
    let up = call(
        &a,
        Method::PUT,
        &format!("/api/v1/members/{MEMBER}/role"),
        Some(OWNER),
        Some(json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(up.status, 200, "{:?}", up.body);
    let l = call(&a, Method::GET, "/api/v1/members", Some(OWNER), None).await;
    assert_eq!(role_of(&l.body, MEMBER), json!("admin"));
    // Quản trị mới làm được việc quản trị.
    let ok = call(
        &a,
        Method::PUT,
        &format!("/api/v1/members/{MEMBER2}/role"),
        Some(MEMBER),
        Some(json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    let down = call(
        &a,
        Method::PUT,
        &format!("/api/v1/members/{MEMBER2}/role"),
        Some(OWNER),
        Some(json!({ "role": "member" })),
    )
    .await;
    assert_eq!(down.status, 200, "{:?}", down.body);
    assert_eq!(
        call(&a, Method::GET, "/api/v1/members", Some(OWNER), None).await.body["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == json!(MEMBER2))
            .unwrap()["role"],
        json!("member")
    );
    // Vai trò lạ ⇒ 400; Chủ sở hữu không đổi được, kể cả do Quản trị khác.
    let bad = call(
        &a,
        Method::PUT,
        &format!("/api/v1/members/{MEMBER2}/role"),
        Some(OWNER),
        Some(json!({ "role": "owner" })),
    )
    .await;
    assert_eq!(bad.status, 400);
    let own = call(
        &a,
        Method::PUT,
        &format!("/api/v1/members/{OWNER}/role"),
        Some(ADMIN2),
        Some(json!({ "role": "member" })),
    )
    .await;
    assert_eq!(own.status, 403, "{:?}", own.body);
    // Chủ không bị khoá, xoá hay đặt lại mật khẩu bởi Quản trị khác qua API cũ.
    for (method, path, body) in [
        (
            Method::PATCH,
            format!("/api/v1/users/{OWNER}"),
            Some(json!({ "status": "locked" })),
        ),
        (Method::DELETE, format!("/api/v1/users/{OWNER}"), None),
        (Method::DELETE, format!("/api/v1/users/{OWNER}/permanent"), None),
        (
            Method::PATCH,
            format!("/api/v1/users/{OWNER}/reset-password"),
            Some(json!({ "password": "matkhau-moi-1" })),
        ),
        (
            Method::PUT,
            format!("/api/v1/users/{OWNER}/roles"),
            Some(json!({ "roleIds": [9502] })),
        ),
        (
            Method::DELETE,
            format!("/api/v1/members/{OWNER}"),
            Some(json!({ "reassign_to": ADMIN2 })),
        ),
    ] {
        let r = call(&a, method.clone(), &path, Some(ADMIN2), body).await;
        assert_eq!(r.status, 403, "{method} {path}: {:?}", r.body);
    }
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM users WHERE id = {OWNER}")).await,
        "active"
    );
    teardown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn chuyen_quyen_chu() {
    setup().await;
    let a = app().await;
    // Quản trị không phải chủ ⇒ 403; thiếu/ sai user_id ⇒ 400; thành viên đã khoá ⇒ 400.
    let p = "/api/v1/members/transfer-owner";
    assert_eq!(
        call(&a, Method::POST, p, Some(ADMIN2), Some(json!({ "user_id": ADMIN2 })))
            .await
            .status,
        403
    );
    assert_eq!(
        call(&a, Method::POST, p, Some(OWNER), Some(json!({}))).await.status,
        400
    );
    assert_eq!(
        call(&a, Method::POST, p, Some(OWNER), Some(json!({ "user_id": OWNER })))
            .await
            .status,
        400
    );
    exec(&format!("UPDATE users SET status = 'locked' WHERE id = {MEMBER2}")).await;
    assert_eq!(
        call(&a, Method::POST, p, Some(OWNER), Some(json!({ "user_id": MEMBER2 })))
            .await
            .status,
        400
    );

    // Chuyển cho một Thành viên đang hoạt động: người đó thành chủ (và Quản trị), chủ cũ còn là Quản trị.
    let r = call(&a, Method::POST, p, Some(OWNER), Some(json!({ "user_id": MEMBER }))).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    let l = call(&a, Method::GET, "/api/v1/members", Some(MEMBER), None).await;
    assert_eq!(l.body["owner_id"], json!(MEMBER));
    assert_eq!(role_of(&l.body, MEMBER), json!("owner"));
    assert_eq!(role_of(&l.body, OWNER), json!("admin"));
    // Chủ cũ không còn chuyển quyền được.
    assert_eq!(
        call(&a, Method::POST, p, Some(OWNER), Some(json!({ "user_id": ADMIN2 })))
            .await
            .status,
        403
    );
    teardown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn xoa_thanh_vien_chuyen_du_lieu_cho_nguoi_chon() {
    setup().await;
    let a = app().await;
    exec(&format!(
        "INSERT INTO contacts (id, phone, assigned_to, updated_at) VALUES (950101, '0911000001', {MEMBER}, now()), (950102, '0911000002', {MEMBER}, now()), (950103, '0911000003', {OWNER}, now());
         INSERT INTO deals (id, title, assigned_to, created_by, updated_at) VALUES (950101, 'Deal A', {MEMBER}, {MEMBER}, now());"
    ))
    .await;
    let path = format!("/api/v1/members/{MEMBER}");
    // Bắt buộc chọn người nhận; không nhận chính mình; người nhận phải còn hoạt động.
    assert_eq!(
        call(&a, Method::DELETE, &path, Some(OWNER), Some(json!({})))
            .await
            .status,
        400
    );
    assert_eq!(
        call(
            &a,
            Method::DELETE,
            &path,
            Some(OWNER),
            Some(json!({ "reassign_to": MEMBER }))
        )
        .await
        .status,
        400
    );
    exec(&format!("UPDATE users SET status = 'locked' WHERE id = {MEMBER2}")).await;
    assert_eq!(
        call(
            &a,
            Method::DELETE,
            &path,
            Some(OWNER),
            Some(json!({ "reassign_to": MEMBER2 }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        scalar::<i64>(&format!("SELECT count(*) FROM contacts WHERE assigned_to = {MEMBER}")).await,
        2,
        "lỗi 400 không được đổi dữ liệu"
    );
    // Không tự xoá mình; Thành viên không xoá được ai (403).
    assert_eq!(
        call(
            &a,
            Method::DELETE,
            &format!("/api/v1/members/{OWNER}"),
            Some(OWNER),
            Some(json!({ "reassign_to": ADMIN2 }))
        )
        .await
        .status,
        403
    );

    let r = call(
        &a,
        Method::DELETE,
        &path,
        Some(OWNER),
        Some(json!({ "reassign_to": ADMIN2 })),
    )
    .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(
        scalar::<i64>(&format!("SELECT count(*) FROM contacts WHERE assigned_to = {ADMIN2}")).await,
        2
    );
    assert_eq!(
        scalar::<i64>(&format!("SELECT count(*) FROM contacts WHERE assigned_to = {OWNER}")).await,
        1,
        "khách của người khác giữ nguyên"
    );
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM deals WHERE assigned_to = {ADMIN2} AND id = 950101"
        ))
        .await,
        1
    );
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM users WHERE id = {MEMBER} AND deleted_at IS NOT NULL"
        ))
        .await,
        1
    );
    // Người bị xoá biến khỏi danh sách; không đăng nhập lại vào API được.
    let l = call(&a, Method::GET, "/api/v1/members", Some(OWNER), None).await;
    assert_eq!(role_of(&l.body, MEMBER), Value::Null);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cong_ty_moi_chua_co_vai_tro_thanh_vien_thi_tao_luoi_mot_lan() {
    setup().await;
    exec(&format!(
        "DELETE FROM user_roles WHERE role_id = 9502; DELETE FROM role_permissions WHERE role_id = 9502; DELETE FROM roles WHERE id = 9502;
         INSERT INTO user_roles (user_id, role_id) VALUES ({MEMBER}, 9501), ({MEMBER2}, 9501)"
    ))
    .await;
    let a = app().await;
    // Hai lần gọi đồng thời vẫn chỉ một dòng.
    let (r1, r2) = tokio::join!(
        call(&a, Method::GET, "/api/v1/members", Some(OWNER), None),
        call(&a, Method::GET, "/api/v1/members", Some(ADMIN2), None)
    );
    assert_eq!(
        (r1.status.as_u16(), r2.status.as_u16()),
        (200, 200),
        "{:?} {:?}",
        r1.body,
        r2.body
    );
    let id = r1.body["roles"]["member_role_id"]
        .as_i64()
        .expect("đã tạo vai trò Thành viên");
    assert_eq!(r2.body["roles"]["member_role_id"].as_i64(), Some(id));
    assert_eq!(
        r1.body["roles"]["admin_role_id"].as_i64(),
        Some(scalar::<i32>("SELECT min(id) FROM roles WHERE is_system").await.into())
    );
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM roles WHERE description = '{}'",
            trinity_rbac::fixed_roles::MEMBER_ROLE_MARK
        ))
        .await,
        1
    );
    // Đổi một Quản trị xuống Thành viên dùng đúng vai trò đó.
    let r = call(
        &a,
        Method::PUT,
        &format!("/api/v1/members/{MEMBER}/role"),
        Some(OWNER),
        Some(json!({ "role": "member" })),
    )
    .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT role_id::bigint FROM user_roles WHERE user_id = {MEMBER}"
        ))
        .await,
        id
    );
    exec(&format!("DELETE FROM user_roles WHERE role_id = {id}; DELETE FROM role_permissions WHERE role_id = {id}; DELETE FROM roles WHERE id = {id}")).await;
    teardown().await;
}
