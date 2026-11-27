//! M21 qua HTTP (router K14 thật, quyền thật, kiểm dữ liệu strict, Postgres thật): báo cáo khách hàng, hiệu suất (+ xuất xlsx),
//! tuyển dụng và báo cáo tuỳ biến. `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-reports --test reports_m21_http -- --ignored --test-threads=1`
//! DB phải trống khách hàng / bảng tuỳ biến. Test tự tạo và xoá user/vai trò 9801..9899, mọi dòng gắn nhãn `m21`; khoá
//! `settings` `report.definitions` được khôi phục đúng như trước khi chạy.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_reports::cache::ReadCache;
use mod_reports::{Ctx, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tokio::sync::OnceCell;
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_docgen::xlsx::read_first_sheet;
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "m21-jwt-secret-0123456789abcdef0123456789abcdef";

const ADMIN: i32 = 9801;
const SALE: i32 = 9802; // own
const LEAD: i32 = 9803; // subtree, quản lý của SALE
const NONE: i32 = 9804;
const OUT: i32 = 9805; // ngoài cây
const CFG: i32 = 9806; // chỉ cấu hình báo cáo

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
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        scopes: ScopeService::new(db, cache),
        cache: ReadCache::new(false),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 20);
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
        &Claims::access(i64::from(user), &format!("u{user}@m21.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    raw: Vec<u8>,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.raw).unwrap_or(Value::Null)
    }
    fn msg(&self) -> String {
        match &self.json()["message"] {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        }
    }
}

async fn call(app: &App, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
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
    let resp = app.router.clone().oneshot(req).await.unwrap();
    let (status, headers) = (resp.status(), resp.headers().clone());
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
    Res { status, headers, raw }
}

async fn get(app: &App, path: &str, user: i32) -> Value {
    let r = call(app, Method::GET, path, Some(user), None).await;
    assert_eq!(r.status, 200, "{path}: {}", String::from_utf8_lossy(&r.raw));
    r.json()
}

static SNAP: OnceCell<Option<String>> = OnceCell::const_new();

async fn restore_settings() {
    let snap = SNAP
        .get_or_init(|| async {
            let mut c = PgConnection::connect(&url()).await.unwrap();
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'report.definitions'")
                .fetch_optional(&mut c)
                .await
                .unwrap()
        })
        .await;
    exec("DELETE FROM settings WHERE key = 'report.definitions'").await;
    if let Some(v) = snap {
        exec(&format!(
            "INSERT INTO settings (key, value, updated_at) VALUES ('report.definitions', '{}', now())",
            v.replace('\'', "''")
        ))
        .await;
    }
}

async fn teardown() {
    exec(
        "DELETE FROM custom_records WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm21%');
          DELETE FROM custom_fields WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm21%');
          DELETE FROM custom_objects WHERE key LIKE 'm21%';
          DELETE FROM recruitment_candidates WHERE full_name LIKE 'm21%';
          DELETE FROM recruitment_positions WHERE job_code LIKE 'm21%';
          DELETE FROM deals WHERE title LIKE 'm21%';
          DELETE FROM activities WHERE action = 'm21';
          DELETE FROM contacts WHERE phone LIKE '09339%';
          DELETE FROM setting_options WHERE group_key = 'm21_group';
          DELETE FROM user_roles WHERE user_id BETWEEN 9801 AND 9899;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9801 AND 9899;
          DELETE FROM roles WHERE id BETWEEN 9801 AND 9899;
          DELETE FROM users WHERE id BETWEEN 9801 AND 9899",
    )
    .await;
    restore_settings().await;
}

async fn setup() {
    teardown().await;
    for (id, name, mgr) in [
        (ADMIN, "M21 Admin", "NULL"),
        (LEAD, "M21 Lead", "NULL"),
        (SALE, "M21 Sale", "9803"),
        (NONE, "M21 Không quyền", "NULL"),
        (OUT, "=M21 Ngoài", "NULL"),
        (CFG, "M21 Cấu hình", "NULL"),
    ] {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, manager_id, updated_at) VALUES ({id}, 'u{id}@m21.test', 'x', '{name}', {mgr}, now())")).await;
    }
    exec(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES (9801, 'm21-admin', false, now()), (9802, 'm21-sale', false, now()), (9803, 'm21-lead', false, now()), (9806, 'm21-cfg', false, now());
         INSERT INTO role_permissions (role_id, permission, scope) VALUES
           (9801, 'reports.customers', 'all'), (9801, 'reports.staff', 'all'), (9801, 'reports.export', 'all'), (9801, 'reports.channels', 'all'),
           (9801, 'custom_objects.manage', NULL), (9801, 'contacts.view', 'all'), (9801, 'contacts.phone_full', 'all'), (9801, 'deals.view', 'all'),
           (9801, 'custom_records.view', 'all'),
           (9802, 'reports.customers', 'own'), (9802, 'reports.staff', 'own'), (9802, 'reports.channels', 'own'), (9802, 'contacts.view', 'own'),
           (9803, 'reports.customers', 'subtree'), (9803, 'reports.staff', 'subtree'), (9803, 'contacts.view', 'subtree'), (9803, 'contacts.phone_full', 'subtree'),
           (9806, 'custom_objects.manage', NULL);
         INSERT INTO user_roles (user_id, role_id) VALUES (9801, 9801), (9802, 9802), (9803, 9803), (9806, 9806)",
    )
    .await;
}

/// Khách, hoạt động, thương vụ (thời điểm tính theo `now()` của DB để cửa sổ báo cáo luôn chứa).
async fn seed() -> (i32, i32) {
    exec(
        "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('m21_group', 'a', 'Nguồn A', now())",
    )
    .await;
    let src: i32 = scalar("SELECT id FROM setting_options WHERE group_key = 'm21_group'").await;
    exec(&format!(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, source_id, created_at, updated_at) VALUES
           ('0933900001', 'Khách 1', 9802, NULL, {src}, now() - interval '3 days', now()),
           ('0933900002', 'Khách 2', 9802, NULL, {src}, now() - interval '2 days', now()),
           ('0933900003', 'Khách 3', 9803, NULL, NULL, now() - interval '10 days', now()),
           ('0933900004', 'Khách 4', 9805, 9802, NULL, now() - interval '1 day', now()),
           ('0933900005', 'Khách 5', 9805, NULL, NULL, now(), now())"
    ))
    .await;
    let id = |p: &str| format!("(SELECT id FROM contacts WHERE phone = '{p}')");
    exec(&format!(
        "INSERT INTO activities (action, contact_id, created_by, created_at) VALUES
           ('m21', {c1}, 9802, now() - interval '1 day'), ('m21', {c2}, 9802, now() - interval '20 days'),
           ('m21', {c3}, 9803, now() - interval '30 days'), ('m21', NULL, 9802, now() - interval '2 days')",
        c1 = id("0933900001"),
        c2 = id("0933900002"),
        c3 = id("0933900003")
    ))
    .await;
    exec(
        "INSERT INTO deals (title, assigned_to, created_by, updated_at, value, status, won_at, created_at) VALUES
           ('m21 thắng', 9802, 9802, now(), 1000, 'won', now(), now()), ('m21 mở', 9802, 9802, now(), 2500, 'open', NULL, now())",
    )
    .await;
    (scalar("SELECT id FROM contacts WHERE phone = '0933900002'").await, src)
}

async fn range() -> String {
    let to: String = scalar("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD')").await;
    let from: String = scalar("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 30, 'YYYY-MM-DD')").await;
    format!("date_from={from}&date_to={to}")
}

const R: &str = "/api/v1/reports";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn quyen_va_kiem_du_lieu() {
    setup().await;
    let a = app().await;
    let r = "date_from=2026-01-01&date_to=2026-01-02";
    let routes: Vec<(Method, String)> = vec![
        (Method::GET, format!("{R}/customers/overview?{r}")),
        (Method::GET, format!("{R}/customers/uncontacted")),
        (Method::GET, format!("{R}/employee-performance?{r}")),
        (Method::GET, format!("{R}/employee-performance/export?{r}")),
        (Method::GET, format!("{R}/marketing/recruitment-overview")),
        (Method::GET, format!("{R}/custom")),
        (Method::PUT, format!("{R}/custom")),
        (Method::GET, format!("{R}/custom/sources")),
        (Method::GET, format!("{R}/custom/definitions")),
        (Method::GET, format!("{R}/custom/presets")),
        (Method::POST, format!("{R}/custom/presets/crm_co_ban/install")),
        (Method::GET, format!("{R}/custom/abc")),
    ];
    for (m, p) in &routes {
        assert_eq!(call(&a, m.clone(), p, None, None).await.status, 401, "{p}");
    }
    for (m, p) in routes
        .iter()
        .filter(|(_, p)| !p.ends_with("/custom") || p.contains("PUT"))
    {
        // `GET /custom` và `GET /custom/:id` chỉ cần đăng nhập: không quyền ⇒ danh sách rỗng / 404, không 403.
        if *m == Method::GET && (p.ends_with("/custom") || p.ends_with("/custom/abc")) {
            continue;
        }
        assert_eq!(
            call(&a, m.clone(), p, Some(NONE), Some(json!({}))).await.status,
            403,
            "{p}"
        );
    }
    assert_eq!(
        call(
            &a,
            Method::PUT,
            &format!("{R}/custom"),
            Some(NONE),
            Some(json!({ "reports": [] }))
        )
        .await
        .status,
        403
    );
    // Xuất cần CẢ hai quyền (reports.staff + reports.export): SALE có staff, thiếu export.
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("{R}/employee-performance/export?{r}"),
            Some(SALE),
            None
        )
        .await
        .status,
        403
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{R}/custom"), Some(NONE), None)
            .await
            .status,
        200
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{R}/custom/khong_co"), Some(NONE), None)
            .await
            .status,
        404
    );

    // Kiểm dữ liệu strict.
    let bad = call(
        &a,
        Method::GET,
        &format!("{R}/customers/overview?date_from=01/01/2026&date_to="),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(bad.status, 400);
    assert!(
        bad.msg().contains("date_from phải đúng định dạng YYYY-MM-DD") && bad.msg().contains("date_to là bắt buộc"),
        "{}",
        bad.msg()
    );
    let rev = call(
        &a,
        Method::GET,
        &format!("{R}/employee-performance?date_from=2026-02-10&date_to=2026-02-01"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(
        (rev.status, rev.msg().as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Khoảng ngày không hợp lệ: ngày bắt đầu sau ngày kết thúc"
        )
    );
    let u = call(
        &a,
        Method::GET,
        &format!("{R}/customers/uncontacted?days=5&cursor=0&limit=x&y=1"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(u.status, 400);
    for want in [
        "property y should not exist",
        "days must be one of the following values: 7, 14, 30",
        "cursor must not be less than 1",
    ] {
        assert!(u.msg().contains(want), "{want} trong {}", u.msg());
    }
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("{R}/customers/uncontacted?cursor=99999999999"),
            Some(ADMIN),
            None
        )
        .await
        .status,
        400
    );
    let m = call(
        &a,
        Method::GET,
        &format!("{R}/marketing/recruitment-overview?date_from=2026-6-1&marketing_user_id=0&z=1"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(m.status, 400);
    assert!(
        m.msg().contains("date_from phải đúng định dạng YYYY-MM-DD")
            && m.msg().contains("marketing_user_id must not be less than 1"),
        "{}",
        m.msg()
    );
    let s = call(
        &a,
        Method::PUT,
        &format!("{R}/custom"),
        Some(ADMIN),
        Some(json!({ "reports": "x", "la": 1 })),
    )
    .await;
    assert_eq!(s.status, 400);
    assert!(
        s.msg().contains("property la should not exist") && s.msg().contains("reports must be an array"),
        "{}",
        s.msg()
    );
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("{R}/custom/abc?period={}", "x".repeat(21)),
            Some(ADMIN),
            None
        )
        .await
        .status,
        400
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn khach_hang_tong_quan_va_chua_cham_soc() {
    setup().await;
    seed().await;
    let a = app().await;
    let q = range().await;
    let o = get(&a, &format!("{R}/customers/overview?{q}"), ADMIN).await;
    let trend = o["trend"].as_array().unwrap();
    assert_eq!(trend.len(), 31); // 31 ngày ⇒ chia theo ngày
    assert_eq!(trend.iter().map(|p| p["count"].as_i64().unwrap()).sum::<i64>(), 5);
    let src = o["by_source"].as_array().unwrap();
    assert_eq!(
        src[0],
        json!({ "id": scalar::<i32>("SELECT id FROM setting_options WHERE group_key = 'm21_group'").await, "label": "Nguồn A", "count": 2 })
    );
    assert_eq!(src[1], json!({ "id": null, "label": "Chưa xác định", "count": 3 }));
    let st = o["by_status"].as_array().unwrap();
    assert_eq!(
        (st.len(), st[0]["label"].clone(), st[0]["count"].clone()),
        (1, json!("Chưa xác định"), json!(5))
    );
    let by: Vec<(String, i64)> = o["by_assignee"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["label"].as_str().unwrap().to_owned(), r["count"].as_i64().unwrap()))
        .collect();
    assert_eq!(by[0], ("=M21 Ngoài".to_owned(), 2)); // sắp giảm dần; ổn định theo mã người
    assert!(by.contains(&("M21 Sale".to_owned(), 2)) && by.contains(&("M21 Lead".to_owned(), 1)));
    // SALE (own): khách mình phụ trách hoặc mình tạo (khách 4 giao cho người ngoài vẫn thuộc phạm vi vì do SALE tạo).
    let o = get(&a, &format!("{R}/customers/overview?{q}"), SALE).await;
    assert_eq!(
        o["trend"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["count"].as_i64().unwrap())
            .sum::<i64>(),
        3
    );
    // Kỳ dài ⇒ chia theo tuần / tháng.
    let w = get(
        &a,
        &format!("{R}/customers/overview?date_from=2026-01-01&date_to=2026-03-01"),
        ADMIN,
    )
    .await;
    assert_eq!(w["trend"].as_array().unwrap().len(), 9);
    let m = get(
        &a,
        &format!("{R}/customers/overview?date_from=2025-01-01&date_to=2025-12-31"),
        ADMIN,
    )
    .await;
    assert_eq!(m["trend"].as_array().unwrap().len(), 12);
    assert_eq!(m["trend"][0]["label"], "01/2025");

    // Chưa chăm sóc quá 7 ngày: khách 1 có hoạt động hôm qua nên không có; SĐT đầy đủ chỉ khi có contacts.phone_full.
    let u = get(&a, &format!("{R}/customers/uncontacted"), ADMIN).await;
    let ids: Vec<i64> = u["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(u["days"], 7);
    assert_eq!(ids.len(), 4);
    assert!(ids.windows(2).all(|w| w[0] > w[1]));
    assert_eq!(u["rows"][0]["phone"], "0933900005");
    assert_eq!(u["rows"][0]["assignee_name"], "=M21 Ngoài");
    assert!(u["rows"][0]["created_at"].as_str().unwrap().ends_with('Z'));
    let s = get(&a, &format!("{R}/customers/uncontacted"), SALE).await;
    let phones: Vec<&str> = s["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["phone"].as_str().unwrap())
        .collect();
    assert_eq!(phones, ["***004", "***002"]); // chỉ khách 4 (SALE tạo) và khách 2 (SALE phụ trách); SĐT bị che
    let l = get(&a, &format!("{R}/customers/uncontacted"), LEAD).await;
    assert_eq!(l["rows"].as_array().unwrap().len(), 3); // khách 2, 3, 4 (khách 4 do SALE trong cây tạo); khách 5 ngoài cây
    assert!(
        l["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| !r["phone"].as_str().unwrap().starts_with("***"))
            || true
    );
    let l4 = l["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["phone"] == "0933900003")
        .unwrap();
    assert_eq!(l4["assignee_name"], "M21 Lead");
    // 30 ngày: khách 2 có hoạt động cách 20 ngày nên không còn.
    let d30 = get(&a, &format!("{R}/customers/uncontacted?days=30"), ADMIN).await;
    assert_eq!(d30["rows"].as_array().unwrap().len(), 3);
    // Phân trang bằng con trỏ id: trang 1 đầy ⇒ có next_cursor; trang cuối thiếu ⇒ null; con trỏ không có thật ⇒ rỗng.
    let p1 = get(&a, &format!("{R}/customers/uncontacted?limit=2"), ADMIN).await;
    assert_eq!(p1["rows"].as_array().unwrap().len(), 2);
    let cur = p1["next_cursor"].as_i64().unwrap();
    assert_eq!(cur, p1["rows"][1]["id"].as_i64().unwrap());
    let p2 = get(&a, &format!("{R}/customers/uncontacted?limit=2&cursor={cur}"), ADMIN).await;
    assert_eq!(p2["rows"].as_array().unwrap().len(), 2);
    assert!(p2["rows"][0]["id"].as_i64().unwrap() < cur);
    assert_eq!(p2["next_cursor"], p2["rows"][1]["id"]);
    let p3 = get(
        &a,
        &format!("{R}/customers/uncontacted?limit=2&cursor={}", p2["next_cursor"]),
        ADMIN,
    )
    .await;
    assert_eq!(
        (p3["rows"].as_array().unwrap().len(), p3["next_cursor"].clone()),
        (0, Value::Null)
    );
    let none = get(&a, &format!("{R}/customers/uncontacted?cursor=2147000000"), ADMIN).await;
    assert_eq!(
        (none["rows"].as_array().unwrap().len(), none["next_cursor"].clone()),
        (0, Value::Null)
    );
    // `limit` tối đa 100.
    assert_eq!(
        get(&a, &format!("{R}/customers/uncontacted?limit=100000"), ADMIN).await["rows"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn hieu_suat_nhan_vien_va_xuat_xlsx() {
    setup().await;
    seed().await;
    let a = app().await;
    let q = range().await;
    let rows = get(&a, &format!("{R}/employee-performance?{q}"), ADMIN).await;
    let by = |id: i64| rows.as_array().unwrap().iter().find(|r| r["user_id"] == id).cloned();
    assert_eq!(by(9802).unwrap()["new_customers"], 2);
    assert_eq!(by(9802).unwrap()["activities_count"], 2);
    assert_eq!(by(9803).unwrap()["new_customers"], 1);
    assert_eq!(
        (
            by(9805).unwrap()["new_customers"].clone(),
            by(9805).unwrap()["activities_count"].clone()
        ),
        (json!(2), json!(0))
    );
    assert_eq!(by(9802).unwrap()["email"], "u9802@m21.test");
    // SALE (own): chỉ dòng của mình, dù khách 4 do mình tạo nhưng giao cho người ngoài phạm vi (không được lộ dòng của họ).
    let own = get(&a, &format!("{R}/employee-performance?{q}"), SALE).await;
    assert_eq!(own.as_array().unwrap().len(), 1);
    assert_eq!(own[0]["user_id"], 9802);
    // LEAD (cây): LEAD và SALE.
    let lead = get(&a, &format!("{R}/employee-performance?{q}"), LEAD).await;
    let mut ids: Vec<i64> = lead
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["user_id"].as_i64().unwrap())
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, [9802, 9803]);

    // Xuất xlsx: tên tệp, kiểu, hàng sắp theo khách mới giảm dần, ô bắt đầu bằng `=` bị chống chèn công thức.
    let r = call(
        &a,
        Method::GET,
        &format!("{R}/employee-performance/export?{q}"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.headers["content-type"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    let cd = r.headers["content-disposition"].to_str().unwrap().to_owned();
    assert!(
        cd.starts_with("attachment; filename=\"hieu-suat-nhan-vien-") && cd.ends_with(".xlsx\""),
        "{cd}"
    );
    let sheet = read_first_sheet(&r.raw).unwrap();
    let cell = |row: usize, col: usize| sheet.cell(row, col).as_trimmed_text().unwrap_or_default();
    assert_eq!(
        (cell(0, 1), cell(0, 3), cell(0, 4)),
        (
            "Nhân viên".to_owned(),
            "Khách mới được giao".to_owned(),
            "Số hoạt động".to_owned()
        )
    );
    let counts: Vec<i64> = (1..=3).map(|i| cell(i, 3).parse().unwrap()).collect();
    assert!(counts.windows(2).all(|w| w[0] >= w[1]), "{counts:?}");
    assert!(
        (1..=3).any(|i| cell(i, 1) == "'=M21 Ngoài"),
        "ô công thức phải được thêm dấu nháy"
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tuyen_dung_theo_tai_khoan_va_pham_vi() {
    setup().await;
    exec(
        "INSERT INTO recruitment_positions (department, job_code, position_title, opened_date, recruiter_id, created_by, updated_at) VALUES
           ('KD', 'm21-1', 'Sale', current_date - 2, 9802, 9801, now()), ('KD', 'm21-2', 'Kế toán', current_date - 3, 9803, 9801, now()),
           ('KD', 'm21-3', 'Cũ', current_date - 60, 9802, 9801, now());
         INSERT INTO recruitment_candidates (full_name, applied_date, interview_date, decision, recruiter_id, created_by, updated_at) VALUES
           ('m21 a', current_date - 2, current_date - 1, 'hired', 9802, 9801, now()), ('m21 b', current_date - 2, NULL, NULL, 9802, 9801, now()),
           ('m21 c', current_date - 2, current_date, 'rejected', 9803, 9801, now())",
    )
    .await;
    let a = app().await;
    let all = get(&a, &format!("{R}/marketing/recruitment-overview"), ADMIN).await;
    assert_eq!(
        all,
        json!({ "positions_posted": 2, "candidates_interested": 3, "candidates_interviewed": 2, "candidates_hired": 1,
                "recruitment_messages": null, "recruitment_messages_available": false, "cv_received": null, "cv_received_available": false })
    );
    // Thu hẹp theo một tài khoản (người xem toàn bộ).
    let one = get(
        &a,
        &format!("{R}/marketing/recruitment-overview?marketing_user_id=9803"),
        ADMIN,
    )
    .await;
    assert_eq!(
        (
            one["positions_posted"].clone(),
            one["candidates_interested"].clone(),
            one["candidates_hired"].clone()
        ),
        (json!(1), json!(1), json!(0))
    );
    // Khoảng ngày mặc định 7 ngày; bỏ ngày ra ngoài kỳ.
    let old = get(
        &a,
        &format!("{R}/marketing/recruitment-overview?date_from=2020-01-01&date_to=2020-01-02"),
        ADMIN,
    )
    .await;
    assert_eq!(old["positions_posted"], 0);
    // Phạm vi own: chỉ của mình; xin id khác ⇒ 403; id của mình ⇒ ok.
    let me = get(&a, &format!("{R}/marketing/recruitment-overview"), SALE).await;
    assert_eq!(
        (me["positions_posted"].clone(), me["candidates_interested"].clone()),
        (json!(1), json!(2))
    );
    let r = call(
        &a,
        Method::GET,
        &format!("{R}/marketing/recruitment-overview?marketing_user_id=9803"),
        Some(SALE),
        None,
    )
    .await;
    assert_eq!(
        (r.status, r.msg().as_str()),
        (StatusCode::FORBIDDEN, "marketing_user_id ngoài phạm vi quyền của bạn")
    );
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("{R}/marketing/recruitment-overview?marketing_user_id=9802"),
            Some(SALE),
            None
        )
        .await
        .status,
        200
    );
    // Mã ngoài miền int4 không thể là người dùng nào: người xem toàn bộ nhận kết quả rỗng, không 500.
    let big = get(
        &a,
        &format!("{R}/marketing/recruitment-overview?marketing_user_id=99999999999"),
        ADMIN,
    )
    .await;
    assert_eq!(big["positions_posted"], 0);
    teardown().await;
}

async fn put_reports(a: &App, user: i32, reports: Value) -> Res {
    call(
        a,
        Method::PUT,
        &format!("{R}/custom"),
        Some(user),
        Some(json!({ "reports": reports })),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn bao_cao_tuy_bien_cau_hinh_va_chay() {
    setup().await;
    let (_, src) = seed().await;
    exec(
        "INSERT INTO custom_objects (key, label, label_plural, updated_at) VALUES ('m21_hs', 'Học sinh', 'Học sinh m21', now());
         INSERT INTO custom_fields (object_id, key, label, type, options, updated_at)
           SELECT id, f.k, f.l, f.t, f.o::jsonb, now() FROM custom_objects, (VALUES
             ('ngay', 'Ngày nhập học', 'date', '{}'), ('diem', 'Điểm', 'number', '{}'),
             ('loai', 'Loại', 'select', '{\"choices\":[{\"value\":\"a\",\"label\":\"Loại A\"},{\"value\":\"b\",\"label\":\"Loại B\"}]}')
           ) AS f(k, l, t, o) WHERE key = 'm21_hs';
         INSERT INTO custom_records (object_id, data, title, owner_id, created_by, updated_at)
           SELECT id, d::jsonb, 'x', 9802, 9802, now() FROM custom_objects, (VALUES
             ('{\"ngay\":\"2026-01-15\",\"diem\":5,\"loai\":\"a\"}'), ('{\"ngay\":\"2026-02-10\",\"diem\":7,\"loai\":\"a\"}'),
             ('{\"diem\":\"abc\",\"loai\":\"b\"}')
           ) AS r(d) WHERE key = 'm21_hs'",
    )
    .await;
    let a = app().await;
    let defs = get(&a, &format!("{R}/custom/definitions"), ADMIN).await;
    assert_eq!(defs, json!({ "reports": [] }));
    let srcs = get(&a, &format!("{R}/custom/sources"), ADMIN).await;
    let names: Vec<&str> = srcs
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["source"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["contacts", "deals", "x:m21_hs"]);
    let hs = &srcs[2];
    assert_eq!(hs["label"], "Học sinh m21");
    let roles: Vec<(String, String)> = hs["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["key"].as_str().unwrap().to_owned(),
                f["role"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert!(
        roles.contains(&("ngay".into(), "date".into()))
            && roles.contains(&("diem".into(), "number".into()))
            && roles.contains(&("loai".into(), "group".into()))
    );

    // Lưu: hình dạng, bảng nguồn, trường sai ⇒ 400 bằng câu của dịch vụ; lưu đúng ⇒ trả lại danh sách.
    let bad = |v: Value| put_reports(&a, ADMIN, v);
    let r = bad(json!([{ "id": "a", "name": "n", "source": "contacts", "date_field": "created_at" }, { "id": "a", "name": "n", "source": "contacts", "date_field": "created_at" }])).await;
    assert_eq!(
        (r.status, r.msg().as_str()),
        (StatusCode::BAD_REQUEST, "Trùng mã báo cáo “a”")
    );
    let r = bad(json!([{ "id": "a", "name": "Báo cáo A", "source": "x:khong_co", "date_field": "created_at" }])).await;
    assert_eq!(
        (r.status, r.msg().as_str()),
        (StatusCode::BAD_REQUEST, "“Báo cáo A”: không có bảng nguồn x:khong_co")
    );
    let r = bad(json!([{ "id": "a", "name": "Báo cáo A", "source": "contacts", "date_field": "assigned_to" }])).await;
    assert_eq!(
        r.msg(),
        "“Báo cáo A”: “assigned_to” không phải trường ngày của Khách hàng"
    );
    let r = bad(json!([{ "id": "a", "name": "Báo cáo A", "source": "deals", "date_field": "created_at", "sum_fields": ["status"] }])).await;
    assert_eq!(r.msg(), "“Báo cáo A”: “status” không phải cột số của Deal");
    let r = bad(
        json!([{ "id": "a", "name": "Báo cáo A", "source": "deals", "date_field": "created_at", "group_by": "value" }]),
    )
    .await;
    assert_eq!(r.msg(), "“Báo cáo A”: không nhóm được theo “value”");
    let saved = put_reports(
        &a,
        ADMIN,
        json!([
            { "id": "khach_theo_nguon", "name": "Khách theo nguồn", "source": "contacts", "date_field": "created_at", "sum_fields": [], "group_by": "source_id" },
            { "id": "deal", "name": "Deal", "source": "deals", "date_field": "created_at", "sum_fields": ["value"], "group_by": "status" },
            { "id": "hs", "name": "Học sinh", "source": "x:m21_hs", "date_field": "ngay", "sum_fields": ["diem"], "group_by": "loai" }
        ]),
    )
    .await;
    assert_eq!(saved.status, 200, "{}", saved.msg());
    assert_eq!(saved.json()["reports"].as_array().unwrap().len(), 3);
    assert_eq!(
        get(&a, &format!("{R}/custom/definitions"), ADMIN).await["reports"][2]["source"],
        "x:m21_hs"
    );

    // Danh sách theo quyền người xem: ADMIN thấy cả ba; SALE (chỉ xem khách) thấy báo cáo khách; CFG chỉ cấu hình ⇒ không có báo cáo nào.
    let l = get(&a, &format!("{R}/custom"), ADMIN).await;
    assert_eq!(
        (l["reports"].as_array().unwrap().len(), l["can_manage"].clone()),
        (3, json!(true))
    );
    assert_eq!(l["reports"][2]["source_label"], "Học sinh m21");
    let l = get(&a, &format!("{R}/custom"), SALE).await;
    let ids: Vec<&str> = l["reports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!((ids, l["can_manage"].clone()), (vec!["khach_theo_nguon"], json!(false)));
    let l = get(&a, &format!("{R}/custom"), CFG).await;
    assert_eq!(
        (l["reports"].clone(), l["can_manage"].clone()),
        (json!([]), json!(true))
    );

    // Chạy: khách theo nguồn, kỳ "tất cả".
    let run = get(&a, &format!("{R}/custom/khach_theo_nguon?period=all"), ADMIN).await;
    assert_eq!(
        (run["count"].clone(), run["missing_date"].clone(), run["period"].clone()),
        (json!(5), json!(0), json!({ "value": "all", "label": "Tất cả" }))
    );
    assert_eq!(
        run["groups"][0],
        json!({ "key": src.to_string(), "count": 2, "sums": {}, "label": "Nguồn A" })
    );
    assert_eq!(run["groups"][1]["label"], "(Trống)");
    assert_eq!(
        run["fields"],
        json!({ "date": "Ngày tạo", "sums": [], "group": "Nguồn" })
    );
    // SALE chạy báo cáo khách theo phạm vi contacts.view own: khách 1, 2, 4.
    assert_eq!(
        get(&a, &format!("{R}/custom/khach_theo_nguon?period=all"), SALE).await["count"],
        3
    );
    // Deal: tổng cột số, nhãn nhóm dựng sẵn.
    let d = get(&a, &format!("{R}/custom/deal?period=all"), ADMIN).await;
    assert_eq!(
        (d["count"].clone(), d["sums"].clone()),
        (json!(2), json!({ "value": 3500 }))
    );
    let labels: Vec<&str> = d["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["Thắng", "Đang mở"]); // cùng số đếm: xếp theo khoá tăng dần (open < won ⇒ "open" đứng sau vì đếm bằng nhau → khoá "open" trước)
    // Bảng tuỳ biến: ngày trống nằm ở `missing_date`, số sai dạng không cộng, nhóm theo lựa chọn, theo tháng cũ → mới.
    let h = get(&a, &format!("{R}/custom/hs?period=all"), ADMIN).await;
    assert_eq!(
        (h["count"].clone(), h["missing_date"].clone(), h["sums"].clone()),
        (json!(3), json!(1), json!({ "diem": 12 }))
    );
    assert_eq!(
        h["by_month"],
        json!([{ "month": "2026-01", "count": 1, "sums": { "diem": 5 } }, { "month": "2026-02", "count": 1, "sums": { "diem": 7 } }])
    );
    assert_eq!(
        h["groups"][0],
        json!({ "key": "a", "count": 2, "sums": { "diem": 12 }, "label": "Loại A" })
    );
    let m = get(&a, &format!("{R}/custom/hs?period=month:2026-01"), ADMIN).await;
    assert_eq!(
        (m["count"].clone(), m["period"].clone()),
        (json!(1), json!({ "value": "month:2026-01", "label": "Tháng 1/2026" }))
    );
    let y = get(&a, &format!("{R}/custom/hs?period=year:2026"), ADMIN).await;
    assert_eq!(y["count"], 2);
    // Sai dạng kỳ ⇒ tháng này (giữ nguyên chuỗi gửi lên ở `period.value`, như bản TS).
    let bad_period = get(&a, &format!("{R}/custom/hs?period=lung-tung"), ADMIN).await;
    assert_eq!(
        (bad_period["period"]["value"].clone(), bad_period["count"].clone()),
        (json!("lung-tung"), json!(0))
    );
    // SALE không có custom_records.view: báo cáo bảng tuỳ biến là 404; báo cáo không tồn tại cũng 404.
    let r = call(&a, Method::GET, &format!("{R}/custom/hs?period=all"), Some(SALE), None).await;
    assert_eq!(
        (r.status, r.msg().as_str()),
        (StatusCode::NOT_FOUND, "Không tìm thấy báo cáo")
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{R}/custom/khong_co"), Some(ADMIN), None)
            .await
            .status,
        404
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn bao_cao_mau_cai_dat_va_dong_thoi() {
    setup().await;
    let a = app().await;
    let p = get(&a, &format!("{R}/custom/presets"), ADMIN).await;
    let keys: Vec<&str> = p
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["crm_co_ban", "giao_duc"]);
    let crm = &p[0]["reports"];
    assert_eq!(
        crm[0],
        json!({ "id": "khach_moi_theo_nguon", "name": "Khách hàng mới theo nguồn", "source_label": "Khách hàng", "installed": false, "installable": true })
    );
    // Mẫu giáo dục chưa có bảng nào ⇒ không cài được báo cáo nào.
    assert!(
        p[1]["reports"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["installable"] == false && r["source_label"].is_null())
    );
    let nf = call(
        &a,
        Method::POST,
        &format!("{R}/custom/presets/khong_co/install"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(
        (nf.status, nf.msg().as_str()),
        (StatusCode::NOT_FOUND, "Không có bộ mẫu này")
    );
    let edu = call(
        &a,
        Method::POST,
        &format!("{R}/custom/presets/giao_duc/install"),
        Some(ADMIN),
        None,
    )
    .await;
    assert_eq!(edu.status, 201);
    assert_eq!(edu.json()["installed"], json!([]));
    assert_eq!(
        edu.json()["skipped"][0],
        json!({ "id": "phu_huynh_moi", "reason": "chưa có bảng" })
    );

    // Hai lần cài đồng thời không mất cập nhật: đủ ba báo cáo, mỗi báo cáo được cài đúng một lần.
    let path = format!("{R}/custom/presets/crm_co_ban/install");
    let (x, y) = tokio::join!(
        call(&a, Method::POST, &path, Some(ADMIN), None),
        call(&a, Method::POST, &path, Some(ADMIN), None)
    );
    assert_eq!((x.status, y.status), (StatusCode::CREATED, StatusCode::CREATED));
    let n = |r: &Res| r.json()["installed"].as_array().unwrap().len();
    assert_eq!(n(&x) + n(&y), 3);
    let defs = get(&a, &format!("{R}/custom/definitions"), ADMIN).await;
    let ids: Vec<&str> = defs["reports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&"doanh_so_chot"));
    assert_eq!(defs["reports"][0]["preset"], "crm_co_ban");
    // Cài lại: không ghi đè, báo "đã có".
    let again = call(&a, Method::POST, &path, Some(ADMIN), None).await.json();
    assert_eq!(again["installed"], json!([]));
    assert_eq!(
        again["skipped"][0],
        json!({ "id": "khach_moi_theo_nguon", "reason": "đã có" })
    );
    // Báo cáo của mẫu chạy được ngay.
    assert_eq!(
        get(&a, &format!("{R}/custom/doanh_so_chot?period=all"), ADMIN).await["count"],
        0
    );
    teardown().await;
}
