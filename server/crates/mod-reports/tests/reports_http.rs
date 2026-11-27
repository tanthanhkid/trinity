//! M20 qua HTTP (router K14 thật, quyền thật, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-reports --test reports_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9601..9699 và mọi dòng gắn nhãn `m20`; các khoá `settings` mà test đổi được khôi phục
//! đúng như trước khi chạy.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use mod_reports::cache::{DASHBOARD_PREFIX, ReadCache};
use mod_reports::{Ctx, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tokio::sync::OnceCell;
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "m20-jwt-secret-0123456789abcdef0123456789abcdef";
const SETTING_KEYS: &str = "'org_features', 'online_store', 'org_plan', 'setup_status'";

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
    ctx: Arc<Ctx>,
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
    assert_eq!(table.len(), 7);
    App {
        router: router.with_state(ctx.clone()),
        ctx,
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m20.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
}

async fn get(app: &App, path: &str, user: Option<i32>) -> Res {
    let mut b = Request::builder().method("GET").uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    let resp = app
        .router
        .clone()
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
    }
}

async fn ok(app: &App, path: &str, user: i32) -> Value {
    let r = get(app, path, Some(user)).await;
    assert_eq!(r.status, 200, "{path}: {:?}", r.body);
    r.body
}

const ADMIN: i32 = 9601; // reports.overview all, contacts.view all, kênh, trang bán hàng
const DIR: i32 = 9602; // reports.overview + contacts.view subtree; quản lý của LEAD
const LEAD: i32 = 9603; // quản lý của SALE_A và SALE_B
const SALE_A: i32 = 9604; // reports.overview + contacts.view own
const SALE_B: i32 = 9605;
const OUT: i32 = 9606; // ngoài cây của DIR
const NONE: i32 = 9607; // không quyền
const OV_ONLY: i32 = 9608; // reports.overview all, KHÔNG contacts.view
const HIDDEN: i32 = 9609; // reports.overview own, KHÔNG contacts.view

static SNAP: OnceCell<Vec<(String, String)>> = OnceCell::const_new();

async fn restore_settings() {
    let snap = SNAP
        .get_or_init(|| async {
            let mut c = PgConnection::connect(&url()).await.unwrap();
            sqlx::query_as(AssertSqlSafe(format!(
                "SELECT key, value FROM settings WHERE key IN ({SETTING_KEYS})"
            )))
            .fetch_all(&mut c)
            .await
            .unwrap()
        })
        .await;
    exec(&format!("DELETE FROM settings WHERE key IN ({SETTING_KEYS})")).await;
    for (k, v) in snap {
        exec(&format!(
            "INSERT INTO settings (key, value, updated_at) VALUES ('{k}', '{}', now())",
            v.replace('\'', "''")
        ))
        .await;
    }
}

async fn set_setting(k: &str, v: &str) {
    exec(&format!(
        "INSERT INTO settings (key, value, updated_at) VALUES ('{k}', '{}', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        v.replace('\'', "''")
    ))
    .await;
}

async fn teardown() {
    exec(
        "DELETE FROM kanban_boards WHERE name LIKE 'm20%';
          DELETE FROM deals WHERE title LIKE 'm20%';
          DELETE FROM activities WHERE action = 'm20';
          DELETE FROM contacts WHERE phone LIKE 'm20-%';
          DELETE FROM facebook_comments WHERE page_id = 'm20-page';
          DELETE FROM facebook_messages WHERE conversation_id IN (SELECT id FROM facebook_conversations WHERE page_id = 'm20-page');
          DELETE FROM facebook_conversations WHERE page_id = 'm20-page';
          DELETE FROM facebook_pages WHERE page_id = 'm20-page';
          DELETE FROM social_post_targets WHERE post_id IN (SELECT id FROM social_posts WHERE content LIKE 'm20%');
          DELETE FROM social_posts WHERE content LIKE 'm20%';
          DELETE FROM social_accounts WHERE external_id = 'm20-page';
          DELETE FROM zalo_oa_messages WHERE thread_id IN (SELECT id FROM zalo_oa_threads WHERE oa_id = 'm20-oa');
          DELETE FROM zalo_oa_threads WHERE oa_id = 'm20-oa';
          DELETE FROM zalo_oa_connections WHERE oa_id = 'm20-oa';
          DELETE FROM store_orders WHERE code LIKE 'm20-%';
          DELETE FROM user_roles WHERE user_id BETWEEN 9601 AND 9699;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9601 AND 9699;
          DELETE FROM roles WHERE id BETWEEN 9601 AND 9699;
          DELETE FROM users WHERE id BETWEEN 9601 AND 9699",
    )
    .await;
    restore_settings().await;
}

async fn setup() {
    teardown().await;
    // DIR → LEAD → {SALE_A, SALE_B}; OUT đứng riêng.
    for (id, name, mgr) in [
        (ADMIN, "M20 Admin", "NULL"),
        (DIR, "M20 Giám đốc", "NULL"),
        (LEAD, "M20 Trưởng nhóm", "9602"),
        (SALE_A, "M20 An", "9603"),
        (SALE_B, "M20 Bình", "9603"),
        (OUT, "M20 Ngoài", "NULL"),
        (NONE, "M20 Không quyền", "NULL"),
        (OV_ONLY, "M20 Chỉ tổng quan", "NULL"),
        (HIDDEN, "M20 Ẩn khách", "NULL"),
    ] {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, manager_id, updated_at) VALUES ({id}, 'u{id}@m20.test', 'x', '{name}', {mgr}, now())")).await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9601, 'm20-admin', false, now()), (9602, 'm20-dir', false, now()), (9604, 'm20-sale', false, now()), (9608, 'm20-ov', false, now()), (9609, 'm20-hidden', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9601, 'reports.overview', 'all'), (9601, 'contacts.view', 'all'), (9601, 'integrations.webhooks', NULL), (9601, 'social.post', NULL), (9601, 'pos.manage', NULL),
            (9602, 'reports.overview', 'subtree'), (9602, 'contacts.view', 'subtree'),
            (9604, 'reports.overview', 'own'), (9604, 'contacts.view', 'own'),
            (9608, 'reports.overview', 'all'),
            (9609, 'reports.overview', 'own');
          INSERT INTO user_roles (user_id, role_id) VALUES (9601, 9601), (9602, 9602), (9604, 9604), (9608, 9608), (9609, 9609)").await;
}

/// Khách, thương vụ, hoạt động và thẻ Kanban của các ca đo (ngày hôm nay/hôm qua tính theo `now()` của DB).
async fn seed_work() -> (i32, i32) {
    exec(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_at, updated_at, reminder_at, reminder_notes) VALUES
           ('m20-1', 'Khách M20 một', 9604, now(), now(), now(), '  gọi lại  '),
           ('m20-2', 'Khách M20 hai', 9604, now(), now(), NULL, NULL),
           ('m20-3', 'Khách M20 ba', 9605, now(), now(), NULL, NULL),
           ('m20-4', 'Khách M20 bốn', 9604, now() - interval '1 day', now(), NULL, NULL),
           ('m20-5', 'Khách M20 năm', 9606, now(), now(), NULL, NULL);
         INSERT INTO contacts (phone, full_name, assigned_to, created_at, updated_at, reminder_at, reminder_notes)
           VALUES ('m20-6', 'Khách bí mật', 9609, now(), now(), now(), 'ghi chú riêng');
         INSERT INTO deals (title, assigned_to, created_by, updated_at, value, status, won_at) VALUES
           ('m20 mở', 9604, 9604, now(), 1000, 'open', NULL),
           ('m20 thắng', 9604, 9604, now(), 5000000, 'won', now()),
           ('m20 thua', 9604, 9604, now(), 700, 'lost', NULL);
         INSERT INTO activities (action, created_by, created_at) VALUES ('m20', 9604, now()), ('m20', 9604, now()), ('m20', 9604, now() - interval '1 day')",
    )
    .await;
    let c1: i32 = scalar("SELECT id FROM contacts WHERE phone = 'm20-1'").await;
    let board: i32 = scalar("INSERT INTO kanban_boards (name) VALUES ('m20 bảng') RETURNING id").await;
    let hidden_board: i32 = scalar(
        "INSERT INTO kanban_boards (name, visibility_role_ids) VALUES ('m20 bảng kín', ARRAY[999999]) RETURNING id",
    )
    .await;
    let col: i32 = scalar(&format!(
        "INSERT INTO kanban_columns (board_id, name, position) VALUES ({board}, 'Cần làm', 1) RETURNING id"
    ))
    .await;
    let hidden_col: i32 = scalar(&format!(
        "INSERT INTO kanban_columns (board_id, name, position) VALUES ({hidden_board}, 'Kín', 1) RETURNING id"
    ))
    .await;
    let card = |b: i32, c: i32, title: &str, assignee: i32, due: &str, done: &str| {
        format!(
            "INSERT INTO kanban_cards (board_id, column_id, title, assignee_id, due_at, completed_at, position, created_by, contact_id) VALUES ({b}, {c}, '{title}', {assignee}, {due}, {done}, 1, {assignee}, {c1}) RETURNING id"
        )
    };
    let a: i32 = scalar(&card(
        board,
        col,
        "m20 quá hạn",
        9604,
        "now() - interval '1 day'",
        "NULL",
    ))
    .await;
    let b: i32 = scalar(&card(board, col, "m20 hôm nay", 9604, "now()", "NULL")).await;
    let _done: i32 = scalar(&card(board, col, "m20 xong", 9604, "now()", "now()")).await;
    let d: i32 = scalar(&card(board, col, "m20 của B", 9605, "now() - interval '1 day'", "NULL")).await;
    let _kin: i32 = scalar(&card(
        hidden_board,
        hidden_col,
        "m20 kín",
        9604,
        "now() - interval '1 day'",
        "NULL",
    ))
    .await;
    // Người thực hiện qua bảng phụ thay vì cột `assignee_id`.
    let e: i32 = scalar(&format!("INSERT INTO kanban_cards (board_id, column_id, title, due_at, position, created_by) VALUES ({board}, {col}, 'm20 phụ', now(), 1, 9605) RETURNING id")).await;
    exec(&format!(
        "INSERT INTO kanban_card_assignees (card_id, user_id) VALUES ({e}, 9604)"
    ))
    .await;
    let _ = (b, d);
    (a, e)
}

fn today_vn() -> String {
    // chỉ để dựng truy vấn; lấy từ DB nên không phụ thuộc múi giờ máy chạy test
    String::new()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn quyen_va_kiem_du_lieu() {
    setup().await;
    let a = app().await;
    for p in [
        "/api/v1/reports/overview?date_from=2026-01-01&date_to=2026-01-02",
        "/api/v1/reports/dashboard-overview",
        "/api/v1/reports/dashboard-tasks",
        "/api/v1/reports/dashboard-filter-roster",
        "/api/v1/reports/dashboard-channels",
        "/api/v1/reports/dashboard-stats-today",
        "/api/v1/reports/dashboard-trend-14d",
    ] {
        assert_eq!(get(&a, p, None).await.status, 401, "{p}");
    }
    for p in [
        "/api/v1/reports/overview?date_from=2026-01-01&date_to=2026-01-02",
        "/api/v1/reports/dashboard-overview",
        "/api/v1/reports/dashboard-tasks",
        "/api/v1/reports/dashboard-filter-roster",
        "/api/v1/reports/dashboard-stats-today",
        "/api/v1/reports/dashboard-trend-14d",
    ] {
        assert_eq!(get(&a, p, Some(NONE)).await.status, 403, "{p}");
    }
    // dashboard-channels chỉ cần đăng nhập: không quyền nào ⇒ danh sách rỗng.
    assert_eq!(
        ok(&a, "/api/v1/reports/dashboard-channels", NONE).await,
        json!({ "channels": [], "available": [] })
    );

    // Kiểm dữ liệu strict (câu của class-validator).
    let bad = get(&a, "/api/v1/reports/overview?date_from=01/01/2026&date_to=", Some(DIR)).await;
    assert_eq!(bad.status, 400);
    let m = bad.body["message"].to_string();
    assert!(
        m.contains("date_from phải đúng định dạng YYYY-MM-DD") && m.contains("date_to là bắt buộc"),
        "{m}"
    );
    let missing = get(&a, "/api/v1/reports/overview", Some(DIR)).await;
    assert_eq!(missing.status, 400);
    let rev = get(
        &a,
        "/api/v1/reports/overview?date_from=2026-02-10&date_to=2026-02-01",
        Some(DIR),
    )
    .await;
    assert_eq!(rev.status, 400, "{:?}", rev.body);
    let f = get(
        &a,
        "/api/v1/reports/dashboard-overview?dept_head_id=0&team_lead_id=abc&x=1",
        Some(DIR),
    )
    .await;
    assert_eq!(f.status, 400);
    let m = f.body["message"].to_string();
    assert!(m.contains("property x should not exist"), "{m}");
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tong_quan_va_so_voi_ky_truoc() {
    setup().await;
    seed_work().await;
    let a = app().await;
    let day: String = scalar("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD')").await;
    let _ = today_vn();
    // DIR (subtree {DIR, LEAD, SALE_A, SALE_B}): 3 khách mới hôm nay (m20-1..3), hôm qua 1; hoạt động 2 so với 1.
    let o = ok(
        &a,
        &format!("/api/v1/reports/overview?date_from={day}&date_to={day}"),
        DIR,
    )
    .await;
    assert_eq!(o["scope_label"], "Toàn bộ cấp dưới");
    assert_eq!(
        o["new_customers"],
        json!({ "current": 3, "previous": 1, "delta_abs": 2, "delta_pct": 200 })
    );
    assert_eq!(
        o["activities"],
        json!({ "current": 2, "previous": 1, "delta_abs": 1, "delta_pct": 100 })
    );
    // SALE_A (own): chỉ khách của mình (m20-1, m20-2 hôm nay; m20-4 hôm qua).
    let o = ok(
        &a,
        &format!("/api/v1/reports/overview?date_from={day}&date_to={day}"),
        SALE_A,
    )
    .await;
    assert_eq!(o["scope_label"], "Của mình");
    assert_eq!(
        (
            o["new_customers"]["current"].clone(),
            o["new_customers"]["previous"].clone()
        ),
        (json!(2), json!(1))
    );
    // ADMIN (all): thấy cả khách ngoài cây (m20-5).
    let o = ok(
        &a,
        &format!("/api/v1/reports/overview?date_from={day}&date_to={day}"),
        ADMIN,
    )
    .await;
    assert_eq!(o["scope_label"], "Toàn công ty");
    assert_eq!(o["new_customers"]["current"], json!(5)); // m20-1, 2, 3, 5, 6 (m20-4 là hôm qua)
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn dashboard_overview_loc_va_cache() {
    setup().await;
    seed_work().await;
    let a = app().await;
    let p = "/api/v1/reports/dashboard-overview";
    let o = ok(&a, p, DIR).await;
    assert_eq!(o["scope_label"], "phòng");
    assert_eq!(o["months"].as_array().unwrap().len(), 6);
    // DIR thấy khách của SALE_A (3 gồm m20-4) và SALE_B (1), không thấy m20-5/m20-6.
    assert_eq!(o["customers"]["total"], 4);
    assert_eq!(o["customers"]["new_this_month"], json!(o["customers_by_month"][5]));
    assert_eq!(o["deal_status"], json!({ "open": 1, "won": 1, "lost": 1 }));
    assert_eq!(o["opportunities"]["open"], 1);
    assert_eq!(o["revenue"]["this_month"], 5_000_000);
    assert_eq!(o["revenue_by_month"][5], 5_000_000);
    assert_eq!(o["revenue_by_month"][0], Value::Null);

    // Cache 5 phút: thêm khách sau lần đầu, vẫn trả số cũ.
    exec("INSERT INTO contacts (phone, full_name, assigned_to, updated_at) VALUES ('m20-7', 'thêm', 9604, now())")
        .await;
    assert_eq!(ok(&a, p, DIR).await["customers"]["total"], 4);
    // Ghi dữ liệu gọi `invalidate_prefix("dashboard:")` (tiến trình khác nhận qua NOTIFY `cache`): số liệu mới hiện ngay.
    let mut conn = PgConnection::connect(&url()).await.unwrap();
    a.ctx
        .cache
        .invalidate_prefix(&mut conn, CompanyRef::DEFAULT, DASHBOARD_PREFIX)
        .await
        .unwrap();
    assert_eq!(ok(&a, p, DIR).await["customers"]["total"], 5);
    // Mã ngoài miền i32 không phải người dùng nào ⇒ khớp rỗng (không lỗi 500).
    let big = ok(&a, &format!("{p}?user_id=99999999999"), DIR).await;
    assert_eq!(
        (big["customers"]["total"].clone(), big["scope_label"].clone()),
        (json!(0), json!("theo bộ lọc"))
    );
    let t = ok(&a, "/api/v1/reports/dashboard-tasks?team_lead_id=99999999999", DIR).await;
    assert_eq!(t["total"], 0);

    // Bộ lọc: người dùng cụ thể, và ngoài phạm vi thì rỗng.
    let f = ok(&a, &format!("{p}?user_id={SALE_B}"), DIR).await;
    assert_eq!(
        (f["scope_label"].clone(), f["customers"]["total"].clone()),
        (json!("theo bộ lọc"), json!(1))
    );
    let out = ok(&a, &format!("{p}?user_id={OUT}"), DIR).await;
    assert_eq!(out["customers"]["total"], 0);
    assert_eq!(out["revenue"]["this_month"], Value::Null);
    let team = ok(&a, &format!("{p}?team_lead_id={LEAD}"), DIR).await;
    assert_eq!(team["customers"]["total"], 5); // đã thêm m20-7 sau lần đầu
    // Giao các điều kiện: Phòng của DIR ∩ nhân viên SALE_A.
    let both = ok(&a, &format!("{p}?dept_head_id={DIR}&user_id={SALE_A}"), DIR).await;
    assert_eq!(both["customers"]["total"], 4); // m20-1, 2, 4 và m20-7

    // Phạm vi own: bộ lọc bị bỏ qua im lặng.
    let own = ok(&a, &format!("{p}?user_id={SALE_B}"), SALE_A).await;
    assert_eq!(
        (own["scope_label"].clone(), own["customers"]["total"].clone()),
        (json!("cá nhân"), json!(4))
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn viec_can_lam_hom_nay() {
    setup().await;
    let (card_a, card_e) = seed_work().await;
    let a = app().await;
    let p = "/api/v1/reports/dashboard-tasks";
    // SALE_A: thẻ quá hạn + thẻ hôm nay + thẻ qua bảng phụ + lịch hẹn của m20-1 (thẻ xong và bảng kín bị loại).
    let t = ok(&a, p, SALE_A).await;
    assert_eq!(
        (t["total"].clone(), t["due_today"].clone(), t["overdue"].clone()),
        (json!(4), json!(3), json!(1))
    );
    let items = t["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["key"], format!("k{card_a}"));
    assert_eq!(
        (items[0]["kind"].clone(), items[0]["overdue"].clone()),
        (json!("kanban"), json!(true))
    );
    assert!(items.iter().any(|i| i["key"] == format!("k{card_e}")));
    let rem = items.iter().find(|i| i["kind"] == "reminder").unwrap();
    assert_eq!(
        (rem["title"].clone(), rem["contact_name"].clone()),
        (json!("gọi lại"), json!("Khách M20 một"))
    );
    assert!(rem["due_at"].as_str().unwrap().ends_with('Z'));
    let kanban = items.iter().find(|i| i["key"] == format!("k{card_a}")).unwrap();
    assert_eq!(kanban["contact_name"], "Khách M20 một");
    // Bộ lọc của người ở phạm vi own bị bỏ qua.
    assert_eq!(ok(&a, &format!("{p}?user_id={SALE_B}"), SALE_A).await["total"], 4);
    // DIR: mặc định chỉ việc của chính mình (không có), lọc theo nhân viên/phòng thì thấy trong cây.
    assert_eq!(ok(&a, p, DIR).await["total"], 0);
    assert_eq!(ok(&a, &format!("{p}?user_id={SALE_B}"), DIR).await["total"], 1);
    assert_eq!(ok(&a, &format!("{p}?dept_head_id={DIR}"), DIR).await["total"], 5);
    assert_eq!(ok(&a, &format!("{p}?user_id={OUT}"), DIR).await["total"], 0);
    // Khách ngoài phạm vi contacts.view: không lộ id, tên lẫn ghi chú.
    let h = ok(&a, p, HIDDEN).await;
    let it = &h["items"][0];
    assert_eq!(h["total"], 1);
    assert_eq!(
        (
            it["key"].clone(),
            it["id"].clone(),
            it["title"].clone(),
            it["contact_id"].clone(),
            it["contact_name"].clone()
        ),
        (
            json!("c-hidden-0"),
            json!(0),
            json!("Nhắc liên hệ lại"),
            Value::Null,
            Value::Null
        )
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn roster_bo_loc() {
    setup().await;
    let a = app().await;
    let p = "/api/v1/reports/dashboard-filter-roster";
    let ids = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_i64().unwrap())
            .collect::<Vec<_>>()
    };
    let r = ok(&a, p, DIR).await;
    assert_eq!(ids(&r["dept_heads"]), [9602]);
    assert_eq!(ids(&r["team_leads"]), [9603]);
    let mut sales = ids(&r["sales"]);
    sales.sort_unstable();
    assert_eq!(sales, [9604, 9605]);
    assert_eq!(r["sales"][0]["manager_id"], 9603);
    // Phạm vi all thấy cả người ngoài cây; phạm vi own bị 403 bằng câu của dịch vụ.
    let r = ok(&a, p, ADMIN).await;
    assert!(ids(&r["sales"]).contains(&9606) && ids(&r["dept_heads"]).contains(&9602));
    let own = get(&a, p, Some(SALE_A)).await;
    assert_eq!(
        (own.status, own.body["message"].as_str()),
        (StatusCode::FORBIDDEN, Some("Không có quyền dùng bộ lọc Tổng quan"))
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn chi_so_hom_nay_va_xu_huong() {
    setup().await;
    seed_work().await;
    let a = app().await;
    let day: String = scalar("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD')").await;
    let s = ok(&a, "/api/v1/reports/dashboard-stats-today", DIR).await;
    assert_eq!(
        s,
        json!({ "interest_total": 3, "interest_yesterday": 1, "team_size": 4, "scope_label": "Toàn bộ cấp dưới" })
    );
    // Thiếu quyền nguồn (contacts.view) ⇒ null, không phải 0.
    let s = ok(&a, "/api/v1/reports/dashboard-stats-today", OV_ONLY).await;
    assert_eq!(
        s,
        json!({ "interest_total": null, "interest_yesterday": null, "team_size": null, "scope_label": "Toàn công ty" })
    );
    let t = ok(&a, "/api/v1/reports/dashboard-trend-14d", DIR).await;
    let days = t["days"].as_array().unwrap();
    assert_eq!((days.len(), days[13].clone()), (14, json!(day)));
    let series = t["series"]["interest"].as_array().unwrap();
    assert_eq!(
        (series.len(), series[13].clone(), series[12].clone(), series[0].clone()),
        (14, json!(3), json!(1), json!(0))
    );
    // Chuỗi thiếu quyền nguồn vắng mặt hẳn khỏi `series`.
    assert_eq!(
        ok(&a, "/api/v1/reports/dashboard-trend-14d", OV_ONLY).await["series"],
        json!({})
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn kenh_da_ket_noi() {
    setup().await;
    let a = app().await;
    let p = "/api/v1/reports/dashboard-channels";
    // Hệ thống chưa dựng quy trình: các module kênh đang tắt ⇒ không trả kênh nào.
    set_setting("setup_status", "chua_dung").await;
    assert_eq!(ok(&a, p, ADMIN).await, json!({ "channels": [], "available": [] }));
    set_setting("setup_status", "da_dung").await;
    set_setting("org_features", r#"{"online_store":true}"#).await;
    // Chưa nối gì: gợi ý "Nối thêm" theo thứ tự cố định (trang bán hàng chưa có slug).
    let r = ok(&a, p, ADMIN).await;
    let kinds: Vec<&str> = r["available"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        (r["channels"].clone(), kinds),
        (json!([]), vec!["facebook_page", "zalo_oa", "social", "store"])
    );

    exec(
        "INSERT INTO facebook_pages (page_id, name, token_enc, token_status, subscribed, connected_by, contact_source_id, default_assignee_id)
           VALUES ('m20-page', 'Trang m20', 'x', 'valid', true, 9601, 1, 9601);
         INSERT INTO facebook_conversations (page_id, psid) VALUES ('m20-page', 'psid-m20');
         INSERT INTO facebook_comments (post_id, comment_id, page_id, commented_at) VALUES ('p', 'm20-c', 'm20-page', now());
         INSERT INTO social_accounts (network, external_id, name, access_token_enc, connected_by, status)
           VALUES ('facebook', 'm20-page', 'Trang m20', 'x', 9601, 'active');
         INSERT INTO zalo_oa_connections (oa_id, status, access_token_enc, refresh_token_enc, access_expires_at, connected_by, updated_at)
           VALUES ('m20-oa', 'active', 'x', 'x', now() + interval '1 day', 9601, now());
         INSERT INTO zalo_oa_threads (oa_id, zalo_user_id, updated_at) VALUES ('m20-oa', 'zu-m20', now());
         INSERT INTO store_orders (customer_name, customer_phone, code, total, payment_method) VALUES ('m20', '0900000000', 'm20-1', 1000, 'cod')",
    )
    .await;
    let conv: i32 = scalar("SELECT id FROM facebook_conversations WHERE page_id = 'm20-page'").await;
    let thread: i32 = scalar("SELECT id FROM zalo_oa_threads WHERE oa_id = 'm20-oa'").await;
    let post: i32 =
        scalar("INSERT INTO social_posts (content, created_by) VALUES ('m20 bài', 9601) RETURNING id").await;
    let acc: i32 = scalar("SELECT id FROM social_accounts WHERE external_id = 'm20-page'").await;
    exec(&format!(
        "INSERT INTO facebook_messages (conversation_id, mid, direction) VALUES ({conv}, 'm20-a', 'in'), ({conv}, 'm20-b', 'in'), ({conv}, 'm20-c', 'out');
         INSERT INTO zalo_oa_messages (thread_id, status, kind, direction) VALUES ({thread}, 'sent', 'text', 'in');
         INSERT INTO social_post_targets (account_id, network, post_id, status, published_at) VALUES ({acc}, 'facebook', {post}, 'published', now())"
    ))
    .await;
    set_setting(
        "online_store",
        r#"{"name":"Quán m20","slug":"m20-shop","published":true}"#,
    )
    .await;

    let r = ok(&a, p, ADMIN).await;
    assert_eq!(r["available"], json!([]));
    let ch = r["channels"].as_array().unwrap();
    let kinds: Vec<&str> = ch.iter().map(|x| x["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["facebook_page", "zalo_oa", "social", "store"]);
    let fb = &ch[0];
    assert_eq!(
        (
            fb["name"].clone(),
            fb["state"].clone(),
            fb["note"].clone(),
            fb["today"].clone(),
            fb["posting"].clone()
        ),
        (
            json!("Trang m20"),
            json!("ok"),
            json!("Đang nhận tin · 1 bình luận hôm nay"),
            json!({ "label": "tin nhắn mới", "value": 2 }),
            json!("on")
        )
    );
    assert_eq!(
        (ch[1]["state"].clone(), ch[1]["today"]["value"].clone()),
        (json!("ok"), json!(1))
    );
    assert_eq!(
        (ch[2]["note"].clone(), ch[2]["today"].clone()),
        (
            json!("Đăng bài lên Fanpage"),
            json!({ "label": "bài đã đăng", "value": 1 })
        )
    );
    assert_eq!(
        (
            ch[3]["name"].clone(),
            ch[3]["note"].clone(),
            ch[3]["today"]["value"].clone()
        ),
        (json!("Quán m20"), json!("Đang mở bán"), json!(1))
    );
    // Không lộ khoá/token.
    assert!(!r.to_string().contains("token"));

    // Page hỏng token ⇒ cần kết nối lại; tắt Page ⇒ đã tắt; người không có quyền kênh không thấy gì.
    exec("UPDATE facebook_pages SET token_status = 'expired' WHERE page_id = 'm20-page'").await;
    let r = ok(&a, p, ADMIN).await;
    assert_eq!(
        (r["channels"][0]["state"].clone(), r["channels"][0]["note"].clone()),
        (json!("attention"), json!("Cần kết nối lại · 1 bình luận hôm nay"))
    );
    exec("UPDATE facebook_pages SET is_active = false WHERE page_id = 'm20-page'").await;
    assert_eq!((ok(&a, p, ADMIN).await["channels"][0]["state"].clone()), json!("off"));
    assert_eq!(ok(&a, p, SALE_A).await, json!({ "channels": [], "available": [] }));
    // Tính năng tắt theo tổ chức ⇒ nhóm kênh đó biến mất (kể cả gợi ý).
    set_setting("org_features", r#"{"online_store":true,"facebook_page":false}"#).await;
    let r = ok(&a, p, ADMIN).await;
    assert!(
        r["channels"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["kind"] != "facebook_page")
    );
    teardown().await;
}
