//! K06: pool dùng chung, `TenantDb`/`TenantConn`/`TenantTx`/`PlatformDb` (PLAN 4.3).
//!
//! Cần Postgres với `public` đã migrate bằng Prisma (như job Rust pg tests của CI):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test tenant -- --ignored`
//! Test dùng schema `c_92xx` riêng và dòng `platform.companies` cùng id, tự tạo và xoá.

use std::collections::BTreeSet;
use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection, Row};
use trinity_db::{CompanyRef, Db, DbConfig, DbError, LATEST_MIGRATION};

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn cfg(pool: u32) -> DbConfig {
    let mut c = DbConfig::new(url());
    c.pool_size = pool;
    c.multi_tenant = true;
    c.acquire_timeout = Duration::from_secs(5);
    c
}

fn co(id: i64) -> CompanyRef {
    CompanyRef::new(id).unwrap()
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .expect(sql);
}

/// Tạo công ty `ids` với schema `c_<id>`, bảng `k06_contacts` 20 dòng, dòng `platform.companies` có `migrated_to`.
/// `wide` thêm cột và đổi thứ tự cột (như đang giữa hai bản migration).
async fn setup(ids: &[i32], wide: &[i32], migrated_to: Option<&str>) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    exec(
        &mut c,
        "BEGIN; SELECT pg_advisory_xact_lock(726354097);
         CREATE SCHEMA IF NOT EXISTS platform;
         CREATE TABLE IF NOT EXISTS platform.companies (
           id serial PRIMARY KEY, name varchar(200) NOT NULL, schema_name varchar(63) NOT NULL UNIQUE,
           status varchar(20) NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
           migrated_to varchar(255));
         COMMIT;",
    )
    .await;
    for id in ids {
        let ddl = if wide.contains(id) {
            "CREATE TABLE k06_contacts (note text DEFAULT 'n', id int PRIMARY KEY, company int NOT NULL, name text NOT NULL)"
        } else {
            "CREATE TABLE k06_contacts (id int PRIMARY KEY, company int NOT NULL, name text NOT NULL)"
        };
        exec(
            &mut c,
            &format!(
                "DROP SCHEMA IF EXISTS c_{id} CASCADE; CREATE SCHEMA c_{id}; SET search_path = c_{id}; {ddl};
                 INSERT INTO k06_contacts (id, company, name) SELECT g, {id}, 'kh ' || g FROM generate_series(1, 20) g;
                 RESET search_path;"
            ),
        )
        .await;
        sqlx::query(
            "INSERT INTO platform.companies (id, name, schema_name, migrated_to) VALUES ($1, 'k06', $2, $3)
             ON CONFLICT (id) DO UPDATE SET migrated_to = EXCLUDED.migrated_to, schema_name = EXCLUDED.schema_name",
        )
        .bind(id)
        .bind(format!("c_{id}"))
        .bind(migrated_to)
        .execute(&mut c)
        .await
        .unwrap();
    }
}

async fn teardown(ids: &[i32]) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    for id in ids {
        exec(&mut c, &format!("DROP SCHEMA IF EXISTS c_{id} CASCADE")).await;
        sqlx::query("DELETE FROM platform.companies WHERE id = $1")
            .bind(id)
            .execute(&mut c)
            .await
            .unwrap();
    }
}

const Q: &str = "SELECT id, company, name FROM k06_contacts WHERE id = $1";

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn truy_van_khong_gan_cong_ty_thi_loi() {
    setup(&[9201], &[], Some(LATEST_MIGRATION)).await;
    let db = Db::connect(&cfg(1)).await.unwrap();
    let mut p = db.platform().acquire().await.unwrap();
    let err = sqlx::query(Q).bind(1).fetch_one(&mut *p).await.unwrap_err();
    assert_eq!(
        err.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("42P01"),
        "{err}"
    );
    // Bảng dùng chung viết đủ tên thì chạy.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.companies WHERE id = 9201")
        .fetch_one(&mut *p)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let tz: String = sqlx::query_scalar("SELECT current_setting('TimeZone')")
        .fetch_one(&mut *p)
        .await
        .unwrap();
    assert_eq!(tz, "UTC");
    drop(p);

    // Sau khi một TenantConn trả về pool (cùng backend), kết nối lại không gắn công ty.
    let t = db.tenant(co(9201)).await.unwrap();
    let mut c = t.acquire().await.unwrap();
    sqlx::query(Q).bind(1).fetch_one(&mut *c).await.unwrap();
    drop(c);
    let mut p = db.platform().acquire().await.unwrap();
    assert!(sqlx::query(Q).bind(1).fetch_one(&mut *p).await.is_err());
    drop(p);
    db.close().await;
    teardown(&[9201]).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn xen_ke_hai_cong_ty_khong_lan_du_lieu() {
    let ids = [9211, 9212];
    setup(&ids, &[9212], Some(LATEST_MIGRATION)).await;

    // Một kết nối: 1.000 lượt xen kẽ, cùng prepared statement, trong và ngoài giao dịch.
    let db = Db::connect(&cfg(1)).await.unwrap();
    let t = [db.tenant(co(9211)).await.unwrap(), db.tenant(co(9212)).await.unwrap()];
    let mut pids = BTreeSet::new();
    let mut wrong = 0;
    for i in 0..1000 {
        let tdb = &t[i % 2];
        let want = tdb.company().id();
        let id = (i % 20) as i32 + 1;
        if i % 3 == 0 {
            let mut tx = tdb.begin().await.unwrap();
            let row = sqlx::query(Q).bind(id).fetch_one(&mut *tx).await.unwrap();
            let back: i32 = sqlx::query_scalar("UPDATE k06_contacts SET name = name WHERE id = $1 RETURNING company")
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            wrong += usize::from(row.get::<i32, _>("company") != want || back != want);
        } else {
            let mut c = tdb.acquire().await.unwrap();
            let row = sqlx::query(Q).bind(id).fetch_one(&mut *c).await.unwrap();
            wrong += usize::from(row.get::<i32, _>("company") != want);
            pids.insert(
                sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
                    .fetch_one(&mut *c)
                    .await
                    .unwrap(),
            );
        }
    }
    assert_eq!(wrong, 0);
    assert_eq!(pids.len(), 1, "pool 1 kết nối");
    db.close().await;

    // Pool 4 kết nối, 8 task song song.
    let db = Db::connect(&cfg(4)).await.unwrap();
    let mut tasks = Vec::new();
    for k in 0..8 {
        let t = [db.tenant(co(9211)).await.unwrap(), db.tenant(co(9212)).await.unwrap()];
        tasks.push(tokio::spawn(async move {
            let mut wrong = 0;
            for i in 0..250 {
                let tdb = &t[(i + k) % 2];
                let mut c = tdb.acquire().await.unwrap();
                let rows = sqlx::query("SELECT company FROM k06_contacts WHERE id <= 5")
                    .fetch_all(&mut *c)
                    .await
                    .unwrap();
                wrong += rows.iter().filter(|r| r.get::<i32, _>(0) != tdb.company().id()).count();
            }
            wrong
        }));
    }
    let mut wrong = 0;
    for t in tasks {
        wrong += t.await.unwrap();
    }
    assert_eq!(wrong, 0);
    db.close().await;
    teardown(&ids).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tra_ket_noi_giua_giao_dich_loi_van_sach() {
    setup(&[9221, 9222], &[], Some(LATEST_MIGRATION)).await;
    let mut c = cfg(1);
    c.statement_timeout = Duration::from_millis(1500);
    let db = Db::connect(&c).await.unwrap();
    let a = db.tenant(co(9221)).await.unwrap();
    let b = db.tenant(co(9222)).await.unwrap();

    // Giao dịch hỏng (lỗi giữa chừng) bị bỏ, không rollback; trong đó còn đổi GUC, lấy advisory lock.
    let pid_before: i32;
    {
        let mut tx = a.begin().await.unwrap();
        pid_before = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO k06_contacts (id, company, name) VALUES (999, 9221, 'dở')")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("SELECT pg_advisory_lock(726354099)")
            .execute(&mut *tx)
            .await
            .unwrap();
        exec(&mut tx, "SET statement_timeout = 0; SET TimeZone = 'Asia/Ho_Chi_Minh'").await;
        assert!(sqlx::query("SELECT 1/0").execute(&mut *tx).await.is_err());
        // drop tx ở đây
    }
    // Phiên ngoài giao dịch cũng bị đổi GUC và giữ advisory lock cấp phiên.
    {
        let mut conn = b.acquire().await.unwrap();
        exec(&mut conn, "SET work_mem = '8MB'").await;
        sqlx::query("SELECT pg_advisory_lock(726354098)")
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    let mut p = db.platform().acquire().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *p)
        .await
        .unwrap();
    assert_eq!(pid, pid_before, "cùng kết nối được dùng lại");
    let row = sqlx::query(
        "SELECT current_setting('search_path') sp, current_setting('TimeZone') tz,
                current_setting('statement_timeout') st, current_setting('work_mem') wm,
                (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) locks,
                (SELECT count(*) FROM c_9221.k06_contacts WHERE id = 999) leaked",
    )
    .fetch_one(&mut *p)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("sp"), "\"trinity_no_company\"");
    assert_eq!(row.get::<String, _>("tz"), "UTC");
    assert_eq!(row.get::<String, _>("st"), "1500ms");
    assert_ne!(row.get::<String, _>("wm"), "8MB");
    assert_eq!(row.get::<i64, _>("locks"), 0);
    assert_eq!(row.get::<i64, _>("leaked"), 0, "giao dịch bỏ dở phải rollback");
    // statement_timeout còn hiệu lực.
    let err = sqlx::query("SELECT pg_sleep(3)").execute(&mut *p).await.unwrap_err();
    assert_eq!(err.as_database_error().and_then(|e| e.code()).as_deref(), Some("57014"));
    drop(p);
    db.close().await;
    teardown(&[9221, 9222]).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tu_choi_cong_ty_migrate_cu() {
    setup(&[9231], &[], Some("0000_init")).await;
    setup(&[9232], &[], None).await;
    setup(&[9233], &[], Some(LATEST_MIGRATION)).await;
    let db = Db::connect(&cfg(2)).await.unwrap();
    for (id, have) in [(9231_i32, "0000_init"), (9232, "(chưa có)")] {
        match db.tenant(co(i64::from(id))).await {
            Err(DbError::CompanyNotMigrated { company, have: h, need }) => {
                assert_eq!((company, h.as_str(), need.as_str()), (id, have, LATEST_MIGRATION));
            }
            other => panic!("{id}: {other:?}"),
        }
    }
    assert!(matches!(db.tenant(co(9239)).await, Err(DbError::UnknownCompany(9239))));
    db.tenant(co(9233)).await.unwrap();

    // Migrate xong (migrated_to cập nhật) thì được phục vụ, không cần khởi động lại.
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::query("UPDATE platform.companies SET migrated_to = $1 WHERE id = 9231")
        .bind(LATEST_MIGRATION)
        .execute(&mut c)
        .await
        .unwrap();
    db.tenant(co(9231)).await.unwrap();
    db.close().await;
    teardown(&[9231, 9232, 9233]).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn cong_ty_1_kiem_bang_prisma_migrations_cua_public() {
    // public đã migrate bằng Prisma (bước chuẩn bị của test pg) ⇒ công ty 1 đạt.
    let db = Db::connect(&cfg(1)).await.unwrap();
    let t = db.tenant(CompanyRef::DEFAULT).await.unwrap();
    let mut c = t.acquire().await.unwrap();
    let sp: String = sqlx::query_scalar("SELECT current_setting('search_path')")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(sp, "\"public\"");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM _prisma_migrations")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(n > 0);
    drop(c);
    db.close().await;

    // Đòi bản mới hơn bản có trong public._prisma_migrations ⇒ từ chối. Không đọc platform.companies (công ty 1
    // không có dòng migrated_to).
    let mut c = cfg(1);
    c.required_migration = "9999_tuong_lai".to_owned();
    let db = Db::connect(&c).await.unwrap();
    match db.tenant(CompanyRef::DEFAULT).await {
        Err(DbError::CompanyNotMigrated { company: 1, have, .. }) => assert_eq!(have, LATEST_MIGRATION),
        other => panic!("{other:?}"),
    }
    db.close().await;

    // Bản một công ty: chỉ có công ty 1.
    let mut c = cfg(1);
    c.multi_tenant = false;
    let db = Db::connect(&c).await.unwrap();
    db.tenant(CompanyRef::DEFAULT).await.unwrap();
    assert!(matches!(db.tenant(co(9201)).await, Err(DbError::SingleTenant(9201))));
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn het_ket_noi_thi_cho_toi_acquire_timeout() {
    setup(&[9241], &[], Some(LATEST_MIGRATION)).await;
    let mut c = cfg(1);
    c.acquire_timeout = Duration::from_millis(300);
    let db = Db::connect(&c).await.unwrap();
    let t = db.tenant(co(9241)).await.unwrap();
    let held = t.acquire().await.unwrap();
    let t0 = std::time::Instant::now();
    let err = t.acquire().await.unwrap_err();
    assert!(matches!(err, DbError::Sqlx(sqlx::Error::PoolTimedOut)), "{err:?}");
    assert!(t0.elapsed() >= Duration::from_millis(250));
    drop(held);
    t.acquire().await.unwrap();
    db.close().await;
    teardown(&[9241]).await;
}
