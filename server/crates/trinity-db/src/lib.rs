//! Pool Postgres, `TenantDb`/`PlatformDb`, migrator tương thích Prisma, platform, provision, model sinh tự động.
//!
//! K01 chỉ đặt nền cho cách kiểm truy vấn (docs/rust/PLAN.md mục 4.4, `server/README.md`):
//! - truy vấn tĩnh dùng `sqlx::query!`/`query_scalar!`/`query_as!`, kiểm lúc biên dịch bằng dữ liệu trong
//!   `server/.sqlx/` (`SQLX_OFFLINE=true`), nên `cargo check` và CI không cần DB;
//! - truy vấn có bộ lọc động dùng `QueryBuilder`/`query_as` không macro, giá trị luôn bind, và bắt buộc có test pg.

pub mod prisma_migrate;

use sqlx::PgExecutor;

/// Truy vấn tĩnh mẫu: kiểm kết nối DB còn sống. Cũng là truy vấn giữ cho `cargo sqlx prepare --check` có dữ liệu
/// để so ngay từ K01.
pub async fn ping<'e>(db: impl PgExecutor<'e>) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT 1::int4 AS "one!""#).fetch_one(db).await
}
