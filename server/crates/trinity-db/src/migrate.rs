//! `trinity migrate` (K07, PLAN 4.5): migrate schema công ty 1 và mọi schema công ty, dùng migrator tương thích
//! Prisma ở [`crate::prisma_migrate`] và bộ migration nhúng trong binary.
//!
//! Thay `prisma migrate deploy` (bước deploy) và `scripts/migrate-companies.cjs` / `migrateAllCompanies`:
//! - mỗi công ty một kết nối riêng, khoá theo **từng schema** (không giữ suốt lượt), `TENANT_MIGRATE_CONCURRENCY`
//!   schema chạy song song (mặc định 4); khoá hết giờ (55P03, ví dụ Prisma đang migrate) thì thử lại;
//! - xong thì ghi `platform.companies.migrated_to`; một công ty lỗi không chặn công ty khác, báo cáo liệt kê lỗi;
//! - khác bản TS có chủ đích: chỉ migrate công ty có `migrated_to` rỗng hoặc **nhỏ hơn** bản nhúng (TS chạy lại cả
//!   công ty có `migrated_to` lớn hơn và ghi lùi về bản cũ khi chạy binary cũ trên DB mới).

use std::sync::Arc;
use std::time::Duration;

use sqlx::{PgConnection, PgPool};
use tokio::sync::Mutex;

use crate::prisma_migrate::{self as pm, MigrateError, Migration};
use crate::{CompanyRef, LATEST_MIGRATION};

include!(concat!(env!("OUT_DIR"), "/embedded_migrations.rs"));

/// Số lần thử lấy khoá migrate (mỗi lần chờ tối đa [`pm::LOCK_TIMEOUT_MS`]).
pub const LOCK_ATTEMPTS: u32 = 3;

/// Bộ migration nhúng lúc biên dịch (nguyên văn từng byte `packages/prisma/prisma/migrations/*/migration.sql`).
pub fn embedded_migrations() -> Vec<Migration> {
    EMBEDDED
        .iter()
        .map(|(name, script)| Migration {
            name: (*name).to_owned(),
            script: (*script).to_owned(),
        })
        .collect()
}

/// Lỗi lấy khoá hết giờ (`lock_timeout`): Prisma hoặc worker khác đang migrate.
fn is_lock_timeout(e: &MigrateError) -> bool {
    matches!(e, MigrateError::Db(sqlx::Error::Database(d)) if d.code().as_deref() == Some("55P03"))
}

/// [`pm::deploy`] có thử lại khi lấy khoá hết giờ, tối đa `attempts` lần, nghỉ `pause` giữa hai lần.
pub async fn deploy_with_retry(
    conn: &mut PgConnection,
    schema: &str,
    migrations: &[Migration],
    attempts: u32,
    pause: Duration,
) -> Result<Vec<String>, MigrateError> {
    let mut left = attempts.max(1);
    loop {
        match pm::deploy(conn, schema, migrations).await {
            Err(e) if is_lock_timeout(&e) && left > 1 => {
                left -= 1;
                tokio::time::sleep(pause).await;
            }
            other => return other,
        }
    }
}

/// Kết quả của một công ty.
#[derive(Debug)]
pub struct CompanyOutcome {
    pub id: i32,
    pub schema: String,
    /// Tên migration vừa chạy, hoặc lỗi.
    pub result: Result<Vec<String>, String>,
}

/// Báo cáo một lượt `migrate --companies`.
#[derive(Debug, Default)]
pub struct CompaniesReport {
    /// Công ty đã có `migrated_to` ≥ bản nhúng, không đụng tới.
    pub up_to_date: usize,
    pub outcomes: Vec<CompanyOutcome>,
}

impl CompaniesReport {
    pub fn failed(&self) -> impl Iterator<Item = &CompanyOutcome> {
        self.outcomes.iter().filter(|o| o.result.is_err())
    }

    pub fn ok(&self) -> bool {
        self.failed().next().is_none()
    }
}

/// Migrate mọi công ty khác 1 trong `platform.companies` còn chậm hơn `latest` (thường là [`LATEST_MIGRATION`]),
/// `concurrency` công ty một lúc. Pool cần ít nhất `concurrency` kết nối và nên không có `statement_timeout`
/// (migration có thể chạy lâu). Chưa có `platform.companies` ⇒ không có công ty nào.
pub async fn migrate_companies(
    pool: &PgPool,
    migrations: &[Migration],
    latest: &str,
    concurrency: usize,
) -> Result<CompaniesReport, MigrateError> {
    let rows = {
        let mut conn = pool.acquire().await?;
        list_companies(&mut conn).await?
    };

    let mut report = CompaniesReport::default();
    let mut pending = Vec::new();
    for (id, schema, migrated_to) in rows {
        if migrated_to.as_deref().is_some_and(|m| m >= latest) {
            report.up_to_date += 1;
        } else {
            pending.push((id, schema));
        }
    }
    let queue = Arc::new(Mutex::new(pending.into_iter()));
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let migrations = Arc::new(migrations.to_vec());
    let mut workers = Vec::new();
    for _ in 0..concurrency.max(1) {
        let (queue, outcomes, migrations, pool, latest) = (
            queue.clone(),
            outcomes.clone(),
            migrations.clone(),
            pool.clone(),
            latest.to_owned(),
        );
        workers.push(tokio::spawn(async move {
            loop {
                let Some((id, schema)) = queue.lock().await.next() else {
                    break;
                };
                let result = migrate_one(&pool, id, &schema, &migrations, &latest)
                    .await
                    .map_err(|e| e.to_string());
                outcomes.lock().await.push(CompanyOutcome { id, schema, result });
            }
        }));
    }
    for w in workers {
        w.await.map_err(|e| MigrateError::Io(std::io::Error::other(e)))?;
    }
    let mut outcomes = std::mem::take(&mut *outcomes.lock().await);
    outcomes.sort_by_key(|o| o.id);
    report.outcomes = outcomes;
    Ok(report)
}

async fn migrate_one(
    pool: &PgPool,
    id: i32,
    schema: &str,
    migrations: &[Migration],
    latest: &str,
) -> Result<Vec<String>, MigrateError> {
    // schema_name phải đúng là schema của id (như `schemaForCompany`), không tin dữ liệu bảng.
    let expected = CompanyRef::new(i64::from(id))
        .map(|c| c.schema())
        .map_err(|_| MigrateError::InvalidSchema(schema.to_owned()))?;
    if expected != schema {
        return Err(MigrateError::InvalidSchema(schema.to_owned()));
    }
    let mut conn = pool.acquire().await?;
    let done = deploy_with_retry(&mut conn, schema, migrations, LOCK_ATTEMPTS, Duration::from_secs(1)).await?;
    sqlx::query(
        "UPDATE platform.companies SET migrated_to = $1 WHERE id = $2 AND (migrated_to IS NULL OR migrated_to < $1)",
    )
    .bind(latest)
    .bind(id)
    .execute(&mut *conn)
    .await?;
    Ok(done)
}

/// Công ty khác 1 trong `platform.companies` (id, schema_name, migrated_to) theo id; chưa có bảng ⇒ rỗng.
pub async fn list_companies(conn: &mut PgConnection) -> Result<Vec<(i32, String, Option<String>)>, MigrateError> {
    let has_platform: bool = sqlx::query_scalar("SELECT to_regclass('platform.companies') IS NOT NULL")
        .fetch_one(&mut *conn)
        .await?;
    if !has_platform {
        return Ok(Vec::new());
    }
    Ok(
        sqlx::query_as("SELECT id, schema_name, migrated_to FROM platform.companies WHERE id <> 1 ORDER BY id")
            .fetch_all(&mut *conn)
            .await?,
    )
}

/// `TENANT_MIGRATE_CONCURRENCY` (mặc định 4, tối thiểu 1), như `migrateAllCompanies`.
pub fn concurrency_from_env(value: Option<&str>) -> usize {
    value
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(4)
}

/// Bản nhúng có tên mới nhất bằng [`LATEST_MIGRATION`] (cùng một thư mục lúc biên dịch).
pub fn latest_embedded() -> &'static str {
    EMBEDDED.last().map_or(LATEST_MIGRATION, |(n, _)| n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nhung_giong_tung_byte_thu_muc() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/prisma/prisma/migrations");
        let on_disk = pm::read_migrations_dir(&dir).unwrap();
        let embedded = embedded_migrations();
        assert_eq!(embedded.len(), on_disk.len());
        for (a, b) in embedded.iter().zip(&on_disk) {
            assert_eq!(a.name, b.name);
            assert_eq!(a.script.as_bytes(), b.script.as_bytes(), "{}", a.name);
            assert_eq!(a.checksum(), b.checksum());
        }
        assert_eq!(latest_embedded(), LATEST_MIGRATION);
    }

    #[test]
    fn concurrency() {
        assert_eq!(concurrency_from_env(None), 4);
        assert_eq!(concurrency_from_env(Some("2")), 2);
        assert_eq!(concurrency_from_env(Some("0")), 4);
        assert_eq!(concurrency_from_env(Some("x")), 4);
    }
}
