//! K07: `migrate_companies` (thay `migrateAllCompanies`), thử lại khi khoá hết giờ, bộ migration nhúng.
//!
//! Cần Postgres và Prisma CLI như `prisma_compat.rs`:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test migrate_companies -- --ignored`
//! Dùng schema `c_93xx` và dòng `platform.companies` cùng id, tự tạo và xoá. Các test chạy tuần tự (cùng đọc cả bảng
//! `platform.companies`).

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sqlx::postgres::PgPoolOptions;
use sqlx::{AssertSqlSafe, Connection, PgConnection, PgPool};
use trinity_db::LATEST_MIGRATION;
use trinity_db::migrate::{self, CompaniesReport};
use trinity_db::prisma_migrate as pm;

fn serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn prisma_bin() -> PathBuf {
    std::env::var("PRISMA_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(manifest_dir()).join("../../../packages/prisma/node_modules/.bin/prisma"))
}

/// `prisma migrate status` cho một schema: (thành công, đầu ra).
fn prisma_status(schema: &str) -> (bool, String) {
    let u = url();
    let sep = if u.contains('?') { '&' } else { '?' };
    let o = Command::new(prisma_bin())
        .args(["migrate", "status", "--schema"])
        .arg(PathBuf::from(manifest_dir()).join("../../../packages/prisma/prisma/schema.prisma"))
        .env("DATABASE_URL", format!("{u}{sep}schema={schema}"))
        .env("PRISMA_HIDE_UPDATE_MESSAGE", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .output()
        .expect("chạy được prisma CLI");
    (
        o.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
    )
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .expect(sql);
}

async fn pool(n: u32) -> PgPool {
    PgPoolOptions::new().max_connections(n).connect(&url()).await.unwrap()
}

/// Bảng `platform.companies` (DDL của `platform.ts`) và các dòng (id, schema_name, migrated_to).
async fn setup(c: &mut PgConnection, rows: &[(i32, &str, Option<&str>)]) {
    exec(
        c,
        "BEGIN; SELECT pg_advisory_xact_lock(726354097);
         CREATE SCHEMA IF NOT EXISTS platform;
         CREATE TABLE IF NOT EXISTS platform.companies (
           id serial PRIMARY KEY, name varchar(200) NOT NULL, schema_name varchar(63) NOT NULL UNIQUE,
           status varchar(20) NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
           migrated_to varchar(255));
         COMMIT;",
    )
    .await;
    for (id, schema, migrated_to) in rows {
        exec(c, &format!("DROP SCHEMA IF EXISTS c_{id} CASCADE")).await;
        sqlx::query(
            "INSERT INTO platform.companies (id, name, schema_name, migrated_to) VALUES ($1, 'k07', $2, $3)
             ON CONFLICT (id) DO UPDATE SET schema_name = EXCLUDED.schema_name, migrated_to = EXCLUDED.migrated_to",
        )
        .bind(id)
        .bind(schema)
        .bind(migrated_to)
        .execute(&mut *c)
        .await
        .unwrap();
    }
}

/// Dọn schema và dòng `platform.companies` khi test kết thúc, kể cả khi test hỏng giữa chừng.
struct Cleanup(Vec<i32>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let ids = std::mem::take(&mut self.0);
        // Drop chạy trong runtime của test: dọn trên luồng riêng với runtime riêng.
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(mut c) = PgConnection::connect(&url()).await {
                    teardown(&mut c, &ids).await;
                }
            });
        })
        .join();
    }
}

async fn teardown(c: &mut PgConnection, ids: &[i32]) {
    for id in ids {
        let _ = sqlx::raw_sql(AssertSqlSafe(format!("DROP SCHEMA IF EXISTS c_{id} CASCADE")))
            .execute(&mut *c)
            .await;
        let _ = sqlx::query("DELETE FROM platform.companies WHERE id = $1")
            .bind(id)
            .execute(&mut *c)
            .await;
    }
}

async fn migrated_to(c: &mut PgConnection, id: i32) -> Option<String> {
    sqlx::query_scalar("SELECT migrated_to FROM platform.companies WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

fn outcome(r: &CompaniesReport, id: i32) -> Option<&Result<Vec<String>, String>> {
    r.outcomes.iter().find(|o| o.id == id).map(|o| &o.result)
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn migrate_moi_cong_ty_mot_cong_ty_loi_khong_chan_cong_ty_khac() {
    let _g = serial().lock().await;
    let ids = [9301, 9302, 9303, 9304, 9305, 9306];
    let _cleanup = Cleanup(ids.to_vec());
    let mut c = PgConnection::connect(&url()).await.unwrap();
    setup(
        &mut c,
        &[
            (9301, "c_9301", None),
            (9302, "c_9302", Some("0000_init")),
            (9303, "c_9303", Some(LATEST_MIGRATION)),
            (9304, "c_9304", Some("9999_tuong_lai")),
            (9305, "c_1", None),
            (9306, "c_9306", None),
        ],
    )
    .await;
    // 9302: schema có bảng lạ mà không có _prisma_migrations ⇒ P3005.
    exec(&mut c, "CREATE SCHEMA c_9302; CREATE TABLE c_9302.la (id int)").await;

    let ms = migrate::embedded_migrations();
    let p = pool(3).await;
    let r = migrate::migrate_companies(&p, &ms, LATEST_MIGRATION, 2).await.unwrap();
    assert_eq!(outcome(&r, 9301).unwrap().as_ref().unwrap().len(), ms.len());
    assert_eq!(outcome(&r, 9306).unwrap().as_ref().unwrap().len(), ms.len());
    assert!(outcome(&r, 9302).unwrap().as_ref().unwrap_err().contains("P3005"));
    assert!(outcome(&r, 9305).unwrap().is_err(), "schema_name không khớp id");
    assert!(
        outcome(&r, 9303).is_none() && outcome(&r, 9304).is_none(),
        "đã cập nhật thì không đụng"
    );
    assert!(r.up_to_date >= 2);
    assert!(!r.ok());

    assert_eq!(migrated_to(&mut c, 9301).await.as_deref(), Some(LATEST_MIGRATION));
    assert_eq!(migrated_to(&mut c, 9302).await.as_deref(), Some("0000_init"));
    assert_eq!(
        migrated_to(&mut c, 9304).await.as_deref(),
        Some("9999_tuong_lai"),
        "không ghi lùi"
    );
    let exists: bool = sqlx::query_scalar("SELECT to_regnamespace('c_9303') IS NOT NULL")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert!(!exists, "công ty đã cập nhật không bị migrate lại");

    // Hai chiều: schema do Rust migrate, Prisma báo đã cập nhật.
    let (ok, out) = prisma_status("c_9301");
    assert!(ok && out.contains("Database schema is up to date"), "{out}");

    // Lượt hai: công ty đã migrate không chạy lại; công ty lỗi vẫn lỗi; không có gì mới chạy.
    let r = migrate::migrate_companies(&p, &ms, LATEST_MIGRATION, 2).await.unwrap();
    assert!(outcome(&r, 9301).is_none() && outcome(&r, 9306).is_none());
    assert!(outcome(&r, 9302).unwrap().is_err());

    // Sửa công ty lỗi rồi chạy lại: được.
    exec(&mut c, "DROP TABLE c_9302.la").await;
    let r = migrate::migrate_companies(&p, &ms, LATEST_MIGRATION, 2).await.unwrap();
    assert_eq!(outcome(&r, 9302).unwrap().as_ref().unwrap().len(), ms.len());
    // Migrate lại một schema đã cập nhật (kể cả khi migrated_to bị xoá) là thao tác rỗng.
    sqlx::query("UPDATE platform.companies SET migrated_to = NULL WHERE id = 9301")
        .execute(&mut c)
        .await
        .unwrap();
    let r = migrate::migrate_companies(&p, &ms, LATEST_MIGRATION, 2).await.unwrap();
    assert_eq!(outcome(&r, 9301).unwrap().as_ref().unwrap(), &Vec::<String>::new());
    assert_eq!(migrated_to(&mut c, 9301).await.as_deref(), Some(LATEST_MIGRATION));

    p.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn so_migrated_to_theo_byte_khong_theo_collation_cua_db() {
    let _g = serial().lock().await;
    let _cleanup = Cleanup(vec![9307]);
    let mut c = PgConnection::connect(&url()).await.unwrap();
    setup(&mut c, &[(9307, "c_9307", Some("0020_channel_guard"))]).await;
    // Collation bỏ qua dấu câu như glibc en_US: `0020_channel_guard` "lớn hơn" `0020a_…`, còn theo byte thì nhỏ hơn.
    exec(
        &mut c,
        "CREATE COLLATION IF NOT EXISTS k07_bo_dau_cau (provider = icu, locale = 'en-u-ka-shifted')",
    )
    .await;
    let differs: bool = sqlx::query_scalar(
        "SELECT '0020_channel_guard' COLLATE k07_bo_dau_cau > '0020a_go_quyen_chuong_trinh_con' COLLATE k07_bo_dau_cau",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    assert!(differs, "collation thử phải sắp khác thứ tự byte");
    exec(
        &mut c,
        "ALTER TABLE platform.companies ALTER COLUMN migrated_to TYPE varchar(255) COLLATE k07_bo_dau_cau",
    )
    .await;

    let all = migrate::embedded_migrations();
    let upto = all
        .iter()
        .position(|m| m.name == "0020a_go_quyen_chuong_trinh_con")
        .unwrap();
    let ms = &all[..=upto];
    let p = pool(2).await;
    let res = migrate::migrate_companies(&p, ms, "0020a_go_quyen_chuong_trinh_con", 1).await;
    exec(
        &mut c,
        "ALTER TABLE platform.companies ALTER COLUMN migrated_to TYPE varchar(255) COLLATE \"default\"",
    )
    .await;
    let r = res.unwrap();
    assert_eq!(outcome(&r, 9307).unwrap().as_ref().unwrap().len(), ms.len());
    assert_eq!(
        migrated_to(&mut c, 9307).await.as_deref(),
        Some("0020a_go_quyen_chuong_trinh_con"),
        "UPDATE phải so theo byte như Rust"
    );
    p.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn thu_lai_khi_prisma_dang_giu_khoa() {
    let _g = serial().lock().await;
    let _cleanup = Cleanup(vec![9310]);
    let mut c = PgConnection::connect(&url()).await.unwrap();
    exec(&mut c, "DROP SCHEMA IF EXISTS c_9310 CASCADE").await;

    // Một phiên giữ khoá exclusive như `prisma migrate deploy` trong 12 giây (lâu hơn một lần chờ 10 giây).
    let mut holder = PgConnection::connect(&url()).await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(72707369)")
        .execute(&mut holder)
        .await
        .unwrap();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(12)).await;
        sqlx::query("SELECT pg_advisory_unlock_all()")
            .execute(&mut holder)
            .await
            .unwrap();
        holder
    });

    let ms = migrate::embedded_migrations();
    let t0 = Instant::now();
    // Lần thử đầu hết giờ sau 10 giây, lần sau lấy được khi khoá nhả ở giây 12.
    let mut w = PgConnection::connect(&url()).await.unwrap();
    let done = migrate::deploy_with_retry(&mut w, "c_9310", &ms, 3, Duration::from_millis(200))
        .await
        .unwrap();
    assert_eq!(done.len(), ms.len());
    assert!(t0.elapsed() >= Duration::from_secs(12));
    let mut holder = release.await.unwrap();

    // Chỉ một lần thử thì báo lỗi lock timeout, không chạy gì.
    sqlx::query("SELECT pg_advisory_lock(72707369)")
        .execute(&mut holder)
        .await
        .unwrap();
    let err = migrate::deploy_with_retry(&mut w, "c_9310", &ms, 1, Duration::ZERO)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("lock timeout"), "{err}");
    sqlx::query("SELECT pg_advisory_unlock_all()")
        .execute(&mut holder)
        .await
        .unwrap();
    let st = pm::status(&mut w, "c_9310", &ms).await.unwrap();
    assert!(st.up_to_date() && st.exact_checksum == ms.len());
    exec(&mut c, "DROP SCHEMA IF EXISTS c_9310 CASCADE").await;
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
