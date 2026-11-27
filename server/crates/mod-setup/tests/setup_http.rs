//! M19 qua HTTP (router K14 thật, quyền thật, kiểm dữ liệu strict, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-setup --test setup_http -- --ignored --test-threads=1`
//! DB phải trống khách hàng và bản ghi tuỳ biến (đếm "bản ghi thật"). Test tự tạo và xoá user/vai trò 9701..9799, mọi bảng của
//! danh mục mẫu, khách mẫu và các khoá `settings` của wizard; các khoá đó được khôi phục đúng như trước khi chạy.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_setup::{Ctx, api_router, catalog};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tokio::sync::OnceCell;
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache};

const JWT: &str = "m19-jwt-secret-0123456789abcdef0123456789abcdef";
const WHERE_KEYS: &str = "key IN ('org_features', 'setup_status', 'setup_built', 'setup_industry', 'sample_records', 'onboarding_wizard') OR key LIKE 'onboarding\\_%:user:%'";

const ADMIN: i32 = 9701; // quản trị + ghi bản ghi + kênh
const MEMBER: i32 = 9702; // không quyền
const MANAGER: i32 = 9703; // dựng được nhưng không ghi được bản ghi tuỳ biến
const LATE: i32 = 9704; // tạo SAU lúc dựng

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
    env: Arc<Mutex<HashMap<String, String>>>,
    removed: Arc<AtomicUsize>,
}

async fn app() -> App {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache);
    let env: Arc<Mutex<HashMap<String, String>>> = Arc::default();
    let removed = Arc::new(AtomicUsize::new(0));
    let (e2, r2) = (env.clone(), removed.clone());
    let ctx = Arc::new(Ctx {
        db,
        env: Arc::new(move |k| e2.lock().unwrap().get(k).cloned()),
        contacts_changed: Some(Arc::new(move |_| {
            r2.fetch_add(1, Ordering::SeqCst);
        })),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 13);
    App {
        router: router.with_state(ctx),
        env,
        removed,
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m19.test"), None, None, now),
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
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = app.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
    }
}

async fn ok(app: &App, method: Method, path: &str, user: i32, body: Option<Value>) -> Value {
    let r = call(app, method, path, Some(user), body).await;
    assert!(r.status.is_success(), "{path}: {} {:?}", r.status, r.body);
    r.body
}

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

static SNAP: OnceCell<Vec<(String, String)>> = OnceCell::const_new();

async fn restore_settings() {
    let snap = SNAP
        .get_or_init(|| async {
            let mut c = PgConnection::connect(&url()).await.unwrap();
            sqlx::query_as(AssertSqlSafe(format!(
                "SELECT key, value FROM settings WHERE {WHERE_KEYS}"
            )))
            .fetch_all(&mut c)
            .await
            .unwrap()
        })
        .await;
    exec(&format!("DELETE FROM settings WHERE {WHERE_KEYS}")).await;
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

fn object_keys() -> String {
    let keys: Vec<String> = catalog::catalog()
        .templates
        .iter()
        .flat_map(|t| t.objects.iter())
        .map(|o| format!("'{}'", o.key))
        .collect();
    keys.join(",")
}

async fn teardown() {
    let keys = object_keys();
    exec(&format!(
        "DELETE FROM custom_records WHERE object_id IN (SELECT id FROM custom_objects WHERE key IN ({keys}));
          DELETE FROM custom_records WHERE created_by BETWEEN 9701 AND 9799;
          DELETE FROM custom_views WHERE object_id IN (SELECT id FROM custom_objects WHERE key IN ({keys}));
          DELETE FROM custom_fields WHERE object_id IN (SELECT id FROM custom_objects WHERE key IN ({keys}));
          DELETE FROM custom_schema_versions WHERE true;
          DELETE FROM custom_objects WHERE key IN ({keys});
          DELETE FROM contacts WHERE phone LIKE 'm19-%' OR phone IN ('0900000001', '0900000002', '0900000003');
          DELETE FROM oauth_tokens WHERE user_id BETWEEN 9701 AND 9799;
          DELETE FROM user_roles WHERE user_id BETWEEN 9701 AND 9799;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9701 AND 9799;
          DELETE FROM roles WHERE id BETWEEN 9701 AND 9799;
          DELETE FROM users WHERE id BETWEEN 9701 AND 9799"
    ))
    .await;
    restore_settings().await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [
        (ADMIN, "M19 Quản trị"),
        (MEMBER, "M19 Thành viên"),
        (MANAGER, "M19 Quản lý"),
    ] {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({id}, 'u{id}@m19.test', 'x', '{name}', now())")).await;
    }
    exec(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES (9701, 'm19-admin', false, now()), (9703, 'm19-manager', false, now());
         INSERT INTO role_permissions (role_id, permission, scope) VALUES
           (9701, 'custom_objects.manage', NULL), (9701, 'settings.features', NULL), (9701, 'custom_records.manage', 'all'),
           (9701, 'social.manage', NULL), (9701, 'social.post', NULL),
           (9703, 'custom_objects.manage', NULL), (9703, 'settings.features', NULL);
         INSERT INTO user_roles (user_id, role_id) VALUES (9701, 9701), (9703, 9703)",
    )
    .await;
    set_setting("setup_status", "chua_dung").await;
}

const S: &str = "/api/v1/setup";
const TPL: &str = "/api/v1/custom-objects/templates";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn quyen_va_kiem_du_lieu() {
    setup().await;
    let a = app().await;
    for (m, p) in [
        (Method::GET, "/status"),
        (Method::GET, "/connect-prompt"),
        (Method::GET, "/onboarding"),
        (Method::POST, "/onboarding/seen"),
        (Method::POST, "/complete"),
        (Method::POST, "/build"),
        (Method::GET, "/wizard"),
        (Method::GET, "/wizard/config"),
        (Method::PUT, "/wizard/config"),
        (Method::POST, "/wizard/confirm"),
        (Method::POST, "/wizard/skip"),
    ] {
        assert_eq!(call(&a, m, &format!("{S}{p}"), None, None).await.status, 401, "{p}");
    }
    assert_eq!(call(&a, Method::GET, TPL, None, None).await.status, 401);
    for (m, p) in [
        (Method::POST, format!("{S}/complete")),
        (Method::POST, format!("{S}/build")),
        (Method::GET, format!("{S}/wizard/config")),
        (Method::PUT, format!("{S}/wizard/config")),
        (Method::GET, TPL.to_owned()),
        (Method::POST, format!("{TPL}/clinic/apply")),
    ] {
        assert_eq!(call(&a, m, &p, Some(MEMBER), Some(json!({}))).await.status, 403, "{p}");
    }
    // Build cần CẢ hai quyền (mode all).
    let one = call(
        &a,
        Method::POST,
        &format!("{S}/build"),
        Some(MANAGER),
        Some(json!({ "industry": "other" })),
    )
    .await;
    assert_eq!(one.status, 200, "{:?}", one.body); // MANAGER có đủ hai quyền ⇒ dựng được

    // Kiểm dữ liệu strict (câu của class-validator).
    let bad = call(
        &a,
        Method::POST,
        &format!("{S}/build"),
        Some(ADMIN),
        Some(json!({ "industry": "khac", "features": ["a", 1], "x": 1 })),
    )
    .await;
    assert_eq!(bad.status, 400);
    let m = msg(&bad);
    for want in [
        "industry must be one of the following values",
        "each value in features must be a string",
        "property x should not exist",
    ] {
        assert!(m.contains(want), "{want} trong {m}");
    }
    assert_eq!(
        call(&a, Method::POST, &format!("{S}/build"), Some(ADMIN), Some(json!({})))
            .await
            .status,
        400
    );
    let many: Vec<String> = (0..40).map(|i| format!("f{i}")).collect();
    assert_eq!(
        call(
            &a,
            Method::POST,
            &format!("{S}/build"),
            Some(ADMIN),
            Some(json!({ "industry": "other", "features": many }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(
            &a,
            Method::POST,
            &format!("{S}/wizard/confirm"),
            Some(ADMIN),
            Some(json!({ "step": "khac" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(
            &a,
            Method::PUT,
            &format!("{S}/wizard/config"),
            Some(ADMIN),
            Some(json!({ "enabled": "x", "exempt_before": "hôm qua" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(
            &a,
            Method::POST,
            &format!("{TPL}/clinic/apply"),
            Some(ADMIN),
            Some(json!({ "with_sample_data": "yes" }))
        )
        .await
        .status,
        400
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn mau_bang_ap_idempotent_co_du_lieu_mau() {
    setup().await;
    let a = app().await;
    let list = ok(&a, Method::GET, TPL, ADMIN, None).await;
    let keys: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["education_center", "real_estate", "retail_service", "clinic"]);
    assert_eq!(
        list[3]["objects"][0],
        json!({ "key": "pk_benh_nhan", "label": "Bệnh nhân / thú cưng", "applied": false })
    );
    let nf = call(
        &a,
        Method::POST,
        &format!("{TPL}/khong_co/apply"),
        Some(ADMIN),
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (nf.status, msg(&nf).as_str()),
        (StatusCode::NOT_FOUND, "Không tìm thấy mẫu này")
    );
    // Dữ liệu mẫu cần thêm quyền ghi bản ghi.
    let no = call(
        &a,
        Method::POST,
        &format!("{TPL}/clinic/apply"),
        Some(MANAGER),
        Some(json!({ "with_sample_data": true })),
    )
    .await;
    assert_eq!(no.status, 403);
    assert!(msg(&no).contains("Tạo dữ liệu mẫu cần thêm quyền"));

    let r = ok(&a, Method::POST, &format!("{TPL}/clinic/apply"), ADMIN, Some(json!({}))).await;
    assert_eq!(
        r,
        json!({ "created": ["pk_benh_nhan", "pk_lich_hen", "pk_dieu_tri"], "existing": [], "sample_records": 0 })
    );
    // Mã bảng do DB cấp, trường liên kết trỏ đúng id thực thể, công thức giữ biểu thức.
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM custom_objects WHERE key LIKE 'pk\\_%' AND code_prefix IS NOT NULL").await,
        3
    );
    assert!(
        scalar::<bool>("SELECT (f.options ->> 'target_object_id')::int = (SELECT id FROM custom_objects WHERE key = 'pk_benh_nhan') FROM custom_fields f JOIN custom_objects o ON o.id = f.object_id WHERE o.key = 'pk_lich_hen' AND f.key = 'benh_nhan'").await);
    assert_eq!(
        scalar::<String>("SELECT f.options ->> 'expression' FROM custom_fields f JOIN custom_objects o ON o.id = f.object_id WHERE o.key = 'pk_dieu_tri' AND f.key = 'tong_chi_phi'").await,
        "{chi_phi_thu_thuat}+{chi_phi_thuoc}"
    );
    // Áp lại: giữ nguyên, không nhân đôi, không sinh mẫu (không phải bảng mới).
    let again = ok(
        &a,
        Method::POST,
        &format!("{TPL}/clinic/apply"),
        ADMIN,
        Some(json!({ "with_sample_data": true })),
    )
    .await;
    assert_eq!(
        again,
        json!({ "created": [], "existing": ["pk_benh_nhan", "pk_lich_hen", "pk_dieu_tri"], "sample_records": 0 })
    );
    assert_eq!(
        ok(&a, Method::GET, TPL, ADMIN, None).await[3]["objects"][0]["applied"],
        true
    );

    // Mẫu khác kèm dữ liệu mẫu: bản ghi có tiêu đề, mã do DB cấp, liên kết trỏ bản ghi mẫu thật.
    let r = ok(
        &a,
        Method::POST,
        &format!("{TPL}/real_estate/apply"),
        ADMIN,
        Some(json!({ "with_sample_data": true })),
    )
    .await;
    let n = r["sample_records"].as_u64().unwrap();
    assert!(n > 0, "{r}");
    assert_eq!(scalar::<i64>("SELECT count(*) FROM custom_records r JOIN custom_objects o ON o.id = r.object_id WHERE o.key LIKE 'bds\\_%'").await, i64::try_from(n).unwrap());
    assert_eq!(scalar::<i64>("SELECT count(*) FROM custom_records r JOIN custom_objects o ON o.id = r.object_id WHERE o.key LIKE 'bds\\_%' AND (r.title IS NULL OR r.code IS NULL)").await, 0);
    // Bản ghi mẫu của lần "áp mẫu" thường KHÔNG vào danh sách tự xoá (chỉ dựng hệ thống mới theo dõi).
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM settings WHERE key = 'sample_records'").await,
        0
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn dung_he_thong_theo_nganh_va_mau_tu_xoa() {
    setup().await;
    let a = app().await;
    let b = format!("{S}/build");
    // Ngành có mẫu bảng: chọn phân hệ; mẫu chỉ sinh cho thực thể đầu (3 bản ghi), theo dõi để tự xoá.
    let r = ok(
        &a,
        Method::POST,
        &b,
        ADMIN,
        Some(json!({ "industry": "clinic", "features": ["pos", "khong-co"] })),
    )
    .await;
    assert_eq!(
        (
            r["industry"].clone(),
            r["created_objects"].clone(),
            r["sample_records"].clone(),
            r["setup_status"].clone()
        ),
        (
            json!("clinic"),
            json!(["pk_benh_nhan", "pk_lich_hen", "pk_dieu_tri"]),
            json!(3),
            json!("da_dung")
        )
    );
    let f: Vec<&str> = r["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert!(
        ["dashboard", "contacts", "kanban", "reports", "pos"]
            .iter()
            .all(|k| f.contains(k))
            && !f.contains(&"inbox")
            && !f.contains(&"khong-co"),
        "{f:?}"
    );
    assert_eq!(r["wizard"]["industry"], "clinic");
    assert_eq!(r["wizard"]["sample_data"], true);
    let steps: Vec<(&str, bool)> = r["wizard"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["key"].as_str().unwrap(), s["done"].as_bool().unwrap()))
        .collect();
    assert_eq!(steps, [("industry", true), ("modules", true), ("data", false)]);
    let stored: Value =
        serde_json::from_str(&scalar::<String>("SELECT value FROM settings WHERE key = 'org_features'").await).unwrap();
    assert_eq!(
        (
            stored["pos"].clone(),
            stored["inbox"].clone(),
            stored["dashboard"].clone()
        ),
        (json!(true), json!(false), json!(true))
    );
    assert_eq!(
        scalar::<String>("SELECT value FROM settings WHERE key = 'setup_industry'").await,
        "clinic"
    );
    assert_eq!(
        scalar::<String>("SELECT value FROM settings WHERE key = 'setup_status'").await,
        "da_dung"
    );
    let built: Value =
        serde_json::from_str(&scalar::<String>("SELECT value FROM settings WHERE key = 'setup_built'").await).unwrap();
    assert_eq!(
        (
            built["industry"].clone(),
            built["built_by"].clone(),
            built["samples_seeded"].clone()
        ),
        (json!("clinic"), json!(ADMIN), json!(true))
    );
    let st = ok(&a, Method::GET, &format!("{S}/status"), ADMIN, None).await;
    assert_eq!(
        (
            st["status"].clone(),
            st["has_sample_data"].clone(),
            st["can_build"].clone()
        ),
        (json!("da_dung"), json!(true), json!(true))
    );
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/status"), MEMBER, None).await["can_build"],
        false
    );

    // Dựng lại không truyền phân hệ: giữ cấu hình, không tạo lại bảng, không sinh thêm mẫu.
    let again = ok(&a, Method::POST, &b, ADMIN, Some(json!({ "industry": "clinic" }))).await;
    assert_eq!(
        (
            again["created_objects"].clone(),
            again["existing_objects"].clone(),
            again["sample_records"].clone()
        ),
        (
            json!([]),
            json!(["pk_benh_nhan", "pk_lich_hen", "pk_dieu_tri"]),
            json!(0)
        )
    );
    let kept: Vec<&str> = again["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert_eq!(kept, f);
    assert_eq!(scalar::<i64>("SELECT count(*) FROM custom_records r JOIN custom_objects o ON o.id = r.object_id WHERE o.key = 'pk_benh_nhan' AND r.deleted_at IS NULL").await, 3);

    // Bản ghi THẬT đầu tiên (một bản ghi mẫu bị người dùng sửa thì được giữ): màn trạng thái dọn mẫu còn nguyên.
    let edited: i32 = scalar("SELECT min(r.id) FROM custom_records r JOIN custom_objects o ON o.id = r.object_id WHERE o.key = 'pk_benh_nhan'").await;
    exec(&format!(
        "UPDATE custom_records SET updated_at = created_at + interval '10 seconds' WHERE id = {edited}"
    ))
    .await;
    exec("INSERT INTO custom_records (object_id, data, title, created_by, updated_at) SELECT id, '{}', 'Bản ghi thật', 9701, now() FROM custom_objects WHERE key = 'pk_benh_nhan'").await;
    let st = ok(&a, Method::GET, &format!("{S}/status"), ADMIN, None).await;
    assert_eq!(st["has_sample_data"], false);
    assert_eq!(scalar::<i64>("SELECT count(*) FROM custom_records r JOIN custom_objects o ON o.id = r.object_id WHERE o.key = 'pk_benh_nhan' AND r.deleted_at IS NULL").await, 2); // thật + mẫu đã sửa
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM settings WHERE key = 'sample_records'").await,
        0
    );
    assert_eq!(a.removed.load(Ordering::SeqCst), 0); // không có khách mẫu bị xoá
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn dung_crm_co_ban_khach_mau_va_quyen_ghi() {
    setup().await;
    let a = app().await;
    let b = format!("{S}/build");
    // Thiếu quyền ghi bản ghi (MANAGER): vẫn dựng, không có mẫu.
    let r = ok(&a, Method::POST, &b, MANAGER, Some(json!({ "industry": "other" }))).await;
    assert_eq!(
        (r["sample_contacts"].clone(), r["created_objects"].clone()),
        (json!(0), json!([]))
    );
    assert_eq!(scalar::<i64>("SELECT count(*) FROM contacts").await, 0);
    // Dựng lại bằng quản trị có quyền: `samples_seeded` chưa bật nên vẫn sinh 3 khách mẫu, đã đăng ký theo dõi.
    let r = ok(&a, Method::POST, &b, ADMIN, Some(json!({ "industry": "other" }))).await;
    assert_eq!(r["sample_contacts"], 3);
    assert_eq!(a.removed.load(Ordering::SeqCst), 1);
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM contacts WHERE full_name LIKE '%(mẫu)'").await,
        3
    );
    let tracked: Value =
        serde_json::from_str(&scalar::<String>("SELECT value FROM settings WHERE key = 'sample_records'").await)
            .unwrap();
    assert_eq!(tracked["contacts"].as_array().unwrap().len(), 3);
    // Dựng lại lần nữa: không thêm khách mẫu.
    assert_eq!(
        ok(&a, Method::POST, &b, ADMIN, Some(json!({ "industry": "other" }))).await["sample_contacts"],
        0
    );
    assert_eq!(scalar::<i64>("SELECT count(*) FROM contacts").await, 3);

    // Khách thật đầu tiên ⇒ 3 khách mẫu xoá mềm, khách thật còn, cache đếm khách được báo xoá.
    exec("INSERT INTO contacts (phone, full_name, updated_at) VALUES ('m19-1', 'Khách thật', now())").await;
    let w = ok(&a, Method::GET, &format!("{S}/wizard"), ADMIN, None).await;
    assert_eq!(w["sample_data"], false);
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM contacts WHERE deleted_at IS NULL").await,
        1
    );
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM settings WHERE key = 'sample_records'").await,
        0
    );
    assert_eq!(a.removed.load(Ordering::SeqCst), 2); // một lần sau khi sinh mẫu, một lần sau khi dọn mẫu
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn hai_lan_dung_dong_thoi_khong_nhan_doi_mau() {
    setup().await;
    let a = app().await;
    let body = json!({ "industry": "retail_service" });
    let p = format!("{S}/build");
    let (x, y) = tokio::join!(
        call(&a, Method::POST, &p, Some(ADMIN), Some(body.clone())),
        call(&a, Method::POST, &p, Some(ADMIN), Some(body.clone()))
    );
    assert!(
        x.status.is_success() && y.status.is_success(),
        "{:?} {:?}",
        x.body,
        y.body
    );
    let first = &catalog::catalog()
        .templates
        .iter()
        .find(|t| t.key == "retail_service")
        .unwrap()
        .objects[0]
        .key;
    let want = i64::try_from(
        catalog::catalog()
            .templates
            .iter()
            .find(|t| t.key == "retail_service")
            .unwrap()
            .samples
            .iter()
            .filter(|s| &s.object == first)
            .count(),
    )
    .unwrap();
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM custom_records r JOIN custom_objects o ON o.id = r.object_id WHERE o.key = '{first}'"
        ))
        .await,
        want
    );
    let n = |v: &Value| v["sample_records"].as_i64().unwrap();
    assert_eq!(n(&x.body) + n(&y.body), want);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn wizard_buoc_bo_qua_cau_hinh_va_nguoi_vao_sau() {
    setup().await;
    let a = app().await;
    let w = ok(&a, Method::GET, &format!("{S}/wizard"), ADMIN, None).await;
    assert_eq!(
        (
            w["enabled"].clone(),
            w["completed"].clone(),
            w["current"].clone(),
            w["industry"].clone()
        ),
        (json!(true), json!(false), json!("industry"), Value::Null)
    );
    let keys: Vec<&str> = w["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["industry", "modules", "data"]); // chưa cấu hình mạng xã hội ⇒ không có bước kênh/đăng bài
    assert_eq!(w["steps"][0]["needs_admin"], false);
    let m = ok(&a, Method::GET, &format!("{S}/wizard"), MEMBER, None).await;
    assert_eq!(m["steps"][0]["needs_admin"], true);

    // Bước chưa đạt: ok=false + câu hướng dẫn; thiếu quyền thì nhờ quản trị viên.
    let c = ok(
        &a,
        Method::POST,
        &format!("{S}/wizard/confirm"),
        ADMIN,
        Some(json!({ "step": "industry" })),
    )
    .await;
    assert_eq!(c["ok"], false);
    assert!(
        c["message"]
            .as_str()
            .unwrap()
            .starts_with("Bạn chưa chọn loại doanh nghiệp")
    );
    let c = ok(
        &a,
        Method::POST,
        &format!("{S}/wizard/confirm"),
        MEMBER,
        Some(json!({ "step": "modules" })),
    )
    .await;
    assert!(
        c["message"]
            .as_str()
            .unwrap()
            .starts_with("Quản trị viên của công ty chưa làm xong")
    );
    let not_in = call(
        &a,
        Method::POST,
        &format!("{S}/wizard/confirm"),
        Some(ADMIN),
        Some(json!({ "step": "channels" })),
    )
    .await;
    assert_eq!(
        (not_in.status, msg(&not_in).as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Bước này không có trong phần bắt đầu của công ty bạn."
        )
    );
    // Bước bắt buộc không bỏ qua được.
    let r = call(
        &a,
        Method::POST,
        &format!("{S}/wizard/skip"),
        Some(ADMIN),
        Some(json!({ "step": "industry" })),
    )
    .await;
    assert_eq!(
        (r.status, msg(&r).as_str()),
        (StatusCode::BAD_REQUEST, "Bước này bắt buộc, không bỏ qua được.")
    );

    // Dựng xong, bỏ qua bước dữ liệu ⇒ xong wizard; người tạo SAU lúc dựng vào thẳng ứng dụng và có dấu xong.
    ok(
        &a,
        Method::POST,
        &format!("{S}/build"),
        ADMIN,
        Some(json!({ "industry": "other" })),
    )
    .await;
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/wizard"), ADMIN, None).await["completed"],
        false
    );
    let s = ok(
        &a,
        Method::POST,
        &format!("{S}/wizard/skip"),
        ADMIN,
        Some(json!({ "step": "data" })),
    )
    .await;
    assert_eq!(
        (
            s["ok"].clone(),
            s["wizard"]["completed"].clone(),
            s["wizard"]["current"].clone()
        ),
        (json!(true), json!(true), Value::Null)
    );
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM settings WHERE key = 'onboarding_done:user:{ADMIN}'"
        ))
        .await,
        1
    );
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    exec(&format!("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({LATE}, 'u{LATE}@m19.test', 'x', 'M19 Vào sau', now())")).await;
    let late = ok(&a, Method::GET, &format!("{S}/wizard"), LATE, None).await;
    assert_eq!(late["completed"], true);
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM settings WHERE key = 'onboarding_done:user:{LATE}'"
        ))
        .await,
        1
    );
    // Người đã có từ trước nhưng chưa bấm xong vẫn phải đi tiếp.
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/wizard"), MEMBER, None).await["completed"],
        false
    );

    // Cấu hình: mặc định, đổi từng phần (khoá vắng giữ nguyên), tắt hẳn wizard, miễn tài khoản cũ.
    let cfg = ok(&a, Method::GET, &format!("{S}/wizard/config"), ADMIN, None).await;
    assert_eq!(
        cfg,
        json!({ "enabled": true, "skippable": ["data", "channels", "post"], "exempt_before": null, "version": 2 })
    );
    let cfg = ok(
        &a,
        Method::PUT,
        &format!("{S}/wizard/config"),
        ADMIN,
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!(cfg["enabled"], false);
    let cfg = ok(
        &a,
        Method::PUT,
        &format!("{S}/wizard/config"),
        ADMIN,
        Some(json!({ "skippable": ["post"] })),
    )
    .await;
    assert_eq!(
        (cfg["enabled"].clone(), cfg["skippable"].clone()),
        (json!(false), json!(["post"]))
    );
    let off = ok(&a, Method::GET, &format!("{S}/wizard"), MEMBER, None).await;
    assert_eq!(
        (off["enabled"].clone(), off["completed"].clone(), off["steps"].clone()),
        (json!(false), json!(true), json!([]))
    );
    ok(
        &a,
        Method::PUT,
        &format!("{S}/wizard/config"),
        ADMIN,
        Some(json!({ "enabled": true, "exempt_before": "2999-01-01T00:00:00Z" })),
    )
    .await;
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/wizard"), MEMBER, None).await["completed"],
        true
    );
    let cfg = ok(
        &a,
        Method::PUT,
        &format!("{S}/wizard/config"),
        ADMIN,
        Some(json!({ "exempt_before": null })),
    )
    .await;
    assert_eq!(cfg["exempt_before"], Value::Null);

    // Có mạng xã hội trên máy chủ + tính năng đang bật ⇒ thêm bước kênh và đăng bài.
    {
        let mut e = a.env.lock().unwrap();
        e.insert("FACEBOOK_APP_ID".into(), "id".into());
        e.insert("FACEBOOK_APP_SECRET".into(), "secret".into());
        e.insert("INTEGRATIONS_PUBLIC_BASE_URL".into(), "https://crm.example.test".into());
    }
    set_setting("org_features", r#"{"social_posting":true,"facebook_page":true}"#).await;
    let w = ok(&a, Method::GET, &format!("{S}/wizard"), ADMIN, None).await;
    let keys: Vec<&str> = w["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["industry", "modules", "data", "channels", "post"]);
    assert_eq!(w["steps"][3]["needs_admin"], false);
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/wizard"), MANAGER, None).await["steps"][3]["needs_admin"],
        true
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn trang_thai_nhap_mon_va_ket_noi_ai() {
    setup().await;
    let a = app().await;
    let st = ok(&a, Method::GET, &format!("{S}/status"), ADMIN, None).await;
    assert_eq!(
        st,
        json!({ "status": "chua_dung", "mcp_url": null, "ai_connected": false, "ai_granted": false, "ai_last_active_at": null, "ai_connected_anyone": false, "can_build": true, "has_sample_data": false })
    );
    // Hoàn tất khi chưa dựng ⇒ 400; đang dựng dở ⇒ đạt.
    let r = call(&a, Method::POST, &format!("{S}/complete"), Some(ADMIN), None).await;
    assert_eq!(
        (r.status, msg(&r).as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Chưa dựng quy trình: hãy để AI đề xuất gói dựng và duyệt trước."
        )
    );
    set_setting("setup_status", "dang_dung").await;
    assert_eq!(
        ok(&a, Method::POST, &format!("{S}/complete"), ADMIN, None).await,
        json!({ "status": "da_dung" })
    );

    // Máy chủ chưa bật kết nối AI ⇒ 404; bật ⇒ prompt đúng agent, agent lạ ⇒ other.
    assert_eq!(
        call(&a, Method::GET, &format!("{S}/connect-prompt"), Some(ADMIN), None)
            .await
            .status,
        404
    );
    {
        let mut e = a.env.lock().unwrap();
        e.insert("INTEGRATIONS_MCP_ENABLED".into(), "true".into());
        e.insert("INTEGRATIONS_PUBLIC_BASE_URL".into(), "https://crm.example.test".into());
    }
    let p = ok(
        &a,
        Method::GET,
        &format!("{S}/connect-prompt?agent=claude_code"),
        ADMIN,
        None,
    )
    .await;
    assert_eq!(
        (p["agent"].clone(), p["mcp_url"].clone()),
        (json!("claude_code"), json!("https://crm.example.test/api/v1/mcp"))
    );
    assert!(
        p["prompt"]
            .as_str()
            .unwrap()
            .contains("claude mcp add --transport http --scope user trinity https://crm.example.test/api/v1/mcp")
    );
    assert_eq!(p["agents"].as_array().unwrap().len(), 9);
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/connect-prompt?agent=x"), ADMIN, None).await["agent"],
        "other"
    );
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/status"), ADMIN, None).await["mcp_url"],
        "https://crm.example.test/api/v1/mcp"
    );

    // AI đã nối: có token còn sống nhưng lâu không dùng ⇒ đã cấp quyền mà chưa "đang nối".
    exec(&format!("INSERT INTO oauth_tokens (access_hash, refresh_hash, client_id, user_id, resource, family_id, access_expires_at, refresh_expires_at, last_used_at) VALUES ('m19a', 'm19b', 'c', {ADMIN}, 'r', 'f', now() + interval '1 hour', now() + interval '30 days', now() - interval '2 hours')")).await;
    let st = ok(&a, Method::GET, &format!("{S}/status"), ADMIN, None).await;
    assert_eq!(
        (
            st["ai_granted"].clone(),
            st["ai_connected"].clone(),
            st["ai_connected_anyone"].clone()
        ),
        (json!(true), json!(false), json!(false))
    );
    assert!(st["ai_last_active_at"].as_str().unwrap().ends_with('Z'));
    exec("UPDATE oauth_tokens SET last_used_at = now() WHERE access_hash = 'm19a'").await;
    let st = ok(&a, Method::GET, &format!("{S}/status"), ADMIN, None).await;
    assert_eq!(
        (st["ai_connected"].clone(), st["ai_connected_anyone"].clone()),
        (json!(true), json!(true))
    );
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/status"), MEMBER, None).await["ai_connected_anyone"],
        true
    );
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/status"), MEMBER, None).await["ai_connected"],
        false
    );

    // Màn hướng dẫn người mới.
    let o = ok(&a, Method::GET, &format!("{S}/onboarding"), ADMIN, None).await;
    assert_eq!(
        o,
        json!({ "seen": false, "ai_connected": true, "workspace_built": false, "has_data": false, "channel_linked": false, "first_post": false })
    );
    assert_eq!(
        ok(&a, Method::POST, &format!("{S}/onboarding/seen"), ADMIN, None).await,
        json!({ "seen": true })
    );
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/onboarding"), ADMIN, None).await["seen"],
        true
    );
    assert_eq!(
        ok(&a, Method::GET, &format!("{S}/onboarding"), MEMBER, None).await["seen"],
        false
    );
    exec("INSERT INTO contacts (phone, full_name, updated_at) VALUES ('m19-2', 'x', now())").await;
    ok(&a, Method::POST, &format!("{TPL}/clinic/apply"), ADMIN, Some(json!({}))).await;
    let o = ok(&a, Method::GET, &format!("{S}/onboarding"), ADMIN, None).await;
    assert_eq!(
        (o["workspace_built"].clone(), o["has_data"].clone()),
        (json!(true), json!(true))
    );
    teardown().await;
}
