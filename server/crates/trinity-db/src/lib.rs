//! Pool Postgres, `TenantDb`/`PlatformDb`, migrator tương thích Prisma, platform, provision, model sinh tự động.
//!
//! Định tuyến công ty bằng `search_path` (K06): xem [`Db`], [`TenantDb`] và tài liệu đầu `tenant.rs`.
//!
//! Cổng sự kiện tích hợp + thông báo ([`outbox`]) và kênh đồng bộ `trinity_sync` ([`sync`]) (K36).
//!
//! Struct model sinh tự động ([`models`], `cargo xtask gen-models`) và kiểu cột ghi JSON giống bản Node ([`types`]) (K10).
//!
//! K01 chỉ đặt nền cho cách kiểm truy vấn (docs/rust/PLAN.md mục 4.4, `server/README.md`):
//! - truy vấn tĩnh dùng `sqlx::query!`/`query_scalar!`/`query_as!`, kiểm lúc biên dịch bằng dữ liệu trong
//!   `server/.sqlx/` (`SQLX_OFFLINE=true`), nên `cargo check` và CI không cần DB;
//! - truy vấn có bộ lọc động dùng `QueryBuilder`/`query_as` không macro, giá trị luôn bind, và bắt buộc có test pg.

pub mod migrate;
pub mod outbox;
pub mod pg_error;
pub mod platform;
#[rustfmt::skip]
pub mod models;
pub mod prisma_migrate;
pub mod provision;
pub mod sync;
mod tenant;
pub mod types;

pub use tenant::{
    CompanyRef, Db, DbConfig, DbError, LATEST_MIGRATION, PlatformConn, PlatformDb, PlatformTx, TenantConn, TenantDb,
    TenantTx,
};

use sqlx::PgExecutor;

/// Truy vấn tĩnh mẫu: kiểm kết nối DB còn sống. Cũng là truy vấn giữ cho `cargo sqlx prepare --check` có dữ liệu
/// để so ngay từ K01.
pub async fn ping<'e>(db: impl PgExecutor<'e>) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT 1::int4 AS "one!""#).fetch_one(db).await
}
