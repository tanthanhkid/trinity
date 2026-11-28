//! «Sửa giờ công kèm lý do» qua HTTP (router K14 thật, quyền thật, Postgres thật). DB cần schema + migration 0030 (`attendance_edits`):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-attendance --test adjust_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9841..9849 (và mọi dòng liên quan).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_attendance::routes::router;
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
use trinity_storage::LocalUploadsStore;

const JWT: &str = "adjust-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/management/attendance";
const MGR: i32 = 9841; // attendance.view + attendance.manage, phạm vi all
const EMP: i32 = 9842; // nhân viên, không quyền nào
const OTHER: i32 = 9843; // nhân viên khác, không quyền nào
const OWN: i32 = 9844; // quản lý có attendance.manage/view chỉ phạm vi `own` (không thấy EMP)
const STORE: &str = "trinity-adjust-uploads";

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
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (r, _table) = router(deps).into_parts();
    r.with_state(ctx)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@adjust.test"), None, None, now),
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
        "DELETE FROM attendance_edits WHERE user_id BETWEEN 9841 AND 9849;
          DELETE FROM attendance_records WHERE user_id BETWEEN 9841 AND 9849;
          DELETE FROM employees WHERE user_id BETWEEN 9841 AND 9849;
          DELETE FROM user_roles WHERE user_id BETWEEN 9841 AND 9849;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9841 AND 9849;
          DELETE FROM roles WHERE id BETWEEN 9841 AND 9849;
          DELETE FROM users WHERE id BETWEEN 9841 AND 9849",
    )
    .await;
}

async fn setup() {
    teardown().await;
    // Trigger của `users` ghi `platform.company_logins` (khoá ngoại tới công ty 1).
    exec("INSERT INTO platform.companies (id, name, schema_name) VALUES (1, 'c1', 'public') ON CONFLICT DO NOTHING")
        .await;
    for (id, name) in [
        (MGR, "Quản lý"),
        (EMP, "Nhân viên"),
        (OTHER, "Nhân viên khác"),
        (OWN, "Quản lý hẹp"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@adjust.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec("INSERT INTO employees (user_id, position, status, joined_at) VALUES (9842, 'Nhân viên', 'active', now()), (9843, 'Nhân viên', 'active', now());
          INSERT INTO roles (id, name, is_system, updated_at) VALUES (9841, 'adjust-mgr', false, now()), (9842, 'adjust-own', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9841, 'attendance.view', 'all'), (9841, 'attendance.manage', 'all'),
            (9841, 'attendance.export', 'all'),
            (9842, 'attendance.view', 'own'), (9842, 'attendance.manage', 'own');
          INSERT INTO user_roles (user_id, role_id) VALUES (9841, 9841), (9844, 9842)")
        .await;
}

const DAY: &str = "2026-06-17";

async fn seed_record() -> i32 {
    exec(&format!(
        "INSERT INTO attendance_records (user_id, work_date, check_in_at, check_out_at, status, updated_at)
          VALUES (9842, '{DAY}', '{DAY} 01:30:00+00', '{DAY} 10:30:00+00', 'present', now())"
    ))
    .await;
    scalar(&format!(
        "SELECT id FROM attendance_records WHERE user_id = 9842 AND work_date = '{DAY}'"
    ))
    .await
}

async fn edit_count(id: i32) -> i64 {
    scalar(&format!("SELECT count(*) FROM attendance_edits WHERE record_id = {id}")).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn sua_gio_cong_kem_ly_do_va_lich_su() {
    setup().await;
    let a = app().await;
    let id = seed_record().await;
    let url = format!("{B}/{id}/edits");
    let ok_body = json!({ "check_in": "08:00", "reason": "Đối chiếu camera cửa hàng" });

    // Không đăng nhập 401; không quyền 403 (đọc lẫn ghi).
    assert_eq!(call(&a, Method::GET, &url, None, None).await.status, 401);
    assert_eq!(
        call(&a, Method::POST, &url, None, Some(ok_body.clone())).await.status,
        401
    );
    assert_eq!(call(&a, Method::GET, &url, Some(EMP), None).await.status, 403);
    assert_eq!(
        call(&a, Method::POST, &url, Some(EMP), Some(ok_body.clone()))
            .await
            .status,
        403
    );

    // Body sai ⇒ 400, không ghi lịch sử, không đổi giờ.
    for bad in [
        json!({}),
        json!({ "check_in": "08:00" }),
        json!({ "reason": "x" }),
        json!({ "check_in": "08:00", "reason": "   " }),
        json!({ "check_in": "08:00", "reason": null }),
        json!({ "check_in": "8h", "reason": "x" }),
        json!({ "check_in": "25:00", "reason": "x" }),
        json!({ "check_in": null, "reason": "x" }),
        json!({ "check_in": "08:00", "reason": "x", "la": 1 }),
        json!({ "check_in": "08:00", "reason": "a".repeat(501) }),
    ] {
        let r = call(&a, Method::POST, &url, Some(MGR), Some(bad.clone())).await;
        assert_eq!(r.status, 400, "{bad}: {:?}", r.body);
    }
    assert_eq!(edit_count(id).await, 0);

    // Giờ ra không sau giờ vào ⇒ 400; giờ không đổi ⇒ 400.
    for bad in [
        json!({ "check_in": "18:00", "reason": "x" }),
        json!({ "check_out": "08:30", "reason": "x" }),
        json!({ "check_in": "08:30", "check_out": "17:30", "reason": "x" }),
    ] {
        let r = call(&a, Method::POST, &url, Some(MGR), Some(bad.clone())).await;
        assert_eq!(r.status, 400, "{bad}: {:?}", r.body);
    }
    assert_eq!(edit_count(id).await, 0);

    // Sửa giờ vào 08:30 → 08:00 (giờ VN): 201, bản ghi đổi, lịch sử có người sửa + lý do + giờ cũ/mới.
    let r = call(&a, Method::POST, &url, Some(MGR), Some(ok_body)).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    assert_eq!(r.body["record"]["check_in_at"], format!("{DAY}T01:00:00.000Z"));
    assert_eq!(r.body["record"]["check_out_at"], format!("{DAY}T10:30:00.000Z"));
    assert_eq!(r.body["record"]["late_minutes"], 0);
    assert_eq!(r.body["record"]["total_hours"], 8.0);
    assert_eq!(r.body["edit"]["editor_id"], MGR);
    assert_eq!(r.body["edit"]["editor_name"], "Quản lý");
    assert_eq!(r.body["edit"]["reason"], "Đối chiếu camera cửa hàng");
    assert_eq!(r.body["edit"]["old_check_in_at"], format!("{DAY}T01:30:00.000Z"));
    assert_eq!(r.body["edit"]["new_check_in_at"], format!("{DAY}T01:00:00.000Z"));
    assert_eq!(edit_count(id).await, 1);

    // Sửa lần hai (giờ ra, lý do cắt khoảng trắng): có thêm một dòng, danh sách mới nhất trước.
    let r2 = call(
        &a,
        Method::POST,
        &url,
        Some(MGR),
        Some(json!({ "check_out": "17:00", "check_in": "9:15", "reason": "  Nhân viên báo muộn  " })),
    )
    .await;
    assert_eq!(r2.status, 201, "{:?}", r2.body);
    assert!(r2.body["record"]["late_minutes"].as_i64().unwrap() > 0, "{:?}", r2.body);
    assert_eq!(r2.body["edit"]["reason"], "Nhân viên báo muộn");
    let l = call(&a, Method::GET, &url, Some(MGR), None).await;
    assert_eq!(l.status, 200, "{:?}", l.body);
    let rows = l.body.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["reason"], "Nhân viên báo muộn");
    assert_eq!(rows[0]["old_check_out_at"], format!("{DAY}T10:30:00.000Z"));
    assert_eq!(rows[1]["reason"], "Đối chiếu camera cửa hàng");
    // Chi tiết bản ghi (API cũ) thấy giờ mới.
    let d = call(&a, Method::GET, &format!("{B}/{id}"), Some(MGR), None).await;
    assert_eq!(d.body["check_out_at"], format!("{DAY}T10:00:00.000Z"));

    // Ngoài phạm vi (own) và id lạ ⇒ 404; id không toàn chữ số không khớp route.
    assert_eq!(call(&a, Method::GET, &url, Some(OWN), None).await.status, 404);
    assert_eq!(
        call(
            &a,
            Method::POST,
            &url,
            Some(OWN),
            Some(json!({ "check_in": "07:00", "reason": "x" }))
        )
        .await
        .status,
        404
    );
    assert_eq!(edit_count(id).await, 2);
    assert_eq!(
        call(
            &a,
            Method::POST,
            &format!("{B}/2000000000/edits"),
            Some(MGR),
            Some(json!({ "check_in": "07:00", "reason": "x" }))
        )
        .await
        .status,
        404
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/abc/edits"), Some(MGR), None)
            .await
            .status,
        404
    );

    // PATCH cũ vẫn chạy và không vào lịch sử (không có lý do).
    let p = call(
        &a,
        Method::PATCH,
        &format!("{B}/{id}"),
        Some(MGR),
        Some(json!({ "check_in_note": "ghi chú" })),
    )
    .await;
    assert_eq!(p.status, 200, "{:?}", p.body);
    assert_eq!(edit_count(id).await, 2);

    // Xoá bản ghi ⇒ lịch sử đi theo.
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/{id}"), Some(MGR), None)
            .await
            .status,
        200
    );
    assert_eq!(edit_count(id).await, 0);
    teardown().await;
}

/// Lõi dùng chung với tool MCP: tìm bản ghi theo nhân viên + ngày, trong phạm vi.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tim_ban_ghi_theo_nhan_vien_va_ngay() {
    use mod_attendance::adjust::find_record_id;
    use trinity_rbac::OwnerIds;
    setup().await;
    let id = seed_record().await;
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let day = chrono::NaiveDate::from_ymd_opt(2026, 6, 17).unwrap();
    assert_eq!(find_record_id(&mut c, &OwnerIds::All, EMP, day).await.unwrap(), id);
    assert!(
        find_record_id(&mut c, &OwnerIds::Ids(vec![OTHER]), EMP, day)
            .await
            .is_err()
    );
    assert!(
        find_record_id(
            &mut c,
            &OwnerIds::All,
            EMP,
            chrono::NaiveDate::from_ymd_opt(2026, 6, 18).unwrap()
        )
        .await
        .is_err()
    );
    teardown().await;
}
