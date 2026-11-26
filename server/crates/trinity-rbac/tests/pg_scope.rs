//! K13 với Postgres thật: điều kiện phạm vi dựng bằng `push_scope` chạy trên bảng `contacts`, kiểm theo id (404) và che số.
//!
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-rbac --test pg_scope -- --ignored --test-threads=1`
//! (schema `public` đã migrate bằng Prisma). Test tự tạo và xoá user 9301..9399 và liên hệ có `phone` bắt đầu bằng `k13-`.

use sqlx::{AssertSqlSafe, Connection, PgConnection, Postgres, QueryBuilder};
use trinity_auth::Security;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_rbac::grants::grants_from_json;
use trinity_rbac::{OwnerIds, RbacCache, ScopeError, ScopeService, push_scope};

const CO: CompanyRef = CompanyRef::DEFAULT;

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

async fn teardown() {
    exec("DELETE FROM contacts WHERE phone LIKE 'k13-%'").await;
    exec("UPDATE users SET manager_id = NULL WHERE id BETWEEN 9301 AND 9399").await;
    exec("DELETE FROM users WHERE id BETWEEN 9301 AND 9399").await;
}

/// Cây: 9301 quản lý 9302, 9303; 9302 quản lý 9304. Liên hệ: mỗi liên hệ có người phụ trách và người tạo.
async fn setup() {
    teardown().await;
    for (id, mgr) in [
        (9301, "NULL"),
        (9302, "9301"),
        (9303, "9301"),
        (9304, "9302"),
        (9305, "NULL"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({id}, 'k13-{id}@example.test', 'x', 'K13', now())"
        ))
        .await;
        if mgr != "NULL" {
            exec(&format!("UPDATE users SET manager_id = {mgr} WHERE id = {id}")).await;
        }
    }
    // (tên, phụ trách, người tạo)
    for (n, assigned, created) in [
        ("a", "9301", "9305"),
        ("b", "9302", "9302"),
        ("c", "9304", "NULL"),
        ("d", "NULL", "9304"),
        ("e", "9305", "9305"),
        ("f", "NULL", "NULL"),
    ] {
        exec(&format!(
            "INSERT INTO contacts (full_name, phone, assigned_to, created_by_id, updated_at) VALUES ('{n}', 'k13-{n}', {assigned}, {created}, now())"
        ))
        .await;
    }
}

async fn names(owner: &OwnerIds, fields: &[&str]) -> Vec<String> {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let mut qb = QueryBuilder::<Postgres>::new("SELECT full_name FROM contacts WHERE phone LIKE 'k13-%' AND ");
    push_scope(&mut qb, owner, fields);
    qb.push(" ORDER BY full_name");
    let rows: Vec<(String,)> = qb.build_query_as().fetch_all(&mut c).await.unwrap();
    rows.into_iter().map(|r| r.0).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "cần Postgres"]
async fn dieu_kien_pham_vi_tren_du_lieu_that() {
    setup().await;
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let scopes = ScopeService::new(db.clone(), RbacCache::new(security));
    let g = |v: &str| grants_from_json(&serde_json::json!({ "contacts.view": v }));
    let owner = |user: i32, v: &str| {
        let (scopes, grants) = (scopes.clone(), g(v));
        async move {
            scopes
                .owner_ids(CO, user, &grants, "contacts.view")
                .await
                .unwrap()
                .unwrap()
        }
    };
    let both = ["assigned_to", "created_by_id"];

    // all ⇒ mọi dòng.
    assert_eq!(
        names(&owner(9301, "all").await, &both).await,
        ["a", "b", "c", "d", "e", "f"]
    );
    // own: chính mình, một cột và hai cột (phụ trách HOẶC người tạo).
    let own = owner(9302, "own").await;
    assert_eq!(names(&own, &["assigned_to"]).await, ["b"]);
    assert_eq!(names(&owner(9304, "own").await, &both).await, ["c", "d"]);
    // team: 9301 + trực tiếp 9302, 9303 (không gồm 9304).
    let team = owner(9301, "team").await;
    assert_eq!(names(&team, &["assigned_to"]).await, ["a", "b"]);
    assert_eq!(names(&team, &both).await, ["a", "b"]);
    // subtree: thêm 9304.
    let sub = owner(9301, "subtree").await;
    assert_eq!(names(&sub, &["assigned_to"]).await, ["a", "b", "c"]);
    assert_eq!(names(&sub, &both).await, ["a", "b", "c", "d"]);
    // Tập rỗng không khớp dòng nào; cột sai tên đóng (chỉ kiểm khi bản release, ở debug có debug_assert).
    assert!(names(&OwnerIds::Ids(vec![]), &both).await.is_empty());
    // Ghép với điều kiện khác bằng AND: tách bạch, không mở rộng.
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT count(*) FROM contacts WHERE phone LIKE 'k13-%' AND full_name <> 'b' AND ",
    );
    push_scope(&mut qb, &sub, &both);
    let n: (i64,) = qb.build_query_as().fetch_one(&mut c).await.unwrap();
    assert_eq!(n.0, 3);

    // Kiểm theo id: ngoài phạm vi ⇒ 404; trong phạm vi hoặc không có chủ ⇒ theo `owners`.
    let own_g = g("own");
    scopes
        .assert_in_scope(CO, 9302, &own_g, "contacts.view", &[None, Some(9302)])
        .await
        .unwrap();
    match scopes
        .assert_in_scope(CO, 9302, &own_g, "contacts.view", &[Some(9305)])
        .await
    {
        Err(ScopeError::NotFound(e)) => assert_eq!(e.status(), 404),
        other => panic!("{other:?}"),
    }
    let all_g = g("all");
    scopes
        .assert_in_scope(CO, 9302, &all_g, "contacts.view", &[Some(9305)])
        .await
        .unwrap();
    // Che số theo phạm vi: số thật khi chủ trong tập, ngược lại bị che; 'all' luôn thật.
    let m = |grants: &_, owners: &[Option<i32>]| {
        let (scopes, grants) = (scopes.clone(), Clone::clone(grants));
        let owners = owners.to_vec();
        async move {
            scopes
                .mask_phone_for(CO, 9301, &grants, "contacts.view", &owners, Some("0900000168"))
                .await
                .unwrap()
        }
    };
    assert_eq!(m(&g("team"), &[Some(9302)]).await.as_deref(), Some("0900000168"));
    assert_eq!(m(&g("team"), &[Some(9304)]).await.as_deref(), Some("***168"));
    assert_eq!(m(&g("all"), &[Some(9305)]).await.as_deref(), Some("0900000168"));
    drop(db);
    teardown().await;
}
