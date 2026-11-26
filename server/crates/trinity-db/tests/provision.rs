//! K09: `provision_company`, dọn đăng ký bỏ dở và migrate nền theo tệp sở hữu (PLAN 4.5).
//!
//! Cần Postgres và quyền tạo DB. Mỗi test tạo một DB trống riêng (`<DB của TEST_DATABASE_URL>_k09_<ca>_<pid>`) rồi xoá:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test provision -- --ignored`

use std::time::{Duration, Instant};

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::migrate::{self, boot_migrate_companies};
use trinity_db::platform::Platform;
use trinity_db::prisma_migrate::Migration;
use trinity_db::provision::{self, ProvisionError, ProvisionInput, provision_company};
use trinity_db::{Db, DbConfig};

/// Dàn dựng tối thiểu của schema `public` (đủ cho `ensure` chép bù công ty 1).
const SETUP: &str = "
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
";

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn url_for(db: &str) -> String {
    let base = base_url();
    let (head, query) = base
        .split_once('?')
        .map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
    let (server, _) = head.rsplit_once('/').expect("URL có tên DB");
    match query {
        Some(q) => format!("{server}/{db}?{q}"),
        None => format!("{server}/{db}"),
    }
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

struct TestDb {
    name: String,
    url: String,
}

impl TestDb {
    async fn new(case: &str) -> Self {
        let base = base_url();
        let dbname = base
            .split_once('?')
            .map_or(base.as_str(), |(h, _)| h)
            .rsplit_once('/')
            .map(|(_, d)| d.to_owned())
            .unwrap();
        let name = format!("{dbname}_k09_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        let mut c = PgConnection::connect(&url).await.unwrap();
        exec(&mut c, SETUP).await;
        Self { name, url }
    }

    fn db(&self) -> (Db, Platform) {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.multi_tenant = true;
        cfg.pool_size = 8;
        cfg.acquire_timeout = Duration::from_secs(20);
        cfg.statement_timeout = Duration::ZERO;
        let db = Db::connect_lazy(&cfg).unwrap();
        let platform = Platform::new(&db, None);
        (db, platform)
    }

    async fn conn(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(mut admin) = PgConnection::connect(&base_url()).await {
                    let _ = sqlx::raw_sql(AssertSqlSafe(format!(
                        "DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"
                    )))
                    .execute(&mut admin)
                    .await;
                }
            });
        })
        .join();
    }
}

fn input(email: &str) -> ProvisionInput {
    ProvisionInput {
        company_name: "  Công ty Thử  ".to_owned(),
        admin_email: email.to_owned(),
        admin_password: "mat-khau-thu-123".to_owned(),
        admin_name: "Quản trị Thử".to_owned(),
    }
}

async fn scalar_i64(c: &mut PgConnection, sql: &str) -> i64 {
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn a_tao_cong_ty_duoi_5_giay_va_du_lieu_dau() {
    let t = TestDb::new("a").await;
    let (db, platform) = t.db();
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();

    let start = Instant::now();
    let res = provision_company(&db, &platform, &migrations, latest, &input("Admin@Thu.VN"))
        .await
        .unwrap();
    let took = start.elapsed();
    assert!(took < Duration::from_secs(5), "tạo công ty mất {took:?}");
    assert_eq!(res.company.schema(), "c_2");

    let mut c = t.conn().await;
    let (status, migrated_to, name): (String, Option<String>, String) =
        sqlx::query_as("SELECT status, migrated_to, name FROM platform.companies WHERE id = 2")
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(status, "active");
    assert_eq!(migrated_to.as_deref(), Some(latest));
    assert_eq!(name, "Công ty Thử");
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM c_2._prisma_migrations WHERE finished_at IS NOT NULL"
        )
        .await,
        migrations.len() as i64
    );
    // Email chữ thường ở cả users (trigger đồng bộ đã chạy) và company_logins.
    let (email, hash, full_name): (String, String, String) =
        sqlx::query_as("SELECT email, password_hash, full_name FROM c_2.users")
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(email, "admin@thu.vn");
    assert_eq!(full_name, "Quản trị Thử");
    assert!(bcrypt_ok("mat-khau-thu-123", &hash));
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT company_id::int8 FROM platform.company_logins WHERE email = 'admin@thu.vn'"
        )
        .await,
        2
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM c_2.roles WHERE name = 'Quản trị' AND is_system"
        )
        .await,
        1
    );
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM c_2.user_roles").await, 1);
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM c_2.setting_options").await, 14);
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM c_2.kanban_columns").await, 3);
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM c_2.kanban_columns WHERE is_done AND position = 3072"
        )
        .await,
        1
    );
    let org_plan: String = sqlx::query_scalar("SELECT value FROM c_2.settings WHERE key = 'org_plan'")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(org_plan, "mac_dinh");
    // Công ty đã active: qua cổng `Db::tenant`.
    assert!(platform.active_company(2).await.unwrap().is_some());

    // Email đã dùng.
    let again = provision_company(&db, &platform, &migrations, latest, &input("ADMIN@thu.vn")).await;
    assert!(matches!(again, Err(ProvisionError::EmailTaken)), "{again:?}");
    db.close().await;
}

fn bcrypt_ok(password: &str, hash: &str) -> bool {
    // Băm có tiền tố $2b$10$ (cost 10 như bcryptjs).
    hash.starts_with("$2") && hash[4..].starts_with("10$") && bcrypt_verify(password, hash)
}

fn bcrypt_verify(password: &str, hash: &str) -> bool {
    trinity_db::provision::verify_password(password, hash)
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn b_dang_ky_dong_thoi_cung_email_chi_mot_ben_thang() {
    let t = TestDb::new("b").await;
    let (db, platform) = t.db();
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();

    let mut tasks = Vec::new();
    for _ in 0..4 {
        let (db, platform, migrations, latest) = (db.clone(), platform.clone(), migrations.clone(), latest.to_owned());
        tasks.push(tokio::spawn(async move {
            provision_company(&db, &platform, &migrations, &latest, &input("trung@thu.vn")).await
        }));
    }
    let mut ok = 0;
    let mut taken = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => ok += 1,
            Err(ProvisionError::EmailTaken) => taken += 1,
            Err(e) => panic!("lỗi khác: {e}"),
        }
    }
    assert_eq!((ok, taken), (1, 3));
    let mut c = t.conn().await;
    assert_eq!(
        scalar_i64(&mut c, "SELECT count(*) FROM platform.companies WHERE id <> 1").await,
        1
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM information_schema.schemata WHERE schema_name ~ '^c_[0-9]+$'"
        )
        .await,
        1
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn c_loi_giua_chung_khong_de_lai_gi_va_nha_email() {
    let t = TestDb::new("c").await;
    let (db, platform) = t.db();
    let bad = vec![Migration {
        name: "0001_hong".to_owned(),
        script: "SELECT a FROM bang_khong_ton_tai".to_owned(),
    }];
    let res = provision_company(&db, &platform, &bad, "0001_hong", &input("loi@thu.vn")).await;
    assert!(matches!(res, Err(ProvisionError::Migrate(_))), "{res:?}");
    let mut c = t.conn().await;
    assert_eq!(
        scalar_i64(&mut c, "SELECT count(*) FROM platform.companies WHERE id <> 1").await,
        0
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM platform.company_logins WHERE email = 'loi@thu.vn'"
        )
        .await,
        0
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM information_schema.schemata WHERE schema_name ~ '^c_[0-9]+$'"
        )
        .await,
        0
    );
    // Email trống lại: tạo được với bộ migration đúng.
    let ok = provision_company(
        &db,
        &platform,
        &migrate::embedded_migrations(),
        migrate::latest_embedded(),
        &input("loi@thu.vn"),
    )
    .await;
    assert!(ok.is_ok(), "{ok:?}");
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn d_don_dang_ky_bo_do_sau_15_phut() {
    let t = TestDb::new("d").await;
    let (db, platform) = t.db();
    platform.ensure().await.unwrap();
    let mut c = t.conn().await;
    exec(
        &mut c,
        "
        INSERT INTO platform.companies (id, name, schema_name, status, created_at) VALUES
          (7, 'cũ', 'c_7', 'provisioning', now() - interval '20 minutes'),
          (8, 'mới', 'c_8', 'provisioning', now() - interval '2 minutes');
        CREATE SCHEMA c_7; CREATE TABLE c_7.x (a int);
        CREATE SCHEMA c_8;
        INSERT INTO platform.company_logins (email, company_id) VALUES ('cu@thu.vn', 7), ('moi@thu.vn', 8);
    ",
    )
    .await;
    assert_eq!(provision::reap_stale_provisioning(db.raw_pool()).await.unwrap(), 1);
    assert_eq!(
        scalar_i64(&mut c, "SELECT count(*) FROM platform.companies WHERE id IN (7, 8)").await,
        1
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM platform.company_logins WHERE company_id = 7"
        )
        .await,
        0
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'c_7'"
        )
        .await,
        0
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'c_8'"
        )
        .await,
        1
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn e_migrate_nen_theo_chu_va_mot_cong_ty_loi_khong_chan_cong_ty_khac() {
    let t = TestDb::new("e").await;
    let (db, platform) = t.db();
    platform.ensure().await.unwrap();
    let mut c = t.conn().await;
    // Công ty 5: schema trống (migrate được). Công ty 6: có bảng lạ không có _prisma_migrations (P3005, lỗi).
    exec(
        &mut c,
        "
        INSERT INTO platform.companies (id, name, schema_name) VALUES (5, 'ok', 'c_5'), (6, 'hỏng', 'c_6');
        CREATE SCHEMA c_5; CREATE SCHEMA c_6; CREATE TABLE c_6.la (a int);
    ",
    )
    .await;
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();

    // Node giữ migrate nền: Rust không đụng DB.
    let none = boot_migrate_companies(false, db.raw_pool(), &migrations, latest, 4)
        .await
        .unwrap();
    assert!(none.is_none());
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM platform.companies WHERE migrated_to IS NOT NULL"
        )
        .await,
        0
    );

    let report = boot_migrate_companies(true, db.raw_pool(), &migrations, latest, 4)
        .await
        .unwrap()
        .unwrap();
    assert!(!report.ok());
    assert_eq!(report.failed().map(|o| o.id).collect::<Vec<_>>(), vec![6]);
    let m5: Option<String> = sqlx::query_scalar("SELECT migrated_to FROM platform.companies WHERE id = 5")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(m5.as_deref(), Some(latest));
    db.close().await;
}
