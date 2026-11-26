//! K12 với Postgres thật: quyền của người dùng, phạm vi theo cây quản lý, vô hiệu cache trong tiến trình và chéo tiến trình.
//!
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-rbac --test pg_rbac -- --ignored --test-threads=1`
//! (schema `public` đã migrate bằng Prisma). Test tự tạo và xoá user 9201..9299, vai trò 9201..9299.

use std::sync::Arc;
use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_auth::Security;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_rbac::grants::grants_from_json;
use trinity_rbac::{Grant, OwnerIds, PermissionService, RbacCache, Scope, ScopeService, can};

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(sql: &str) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut c)
        .await
        .unwrap();
}

struct Proc {
    db: Db,
    security: Arc<Security>,
    cache: Arc<RbacCache>,
    perms: PermissionService,
    scopes: ScopeService,
}

async fn proc() -> Proc {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), true);
    let cache = RbacCache::new(security.clone());
    Proc {
        perms: PermissionService::new(db.clone(), cache.clone()),
        scopes: ScopeService::new(db.clone(), cache.clone()),
        db,
        security,
        cache,
    }
}

const CO: CompanyRef = CompanyRef::DEFAULT;

async fn teardown() {
    exec("DELETE FROM user_roles WHERE user_id BETWEEN 9201 AND 9299").await;
    exec("DELETE FROM role_permissions WHERE role_id BETWEEN 9201 AND 9299").await;
    exec("DELETE FROM roles WHERE id BETWEEN 9201 AND 9299").await;
    exec("UPDATE users SET manager_id = NULL WHERE id BETWEEN 9201 AND 9299").await;
    exec("DELETE FROM users WHERE id BETWEEN 9201 AND 9299").await;
}

async fn setup() {
    teardown().await;
    // Cây: 9201 quản lý 9202, 9203; 9202 quản lý 9204; 9204 quản lý 9205.
    for (id, mgr) in [
        (9201, "NULL"),
        (9202, "9201"),
        (9203, "9201"),
        (9204, "9202"),
        (9205, "9204"),
        (9206, "NULL"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({id}, 'k12-{id}@example.test', 'x', 'K12 {id}', now())"
        ))
        .await;
        if mgr != "NULL" {
            exec(&format!("UPDATE users SET manager_id = {mgr} WHERE id = {id}")).await;
        }
    }
    // Hai vai trò thường + một vai trò hệ thống.
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9201, 'k12-a', false, now()), (9202, 'k12-b', false, now()), (9203, 'k12-admin', true, now())").await;
    exec("INSERT INTO role_permissions (role_id, permission, scope) VALUES
          (9201, 'contacts.view', 'own'), (9201, 'contacts.create', 'all'), (9201, 'contacts.export', NULL), (9201, 'khong.co', 'all'),
          (9202, 'contacts.view', 'subtree'), (9202, 'payroll.view', 'team')").await;
    exec("INSERT INTO user_roles (user_id, role_id) VALUES (9201, 9201), (9201, 9202), (9203, 9203), (9202, 9201)")
        .await;
}

async fn eventually(what: &str, mut f: impl AsyncFnMut() -> bool) {
    for _ in 0..60 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("không đạt trong 3 giây: {what}");
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn quyen_gop_admin_va_khong_vai_tro() {
    setup().await;
    let p = proc().await;
    let g = p.perms.grants_for(CO, 9201).await.unwrap();
    assert!(!g.is_admin);
    assert_eq!(
        g.grants.get("contacts.view"),
        Some(&Grant::Scope(Scope::Subtree)),
        "own ∪ subtree = subtree"
    );
    assert_eq!(g.grants.get("contacts.create"), Some(&Grant::Full));
    assert_eq!(
        g.grants.get("contacts.export"),
        Some(&Grant::Scope(Scope::Own)),
        "thiếu scope ⇒ own"
    );
    assert_eq!(g.grants.get("payroll.view"), Some(&Grant::Scope(Scope::Team)));
    assert!(!g.grants.contains_key("khong.co"), "khoá lạ bị bỏ");
    assert!(can(&g.grants, "contacts.view", Some(Scope::Team)) && !can(&g.grants, "contacts.view", Some(Scope::All)));

    let admin = p.perms.grants_for(CO, 9203).await.unwrap();
    assert!(admin.is_admin);
    assert_eq!(admin.grants.len(), 61);
    assert_eq!(admin.grants.get("contacts.view"), Some(&Grant::Scope(Scope::All)));
    assert_eq!(admin.grants.get("roles.manage"), Some(&Grant::Full));

    let none = p.perms.grants_for(CO, 9206).await.unwrap();
    assert!(!none.is_admin && none.grants.is_empty());
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn sua_vai_tro_co_hieu_luc_ngay_trong_tien_trinh() {
    setup().await;
    let p = proc().await;
    assert_eq!(
        p.perms.grants_for(CO, 9202).await.unwrap().grants.get("contacts.view"),
        Some(&Grant::Scope(Scope::Own))
    );
    exec("UPDATE role_permissions SET scope = 'all' WHERE role_id = 9201 AND permission = 'contacts.view'").await;
    // Chưa vô hiệu: vẫn đọc cache.
    assert_eq!(
        p.perms.grants_for(CO, 9202).await.unwrap().grants.get("contacts.view"),
        Some(&Grant::Scope(Scope::Own))
    );
    p.cache
        .invalidate_users(1, trinity_rbac::cache::Users::Ids(vec![9202]))
        .await;
    assert_eq!(
        p.perms.grants_for(CO, 9202).await.unwrap().grants.get("contacts.view"),
        Some(&Grant::Scope(Scope::All))
    );
    // Id có tiền tố chung không bị xoá oan: 9202 ≠ 92020.
    p.perms.grants_for(CO, 9201).await.unwrap();
    p.cache
        .invalidate_users(1, trinity_rbac::cache::Users::Ids(vec![920]))
        .await;
    assert!(p.cache.get_grants(1, 9201).is_some());
    p.cache.invalidate_users(1, trinity_rbac::cache::Users::All).await;
    assert!(p.cache.get_grants(1, 9201).is_none());
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn vo_hieu_cache_cheo_tien_trinh_qua_notify() {
    setup().await;
    let (a, b) = (proc().await, proc().await);
    let _la = a.security.spawn_listener();
    let _lb = b.security.spawn_listener();
    tokio::time::sleep(Duration::from_millis(500)).await;
    b.perms.grants_for(CO, 9202).await.unwrap();
    b.perms.grants_for(CO, 9201).await.unwrap();
    assert!(b.cache.get_grants(1, 9202).is_some());
    a.cache
        .invalidate_users(1, trinity_rbac::cache::Users::Ids(vec![9202]))
        .await;
    eventually("B xoá cache của 9202", async || {
        b.cache.get_grants(1, 9202).is_none()
    })
    .await;
    assert!(b.cache.get_grants(1, 9201).is_some(), "người khác giữ nguyên");
    a.cache.invalidate_users(1, trinity_rbac::cache::Users::All).await;
    eventually("B xoá hết", async || b.cache.get_grants(1, 9201).is_none()).await;
    // Tin do Node gửi (c = 0: không có ngữ cảnh công ty) xoá mọi công ty.
    b.perms.grants_for(CO, 9201).await.unwrap();
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::query("SELECT pg_notify('trinity_sync', $1)")
        .bind(r#"{"v":1,"o":"node-1-abc","k":"rbac","c":0,"ids":[9201]}"#)
        .execute(&mut c)
        .await
        .unwrap();
    eventually("B nhận tin Node", async || b.cache.get_grants(1, 9201).is_none()).await;
    drop((a.db, b.db));
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn pham_vi_own_team_subtree_all_va_vong_lap_quan_ly() {
    setup().await;
    let p = proc().await;
    let g = |perm: &str, v: &str| grants_from_json(&serde_json::json!({ perm: v }));
    let ids = |r: Option<OwnerIds>| match r {
        Some(OwnerIds::Ids(mut v)) => {
            v.sort_unstable();
            v
        }
        other => panic!("{other:?}"),
    };
    let own = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "own"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(ids(own), [9201]);
    let team = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "team"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(ids(team), [9201, 9202, 9203]);
    let sub = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "subtree"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(ids(sub), [9201, 9202, 9203, 9204, 9205]);
    let all = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "all"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(all, Some(OwnerIds::All));
    assert_eq!(
        p.scopes
            .owner_ids(CO, 9201, &g("contacts.view", "all"), "deals.view")
            .await
            .unwrap(),
        None
    );
    // Quyền không scoped (Full) ⇒ All.
    let full = grants_from_json(&serde_json::json!({ "contacts.create": true }));
    assert_eq!(
        p.scopes.owner_ids(CO, 9201, &full, "contacts.create").await.unwrap(),
        Some(OwnerIds::All)
    );
    // Vòng lặp quản lý: 9201 → 9205 → … → 9201 không treo.
    exec("UPDATE users SET manager_id = 9205 WHERE id = 9201").await;
    p.cache.clear();
    let cyc = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "subtree"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(ids(cyc), [9201, 9202, 9203, 9204, 9205]);
    // Cache phạm vi: sửa cây rồi vô hiệu ⇒ đọc lại.
    exec("UPDATE users SET manager_id = NULL WHERE id = 9201").await;
    exec("UPDATE users SET manager_id = NULL WHERE id = 9203").await;
    let cached = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "team"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(ids(cached), [9201, 9202]);
    exec("UPDATE users SET manager_id = 9201 WHERE id = 9203").await;
    p.cache
        .invalidate_users(1, trinity_rbac::cache::Users::Ids(vec![9201]))
        .await;
    let again = p
        .scopes
        .owner_ids(CO, 9201, &g("contacts.view", "team"), "contacts.view")
        .await
        .unwrap();
    assert_eq!(ids(again), [9201, 9202, 9203]);
    drop(p.db);
    teardown().await;
}
