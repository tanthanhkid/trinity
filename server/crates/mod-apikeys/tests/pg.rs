#![allow(clippy::result_large_err)] // AppError của kernel là kiểu lỗi chung của handler

//! M05 với Postgres thật. Cần DB riêng đã migrate bằng Prisma (bảng của test bị TRUNCATE):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-apikeys --test pg -- --ignored --test-threads=1`

use std::time::Duration;

use mod_apikeys::api_keys::{self, Ctx, ValidatedApiKey, hash_key, validate_create};
use mod_apikeys::teams;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, PgConnection};
use trinity_auth::Security;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_kernel::error::AppError;
use trinity_rbac::{PermissionService, RbacCache};

const CO: CompanyRef = CompanyRef::DEFAULT;

struct Env {
    db: Db,
    platform: Platform,
    t: TenantDb,
    perms: PermissionService,
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// Người dùng: 1 Quản trị; 2 có `contacts.create`; 3 không có quyền nào; 4 bị khoá (có quyền); 5 có `contacts.create` +
/// `deals.manage`. Vai trò: 1 hệ thống, 2 contacts.create, 3 deals.manage.
async fn setup() -> Env {
    let mut cfg = DbConfig::new(std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL"));
    cfg.pool_size = 8;
    let db = Db::connect(&cfg).await.expect("kết nối DB");
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let perms = PermissionService::new(db.clone(), RbacCache::new(security));
    let t = db.tenant(CO).await.unwrap();
    let mut c = t.acquire().await.unwrap();
    exec(
        &mut c,
        "TRUNCATE api_keys, teams, user_roles, role_permissions, roles, users RESTART IDENTITY CASCADE",
    )
    .await;
    for (id, status) in [
        (1, "active"),
        (2, "active"),
        (3, "active"),
        (4, "locked"),
        (5, "active"),
    ] {
        sqlx::query("INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES ($1, $2, 'x', $3, $4, now())")
            .bind(id)
            .bind(format!("u{id}@example.com"))
            .bind(format!("Người {id}"))
            .bind(status)
            .execute(&mut *c)
            .await
            .unwrap();
    }
    exec(&mut c, "INSERT INTO roles (id, name, is_system, updated_at) VALUES (1, 'Quản trị', true, now()), (2, 'Tạo khách', false, now()), (3, 'Chốt deal', false, now())").await;
    exec(&mut c, "INSERT INTO role_permissions (role_id, permission, scope) VALUES (2, 'contacts.create', 'all'), (3, 'deals.manage', 'all')").await;
    exec(
        &mut c,
        "INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (2, 2), (4, 2), (5, 2), (5, 3)",
    )
    .await;
    drop(c);
    Env { db, platform, t, perms }
}

fn status(e: AppError) -> (u16, String) {
    match e {
        AppError::Http(h) => (h.status(), serde_json::to_string(&h.body()).unwrap()),
        other => panic!("lỗi không phải HTTP: {other:?}"),
    }
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: u16, text: &str) {
    let (s, body) = status(r.unwrap_err());
    assert_eq!(s, code, "{body}");
    assert!(body.contains(text), "{body} thiếu {text}");
}

fn jv<T: serde::Serialize>(v: &T) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

fn input(owner: i32, scopes: &[&str]) -> api_keys::CreateApiKey {
    validate_create(&json!({"name": "  Landing  ", "scopes": scopes, "owner_user_id": owner})).unwrap()
}

async fn validate(env: &Env, key: &str, scope: &str) -> Result<ValidatedApiKey, AppError> {
    api_keys::validate(&env.db, &env.platform, key, scope, Some("203.0.113.9")).await
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn tao_khoa_va_kiem_owner() {
    let env = setup().await;
    let ctx = Ctx {
        company: CO,
        permissions: &env.perms,
    };
    let mut c = env.t.acquire().await.unwrap();
    let k = api_keys::create(&mut c, &ctx, &input(2, &["auth:login", "contacts:create"]), 1)
        .await
        .unwrap();
    let v = jv(&k);
    assert_eq!(
        v.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "id",
            "name",
            "prefix",
            "scopes",
            "owner_user_id",
            "created_by",
            "last_used_at",
            "last_used_ip",
            "expires_at",
            "revoked_at",
            "created_at",
            "updated_at",
            "plain_key",
            "message"
        ]
    );
    let plain = v["plain_key"].as_str().unwrap().to_owned();
    assert!(plain.starts_with("trinity_live_") && plain.len() == 13 + 32, "{plain}");
    assert_eq!(v["prefix"], json!(&plain[..19]));
    assert_eq!(v["name"], "Landing");
    // DB chỉ lưu SHA-256 (hex thường), không lưu khoá gốc.
    let stored: String = sqlx::query_scalar("SELECT key_hash FROM api_keys WHERE id = $1")
        .bind(k.key.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(stored, hash_key(&plain));
    assert_eq!(stored.len(), 64);
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM api_keys WHERE position($1 in prefix || key_hash || name) > 0 AND length(prefix) > 19",
    )
    .bind(&plain)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(leaked, 0);

    // Chốt owner: không có, bị khoá, Quản trị, thiếu quyền của phạm vi.
    expect_err(
        api_keys::create(&mut c, &ctx, &input(99, &["contacts:create"]), 1).await,
        400,
        "Không tìm thấy user ID 99 để gán owner",
    );
    expect_err(
        api_keys::create(&mut c, &ctx, &input(4, &["contacts:create"]), 1).await,
        400,
        "User ID 4 đang bị khoá — không thể gán làm owner",
    );
    expect_err(
        api_keys::create(&mut c, &ctx, &input(1, &["contacts:create"]), 1).await,
        400,
        "User ID 1 là Quản trị",
    );
    expect_err(
        api_keys::create(&mut c, &ctx, &input(3, &["contacts:create"]), 1).await,
        400,
        "User ID 3 không có quyền \\\"contacts.create\\\"",
    );
    expect_err(
        api_keys::create(&mut c, &ctx, &input(2, &["deals:create", "tasks:create"]), 1).await,
        400,
        "\\\"deals.manage\\\", \\\"kanban.manage\\\"",
    );
    api_keys::create(&mut c, &ctx, &input(5, &["contacts:create", "deals:create"]), 1)
        .await
        .unwrap();

    // Danh sách mới nhất trước, chi tiết, 404.
    let list = api_keys::find_all(&mut c).await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].id > list[1].id);
    assert_eq!(api_keys::find_by_id(&mut c, k.key.id).await.unwrap().name, "Landing");
    expect_err(api_keys::find_by_id(&mut c, 999).await, 404, "Không tìm thấy khoá API");
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn xoay_thu_hoi_va_xac_thuc() {
    let env = setup().await;
    let ctx = Ctx {
        company: CO,
        permissions: &env.perms,
    };
    let mut c = env.t.acquire().await.unwrap();
    let k = api_keys::create(&mut c, &ctx, &input(2, &["auth:login"]), 1)
        .await
        .unwrap();
    let old = k.plain_key.clone();
    let ok = validate(&env, &old, "auth:login").await.unwrap();
    assert_eq!((ok.id, ok.owner_user_id, ok.company), (k.key.id, 2, CO));
    // last_used_* ghi ở nền.
    let mut got = None;
    for _ in 0..50 {
        let r: (Option<String>, bool) =
            sqlx::query_as("SELECT last_used_ip, last_used_at IS NOT NULL FROM api_keys WHERE id = $1")
                .bind(k.key.id)
                .fetch_one(&mut *c)
                .await
                .unwrap();
        if r.1 {
            got = Some(r);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(got.unwrap().0.as_deref(), Some("203.0.113.9"));

    // Phạm vi, khoá lạ, thiếu header.
    expect_err(
        validate(&env, &old, "contacts:create").await,
        401,
        "Khoá API không có phạm vi \\\"contacts:create\\\"",
    );
    expect_err(
        validate(&env, "trinity_live_khonghople", "auth:login").await,
        401,
        "X-API-Key không hợp lệ",
    );
    expect_err(validate(&env, "", "auth:login").await, 401, "Thiếu X-API-Key header");
    // Tiền tố công ty khác (không có công ty đó): 401, không tra schema khác.
    expect_err(
        validate(&env, "c7.trinity_live_x", "auth:login").await,
        401,
        "X-API-Key không hợp lệ",
    );

    // Xoay: khoá cũ chết ngay, khoá mới dùng được, prefix đổi, id giữ nguyên.
    let r = api_keys::rotate(&mut c, &ctx, k.key.id, 1).await.unwrap();
    assert_eq!(r.key.id, k.key.id);
    assert_ne!(r.plain_key, old);
    assert_eq!(r.key.prefix, r.plain_key[..19]);
    assert_eq!(
        jv(&r).as_object().unwrap().keys().next_back().map(String::as_str),
        Some("plain_key")
    );
    expect_err(validate(&env, &old, "auth:login").await, 401, "X-API-Key không hợp lệ");
    validate(&env, &r.plain_key, "auth:login").await.unwrap();

    // Thu hồi: lặp lại không lỗi; khoá thu hồi bị từ chối, không xoay được.
    assert_eq!(
        jv(&api_keys::revoke(&mut c, k.key.id, 1).await.unwrap()),
        json!({"message": "Đã thu hồi khoá"})
    );
    assert_eq!(
        jv(&api_keys::revoke(&mut c, k.key.id, 1).await.unwrap()),
        json!({"message": "Khoá đã bị thu hồi trước đó"})
    );
    expect_err(
        validate(&env, &r.plain_key, "auth:login").await,
        401,
        "Khoá API đã bị thu hồi",
    );
    expect_err(
        api_keys::rotate(&mut c, &ctx, k.key.id, 1).await,
        400,
        "Khoá đã bị thu hồi, không xoay được",
    );
    expect_err(
        api_keys::rotate(&mut c, &ctx, 999, 1).await,
        404,
        "Không tìm thấy khoá API",
    );
    expect_err(api_keys::revoke(&mut c, 999, 1).await, 404, "Không tìm thấy khoá API");

    // Hết hạn.
    let e = validate_create(
        &json!({"name": "Hết hạn", "scopes": ["auth:login"], "owner_user_id": 2, "expires_at": "2020-01-01T00:00:00Z"}),
    )
    .unwrap();
    let ex = api_keys::create(&mut c, &ctx, &e, 1).await.unwrap();
    expect_err(
        validate(&env, &ex.plain_key, "auth:login").await,
        401,
        "Khoá API đã hết hạn",
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn team() {
    let env = setup().await;
    let mut c = env.t.acquire().await.unwrap();
    let t1 = teams::create(&mut c, "Kinh doanh", 2).await.unwrap();
    let t2 = teams::create(&mut c, "Vận hành", 3).await.unwrap();
    assert_eq!(jv(&t1), json!({"id": t1.id, "name": "Kinh doanh", "team_lead_id": 2}));
    exec(
        &mut c,
        &format!("UPDATE users SET team_id = {} WHERE id IN (2, 3, 4)", t1.id),
    )
    .await;
    let list = teams::find_all(&mut c).await.unwrap();
    // Bị khoá (4) không tính vào số thành viên.
    assert_eq!(
        jv(&list),
        json!([
            {"id": t1.id, "name": "Kinh doanh", "leadUserId": 2, "lead": {"name": "Người 2"}, "memberCount": 2},
            {"id": t2.id, "name": "Vận hành", "leadUserId": 3, "lead": {"name": "Người 3"}, "memberCount": 0},
        ])
    );
    assert_eq!(
        teams::parse_create(&json!({"name": "A", "leadUserId": 2})).unwrap(),
        ("A".to_owned(), 2)
    );
    assert_eq!(teams::parse_create(&json!({"name": 1})).unwrap_err().status(), 400);
    // Tên thiếu hoặc người dẫn đầu ngoài i32 ⇒ 400 kèm câu như class-validator.
    let body = |v: Value| serde_json::to_string(&teams::parse_create(&v).unwrap_err().body()).unwrap();
    assert!(body(json!({"leadUserId": 2})).contains("name must be a string"));
    assert!(body(json!({"name": "A", "leadUserId": 3_000_000_000_i64})).contains("leadUserId must be an integer number"));
    assert!(body(json!({"name": "A"})).contains("leadUserId must be an integer number"));
}

#[tokio::test]
async fn kiem_dau_vao_nhu_class_validator() {
    let err = |v: Value| serde_json::to_string(&validate_create(&v).unwrap_err().body()).unwrap();
    let b = err(json!({"name": "", "scopes": [], "owner_user_id": "abc"}));
    for want in [
        "Tên khoá 1-120 ký tự",
        "Phải chọn ít nhất 1 phạm vi",
        "owner_user_id phải là số nguyên",
    ] {
        assert!(b.contains(want), "{b}");
    }
    assert!(
        err(json!({"name": "x".repeat(121), "scopes": ["auth:login"], "owner_user_id": 1}))
            .contains("Tên khoá 1-120 ký tự")
    );
    assert!(err(json!({"name": "a", "scopes": ["admin"], "owner_user_id": 1})).contains("Phạm vi không hợp lệ"));
    assert!(err(json!({"name": "a", "scopes": "auth:login", "owner_user_id": 1})).contains("scopes must be an array"));
    assert!(
        err(json!({"name": "a", "scopes": ["auth:login"], "owner_user_id": 1, "expires_at": "mai"}))
            .contains("expires_at không hợp lệ")
    );
    // Chuỗi số nhận như `@Type(() => Number)`; ngày ISO nhiều dạng.
    for exp in ["2027-01-01T00:00:00Z", "2027-01-01", "2027-01-01T10:30"] {
        let k =
            validate_create(&json!({"name": "a", "scopes": ["auth:login"], "owner_user_id": "12", "expires_at": exp}))
                .unwrap();
        assert_eq!((k.owner_user_id, k.expires_at.is_some()), (12, true), "{exp}");
    }
    assert!(
        validate_create(&json!({"name": "a", "scopes": ["auth:login"], "owner_user_id": 1, "expires_at": null}))
            .unwrap()
            .expires_at
            .is_none()
    );
    // `@IsDateString` cho qua mọi dạng ISO mà `new Date()` đọc được: năm, năm-tháng, dấu cách, múi giờ +0700.
    for exp in [
        "2027",
        "2027-06",
        "2027-01-01 10:30",
        "2027-01-01T10:30:15.123+0700",
        "2027-01-01T10:30:15+07:00",
    ] {
        let k = validate_create(&json!({"name": "a", "scopes": ["auth:login"], "owner_user_id": 1, "expires_at": exp}))
            .unwrap_or_else(|e| panic!("{exp}: {e:?}"));
        assert!(k.expires_at.is_some(), "{exp}");
    }
    let k = validate_create(
        &json!({"name": "a", "scopes": ["auth:login"], "owner_user_id": 1, "expires_at": "2027-01-01T10:30:00+0700"}),
    )
    .unwrap();
    assert_eq!(k.expires_at.unwrap().to_rfc3339(), "2027-01-01T03:30:00+00:00");
    // owner_user_id qua `@Type(() => Number)` như Node: chuỗi hex, boolean; ngoài i32 hoặc null thì 400.
    let owner = |v: Value| {
        validate_create(&json!({"name": "a", "scopes": ["auth:login"], "owner_user_id": v}))
            .map(|k| k.owner_user_id)
            .ok()
    };
    assert_eq!(owner(json!(" 12 ")), Some(12));
    assert_eq!(owner(json!("0x10")), Some(16));
    assert_eq!(owner(json!(7.0)), Some(7));
    assert_eq!(owner(json!(true)), Some(1));
    assert_eq!(owner(json!("")), Some(0));
    assert_eq!(owner(json!(3_000_000_000_i64)), None);
    assert_eq!(owner(json!("1e10")), None);
    assert_eq!(owner(json!("1.5")), None);
    assert_eq!(owner(json!(null)), None);
    assert_eq!(owner(json!([5])), None);
}
