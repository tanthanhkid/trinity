//! M36 qua HTTP (router K14 thật, guard thật, Postgres thật). `public` đã migrate bằng Prisma, DB RIÊNG (bảng bị TRUNCATE):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-public-api --test public_http -- --ignored --test-threads=1`

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode};
use mod_public_api::{PublicCtx, api_router, named_guards};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "m36-jwt-secret-0123456789abcdef0123456789abcdef";

const OWNER: i32 = 9801; // contacts.create/view(own), deals.manage(own), kanban.manage/view(own); team 1
const LIMITED: i32 = 9802; // chỉ contacts.create
const ADMIN: i32 = 9803; // vai trò hệ thống
const LOCKED: i32 = 9804; // đủ quyền nhưng bị khoá sau khi cấp khoá
const NOVIEW: i32 = 9805; // deals.manage + contacts.create nhưng KHÔNG có contacts.view

const K_OWNER: &str = "trinity_live_m36-owner-key-000000000000001";
const K_LIMITED: &str = "trinity_live_m36-limited-key-0000000000002";
const K_ADMIN: &str = "trinity_live_m36-admin-key-000000000000003";
const K_LOCKED: &str = "trinity_live_m36-locked-key-00000000000004";
const K_NOSCOPE: &str = "trinity_live_m36-noscope-key-0000000000005";
const K_REVOKED: &str = "trinity_live_m36-revoked-key-0000000000006";
const K_NOVIEW: &str = "trinity_live_m36-noview-key-00000000000008";
const K_EXPIRED: &str = "trinity_live_m36-expired-key-0000000000007";

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

fn hash(k: &str) -> String {
    Sha256::digest(k.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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
    let mut env = BTreeMap::new();
    env.insert(
        "TRUSTED_PROXY".to_owned(),
        "cidr:127.0.0.1/32;header=x-real-ip".to_owned(),
    );
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
    let ctx = Arc::new(PublicCtx {
        db: db.clone(),
        platform,
        perms: perms.clone(),
        scopes: ScopeService::new(db, cache),
        ip,
        limiter: PublicCtx::new_limiter(),
        contact_created: None,
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: named_guards(&ctx),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 5);
    App {
        router: router.with_state(ctx),
    }
}

struct Res {
    status: StatusCode,
    body: Value,
}

async fn send(a: &App, method: Method, path: &str, key: Option<&str>, body: Option<Value>) -> Res {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("x-real-ip", "198.51.100.7");
    if let Some(k) = key {
        b = b.header("x-api-key", k);
    }
    let mut req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5555))));
    let resp = a.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
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

async fn setup() {
    exec(
        "TRUNCATE api_keys, kanban_boards, setting_options, contacts, deals, integration_events, notification_logs, \
          user_roles, role_permissions, roles, users RESTART IDENTITY CASCADE",
    )
    .await;
    exec("INSERT INTO teams (id, name) VALUES (1, 'm36') ON CONFLICT DO NOTHING").await;
    for (id, status) in [
        (OWNER, "active"),
        (LIMITED, "active"),
        (ADMIN, "active"),
        (LOCKED, "locked"),
        (NOVIEW, "active"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, team_id, updated_at)
             VALUES ({id}, 'u{id}@m36.test', 'x', 'Chủ khoá {id}', '{status}', 1, now())"
        ))
        .await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9801, 'm36-owner', false, now()), (9802, 'm36-limited', false, now()), (9803, 'm36-admin', true, now()), (9805, 'm36-noview', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9801, 'contacts.create', NULL), (9801, 'contacts.view', 'own'), (9801, 'deals.manage', 'own'),
            (9801, 'kanban.manage', NULL), (9801, 'kanban.view', 'own'),
            (9802, 'contacts.create', NULL),
            (9805, 'deals.manage', 'own'), (9805, 'contacts.create', NULL);
          INSERT INTO user_roles (user_id, role_id) VALUES (9801, 9801), (9802, 9802), (9803, 9803), (9804, 9801), (9805, 9805)").await;
    exec("INSERT INTO setting_options (id, group_key, value, label, is_active, sort_order, updated_at) VALUES
            (101, 'contact_source', 'web', 'Website', true, 2, now()), (102, 'contact_source', 'zalo', 'Zalo', true, 1, now()),
            (103, 'contact_source', 'old', 'Cũ', false, 3, now()), (104, 'contact_stage', 'new', 'Mới', true, 1, now())").await;
    let keys = [
        (
            K_OWNER,
            OWNER,
            "ARRAY['contacts:create','deals:create','tasks:create']",
            "NULL",
            "NULL",
        ),
        (
            K_LIMITED,
            LIMITED,
            "ARRAY['contacts:create','deals:create','tasks:create']",
            "NULL",
            "NULL",
        ),
        (
            K_ADMIN,
            ADMIN,
            "ARRAY['contacts:create','deals:create','tasks:create']",
            "NULL",
            "NULL",
        ),
        (K_LOCKED, LOCKED, "ARRAY['contacts:create']", "NULL", "NULL"),
        (K_NOVIEW, NOVIEW, "ARRAY['deals:create']", "NULL", "NULL"),
        (K_NOSCOPE, OWNER, "ARRAY['auth:login']", "NULL", "NULL"),
        (K_REVOKED, OWNER, "ARRAY['contacts:create']", "now()", "NULL"),
        (
            K_EXPIRED,
            OWNER,
            "ARRAY['contacts:create']",
            "NULL",
            "now() - interval '1 day'",
        ),
    ];
    for (i, (k, owner, scopes, revoked, expires)) in keys.into_iter().enumerate() {
        exec(&format!(
            "INSERT INTO api_keys (name, prefix, key_hash, scopes, owner_user_id, created_by, revoked_at, expires_at, updated_at)
             VALUES ('k{owner}', 'trinity_live_m36_{i}', '{}', {scopes}, {owner}, {owner}, {revoked}, {expires}, now())",
            hash(k)
        ))
        .await;
    }
    exec(
        "INSERT INTO kanban_boards (id, name, created_by, updated_at) VALUES (1, 'Bảng m36', 9801, now());
          INSERT INTO kanban_columns (id, board_id, name, position, is_archived, updated_at) VALUES
            (11, 1, 'Làm', 1024, false, now()), (12, 1, 'Ẩn', 2048, true, now());
          INSERT INTO kanban_field_defs (board_id, key, label, type, required, position, updated_at) VALUES
            (1, 'khu_vuc', 'Khu vực', 'text', false, 1024, now())",
    )
    .await;
}

// ================================================================= xác thực, giới hạn

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn xac_thuc_khoa_api() {
    setup().await;
    let a = app().await;
    let path = "/api/v1/public/contacts/sources";
    let r = send(&a, Method::GET, path, None, None).await;
    assert_eq!((r.status.as_u16(), msg(&r).as_str()), (401, "Thiếu X-API-Key header"));
    let r = send(&a, Method::GET, path, Some("trinity_live_khong-ton-tai"), None).await;
    assert_eq!((r.status.as_u16(), msg(&r).as_str()), (401, "X-API-Key không hợp lệ"));
    let r = send(&a, Method::GET, path, Some("c9.trinity_live_xyz"), None).await; // công ty lạ
    assert_eq!((r.status.as_u16(), msg(&r).as_str()), (401, "X-API-Key không hợp lệ"));
    let r = send(&a, Method::GET, path, Some(K_REVOKED), None).await;
    assert_eq!(msg(&r), "Khoá API đã bị thu hồi");
    let r = send(&a, Method::GET, path, Some(K_EXPIRED), None).await;
    assert_eq!(msg(&r), "Khoá API đã hết hạn");
    let r = send(&a, Method::GET, path, Some(K_NOSCOPE), None).await;
    assert_eq!(msg(&r), "Khoá API không có phạm vi \"contacts:create\"");
    // Khoá có scope contacts nhưng gọi route deals ⇒ thiếu phạm vi.
    let r = send(
        &a,
        Method::POST,
        "/api/v1/public/deals",
        Some(K_LOCKED),
        Some(json!({ "title": "x" })),
    )
    .await;
    assert_eq!(msg(&r), "Khoá API không có phạm vi \"deals:create\"");
    // Chủ khoá bị khoá ⇒ từ chối.
    let r = send(&a, Method::GET, path, Some(K_LOCKED), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (401, "Owner user của khoá API không còn hoạt động")
    );
    // Khoá tốt ⇒ 200, khoảng trắng đầu/cuối được cắt, `last_used_*` được ghi ở nền.
    let r = send(&a, Method::GET, path, Some(&format!(" {K_OWNER} ")), None).await;
    assert_eq!(r.status, 200);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(
        scalar::<Option<String>>(&format!(
            "SELECT last_used_ip FROM api_keys WHERE key_hash = '{}'",
            hash(K_OWNER)
        ))
        .await
        .as_deref(),
        Some("198.51.100.7")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn gioi_han_100_yeu_cau_moi_phut_moi_khoa() {
    setup().await;
    let a = app().await;
    for i in 0..100 {
        let r = send(&a, Method::GET, "/api/v1/public/contacts/sources", Some(K_OWNER), None).await;
        assert_eq!(r.status, 200, "lần {i}");
    }
    let r = send(&a, Method::GET, "/api/v1/public/contacts/sources", Some(K_OWNER), None).await;
    assert_eq!(r.status, 429);
    assert_eq!(r.body["statusCode"], 429);
    assert_eq!(r.body["message"], "Quá nhiều request, vui lòng thử lại sau.");
    assert!(r.body["retryAfter"].as_u64().unwrap() >= 1);
    assert!(r.body.get("error").is_none(), "{:?}", r.body);
    // Bị chặn trước cả khi kiểm body; khoá khác không bị ảnh hưởng.
    let r = send(
        &a,
        Method::POST,
        "/api/v1/public/contacts",
        Some(K_OWNER),
        Some(json!({})),
    )
    .await;
    assert_eq!(r.status, 429);
    assert_eq!(
        send(
            &a,
            Method::GET,
            "/api/v1/public/contacts/sources",
            Some(K_LIMITED),
            None
        )
        .await
        .status,
        200
    );
}

// ================================================================= khách

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tao_khach_nguon_va_canh_bao_trung() {
    setup().await;
    let a = app().await;
    let r = send(&a, Method::GET, "/api/v1/public/contacts/sources", Some(K_OWNER), None).await;
    assert_eq!(
        r.body,
        json!({ "data": [{ "id": 102, "name": "Zalo" }, { "id": 101, "name": "Website" }] })
    );

    let body = json!({ "phone": "+84900000001", "full_name": "  Nguyễn Văn A  ", "source_id": 101, "email": "a@example.com", "job_title": "NV", "reminder_notes": "ghi chú" });
    let r = send(
        &a,
        Method::POST,
        "/api/v1/public/contacts",
        Some(K_OWNER),
        Some(body.clone()),
    )
    .await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let c = &r.body["contact"];
    assert_eq!(
        (
            c["phone"].as_str(),
            c["full_name"].as_str(),
            c["source_id"].as_i64(),
            c["assigned_to"].as_i64()
        ),
        (
            Some("0900000001"),
            Some("Nguyễn Văn A"),
            Some(101),
            Some(i64::from(OWNER))
        )
    );
    assert!(c["created_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(r.body["warning"], Value::Null);
    // Kế thừa team của chủ khoá + sự kiện outbox `contact.created` có origin = public_api.
    assert_eq!(scalar::<i32>("SELECT team_id FROM contacts WHERE id = 1").await, 1);
    assert_eq!(scalar::<i64>("SELECT count(*) FROM integration_events WHERE event_type = 'contact.created' AND payload->>'origin' = 'public_api'").await, 1);
    // Trùng SĐT cùng chủ khoá ⇒ vẫn tạo, kèm cảnh báo.
    let r = send(
        &a,
        Method::POST,
        "/api/v1/public/contacts",
        Some(K_OWNER),
        Some(body.clone()),
    )
    .await;
    assert_eq!(r.status, 201);
    assert_eq!(r.body["warning"], "SĐT đã tồn tại trong hệ thống — vẫn tạo thành công");
    // Chủ khoá khác (cùng SĐT) không bị lộ việc trùng.
    let r = send(&a, Method::POST, "/api/v1/public/contacts", Some(K_LIMITED), Some(body)).await;
    assert_eq!((r.status.as_u16(), &r.body["warning"]), (201, &Value::Null));
    // Nguồn không hợp lệ / tắt / sai nhóm; SĐT sai; trường lạ.
    let mk = |over: Value| {
        let mut b = json!({ "phone": "0900000002", "full_name": "B", "source_id": 101 });
        for (k, v) in over.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    };
    for (over, want) in [
        (
            json!({ "source_id": 104 }),
            "source_id 104 không thuộc group contact_source",
        ),
        (
            json!({ "source_id": 999 }),
            "source_id 999 không thuộc group contact_source",
        ),
        (json!({ "source_id": 103 }), "Nguồn khách ID 103 đang bị tắt"),
    ] {
        let r = send(
            &a,
            Method::POST,
            "/api/v1/public/contacts",
            Some(K_OWNER),
            Some(mk(over)),
        )
        .await;
        assert_eq!((r.status.as_u16(), msg(&r).as_str()), (400, want));
    }
    let r = send(
        &a,
        Method::POST,
        "/api/v1/public/contacts",
        Some(K_OWNER),
        Some(mk(json!({ "phone": "123" }))),
    )
    .await;
    assert_eq!(r.status, 400);
    assert!(msg(&r).contains("SĐT không hợp lệ"), "{}", msg(&r));
    let r = send(
        &a,
        Method::POST,
        "/api/v1/public/contacts",
        Some(K_OWNER),
        Some(mk(json!({ "assigned_to": 1 }))),
    )
    .await;
    assert_eq!(r.status, 400);
    assert!(msg(&r).contains("property assigned_to should not exist"), "{}", msg(&r));
    assert_eq!(scalar::<i64>("SELECT count(*) FROM contacts").await, 3);
}

// ================================================================= thương vụ

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tao_thuong_vu_theo_quyen_chu_khoa() {
    setup().await;
    let a = app().await;
    let post = |k: &'static str, b: Value| {
        let a = &a;
        async move { send(a, Method::POST, "/api/v1/public/deals", Some(k), Some(b)).await }
    };
    // Thiếu quyền deals.manage ⇒ 403; Quản trị ⇒ 403 chặn khoá.
    let r = post(K_LIMITED, json!({ "title": "x" })).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (403, "Người giữ khoá không có quyền tạo thương vụ.")
    );
    let r = post(K_ADMIN, json!({ "title": "x" })).await;
    assert_eq!(r.status, 403);
    assert!(msg(&r).starts_with("Chủ khoá API hiện là Quản trị"));
    // Không gắn khách.
    let r = post(K_OWNER, json!({ "title": "Đơn #1", "value": 1500000, "note": "n" })).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let d = &r.body["deal"];
    assert_eq!(
        (
            d["title"].as_str(),
            d["value"].as_i64(),
            d["status"].as_str(),
            d["assigned_to"].as_i64(),
            d["created_by"].as_i64()
        ),
        (
            Some("Đơn #1"),
            Some(1_500_000),
            Some("open"),
            Some(i64::from(OWNER)),
            Some(i64::from(OWNER))
        )
    );
    assert!(d["code"].as_str().is_some_and(|c| !c.is_empty()), "{d}");
    assert_eq!(d["assignee"]["email"], format!("u{OWNER}@m36.test"));
    assert_eq!(d["contact"], Value::Null);
    assert_eq!(
        (&r.body["contact_id"], &r.body["contact_created"]),
        (&Value::Null, &json!(false))
    );
    // Gắn khách chưa có (có tên ⇒ tạo mới, cần contacts.create); SĐT che vì không có contacts.phone_full.
    let r = post(K_OWNER, json!({ "title": "Đơn #2", "status": "won", "contact_phone": "0911111111", "contact_name": " Khách mới ", "contact_source_id": 101 })).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    assert_eq!(
        (&r.body["contact_created"], r.body["deal"]["status"].as_str()),
        (&json!(true), Some("won"))
    );
    assert_eq!(r.body["deal"]["contact"]["full_name"], "Khách mới");
    assert_eq!(r.body["deal"]["contact"]["phone"], "***111");
    // Cùng SĐT lần nữa ⇒ gắn khách có sẵn (trong phạm vi contacts.view = own, khách do chủ khoá phụ trách).
    let r = post(K_OWNER, json!({ "title": "Đơn #3", "contact_phone": "+84911111111" })).await;
    assert_eq!((&r.body["contact_created"], r.status.as_u16()), (&json!(false), 201));
    assert_eq!(scalar::<i64>("SELECT count(*) FROM contacts").await, 1);
    // Không có SĐT khớp mà thiếu tên ⇒ 400.
    let r = post(K_OWNER, json!({ "title": "x", "contact_phone": "0922222222" })).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (
            400,
            "Không tìm thấy khách có SĐT này. Gửi thêm contact_name để tạo khách mới."
        )
    );
    // Nguồn khách sai.
    let r = post(
        K_OWNER,
        json!({ "title": "x", "contact_phone": "0922222222", "contact_name": "Y", "contact_source_id": 103 }),
    )
    .await;
    assert_eq!(msg(&r), "contact_source_id 103 không phải nguồn khách đang bật");
    // Outbox: deal.created ×3, deal.won ×1; thông báo "được giao thương vụ".
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM integration_events WHERE event_type = 'deal.created'").await,
        3
    );
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM integration_events WHERE event_type = 'deal.won'").await,
        1
    );
    assert_eq!(
        scalar::<i64>(
            "SELECT count(*) FROM notification_logs WHERE event_type = 'deal.assigned' AND recipient_id = 9801"
        )
        .await,
        3
    );
    // Chủ khoá thiếu contacts.view: khách mới sẽ nằm ngoài phạm vi xem ⇒ bị từ chối TRƯỚC khi tạo khách (không khách mồ côi).
    let before = scalar::<i64>("SELECT count(*) FROM contacts").await;
    let r = post(
        K_NOVIEW,
        json!({ "title": "x", "contact_phone": "0944444444", "contact_name": "Mồ côi" }),
    )
    .await;
    assert_eq!(r.status, 404, "{:?}", r.body);
    assert_eq!(scalar::<i64>("SELECT count(*) FROM contacts").await, before);
    // Body sai kiểu / trường lạ.
    let r = post(K_OWNER, json!({ "title": "", "value": -1, "hack": true })).await;
    assert_eq!(r.status, 400);
}

// ================================================================= việc Kanban

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cot_kanban_va_tao_viec() {
    setup().await;
    let a = app().await;
    let r = send(&a, Method::GET, "/api/v1/public/tasks/columns", Some(K_OWNER), None).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    let b = &r.body["data"][0];
    assert_eq!(
        (b["board_id"].as_i64(), b["board"].as_str()),
        (Some(1), Some("Bảng m36"))
    );
    assert_eq!(b["columns"], json!([{ "column_id": 11, "name": "Làm" }]));
    assert_eq!(b["fields"][0]["key"], "khu_vuc");
    // Thiếu kanban.view.
    let r = send(&a, Method::GET, "/api/v1/public/tasks/columns", Some(K_LIMITED), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (403, "Người giữ khoá không có quyền xem bảng Kanban.")
    );

    let post = |k: &'static str, b: Value| {
        let a = &a;
        async move { send(a, Method::POST, "/api/v1/public/tasks", Some(k), Some(b)).await }
    };
    let r = post(K_LIMITED, json!({ "column_id": 11, "title": "x" })).await;
    assert_eq!(msg(&r), "Người giữ khoá không có quyền tạo việc trên bảng Kanban.");
    // Cột không có / cột ẩn: lỗi TRƯỚC khi tạo khách ⇒ không để lại khách thừa.
    let r = post(
        K_OWNER,
        json!({ "column_id": 999, "title": "x", "contact_phone": "0933333333", "contact_name": "Z" }),
    )
    .await;
    assert_eq!((r.status.as_u16(), msg(&r).as_str()), (400, "column_id không hợp lệ"));
    let r = post(
        K_OWNER,
        json!({ "column_id": 12, "title": "x", "contact_phone": "0933333333", "contact_name": "Z" }),
    )
    .await;
    assert_eq!(msg(&r), "Cột đã ẩn — không thể tạo việc vào đây");
    assert_eq!(scalar::<i64>("SELECT count(*) FROM contacts").await, 0);
    // Tạo việc kèm khách mới, giao cho chủ khoá.
    let r = post(K_OWNER, json!({ "column_id": 11, "title": "Gọi lại", "priority": "high", "labels": ["zapier"], "attributes": { "khu_vuc": "HCM" }, "contact_phone": "0933333333", "contact_name": "Khách Z", "contact_source_id": 101 })).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let t = &r.body["task"];
    assert_eq!(
        (
            t["title"].as_str(),
            t["priority"].as_str(),
            t["assignee_id"].as_i64(),
            t["column_id"].as_i64()
        ),
        (Some("Gọi lại"), Some("high"), Some(i64::from(OWNER)), Some(11))
    );
    assert_eq!(
        (&r.body["contact_created"], r.body["contact_id"].as_i64()),
        (&json!(true), Some(1))
    );
    assert!(t["code"].as_str().is_some());
    // Trường tuỳ biến lạ ⇒ 400.
    let r = post(
        K_OWNER,
        json!({ "column_id": 11, "title": "x", "attributes": { "khong_co": 1 } }),
    )
    .await;
    assert_eq!(r.status, 400, "{:?}", r.body);
    // Body sai.
    assert_eq!(post(K_OWNER, json!({ "title": "thiếu cột" })).await.status, 400);
}
