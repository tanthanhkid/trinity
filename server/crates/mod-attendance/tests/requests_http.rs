//! M14a qua HTTP (router K14 thật, quyền thật, Postgres thật): đơn chấm công (tạo, danh sách, duyệt, từ chối). `public` đã migrate:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-attendance --test requests_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9821..9829 (và mọi dòng liên quan).

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

const JWT: &str = "m14a-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/management/attendance";
const MGR: i32 = 9821; // attendance.view + attendance.manage, phạm vi all
const EMP: i32 = 9822; // nhân viên, không quyền nào
const OTHER: i32 = 9823; // nhân viên khác, không quyền nào

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
        uploads: LocalUploadsStore::new(std::env::temp_dir().join("trinity-m14a-uploads")),
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
        &Claims::access(i64::from(user), &format!("u{user}@m14a.test"), None, None, now),
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
        "DELETE FROM attendance_requests WHERE user_id BETWEEN 9821 AND 9829;
          DELETE FROM attendance_records WHERE user_id BETWEEN 9821 AND 9829;
          DELETE FROM notification_logs WHERE recipient_id BETWEEN 9821 AND 9829;
          DELETE FROM employees WHERE user_id BETWEEN 9821 AND 9829;
          DELETE FROM user_roles WHERE user_id BETWEEN 9821 AND 9829;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9821 AND 9829;
          DELETE FROM roles WHERE id BETWEEN 9821 AND 9829;
          DELETE FROM settings WHERE key = 'attendance_request_config';
          DELETE FROM users WHERE id BETWEEN 9821 AND 9829",
    )
    .await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [(MGR, "Quản lý"), (EMP, "Nhân viên"), (OTHER, "Nhân viên khác")] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@m14a.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec("INSERT INTO employees (user_id, position, status, joined_at) VALUES (9822, 'Nhân viên', 'active', now()), (9823, 'Nhân viên', 'active', now());
          INSERT INTO roles (id, name, is_system, updated_at) VALUES (9821, 'm14a-mgr', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9821, 'attendance.view', 'all'), (9821, 'attendance.manage', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9821, 9821)")
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn don_tu_tao_danh_sach_duyet_tu_choi() {
    setup().await;
    let a = app().await;
    let q = format!("{B}/requests");
    assert_eq!(call(&a, Method::POST, &q, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, &q, Some(EMP), None).await.status, 403);

    // Kiểm đầu vào: thiếu trường, loại sai, giờ sai dạng, lý do rỗng, null ở trường bắt buộc, trường lạ.
    for bad in [
        json!({ "type": "leave", "reason": "x" }),
        json!({ "work_date": "2026-06-17", "type": "khac", "reason": "x" }),
        json!({ "work_date": "17/06/2026", "type": "leave", "reason": "x" }),
        json!({ "work_date": "2026-06-17", "type": "forgot_check_in", "requested_check_in": "8:5", "reason": "x" }),
        json!({ "work_date": "2026-06-17", "type": "leave", "reason": "" }),
        json!({ "work_date": "2026-06-17", "type": "leave", "reason": null }),
        json!({ "work_date": "2026-06-17", "type": "leave", "reason": "x", "la": 1 }),
    ] {
        assert_eq!(
            call(&a, Method::POST, &q, Some(EMP), Some(bad.clone())).await.status,
            400,
            "{bad}"
        );
    }
    // Quên check-in mà không có giờ đề nghị ⇒ 400 theo nghiệp vụ.
    let miss = call(
        &a,
        Method::POST,
        &q,
        Some(EMP),
        Some(json!({ "work_date": "2026-06-17", "type": "forgot_check_in", "reason": "quên" })),
    )
    .await;
    assert_eq!(miss.status, 400);

    // Tạo đơn nghỉ phép: 201, pending, tên người gửi; người giữ attendance.manage nhận thông báo.
    let c = call(
        &a,
        Method::POST,
        &q,
        Some(EMP),
        Some(json!({ "work_date": "2026-06-17", "type": "leave", "reason": "Việc gia đình" })),
    )
    .await;
    assert_eq!(c.status, 201, "{:?}", c.body);
    assert_eq!(c.body["status"], "pending");
    assert_eq!(c.body["user_name"], "Nhân viên");
    assert_eq!(c.body["work_date"], "2026-06-17");
    assert_eq!(c.body["team_name"], Value::Null);
    let leave_id = c.body["id"].as_i64().unwrap();
    let notified: i64 = scalar(
        "SELECT count(*) FROM notification_logs WHERE recipient_id = 9821 AND event_type = 'attendance.request.created'",
    )
    .await;
    assert_eq!(notified, 1);

    // Hạn mức tháng: quên chấm công mặc định 2 lần/tháng; lần thứ ba bị chặn, 0 = không giới hạn.
    for _ in 0..2 {
        let r = call(
            &a,
            Method::POST,
            &q,
            Some(OTHER),
            Some(json!({ "work_date": "2026-06-10", "type": "forgot_check_out", "requested_check_out": "18:00", "reason": "quên" })),
        )
        .await;
        assert_eq!(r.status, 201, "{:?}", r.body);
    }
    let over = call(
        &a,
        Method::POST,
        &q,
        Some(OTHER),
        Some(json!({ "work_date": "2026-06-11", "type": "forgot_check_out", "requested_check_out": "18:00", "reason": "quên" })),
    )
    .await;
    assert_eq!(over.status, 400);
    // Sang tháng khác thì không tính chung.
    let next = call(
        &a,
        Method::POST,
        &q,
        Some(OTHER),
        Some(json!({ "work_date": "2026-07-01", "type": "forgot_check_out", "requested_check_out": "18:00", "reason": "quên" })),
    )
    .await;
    assert_eq!(next.status, 201);

    // Danh sách: lọc theo trạng thái, phân trang, tên người gửi; số lẻ/chữ ở page ⇒ 400.
    let all = call(&a, Method::GET, &format!("{q}?page_size=2"), Some(MGR), None).await;
    assert_eq!(all.status, 200);
    assert_eq!(all.body["total"], 4);
    assert_eq!(all.body["page"], 1);
    assert_eq!(all.body["page_size"], 2);
    assert_eq!(all.body["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&a, Method::GET, &format!("{q}?status=approved"), Some(MGR), None)
            .await
            .body["total"],
        0
    );
    for bad in ["page=abc", "page=1.5", "status=xx", "team_id=0", "foo=1"] {
        assert_eq!(
            call(&a, Method::GET, &format!("{q}?{bad}"), Some(MGR), None)
                .await
                .status,
            400,
            "{bad}"
        );
    }

    // Duyệt đơn nghỉ phép: ghi bản ghi chấm công đủ 8 giờ, trạng thái leave; duyệt lại ⇒ 400; không quyền ⇒ 403; id lạ ⇒ 404.
    assert_eq!(
        call(&a, Method::POST, &format!("{q}/{leave_id}/approve"), Some(EMP), None)
            .await
            .status,
        403
    );
    assert_eq!(
        call(&a, Method::POST, &format!("{q}/999999/approve"), Some(MGR), None)
            .await
            .status,
        404
    );
    let ap = call(&a, Method::POST, &format!("{q}/{leave_id}/approve"), Some(MGR), None).await;
    assert_eq!(ap.status, 201, "{:?}", ap.body);
    assert_eq!(ap.body["status"], "approved");
    assert_eq!(ap.body["reviewer_name"], "Quản lý");
    let (status, hours): (String, f64) = {
        let s: String =
            scalar("SELECT status FROM attendance_records WHERE user_id = 9822 AND work_date = '2026-06-17'").await;
        let h: f64 =
            scalar("SELECT total_hours FROM attendance_records WHERE user_id = 9822 AND work_date = '2026-06-17'")
                .await;
        (s, h)
    };
    assert_eq!((status.as_str(), hours), ("leave", 8.0));
    assert_eq!(
        call(&a, Method::POST, &format!("{q}/{leave_id}/approve"), Some(MGR), None)
            .await
            .status,
        400
    );

    // Duyệt đơn quên check-out: 18:00 giờ VN = 11:00 UTC.
    let fo: i64 = scalar(
        "SELECT id FROM attendance_requests WHERE user_id = 9823 AND work_date = '2026-06-10' ORDER BY id LIMIT 1",
    )
    .await;
    let ap = call(&a, Method::POST, &format!("{q}/{fo}/approve"), Some(MGR), None).await;
    assert_eq!(ap.status, 201, "{:?}", ap.body);
    let out_utc: String = scalar(
        "SELECT to_char(check_out_at AT TIME ZONE 'UTC', 'HH24:MI') FROM attendance_records WHERE user_id = 9823 AND work_date = '2026-06-10'",
    )
    .await;
    assert_eq!(out_utc, "11:00");

    // Từ chối: ghi chú tối đa 500 ký tự; null/không gửi ⇒ không ghi chú.
    let other_id: i64 =
        scalar("SELECT id FROM attendance_requests WHERE user_id = 9823 AND work_date = '2026-07-01'").await;
    let long = "x".repeat(501);
    assert_eq!(
        call(
            &a,
            Method::POST,
            &format!("{q}/{other_id}/reject"),
            Some(MGR),
            Some(json!({ "review_note": long }))
        )
        .await
        .status,
        400
    );
    let rj = call(
        &a,
        Method::POST,
        &format!("{q}/{other_id}/reject"),
        Some(MGR),
        Some(json!({ "review_note": "Thiếu bằng chứng" })),
    )
    .await;
    assert_eq!(rj.status, 201, "{:?}", rj.body);
    assert_eq!(rj.body["status"], "rejected");
    assert_eq!(rj.body["review_note"], "Thiếu bằng chứng");
    // Đơn bị từ chối không tính vào hạn mức tháng 7.
    let again = call(
        &a,
        Method::POST,
        &q,
        Some(OTHER),
        Some(json!({ "work_date": "2026-07-02", "type": "forgot_check_out", "requested_check_out": "18:00", "reason": "quên" })),
    )
    .await;
    assert_eq!(again.status, 201);
    teardown().await;
}
