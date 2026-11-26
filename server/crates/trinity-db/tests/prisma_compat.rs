//! Spike R005 (PLAN 4.5): test hai chiều Prisma 6.19 ↔ migrator Rust (`trinity_db::prisma_migrate`).
//!
//! Cần Postgres và Prisma CLI của repo (`pnpm install --frozen-lockfile` ở gốc repo). Chạy:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test prisma_compat -- --ignored --test-threads=1`
//! (URL phải ghi tên người dùng: Prisma không tự lấy như libpq và báo P1010). Mỗi test dùng schema riêng `r005_*`
//! trong DB đó, tự xoá trước khi chạy; test (b) tạo thêm DB `<tên>_ref` nếu chưa có. `PRISMA_BIN` đổi đường dẫn CLI.
//! Test (c) đo thời gian chờ khoá 10 giây của Prisma nên chạy khoảng 35 giây.

use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::prisma_migrate::{self as pm, Migration};

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn migrations_dir() -> PathBuf {
    repo_root().join("packages/prisma/prisma/migrations")
}

fn migrations() -> Vec<Migration> {
    pm::read_migrations_dir(&migrations_dir()).expect("đọc thư mục migration")
}

fn with_schema(schema: &str) -> String {
    with_schema_of(&url(), schema)
}

fn with_schema_of(u: &str, schema: &str) -> String {
    let sep = if u.contains('?') { '&' } else { '?' };
    format!("{u}{sep}schema={schema}")
}

/// Chạy Prisma CLI của repo với `DATABASE_URL` trỏ vào `schema`. `schema_file` mặc định là schema của repo; ca
/// thư mục migration tạm thì chép schema.prisma sang cạnh thư mục đó (Prisma đọc `migrations/` cạnh schema).
fn prisma(args: &[&str], schema: &str, schema_file: Option<&PathBuf>) -> Output {
    prisma_url(args, &with_schema(schema), schema_file)
}

fn prisma_bin() -> PathBuf {
    std::env::var("PRISMA_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("packages/prisma/node_modules/.bin/prisma"))
}

fn prisma_url(args: &[&str], database_url: &str, schema_file: Option<&PathBuf>) -> Output {
    let file = schema_file
        .cloned()
        .unwrap_or_else(|| repo_root().join("packages/prisma/prisma/schema.prisma"));
    Command::new(prisma_bin())
        .args(args)
        .arg("--schema")
        .arg(file)
        .env("DATABASE_URL", database_url)
        .env("PRISMA_HIDE_UPDATE_MESSAGE", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .output()
        .expect("chạy được prisma CLI")
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

async fn conn() -> PgConnection {
    PgConnection::connect(&url()).await.expect("nối được DB")
}

async fn drop_schema(c: &mut PgConnection, schema: &str) {
    sqlx::raw_sql(AssertSqlSafe(format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")))
        .execute(&mut *c)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn a_prisma_migrate_thi_rust_khong_con_gi_va_checksum_khop() {
    let schema = "r005_prisma";
    let mut c = conn().await;
    drop_schema(&mut c, schema).await;
    let o = prisma(&["migrate", "deploy"], schema, None);
    assert!(o.status.success(), "prisma migrate deploy: {}", text(&o));

    let ms = migrations();
    let st = pm::status(&mut c, schema, &ms).await.unwrap();
    assert!(st.up_to_date(), "{st:?}");
    assert!(st.checksum_mismatch.is_empty(), "{st:?}");
    assert_eq!(
        st.exact_checksum,
        ms.len(),
        "checksum Rust phải khớp từng ký tự checksum Prisma ghi: {st:?}"
    );

    // Dòng Prisma ghi: applied_steps_count = 1, đã finished.
    let rows = pm::applied(&mut c, schema).await.unwrap();
    assert_eq!(rows.len(), ms.len());
    assert!(
        rows.iter()
            .all(|r| r.finished && !r.rolled_back && r.applied_steps_count == 1 && r.id.len() == 36)
    );

    let done = pm::deploy(&mut c, schema, &ms).await.unwrap();
    assert!(done.is_empty(), "migrate lại phải rỗng: {done:?}");
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn b_rust_migrate_thi_prisma_bao_da_cap_nhat_va_schema_giong_het() {
    let schema = "r005_rust";
    let mut c = conn().await;
    drop_schema(&mut c, schema).await;
    let ms = migrations();
    let done = pm::deploy(&mut c, schema, &ms).await.unwrap();
    assert_eq!(done.len(), ms.len());
    assert!(
        pm::deploy(&mut c, schema, &ms).await.unwrap().is_empty(),
        "migrate lại là thao tác rỗng"
    );

    let o = prisma(&["migrate", "status"], schema, None);
    let t = text(&o);
    assert!(
        o.status.success() && t.contains("Database schema is up to date"),
        "prisma migrate status: {t}"
    );
    let o = prisma(&["migrate", "deploy"], schema, None);
    let t = text(&o);
    assert!(
        o.status.success() && t.contains("No pending migrations to apply"),
        "prisma migrate deploy: {t}"
    );

    // So cấu trúc với cùng tên schema do Prisma migrate ở một DB khác (`<db>_ref`), bằng `prisma migrate diff`
    // (Prisma tự so, không phải bộ so tự viết). Khác DB vì diff hai schema khác tên luôn ra khác.
    let (ref_db, ref_url) = ref_database();
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)")
        .bind(&ref_db)
        .fetch_one(&mut c)
        .await
        .unwrap();
    if !exists {
        sqlx::raw_sql(AssertSqlSafe(format!("CREATE DATABASE \"{ref_db}\"")))
            .execute(&mut c)
            .await
            .unwrap();
    }
    let mut rc = PgConnection::connect(&ref_url).await.unwrap();
    drop_schema(&mut rc, schema).await;
    let o = prisma_url(&["migrate", "deploy"], &with_schema_of(&ref_url, schema), None);
    assert!(o.status.success(), "{}", text(&o));
    let o = Command::new(prisma_bin())
        .args(["migrate", "diff", "--exit-code", "--script", "--from-url"])
        .arg(with_schema_of(&ref_url, schema))
        .arg("--to-url")
        .arg(with_schema(schema))
        .env("PRISMA_HIDE_UPDATE_MESSAGE", "1")
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "schema Rust migrate khác schema Prisma migrate: {}",
        text(&o)
    );
    assert!(text(&o).contains("empty migration"), "{}", text(&o));
}

/// DB phụ `<tên DB test>_ref` cùng máy chủ.
fn ref_database() -> (String, String) {
    let u = url();
    let (base, query) = u.split_once('?').map_or((u.as_str(), None), |(b, q)| (b, Some(q)));
    let (prefix, db) = base.rsplit_once('/').expect("URL có tên DB");
    let ref_db = format!("{db}_ref");
    let ref_url = match query {
        Some(q) => format!("{prefix}/{ref_db}?{q}"),
        None => format!("{prefix}/{ref_db}"),
    };
    (ref_db, ref_url)
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn c_khoa_rust_chan_prisma_va_khoa_prisma_chan_rust() {
    let mut rust = conn().await;
    let mut other = conn().await;
    drop_schema(&mut rust, "r005_lock_p").await;

    // Hai worker Rust khác schema giữ khoá cùng lúc được (cùng shared 72707369); cùng schema thì chờ rồi lỗi.
    pm::lock(&mut rust, "r005_lock_r").await.unwrap();
    pm::lock(&mut other, "r005_lock_x")
        .await
        .expect("worker Rust thứ hai, schema khác");
    pm::unlock(&mut other).await.unwrap();
    let t0 = Instant::now();
    let err = pm::lock(&mut other, "r005_lock_r")
        .await
        .expect_err("cùng schema phải chờ rồi lỗi");
    assert!(
        t0.elapsed() >= Duration::from_secs(9) && err.to_string().contains("lock timeout"),
        "{err}"
    );

    // Rust giữ khoá ⇒ prisma migrate deploy chờ 10 giây rồi báo P1002.
    let t0 = Instant::now();
    let o = prisma(&["migrate", "deploy"], "r005_lock_p", None);
    let t = text(&o);
    assert!(!o.status.success(), "Prisma không được chạy khi Rust giữ khoá: {t}");
    assert!(t.contains("P1002") && t.contains("pg_advisory_lock(72707369)"), "{t}");
    assert!(
        t0.elapsed() >= Duration::from_secs(9),
        "Prisma phải chờ khoá: {:?}",
        t0.elapsed()
    );

    // Cạm bẫy đo được: Prisma hết giờ nhưng yêu cầu khoá exclusive của nó vẫn nằm trong hàng đợi của Postgres
    // (backend không biết client đã đi khi đang chờ khoá), nên yêu cầu shared mới phải xếp sau nó.
    let orphan: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock' AND objid = 72707369",
    )
    .fetch_one(&mut other)
    .await
    .unwrap();
    assert_eq!(orphan, 1, "yêu cầu khoá mồ côi của Prisma");
    // Nhả khoá Rust: yêu cầu mồ côi được cấp rồi backend đó tự thoát.
    pm::unlock(&mut rust).await.unwrap();
    let mut cleared = false;
    for _ in 0..50 {
        let n: i64 =
            sqlx::query_scalar("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 72707369")
                .fetch_one(&mut other)
                .await
                .unwrap();
        if n == 0 {
            cleared = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(cleared, "khoá mồ côi phải tự hết khi người giữ nhả");

    // Phía ngược lại: một phiên giữ khoá exclusive như Prisma ⇒ Rust chờ rồi báo lỗi lock timeout (55P03).
    let mut prisma_like = conn().await;
    sqlx::query("SELECT pg_advisory_lock(72707369)")
        .execute(&mut prisma_like)
        .await
        .unwrap();
    let err = pm::lock(&mut rust, "r005_lock_r")
        .await
        .expect_err("Rust phải chờ Prisma");
    assert!(err.to_string().contains("lock timeout"), "{err}");
    sqlx::query("SELECT pg_advisory_unlock_all()")
        .execute(&mut prisma_like)
        .await
        .unwrap();
    pm::lock(&mut rust, "r005_lock_r")
        .await
        .expect("Prisma nhả thì Rust lấy được");
    pm::unlock(&mut rust).await.unwrap();
    drop_schema(&mut rust, "r005_lock_p").await;
}

#[tokio::test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
async fn d_migration_loi_rust_ghi_dong_prisma_doc_ra_p3009() {
    // Thư mục migration tạm: bản đầu của repo + một migration hỏng.
    let tmp = std::env::temp_dir().join(format!("r005-mig-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let mig = tmp.join("migrations");
    std::fs::create_dir_all(mig.join("0000_init")).unwrap();
    std::fs::create_dir_all(mig.join("0001_hong")).unwrap();
    std::fs::copy(
        migrations_dir().join("0000_init/migration.sql"),
        mig.join("0000_init/migration.sql"),
    )
    .unwrap();
    std::fs::copy(
        migrations_dir().join("migration_lock.toml"),
        mig.join("migration_lock.toml"),
    )
    .unwrap();
    std::fs::write(
        mig.join("0001_hong/migration.sql"),
        "CREATE TABLE r005_ok (id int);\nSELECT 1/0;\n",
    )
    .unwrap();
    let schema_file = tmp.join("schema.prisma");
    std::fs::copy(repo_root().join("packages/prisma/prisma/schema.prisma"), &schema_file).unwrap();

    let schema = "r005_fail";
    let mut c = conn().await;
    drop_schema(&mut c, schema).await;
    let ms = pm::read_migrations_dir(&mig).unwrap();
    let err = pm::deploy(&mut c, schema, &ms).await.expect_err("migration hỏng");
    assert!(err.to_string().contains("0001_hong"), "{err}");
    // Script chạy trong một giao dịch ngầm: phần đã chạy của migration hỏng bị hoàn tác, như Prisma.
    let leaked: bool = sqlx::query_scalar("SELECT to_regclass('r005_fail.r005_ok') IS NOT NULL")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert!(!leaked);

    let o = prisma(&["migrate", "deploy"], schema, Some(&schema_file));
    let t = text(&o);
    assert!(
        !o.status.success() && t.contains("P3009") && t.contains("0001_hong"),
        "Prisma phải thấy dòng lỗi Rust ghi: {t}"
    );
    let st = pm::status(&mut c, schema, &ms).await.unwrap();
    assert_eq!(st.failed, vec!["0001_hong".to_owned()]);

    drop_schema(&mut c, schema).await;
    let _ = std::fs::remove_dir_all(&tmp);
}
