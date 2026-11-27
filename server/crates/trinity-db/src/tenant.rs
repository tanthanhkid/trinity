//! Pool dùng chung và kết nối gắn công ty bằng `search_path` (PLAN 4.3, issue K06; kết luận spike R005).
//!
//! - Một pool cho mọi công ty. Mỗi phiên mở với `search_path` = schema không tồn tại, `TimeZone=UTC`,
//!   `statement_timeout` (gửi trong gói khởi động, không tốn thêm vòng gọi): kết nối chưa gắn công ty chạy truy vấn
//!   không định danh schema thì lỗi 42P01 (fail-closed, như `MissingCompanyContextError`).
//! - [`TenantDb`] là **handle** (rẻ, clone được), không giữ kết nối: lấy [`TenantConn`]/[`TenantTx`] theo từng nhóm truy
//!   vấn rồi trả ngay, không giữ qua lời gọi HTTP ra ngoài (lint `cargo xtask lint`).
//! - [`TenantConn`]/[`TenantTx`] chỉ tạo được từ [`TenantDb`], mà [`TenantDb`] chỉ tạo được qua [`Db::tenant`] với một
//!   [`CompanyRef`] đã qua cổng migrate: quên chọn công ty là lỗi biên dịch.
//! - Lấy kết nối thì luôn đặt `search_path` (chỉ schema công ty, không thêm `public`). [`TenantTx`] đặt **trước**
//!   `BEGIN` (đặt trong giao dịch rồi rollback thì bị hoàn tác).
//! - Trả kết nối về pool: `ROLLBACK` phòng giao dịch sót, `RESET ALL` (về giá trị của gói khởi động: schema không tồn
//!   tại, UTC, `statement_timeout`), `pg_advisory_unlock_all()`. Lỗi ở bước này ⇒ đóng kết nối thay vì trả về pool.
//! - Statement cache của sqlx giữ bật; cấm `SELECT *`/`RETURNING *` (lint) và từ chối công ty có bản migration cũ hơn
//!   [`LATEST_MIGRATION`] (R005: đổi kiểu cột giữa hai schema làm giao dịch lỗi 0A000).

use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};

use crate::prisma_migrate::NO_COMPANY_SEARCH_PATH;

/// Migration mới nhất trong thư mục Prisma lúc biên dịch binary này.
pub const LATEST_MIGRATION: &str = env!("TRINITY_LATEST_MIGRATION");

/// Lỗi tầng DB.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("Invalid company id: {0}")]
    InvalidCompany(i64),
    #[error("Refusing to open unknown schema \"{0}\"")]
    InvalidSchema(String),
    #[error("DATABASE_URL is not set")]
    MissingUrl,
    /// URL pooler transaction-mode: `search_path` theo phiên bị chia sẻ giữa các client.
    #[error("{}", pooler_message(*multi_tenant))]
    PoolerUrl { multi_tenant: bool },
    #[error("cấu hình DB không hợp lệ: {0}")]
    Config(String),
    /// `MULTI_TENANT` tắt mà xin công ty khác 1.
    #[error("bản cài một công ty: không có công ty {0}")]
    SingleTenant(i32),
    #[error("không có công ty {0}")]
    UnknownCompany(i32),
    /// Công ty có trong `platform.companies` nhưng `status` khác `active` (đang tạo, bị khoá…).
    #[error("công ty {company} không hoạt động (status = {status})")]
    CompanyInactive { company: i32, status: String },
    /// HTTP trả 503 kèm câu này cho tới khi migrate nền xong.
    #[error(
        "Dữ liệu công ty {company} đang được nâng cấp (đã migrate tới {have}, cần {need}). Vui lòng thử lại sau ít phút."
    )]
    CompanyNotMigrated { company: i32, have: String, need: String },
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

fn pooler_message(multi_tenant: bool) -> &'static str {
    if multi_tenant {
        "Multi-tenant company schemas need a direct or session-mode Postgres URL: set TENANT_DATABASE_URL (or DIRECT_DATABASE_URL)"
    } else {
        "The Rust server keeps per-session state (search_path) and needs a direct or session-mode Postgres URL: set DIRECT_DATABASE_URL"
    }
}

/// URL trỏ vào pooler transaction-mode (`pgbouncer=true` hoặc host `-pooler.`, như `clients.ts`).
pub fn is_pooler_url(url: &str) -> bool {
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    if query.split('&').any(|p| p == "pgbouncer=true") {
        return true;
    }
    let host = base.split_once("://").map_or(base, |(_, r)| r);
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    host.split(['/', ':']).next().unwrap_or("").contains("-pooler.")
}

/// Kết quả cổng của một công ty được nhớ trong khoảng này (chỉ nhớ kết quả đạt): đổi `status` hay `migrated_to`
/// có hiệu lực sau tối đa chừng ấy, như cache khoá kênh 10 giây của bản Node.
pub const GATE_CACHE_TTL: Duration = Duration::from_secs(10);

/// Một công ty. Công ty 1 = schema `public`, công ty N = `c_N`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CompanyRef {
    id: i32,
}

impl CompanyRef {
    /// Công ty mặc định (dữ liệu có trước khi đa công ty).
    pub const DEFAULT: CompanyRef = CompanyRef { id: 1 };

    pub fn new(id: i64) -> Result<Self, DbError> {
        match i32::try_from(id) {
            Ok(id) if id >= 1 => Ok(Self { id }),
            _ => Err(DbError::InvalidCompany(id)),
        }
    }

    /// Ngược lại của [`Self::schema`]: chỉ nhận `public` hoặc `^c_[0-9]+$` (như `clients.ts`).
    pub fn from_schema(schema: &str) -> Result<Self, DbError> {
        if schema == "public" {
            return Ok(Self::DEFAULT);
        }
        let bad = || DbError::InvalidSchema(schema.to_owned());
        let digits = schema.strip_prefix("c_").ok_or_else(bad)?;
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        let id: i64 = digits.parse().map_err(|_| bad())?;
        let c = Self::new(id).map_err(|_| bad())?;
        // `c_1` hoặc `c_02` không phải tên do `schema()` sinh ra.
        if c.schema() != schema {
            return Err(bad());
        }
        Ok(c)
    }

    pub fn id(&self) -> i32 {
        self.id
    }

    pub fn schema(&self) -> String {
        if self.id == 1 {
            "public".to_owned()
        } else {
            format!("c_{}", self.id)
        }
    }

    fn search_path(&self) -> String {
        format!("\"{}\"", self.schema())
    }
}

/// Cấu hình pool.
#[derive(Debug, Clone)]
pub struct DbConfig {
    pub url: String,
    /// Số kết nối tối đa (mặc định 8).
    pub pool_size: u32,
    /// Chờ kết nối rảnh tối đa (mặc định 10 giây).
    pub acquire_timeout: Duration,
    /// `statement_timeout` của mọi phiên (mặc định 30 giây; 0 = không giới hạn).
    pub statement_timeout: Duration,
    /// `MULTI_TENANT=true`.
    pub multi_tenant: bool,
    /// Bản migration tối thiểu một công ty phải có để được phục vụ (mặc định [`LATEST_MIGRATION`]).
    pub required_migration: String,
}

impl DbConfig {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            pool_size: 8,
            acquire_timeout: Duration::from_secs(10),
            statement_timeout: Duration::from_secs(30),
            multi_tenant: false,
            required_migration: LATEST_MIGRATION.to_owned(),
        }
    }

    /// Đọc env. URL: đa công ty theo thứ tự `TENANT_DATABASE_URL`, `DIRECT_DATABASE_URL`, `DATABASE_URL` (như
    /// `clients.ts`); một công ty `DATABASE_URL` rồi `DIRECT_DATABASE_URL`; lấy URL đầu tiên không phải pooler, tất cả
    /// đều là pooler thì lỗi. `DB_POOL_SIZE`, không có mới đọc `PRISMA_CONNECTION_LIMIT`; `DB_ACQUIRE_TIMEOUT_MS`
    /// (phải > 0), `DB_STATEMENT_TIMEOUT_MS` (0 = không giới hạn); `MULTI_TENANT=true`.
    pub fn from_env() -> Result<Self, DbError> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Như [`Self::from_env`] với nguồn biến tuỳ ý (test).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, DbError> {
        let var = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let multi_tenant = get("MULTI_TENANT").as_deref() == Some("true");
        let keys: &[&str] = if multi_tenant {
            &["TENANT_DATABASE_URL", "DIRECT_DATABASE_URL", "DATABASE_URL"]
        } else {
            &["DATABASE_URL", "DIRECT_DATABASE_URL"]
        };
        let urls: Vec<String> = keys.iter().filter_map(|k| var(k)).collect();
        if urls.is_empty() {
            return Err(DbError::MissingUrl);
        }
        let url = urls
            .into_iter()
            .find(|u| !is_pooler_url(u))
            .ok_or(DbError::PoolerUrl { multi_tenant })?;
        let mut cfg = Self::new(url);
        cfg.multi_tenant = multi_tenant;
        let num = |k: &str| -> Result<Option<u64>, DbError> {
            var(k)
                .map(|v| {
                    v.parse::<u64>()
                        .map_err(|_| DbError::Config(format!("{k}={v} không phải số")))
                })
                .transpose()
        };
        let pool_size = match num("DB_POOL_SIZE")? {
            Some(n) => Some(n),
            None => num("PRISMA_CONNECTION_LIMIT")?,
        };
        if let Some(n) = pool_size {
            cfg.pool_size = u32::try_from(n.max(1)).unwrap_or(u32::MAX);
        }
        if let Some(ms) = num("DB_ACQUIRE_TIMEOUT_MS")? {
            if ms == 0 {
                return Err(DbError::Config("DB_ACQUIRE_TIMEOUT_MS phải lớn hơn 0".to_owned()));
            }
            cfg.acquire_timeout = Duration::from_millis(ms);
        }
        if let Some(ms) = num("DB_STATEMENT_TIMEOUT_MS")? {
            cfg.statement_timeout = Duration::from_millis(ms);
        }
        Ok(cfg)
    }

    /// URL kiểu Prisma ⇒ tuỳ chọn kết nối sqlx: từ chối pooler transaction-mode (`pgbouncer=true`, host `-pooler.`)
    /// vì `search_path` theo phiên sẽ bị chia sẻ giữa các client; bỏ tham số riêng của Prisma.
    pub fn connect_options(&self) -> Result<PgConnectOptions, DbError> {
        let (base, query) = self.url.split_once('?').unwrap_or((&self.url, ""));
        let mut kept = Vec::new();
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            match k {
                "pgbouncer" if v == "true" => {
                    return Err(DbError::PoolerUrl {
                        multi_tenant: self.multi_tenant,
                    });
                }
                "schema"
                | "connection_limit"
                | "pool_timeout"
                | "pgbouncer"
                | "socket_timeout"
                | "statement_cache_size" => {}
                _ => kept.push(pair),
            }
        }
        let host = base.split_once("://").map_or(base, |(_, r)| r);
        let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
        let host = host.split(['/', ':']).next().unwrap_or("");
        if host.contains("-pooler.") {
            return Err(DbError::PoolerUrl {
                multi_tenant: self.multi_tenant,
            });
        }
        let url = if kept.is_empty() {
            base.to_owned()
        } else {
            format!("{base}?{}", kept.join("&"))
        };
        let opts: PgConnectOptions = url.parse().map_err(|e: sqlx::Error| DbError::Config(e.to_string()))?;
        let stmt = self.statement_timeout.as_millis().to_string();
        Ok(opts.options([
            ("search_path", NO_COMPANY_SEARCH_PATH),
            ("TimeZone", "UTC"),
            ("statement_timeout", stmt.as_str()),
        ]))
    }
}

struct Inner {
    multi_tenant: bool,
    required_migration: String,
    /// Công ty đã qua cổng và lúc qua (chỉ nhớ kết quả đạt, trong [`GATE_CACHE_TTL`]).
    passed: RwLock<HashMap<i32, Instant>>,
}

/// Pool dùng chung. Clone rẻ.
#[derive(Clone)]
pub struct Db {
    pool: PgPool,
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db")
            .field("multi_tenant", &self.inner.multi_tenant)
            .finish_non_exhaustive()
    }
}

impl Db {
    /// Mở pool (lười: kết nối tạo khi cần).
    pub fn connect_lazy(cfg: &DbConfig) -> Result<Self, DbError> {
        if cfg.acquire_timeout.is_zero() {
            return Err(DbError::Config("acquire_timeout phải lớn hơn 0".to_owned()));
        }
        let pool = PgPoolOptions::new()
            .max_connections(cfg.pool_size)
            .acquire_timeout(cfg.acquire_timeout)
            .after_release(|conn, _meta| {
                Box::pin(async move {
                    // ROLLBACK chỉ khi sqlx biết kết nối còn giao dịch mở: gửi khi không có giao dịch làm Postgres
                    // ghi cảnh báo "there is no transaction in progress" mỗi lần trả kết nối (#572).
                    // RESET ALL: về giá trị của gói khởi
                    // động (schema không tồn tại, UTC, statement_timeout). DISCARD TEMP: bảng tạm của công ty trước
                    // (pg_temp đứng đầu search_path, sẽ che bảng thật của công ty sau). UNLISTEN *: kênh LISTEN.
                    // Không DISCARD ALL: nó xoá cả prepared statement mà statement cache của sqlx đang giữ.
                    // Lỗi ⇒ đóng kết nối.
                    let sql = if sqlx::Connection::is_in_transaction(&*conn) {
                        "ROLLBACK; RESET ALL; DISCARD TEMP; UNLISTEN *; SELECT pg_advisory_unlock_all()"
                    } else {
                        "RESET ALL; DISCARD TEMP; UNLISTEN *; SELECT pg_advisory_unlock_all()"
                    };
                    let ok = sqlx::raw_sql(sql).execute(&mut *conn).await.is_ok();
                    Ok(ok)
                })
            })
            .connect_lazy_with(cfg.connect_options()?);
        Ok(Self {
            pool,
            inner: Arc::new(Inner {
                multi_tenant: cfg.multi_tenant,
                required_migration: cfg.required_migration.clone(),
                passed: RwLock::new(HashMap::new()),
            }),
        })
    }

    /// Mở pool và thử một kết nối ngay (lỗi cấu hình lộ ra lúc khởi động).
    pub async fn connect(cfg: &DbConfig) -> Result<Self, DbError> {
        let db = Self::connect_lazy(cfg)?;
        drop(db.pool.acquire().await?);
        Ok(db)
    }

    pub fn multi_tenant(&self) -> bool {
        self.inner.multi_tenant
    }

    /// Bảng dùng chung (`platform.*`), không gắn công ty.
    pub fn platform(&self) -> PlatformDb {
        PlatformDb {
            pool: self.pool.clone(),
        }
    }

    /// Pool thô, **chỉ** cho migrator và provision (chạy trên kết nối riêng, tự đặt `search_path`).
    pub fn raw_pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// Handle cho một công ty, sau khi qua cổng: bản một công ty chỉ có công ty 1; công ty khác 1 phải có trong
    /// `platform.companies` với `status = 'active'` (như `findActiveCompany`; công ty 1 không có dòng); công ty phải
    /// migrate tới `required_migration` (công ty 1 đọc `public._prisma_migrations` vì `migrated_to` không ghi cho nó;
    /// công ty khác đọc `platform.companies.migrated_to`).
    pub async fn tenant(&self, company: CompanyRef) -> Result<TenantDb, DbError> {
        if !self.inner.multi_tenant && company.id != 1 {
            return Err(DbError::SingleTenant(company.id));
        }
        let cached = self
            .inner
            .passed
            .read()
            .ok()
            .and_then(|m| m.get(&company.id).copied())
            .is_some_and(|t| t.elapsed() < GATE_CACHE_TTL);
        if !cached {
            self.check_company(company).await?;
            if let Ok(mut m) = self.inner.passed.write() {
                m.insert(company.id, Instant::now());
            }
        }
        Ok(TenantDb {
            pool: self.pool.clone(),
            company,
        })
    }

    async fn check_company(&self, company: CompanyRef) -> Result<(), DbError> {
        let mut conn = self.pool.acquire().await?;
        let have: Option<String> = if company.id == 1 {
            latest_applied(&mut conn, "public").await?
        } else {
            let row: Option<(Option<String>, String)> =
                sqlx::query_as("SELECT migrated_to, status FROM platform.companies WHERE id = $1")
                    .bind(company.id)
                    .fetch_optional(&mut *conn)
                    .await?;
            match row {
                None => return Err(DbError::UnknownCompany(company.id)),
                Some((_, status)) if status != "active" => {
                    return Err(DbError::CompanyInactive {
                        company: company.id,
                        status,
                    });
                }
                Some((m, _)) => m,
            }
        };
        let need = &self.inner.required_migration;
        match have {
            Some(h) if h.as_str() >= need.as_str() => Ok(()),
            h => Err(DbError::CompanyNotMigrated {
                company: company.id,
                have: h.unwrap_or_else(|| "(chưa có)".to_owned()),
                need: need.clone(),
            }),
        }
    }
}

/// Tên migration lớn nhất đã chạy xong (không lỗi, không rolled back) trong `<schema>._prisma_migrations`; `None` nếu
/// chưa có bảng hoặc chưa có dòng.
pub(crate) async fn latest_applied(conn: &mut PgConnection, schema: &str) -> Result<Option<String>, DbError> {
    CompanyRef::from_schema(schema)?;
    let exists: bool = sqlx::query_scalar("SELECT to_regclass(format('%I._prisma_migrations', $1::text)) IS NOT NULL")
        .bind(schema)
        .fetch_one(&mut *conn)
        .await?;
    if !exists {
        return Ok(None);
    }
    let sql = format!(
        "SELECT max(migration_name COLLATE \"C\")::text FROM \"{schema}\"._prisma_migrations \
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
    );
    Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(&mut *conn)
        .await?)
}

/// Handle của một công ty: không giữ kết nối. Clone rẻ.
#[derive(Debug, Clone)]
pub struct TenantDb {
    pool: PgPool,
    company: CompanyRef,
}

impl TenantDb {
    pub fn company(&self) -> CompanyRef {
        self.company
    }

    /// Lấy kết nối và đặt `search_path` về đúng schema công ty.
    pub async fn acquire(&self) -> Result<TenantConn, DbError> {
        let mut conn = self.pool.acquire().await?;
        set_search_path(&mut conn, &self.company.search_path()).await?;
        shadow_read_only(&mut conn).await?;
        Ok(TenantConn {
            conn,
            company: self.company,
        })
    }

    /// Mở giao dịch: đặt `search_path` trước rồi mới `BEGIN`.
    pub async fn begin(&self) -> Result<TenantTx, DbError> {
        let mut conn = self.pool.acquire().await?;
        set_search_path(&mut conn, &self.company.search_path()).await?;
        shadow_read_only(&mut conn).await?;
        let tx = Transaction::begin(conn, None).await?;
        Ok(TenantTx {
            tx,
            company: self.company,
        })
    }
}

/// Đang chạy shadow (K28) ⇒ phiên chỉ đọc. Đặt ở mức PHIÊN vì `TenantDb` lấy kết nối theo nhu cầu chứ không bọc cả handler trong
/// một giao dịch; `RESET ALL` của `after_release` trả kết nối về nguyên trạng khi nó quay lại pool.
async fn shadow_read_only(conn: &mut PgConnection) -> Result<(), DbError> {
    if trinity_kernel::shadow::active() {
        sqlx::query("SET default_transaction_read_only = on")
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

async fn set_search_path(conn: &mut PgConnection, value: &str) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('search_path', $1, false)")
        .bind(value)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Kết nối đã gắn một công ty. Dùng như `&mut PgConnection` (`&mut *conn`). Trả về pool khi drop.
#[derive(Debug)]
pub struct TenantConn {
    conn: PoolConnection<Postgres>,
    company: CompanyRef,
}

impl TenantConn {
    pub fn company(&self) -> CompanyRef {
        self.company
    }
}

impl Deref for TenantConn {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        &self.conn
    }
}

impl DerefMut for TenantConn {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.conn
    }
}

/// Giao dịch của một công ty. Drop mà không `commit` ⇒ rollback (sqlx xếp `ROLLBACK`, `after_release` dọn thêm).
#[derive(Debug)]
pub struct TenantTx {
    tx: Transaction<'static, Postgres>,
    company: CompanyRef,
}

impl TenantTx {
    pub fn company(&self) -> CompanyRef {
        self.company
    }

    pub async fn commit(self) -> Result<(), DbError> {
        Ok(self.tx.commit().await?)
    }

    pub async fn rollback(self) -> Result<(), DbError> {
        Ok(self.tx.rollback().await?)
    }
}

impl Deref for TenantTx {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        &self.tx
    }
}

impl DerefMut for TenantTx {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.tx
    }
}

/// Truy cập bảng dùng chung. Kết nối giữ `search_path` không tồn tại: mọi bảng phải viết `platform.<bảng>`.
#[derive(Debug, Clone)]
pub struct PlatformDb {
    pool: PgPool,
}

impl PlatformDb {
    pub async fn acquire(&self) -> Result<PlatformConn, DbError> {
        let mut conn = self.pool.acquire().await?;
        shadow_read_only(&mut conn).await?;
        Ok(PlatformConn { conn })
    }

    pub async fn begin(&self) -> Result<PlatformTx, DbError> {
        let mut conn = self.pool.acquire().await?;
        shadow_read_only(&mut conn).await?;
        Ok(PlatformTx {
            tx: Transaction::begin(conn, None).await?,
        })
    }
}

/// Kết nối không gắn công ty.
#[derive(Debug)]
pub struct PlatformConn {
    conn: PoolConnection<Postgres>,
}

impl Deref for PlatformConn {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        &self.conn
    }
}

impl DerefMut for PlatformConn {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.conn
    }
}

/// Giao dịch không gắn công ty.
#[derive(Debug)]
pub struct PlatformTx {
    tx: Transaction<'static, Postgres>,
}

impl PlatformTx {
    pub async fn commit(self) -> Result<(), DbError> {
        Ok(self.tx.commit().await?)
    }

    pub async fn rollback(self) -> Result<(), DbError> {
        Ok(self.tx.rollback().await?)
    }
}

impl Deref for PlatformTx {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        &self.tx
    }
}

impl DerefMut for PlatformTx {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.tx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_va_schema() {
        assert_eq!(CompanyRef::new(1).unwrap().schema(), "public");
        assert_eq!(CompanyRef::new(42).unwrap().schema(), "c_42");
        assert!(CompanyRef::new(0).is_err());
        assert!(CompanyRef::new(-1).is_err());
        assert!(CompanyRef::new(i64::from(i32::MAX) + 1).is_err());
        assert_eq!(CompanyRef::from_schema("public").unwrap(), CompanyRef::DEFAULT);
        assert_eq!(CompanyRef::from_schema("c_7").unwrap().id(), 7);
        for bad in [
            "c_",
            "c_1",
            "c_07",
            "c_x",
            "C_7",
            "c_-1",
            "pg_catalog",
            "",
            "c_99999999999",
        ] {
            assert!(CompanyRef::from_schema(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tu_choi_pooler_va_bo_tham_so_prisma() {
        let ok = |u: &str| DbConfig::new(u).connect_options();
        assert!(matches!(
            ok("postgresql://u:p@h/db?pgbouncer=true"),
            Err(DbError::PoolerUrl { multi_tenant: false })
        ));
        assert!(matches!(
            ok("postgresql://u:p@ep-x-pooler.neon.tech/db"),
            Err(DbError::PoolerUrl { multi_tenant: false })
        ));
        assert!(ok("postgresql://u:p@h:5432/db?schema=public&connection_limit=5&sslmode=disable").is_ok());
        assert!(ok("postgresql://u:p@h/db?pgbouncer=false").is_ok());
    }

    fn env(pairs: &[(&str, &str)]) -> Result<DbConfig, DbError> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        DbConfig::from_lookup(|k| m.get(k).cloned())
    }

    #[test]
    fn doc_env() {
        const POOLED: &str = "postgresql://u:p@ep-x-pooler.neon.tech/db";
        const DIRECT: &str = "postgresql://u:p@ep-x.neon.tech/db";
        // Một công ty: DATABASE_URL pooled ⇒ dùng DIRECT_DATABASE_URL.
        let c = env(&[("DATABASE_URL", POOLED), ("DIRECT_DATABASE_URL", DIRECT)]).unwrap();
        assert_eq!((c.url.as_str(), c.multi_tenant), (DIRECT, false));
        let e = env(&[("DATABASE_URL", POOLED)]).unwrap_err();
        assert!(matches!(e, DbError::PoolerUrl { multi_tenant: false }));
        assert!(e.to_string().contains("DIRECT_DATABASE_URL") && !e.to_string().contains("Multi-tenant"));
        // Đa công ty: TENANT trước.
        let c = env(&[
            ("MULTI_TENANT", "true"),
            ("DATABASE_URL", POOLED),
            ("TENANT_DATABASE_URL", "postgresql://t/db"),
        ])
        .unwrap();
        assert_eq!(c.url, "postgresql://t/db");
        let e = env(&[("MULTI_TENANT", "true"), ("DATABASE_URL", POOLED)]).unwrap_err();
        assert!(e.to_string().contains("TENANT_DATABASE_URL"));
        assert!(matches!(env(&[]), Err(DbError::MissingUrl)));
        // DB_POOL_SIZE ưu tiên, PRISMA_CONNECTION_LIMIT hỏng không làm lỗi khi đã có DB_POOL_SIZE.
        let c = env(&[
            ("DATABASE_URL", DIRECT),
            ("DB_POOL_SIZE", "4"),
            ("PRISMA_CONNECTION_LIMIT", "x"),
        ])
        .unwrap();
        assert_eq!(c.pool_size, 4);
        let c = env(&[("DATABASE_URL", DIRECT), ("PRISMA_CONNECTION_LIMIT", "3")]).unwrap();
        assert_eq!(c.pool_size, 3);
        assert!(env(&[("DATABASE_URL", DIRECT), ("DB_POOL_SIZE", "x")]).is_err());
        assert!(env(&[("DATABASE_URL", DIRECT), ("DB_ACQUIRE_TIMEOUT_MS", "0")]).is_err());
        let c = env(&[("DATABASE_URL", DIRECT), ("DB_STATEMENT_TIMEOUT_MS", "0")]).unwrap();
        assert!(c.statement_timeout.is_zero());
    }

    #[test]
    fn latest_migration_co_gia_tri() {
        assert!(LATEST_MIGRATION.len() > 4 && LATEST_MIGRATION.as_bytes()[..4].iter().all(u8::is_ascii_digit));
    }
}
