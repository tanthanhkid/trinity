//! `trinity migrate` (K07, PLAN 4.5).

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use trinity_db::migrate::{self, LOCK_ATTEMPTS};
use trinity_db::prisma_migrate::{self as pm, Migration};
use trinity_db::{Db, DbConfig};

#[derive(Debug, Args)]
pub struct MigrateArgs {
    /// Migrate mọi công ty khác 1 trong `platform.companies` (cần MULTI_TENANT=true), thay
    /// `scripts/migrate-companies.cjs`. Song song theo TENANT_MIGRATE_CONCURRENCY (mặc định 4).
    #[arg(long, conflicts_with = "schema")]
    companies: bool,
    /// Chỉ một schema (`public` hoặc `c_<id>`); không ghi `platform.companies.migrated_to`.
    #[arg(long)]
    schema: Option<String>,
    /// Chỉ in trạng thái, không chạy gì.
    #[arg(long)]
    status: bool,
    /// Đọc migration từ thư mục này thay cho bộ nhúng trong binary.
    #[arg(long)]
    dir: Option<PathBuf>,
}

pub fn run(args: MigrateArgs) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(&format!("không tạo được runtime: {e}")),
    };
    match rt.block_on(run_async(args)) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => fail(&e),
    }
}

fn fail(msg: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "trinity migrate: {msg}");
    ExitCode::FAILURE
}

fn out(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

async fn run_async(args: MigrateArgs) -> Result<bool, String> {
    let migrations: Vec<Migration> = match &args.dir {
        Some(d) => pm::read_migrations_dir(d).map_err(|e| e.to_string())?,
        None => migrate::embedded_migrations(),
    };
    let Some(latest) = migrations.last().map(|m| m.name.clone()) else {
        return Err("không có migration nào".to_owned());
    };
    let mut cfg = DbConfig::from_env().map_err(|e| e.to_string())?;
    let concurrency = migrate::concurrency_from_env(std::env::var("TENANT_MIGRATE_CONCURRENCY").ok().as_deref());
    // Migration có thể chạy lâu: không giới hạn thời gian câu lệnh; đủ kết nối cho các worker.
    cfg.statement_timeout = Duration::ZERO;
    cfg.pool_size = u32::try_from(concurrency + 1).unwrap_or(u32::MAX);
    if args.companies && !cfg.multi_tenant {
        return Err("--companies chỉ dùng khi MULTI_TENANT=true".to_owned());
    }
    let db = Db::connect(&cfg).await.map_err(|e| e.to_string())?;
    let pool = db.raw_pool();

    let ok = if args.companies {
        companies(pool, &migrations, &latest, concurrency, args.status).await?
    } else {
        let schema = args.schema.as_deref().unwrap_or("public");
        let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
        if args.status {
            print_status(&mut conn, schema, &migrations).await?
        } else {
            match migrate::deploy_with_retry(&mut conn, schema, &migrations, LOCK_ATTEMPTS, Duration::from_secs(1))
                .await
            {
                Ok(done) => {
                    report_done(schema, &done);
                    true
                }
                Err(e) => {
                    out(&format!("{schema}: LỖI {e}"));
                    false
                }
            }
        }
    };
    db.close().await;
    Ok(ok)
}

fn report_done(schema: &str, done: &[String]) {
    if done.is_empty() {
        out(&format!("{schema}: không còn migration nào phải chạy"));
    } else {
        out(&format!(
            "{schema}: đã chạy {} migration: {}",
            done.len(),
            done.join(", ")
        ));
    }
}

async fn print_status(conn: &mut sqlx::PgConnection, schema: &str, migrations: &[Migration]) -> Result<bool, String> {
    let st = pm::status(conn, schema, migrations).await.map_err(|e| e.to_string())?;
    if st.up_to_date() && st.checksum_mismatch.is_empty() {
        out(&format!("{schema}: đã cập nhật ({} migration)", migrations.len()));
        return Ok(true);
    }
    if !st.initialized {
        out(&format!("{schema}: chưa có _prisma_migrations"));
    }
    if !st.pending.is_empty() {
        out(&format!("{schema}: chưa chạy: {}", st.pending.join(", ")));
    }
    if !st.failed.is_empty() {
        out(&format!("{schema}: lỗi dở dang: {}", st.failed.join(", ")));
    }
    if !st.checksum_mismatch.is_empty() {
        out(&format!(
            "{schema}: nội dung đã sửa sau khi chạy: {}",
            st.checksum_mismatch.join(", ")
        ));
    }
    // Nội dung migration đã sửa sau khi chạy cũng là lỗi (Prisma `migrate dev` cũng chặn).
    Ok(st.up_to_date() && st.checksum_mismatch.is_empty())
}

async fn companies(
    pool: &sqlx::PgPool,
    migrations: &[Migration],
    latest: &str,
    concurrency: usize,
    status_only: bool,
) -> Result<bool, String> {
    if status_only {
        let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
        let rows = migrate::list_companies(&mut conn).await.map_err(|e| e.to_string())?;
        if rows.is_empty() {
            no_companies_notice();
        }
        let mut ok = true;
        // Từng công ty riêng: lỗi của một công ty in ra rồi đi tiếp.
        for (id, schema, _) in rows {
            let res = match migrate::check_company_schema(id, &schema) {
                Ok(()) => print_status(&mut conn, &schema, migrations).await,
                Err(e) => Err(e.to_string()),
            };
            if let Err(e) = &res {
                out(&format!("{schema} (công ty {id}): LỖI {e}"));
            }
            ok &= res.unwrap_or(false);
        }
        return Ok(ok);
    }
    let report = migrate::migrate_companies(pool, migrations, latest, concurrency)
        .await
        .map_err(|e| e.to_string())?;
    for o in &report.outcomes {
        match &o.result {
            Ok(done) => report_done(&o.schema, done),
            Err(e) => out(&format!("{} (công ty {}): LỖI {e}", o.schema, o.id)),
        }
    }
    if report.outcomes.is_empty() && report.up_to_date == 0 {
        no_companies_notice();
    }
    let failed = report.failed().count();
    let migrated = report.migrated();
    out(&format!(
        "công ty: {} đã cập nhật từ trước, {} vừa migrate, {} không có gì mới, {} lỗi",
        report.up_to_date,
        migrated,
        report.outcomes.len() - failed - migrated,
        failed
    ));
    Ok(report.ok())
}

/// `platform.companies` do `ensurePlatform` tạo (bản Node lúc khởi động; ở Rust là K08). Chưa có thì không có công ty
/// nào để migrate.
fn no_companies_notice() {
    let _ = writeln!(
        std::io::stderr(),
        "trinity migrate: không có công ty nào trong platform.companies (bảng do bước ensurePlatform tạo: khởi động bản \
         Node với MULTI_TENANT=true trước, cho tới khi Rust có lệnh tương đương)"
    );
}
