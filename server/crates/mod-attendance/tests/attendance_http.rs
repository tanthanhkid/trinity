//! M13a qua HTTP (router K14 thật, quyền thật, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-attendance --test attendance_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9801..9899 (và mọi dòng liên quan).

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

const JWT: &str = "m13a-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/management/attendance";

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
        uploads: LocalUploadsStore::new(std::env::temp_dir().join("trinity-m13a-uploads")),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (r, table) = router(deps).into_parts();
    assert_eq!(table.len(), 11);
    r.with_state(ctx)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m13a.test"), None, None, now),
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

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

const CFG: i32 = 9801; // attendance.view all + attendance.config
const VIEW: i32 = 9802; // attendance.view all
const NOBODY: i32 = 9803; // không quyền nào
const EMP: i32 = 9804; // nhân viên có thiết bị đã đăng ký

async fn teardown() {
    exec("DELETE FROM attendance_offices WHERE name LIKE 'm13a%';
          DELETE FROM employees WHERE user_id BETWEEN 9801 AND 9899;
          DELETE FROM user_roles WHERE user_id BETWEEN 9801 AND 9899;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9801 AND 9899;
          DELETE FROM roles WHERE id BETWEEN 9801 AND 9899;
          DELETE FROM settings WHERE key IN ('attendance_shift_config', 'attendance_request_config', 'attendance_working_saturdays');
          DELETE FROM users WHERE id BETWEEN 9801 AND 9899")
        .await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [
        (CFG, "Cấu hình"),
        (VIEW, "Chỉ xem"),
        (NOBODY, "Không quyền"),
        (EMP, "Nhân viên"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@m13a.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec("INSERT INTO employees (user_id, position, status, joined_at, registered_device_id, device_registered_at)
          VALUES (9804, 'Nhân viên', 'active', now(), 'thiet-bi-cu', now());
          INSERT INTO roles (id, name, is_system, updated_at) VALUES (9801, 'm13a-cfg', false, now()), (9802, 'm13a-view', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9801, 'attendance.view', 'all'), (9801, 'attendance.config', NULL), (9802, 'attendance.view', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9801, 9801), (9802, 9802)")
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn van_phong_quyen_kiem_dau_vao_va_dat_lai_thiet_bi() {
    setup().await;
    let a = app().await;
    let o = format!("{B}/offices");
    assert_eq!(call(&a, Method::GET, &o, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, &o, Some(NOBODY), None).await.status, 403);
    assert_eq!(call(&a, Method::GET, &o, Some(VIEW), None).await.status, 200);
    assert_eq!(
        call(
            &a,
            Method::POST,
            &o,
            Some(VIEW),
            Some(json!({ "name": "m13a x", "ips": ["1.1.1.1"] }))
        )
        .await
        .status,
        403
    );

    // Kiểm đầu vào: tên rỗng, ips rỗng/không phải chuỗi, trường lạ.
    for bad in [
        json!({ "name": "", "ips": ["1.1.1.1"] }),
        json!({ "name": "m13a x", "ips": [] }),
        json!({ "name": "m13a x", "ips": [1, 2] }),
        json!({ "name": "m13a x", "ips": ["1.1.1.1"], "la": 1 }),
        json!({ "name": "m13a x", "ips": ["1.1.1.1"], "is_active": null }),
    ] {
        assert_eq!(
            call(&a, Method::POST, &o, Some(CFG), Some(bad.clone())).await.status,
            400,
            "{bad}"
        );
    }

    // Tạo: mặc định hoạt động, không demo; mô tả trống ⇒ null.
    let c = call(
        &a,
        Method::POST,
        &o,
        Some(CFG),
        Some(json!({ "name": "m13a Hà Nội", "ips": ["203.0.113.1", "203.0.113.2"] })),
    )
    .await;
    assert_eq!(c.status, 201, "{:?}", c.body);
    assert_eq!(
        (
            c.body["is_active"].clone(),
            c.body["is_demo"].clone(),
            c.body["description"].clone()
        ),
        (json!(true), json!(false), Value::Null)
    );
    assert_eq!(c.body["ips"], json!(["203.0.113.1", "203.0.113.2"]));
    let id = c.body["id"].as_i64().unwrap();
    call(
        &a,
        Method::POST,
        &o,
        Some(CFG),
        Some(json!({ "name": "m13a An Giang", "description": "Chi nhánh", "ips": ["10.0.0.1"], "is_demo": true })),
    )
    .await;
    let names: Vec<String> = call(&a, Method::GET, &o, Some(VIEW), None)
        .await
        .body
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|x| x["name"].as_str().map(str::to_owned))
        .filter(|n| n.starts_with("m13a"))
        .collect();
    assert_eq!(names, ["m13a An Giang", "m13a Hà Nội"], "xếp theo tên");

    // Sửa: chỉ trường gửi đổi; description null xoá; null ở trường bắt buộc ⇒ 400, không xoá giá trị cũ.
    let p = call(
        &a,
        Method::PATCH,
        &format!("{o}/{id}"),
        Some(CFG),
        Some(json!({ "description": "Trụ sở", "is_active": false })),
    )
    .await;
    assert_eq!(
        (
            p.body["description"].clone(),
            p.body["is_active"].clone(),
            p.body["name"].clone()
        ),
        (json!("Trụ sở"), json!(false), json!("m13a Hà Nội"))
    );
    let cleared = call(
        &a,
        Method::PATCH,
        &format!("{o}/{id}"),
        Some(CFG),
        Some(json!({ "description": null })),
    )
    .await;
    assert_eq!(cleared.body["description"], Value::Null);
    for bad in [
        json!({ "name": null }),
        json!({ "ips": null }),
        json!({ "ips": [] }),
        json!({ "is_active": null }),
    ] {
        assert_eq!(
            call(&a, Method::PATCH, &format!("{o}/{id}"), Some(CFG), Some(bad.clone()))
                .await
                .status,
            400,
            "{bad}"
        );
    }
    let keep = call(&a, Method::PATCH, &format!("{o}/{id}"), Some(CFG), Some(json!({}))).await;
    assert_eq!(keep.body["ips"], json!(["203.0.113.1", "203.0.113.2"]));
    let nf = call(&a, Method::PATCH, &format!("{o}/999999"), Some(CFG), Some(json!({}))).await;
    assert_eq!(
        (nf.status.as_u16(), msg(&nf)),
        (404, "Không tìm thấy văn phòng.".to_owned())
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{o}/99999999999"),
            Some(CFG),
            Some(json!({}))
        )
        .await
        .status,
        404,
        "id ngoài int4 ⇒ 404"
    );
    assert_eq!(
        call(&a, Method::PATCH, &format!("{o}/abc"), Some(CFG), Some(json!({})))
            .await
            .status,
        400
    );

    // Xoá.
    assert_eq!(
        call(&a, Method::DELETE, &format!("{o}/{id}"), Some(CFG), None)
            .await
            .body,
        json!({ "ok": true })
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{o}/{id}"), Some(CFG), None)
            .await
            .status,
        404
    );

    // Đặt lại thiết bị.
    let reset = format!("{B}/reset-device/{EMP}");
    assert_eq!(call(&a, Method::POST, &reset, Some(VIEW), None).await.status, 403);
    let r = call(&a, Method::POST, &reset, Some(CFG), None).await;
    assert_eq!(
        (r.status.as_u16(), r.body.clone()),
        (201, json!({ "ok": true, "user_id": EMP }))
    );
    let dev: Option<String> = scalar(&format!(
        "SELECT registered_device_id FROM employees WHERE user_id = {EMP}"
    ))
    .await;
    assert_eq!(dev, None);
    let none = call(&a, Method::POST, &format!("{B}/reset-device/{NOBODY}"), Some(CFG), None).await;
    assert_eq!(
        (none.status.as_u16(), msg(&none)),
        (404, "Không tìm thấy hồ sơ nhân viên.".to_owned())
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cau_hinh_ca_thu_bay_va_gioi_han_don() {
    setup().await;
    let a = app().await;
    let (s, w, r) = (
        format!("{B}/settings"),
        format!("{B}/working-saturdays"),
        format!("{B}/request-config"),
    );
    // Đọc cần đăng nhập, không cần quyền; ghi cần attendance.config.
    for p in [&s, &w, &r] {
        assert_eq!(call(&a, Method::GET, p, None, None).await.status, 401);
        assert_eq!(call(&a, Method::GET, p, Some(NOBODY), None).await.status, 200);
        assert_eq!(
            call(&a, Method::PATCH, p, Some(VIEW), Some(json!({}))).await.status,
            403
        );
    }

    // Ca làm việc: mặc định, rồi lưu và trộn (nghỉ trưa/ngưỡng không gửi giữ cũ).
    let d = call(&a, Method::GET, &s, Some(NOBODY), None).await.body;
    assert_eq!(
        (
            d["work_start"].clone(),
            d["lunch_end"].clone(),
            d["half_day_min_hours"].clone()
        ),
        (json!("08:00"), json!("13:30"), json!(4))
    );
    let ok = call(
        &a,
        Method::PATCH,
        &s,
        Some(CFG),
        Some(json!({ "work_start": "07:30", "work_end": "16:30", "late_after": "07:40", "half_day_min_hours": 3.5 })),
    )
    .await;
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    assert_eq!(
        (
            ok.body["lunch_start"].clone(),
            ok.body["half_day_min_hours"].clone(),
            ok.body["full_day_min_hours"].clone()
        ),
        (json!("12:00"), json!(3.5), json!(8))
    );
    assert_eq!(call(&a, Method::GET, &s, Some(NOBODY), None).await.body, ok.body);
    // Nghỉ trưa đảo ngược / ngưỡng không tăng dần ⇒ 400 đúng câu; DTO sai ⇒ 400.
    let inv = call(&a, Method::PATCH, &s, Some(CFG), Some(json!({ "work_start": "08:00", "work_end": "17:00", "late_after": "08:10", "lunch_start": "13:00", "lunch_end": "12:00" }))).await;
    assert_eq!(
        (inv.status.as_u16(), msg(&inv)),
        (400, "Giờ kết thúc nghỉ trưa phải sau giờ bắt đầu.".to_owned())
    );
    let thr = call(&a, Method::PATCH, &s, Some(CFG), Some(json!({ "work_start": "08:00", "work_end": "17:00", "late_after": "08:10", "review_max_hours": 5, "half_day_min_hours": 4, "full_day_min_hours": 8 }))).await;
    assert_eq!(thr.status, 400);
    assert!(msg(&thr).contains("Ngưỡng giờ phải tăng dần"));
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &s,
            Some(CFG),
            Some(json!({ "work_start": "8:00", "work_end": "17:00", "late_after": "08:10" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(&a, Method::GET, &s, Some(NOBODY), None).await.body,
        ok.body,
        "lỗi không làm đổi cấu hình"
    );

    // Thứ 7: chỉ giữ ngày ĐÚNG thứ 7, bỏ trùng, sắp xếp; sai dạng ⇒ 400.
    assert_eq!(
        call(&a, Method::GET, &w, Some(NOBODY), None).await.body,
        json!({ "dates": [] })
    );
    let sat = call(
        &a,
        Method::PATCH,
        &w,
        Some(CFG),
        Some(json!({ "dates": ["2026-06-20", "2026-06-07", "2026-06-06", "2026-06-20", "2026-02-31"] })),
    )
    .await;
    assert_eq!(sat.body, json!({ "dates": ["2026-06-06", "2026-06-20"] }));
    assert_eq!(call(&a, Method::GET, &w, Some(NOBODY), None).await.body, sat.body);
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &w,
            Some(CFG),
            Some(json!({ "dates": ["06/06/2026"] }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(&a, Method::PATCH, &w, Some(CFG), Some(json!({ "dates": "2026-06-06" })))
            .await
            .status,
        400
    );

    // Giới hạn đơn: mặc định, lưu; âm, lẻ, quá int4 ⇒ 400 và KHÔNG ghi đè.
    let rd = call(&a, Method::GET, &r, Some(NOBODY), None).await.body;
    assert_eq!(
        rd,
        json!({ "default_check_in": "08:00", "default_check_out": "17:30", "monthly_forgot_limit": 2, "monthly_late_early_limit": 3 })
    );
    let rs = call(&a, Method::PATCH, &r, Some(CFG), Some(json!({ "default_check_in": "08:15", "default_check_out": "17:45", "monthly_forgot_limit": "5", "monthly_late_early_limit": 0 }))).await;
    assert_eq!(
        rs.body,
        json!({ "default_check_in": "08:15", "default_check_out": "17:45", "monthly_forgot_limit": 5, "monthly_late_early_limit": 0 })
    );
    for lim in [json!(-1), json!(1.5), json!(3_000_000_000_i64), json!(1e300)] {
        let bad = call(&a, Method::PATCH, &r, Some(CFG), Some(json!({ "default_check_in": "08:00", "default_check_out": "17:00", "monthly_forgot_limit": lim, "monthly_late_early_limit": 1 }))).await;
        assert_eq!(bad.status, 400, "{lim}: {:?}", bad.body);
    }
    assert_eq!(call(&a, Method::GET, &r, Some(NOBODY), None).await.body, rs.body);
    teardown().await;
}
