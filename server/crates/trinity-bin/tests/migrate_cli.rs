//! `trinity migrate` chạy thật (K07). Cần Postgres có `public` đã migrate bằng Prisma (như job Rust pg tests) và
//! Prisma CLI: `TEST_DATABASE_URL=… cargo test -p trinity-bin --test migrate_cli -- --ignored`.

use std::path::PathBuf;
use std::process::{Command, Output};

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn trinity(args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_trinity"));
    c.arg("migrate").args(args).env_clear().env("DATABASE_URL", url());
    if let Ok(p) = std::env::var("PATH") {
        c.env("PATH", p);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    c.output().expect("chạy được binary trinity")
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn prisma_bin() -> PathBuf {
    std::env::var("PRISMA_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(manifest_dir()).join("prisma"))
}

#[test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
fn migrate_public_do_prisma_migrate_la_thao_tac_rong() {
    let o = trinity(&["--status"], &[]);
    assert!(
        o.status.success() && text(&o).contains("public: đã cập nhật"),
        "{}",
        text(&o)
    );
    let o = trinity(&[], &[]);
    assert!(
        o.status.success() && text(&o).contains("public: không còn migration nào phải chạy"),
        "{}",
        text(&o)
    );
}

#[test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
fn migrate_mot_schema_roi_prisma_bao_da_cap_nhat() {
    let schema = "c_9320";
    let drop = || drop_schema(schema);
    drop();
    let o = trinity(&["--schema", schema, "--status"], &[]);
    assert!(
        !o.status.success(),
        "chưa migrate thì --status thoát mã 1: {}",
        text(&o)
    );
    let o = trinity(&["--schema", schema], &[]);
    assert!(
        o.status.success() && text(&o).contains(&format!("{schema}: đã chạy")),
        "{}",
        text(&o)
    );
    let o = trinity(&["--schema", schema], &[]);
    assert!(text(&o).contains("không còn migration nào phải chạy"), "{}", text(&o));

    let sep = if url().contains('?') { '&' } else { '?' };
    let p = Command::new(prisma_bin())
        .args(["migrate", "status", "--schema"])
        .arg(PathBuf::from(manifest_dir()).join("../../prisma/schema.prisma"))
        .env("DATABASE_URL", format!("{}{sep}schema={schema}", url()))
        .env("PRISMA_HIDE_UPDATE_MESSAGE", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .output()
        .expect("chạy được prisma CLI");
    assert!(
        p.status.success() && text(&p).contains("Database schema is up to date"),
        "{}",
        text(&p)
    );
    drop();
}

fn drop_schema(schema: &str) {
    use sqlx::Connection;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut c = sqlx::PgConnection::connect(&url()).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
        )))
        .execute(&mut c)
        .await
        .unwrap();
    });
}

#[test]
#[ignore = "cần Postgres và Prisma CLI: xem đầu tệp"]
fn companies_can_multi_tenant_va_schema_sai_bi_tu_choi() {
    let o = trinity(&["--companies"], &[]);
    assert!(
        !o.status.success() && text(&o).contains("MULTI_TENANT=true"),
        "{}",
        text(&o)
    );
    let o = trinity(&["--schema", "pg_catalog"], &[]);
    assert!(!o.status.success() && text(&o).contains("schema"), "{}", text(&o));
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
