//! Schema `platform`: bảng dùng chung cho mọi công ty (PLAN 1.5, 4.5; issue K08). Chuyển nguyên SQL từ
//! `packages/prisma/src/tenant/platform.ts`, giữ nguyên số advisory lock và phiên bản trigger.
//!
//! - `companies`: mỗi công ty một dòng; công ty 1 = dữ liệu có trước đa công ty (schema `public`). Cột khoá kênh
//!   (`channels_locked`, lý do, giờ) là công tắc của chủ nền tảng.
//! - `company_logins`: email → công ty (một email thuộc đúng một công ty; đăng nhập tra ở đây).
//! - `company_routes`: mã ngoài → công ty: Page Facebook, OA Zalo (webhook định tuyến theo bảng này), `state` OAuth
//!   đang mở, gian hàng Shopee/Lazada, địa chỉ trang bán hàng.
//!
//! `company_logins`/`company_routes` (Page, OA) được trigger trong **mỗi** schema công ty giữ đồng bộ
//! ([`SYNC_TRIGGER_VERSION`]); khoá chính làm công ty thứ hai nhận cùng email/Page lỗi ngay ở DB
//! (`TRINITY_EMAIL_TAKEN`, `TRINITY_ROUTE_TAKEN`, câu trả cho người dùng: [`conflict_from_trigger`]).
//!
//! Bản một công ty (`MULTI_TENANT` khác `true`) không có schema này: mọi tra cứu trả công ty 1, như bản Node.
//! Truy vấn ở đây không dùng macro `query!`: schema `platform` không do migration Prisma tạo nên
//! `cargo sqlx prepare` không thấy; mọi câu có test pg (`tests/platform.rs`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sqlx::{AssertSqlSafe, PgConnection};

use crate::tenant::{CompanyRef, Db, DbError, PlatformDb};

/// Đổi mỗi khi hàm trigger bên dưới đổi. Lúc boot chỉ cài lại trigger ở schema thiếu bản này, nên khởi động bình
/// thường không khoá bảng nào.
pub const SYNC_TRIGGER_VERSION: &str = "trinity-sync-v3";
/// Advisory lock (mức giao dịch) của `ensure` và cài trigger: nhiều tiến trình boot cùng lúc xếp hàng ở đây.
pub const PLATFORM_LOCK: i64 = 726_354_001;
/// Advisory lock của đăng ký công ty theo email (`provision.ts`, K09).
pub const SIGNUP_LOCK: i64 = 726_354_002;

/// Tên công ty 1 khi không đặt `DEFAULT_COMPANY_NAME`.
pub const DEFAULT_COMPANY_NAME: &str = "Công ty mặc định";

const COMPANY_CACHE_TTL: Duration = Duration::from_secs(30);
const LOCK_CACHE_TTL: Duration = Duration::from_secs(10);
const DEFAULT_LOCK_REASON: &str = "Chủ nền tảng tạm khoá kênh gửi ra ngoài";

/// Câu 409 của `elk-exception.filter.ts` khi trigger ném `TRINITY_EMAIL_TAKEN`.
pub const EMAIL_TAKEN_TRIGGER_MESSAGE: &str = "Email này đã được dùng cho một công ty khác trên Trinity";
/// Câu 409 của `elk-exception.filter.ts` khi trigger ném `TRINITY_ROUTE_TAKEN`.
pub const ROUTE_TAKEN_TRIGGER_MESSAGE: &str = "Trang/kênh này đã được một công ty khác kết nối với Trinity";

/// Loại mã ngoài trong `platform.company_routes.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RouteKind {
    FacebookPage,
    ZaloOa,
    OauthState,
    ShopeeShop,
    LazadaSeller,
    StoreSlug,
}

impl RouteKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FacebookPage => "facebook_page",
            Self::ZaloOa => "zalo_oa",
            Self::OauthState => "oauth_state",
            Self::ShopeeShop => "shopee_shop",
            Self::LazadaSeller => "lazada_seller",
            Self::StoreSlug => "store_slug",
        }
    }

    /// Câu 409 khi công ty khác đã giữ mã này (`assertRouteAvailableForCurrentCompany`, `claimCompanyRoute`).
    pub fn taken_message(self) -> &'static str {
        match self {
            Self::FacebookPage => "Trang Facebook này đã được một công ty khác kết nối với Trinity",
            Self::ZaloOa => "Zalo OA này đã được một công ty khác kết nối với Trinity",
            Self::ShopeeShop => "Gian hàng Shopee này đã được một công ty khác kết nối với Trinity",
            Self::LazadaSeller => "Tài khoản Lazada này đã được một công ty khác kết nối với Trinity",
            Self::StoreSlug => "Địa chỉ trang bán hàng này đã có công ty khác dùng — chọn địa chỉ khác",
            Self::OauthState => ROUTE_TAKEN_TRIGGER_MESSAGE,
        }
    }

    /// Loại mà [`Platform::claim_route`] nhận: mã có thể bị bỏ rơi (ngắt kết nối, đổi slug).
    fn claimable(self) -> bool {
        matches!(self, Self::ShopeeShop | Self::LazadaSeller | Self::StoreSlug)
    }
}

/// Lỗi của các hàm platform.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    /// HTTP 409 (`ConflictException`) với đúng câu này.
    #[error("{0}")]
    Conflict(&'static str),
    #[error("Khoá kênh chỉ có khi MULTI_TENANT=true")]
    NotMultiTenant,
    #[error("Loại {0:?} không nhận/nhả được bằng hàm này")]
    WrongKind(RouteKind),
    #[error(transparent)]
    Db(#[from] DbError),
}

impl From<sqlx::Error> for PlatformError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e.into())
    }
}

/// Lỗi trigger đồng bộ ⇒ câu 409, như `mapPrismaError` của `elk-exception.filter.ts` (tìm chuỗi trong thông báo
/// lỗi). Lỗi khác ⇒ `None`. Dùng cho mọi lệnh ghi `users`, `facebook_pages`, `zalo_oa_connections` của công ty.
pub fn conflict_from_trigger(e: &sqlx::Error) -> Option<&'static str> {
    let msg = match e {
        sqlx::Error::Database(d) => d.message().to_owned(),
        other => other.to_string(),
    };
    if msg.contains("TRINITY_EMAIL_TAKEN") {
        Some(EMAIL_TAKEN_TRIGGER_MESSAGE)
    } else if msg.contains("TRINITY_ROUTE_TAKEN") {
        Some(ROUTE_TAKEN_TRIGGER_MESSAGE)
    } else {
        None
    }
}

/// Một dòng `platform.companies`.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct CompanyRow {
    pub id: i32,
    pub name: String,
    pub schema_name: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

/// Công tắc khoá kênh của một công ty.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChannelLock {
    pub locked: bool,
    pub reason: Option<String>,
    pub locked_at: Option<DateTime<Utc>>,
}

/// Một dòng của [`Platform::list_channel_locks`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyChannelLock {
    pub id: i32,
    pub name: String,
    pub status: String,
    pub lock: ChannelLock,
}

// ------------------------------------------------------------------------------------------------- DDL

/// Nguyên văn `PLATFORM_DDL` của bản Node (thứ tự cột phải giữ để `schema.sql` khớp).
const PLATFORM_DDL: &[&str] = &[
    "CREATE SCHEMA IF NOT EXISTS platform",
    "CREATE TABLE IF NOT EXISTS platform.companies (
     id serial PRIMARY KEY,
     name varchar(200) NOT NULL,
     schema_name varchar(63) NOT NULL UNIQUE,
     status varchar(20) NOT NULL DEFAULT 'active',
     created_at timestamptz NOT NULL DEFAULT now(),
     migrated_to varchar(255)
   )",
    "ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS channels_locked boolean NOT NULL DEFAULT false",
    "ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS channels_lock_reason text",
    "ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS channels_locked_at timestamptz",
    "CREATE TABLE IF NOT EXISTS platform.company_logins (
     email varchar(255) PRIMARY KEY,
     company_id int NOT NULL REFERENCES platform.companies(id)
   )",
    "CREATE INDEX IF NOT EXISTS company_logins_company_idx ON platform.company_logins(company_id)",
    "CREATE TABLE IF NOT EXISTS platform.company_routes (
     kind varchar(32) NOT NULL,
     external_id varchar(255) NOT NULL,
     company_id int NOT NULL REFERENCES platform.companies(id),
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (kind, external_id)
   )",
];

/// Bảng công ty có trigger đồng bộ mã ngoài (bảng, cột, loại).
const ROUTE_TRIGGERS: [(&str, &str, RouteKind); 2] = [
    ("facebook_pages", "page_id", RouteKind::FacebookPage),
    ("zalo_oa_connections", "oa_id", RouteKind::ZaloOa),
];

/// "Schema `c.schema_name` có trigger bản hiện tại": hàm mang comment phiên bản VÀ trigger còn gắn vào `users`
/// (trigger bị drop thì cài lại). `$2` = phiên bản.
const TRIGGERS_CURRENT_SQL: &str = "WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = c.schema_name AND p.proname = 'trinity_platform_sync_login'
                      AND obj_description(p.oid, 'pg_proc') = $2)
     AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
                    WHERE n.nspname = c.schema_name AND r.relname = 'users' AND t.tgname = 'trinity_platform_sync_login')";

/// `quoteIdent` của bản Node: chỉ `^[a-z_][a-z0-9_]*$`.
fn quote_ident(s: &str) -> Result<String, DbError> {
    let mut bytes = s.bytes();
    let ok = matches!(bytes.next(), Some(b'a'..=b'z' | b'_'))
        && bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'));
    if ok {
        Ok(format!("\"{s}\""))
    } else {
        Err(DbError::InvalidSchema(s.to_owned()))
    }
}

async fn exec(conn: &mut PgConnection, sql: String) -> Result<u64, sqlx::Error> {
    Ok(sqlx::raw_sql(AssertSqlSafe(sql)).execute(conn).await?.rows_affected())
}

async fn lock(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PLATFORM_LOCK)
        .execute(conn)
        .await?;
    Ok(())
}

/// Schema của công ty có trigger bản hiện tại chưa.
async fn sync_triggers_installed(conn: &mut PgConnection, schema: &str) -> Result<bool, sqlx::Error> {
    let sql = format!("SELECT 1 AS ok {}", TRIGGERS_CURRENT_SQL.replace("c.schema_name", "$1"));
    let row: Option<i32> = sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(schema)
        .bind(SYNC_TRIGGER_VERSION)
        .fetch_optional(conn)
        .await?;
    Ok(row.is_some())
}

/// Cài trigger đồng bộ `users.email` → `company_logins` và Page/OA → `company_routes` vào schema của một công ty
/// (`installSyncTriggers`). Chạy trong giao dịch của người gọi; provision (K09) gọi sau khi migrate schema mới.
pub async fn install_sync_triggers(conn: &mut PgConnection, company: CompanyRef) -> Result<(), DbError> {
    let s = quote_ident(&company.schema())?;
    let id = company.id();
    exec(
        conn,
        format!(
            r#"
    CREATE OR REPLACE FUNCTION {s}.trinity_platform_sync_login() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM platform.company_logins WHERE email = lower(OLD.email) AND company_id = {id};
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO platform.company_logins (email, company_id) VALUES (lower(NEW.email), {id})
        ON CONFLICT (email) DO UPDATE SET company_id = EXCLUDED.company_id
          WHERE platform.company_logins.company_id = {id};
        IF NOT EXISTS (SELECT 1 FROM platform.company_logins WHERE email = lower(NEW.email) AND company_id = {id}) THEN
          RAISE EXCEPTION 'TRINITY_EMAIL_TAKEN: % already belongs to another company', NEW.email;
        END IF;
      END IF;
      RETURN NULL;
    END $fn$"#
        ),
    )
    .await?;
    exec(
        conn,
        format!("COMMENT ON FUNCTION {s}.trinity_platform_sync_login() IS '{SYNC_TRIGGER_VERSION}'"),
    )
    .await?;
    exec(
        conn,
        format!("DROP TRIGGER IF EXISTS trinity_platform_sync_login ON {s}.users"),
    )
    .await?;
    exec(
        conn,
        format!(
            "
    CREATE TRIGGER trinity_platform_sync_login AFTER INSERT OR DELETE OR UPDATE OF email ON {s}.users
    FOR EACH ROW EXECUTE FUNCTION {s}.trinity_platform_sync_login()"
        ),
    )
    .await?;

    // Bản cũ giữ một người dùng mỗi công ty bằng trigger; giờ giới hạn là `maxUsers` của gói, kiểm ở máy chủ.
    exec(conn, format!("DROP TRIGGER IF EXISTS trinity_single_user ON {s}.users")).await?;
    exec(conn, format!("DROP FUNCTION IF EXISTS {s}.trinity_single_user()")).await?;

    for (table, column, kind) in ROUTE_TRIGGERS {
        let kind = kind.as_str();
        let func = format!("trinity_platform_sync_{kind}");
        let col = quote_ident(column)?;
        let table = quote_ident(table)?;
        exec(
            conn,
            format!(
                r#"
      CREATE OR REPLACE FUNCTION {s}.{func}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          DELETE FROM platform.company_routes WHERE kind = '{kind}' AND external_id = OLD.{col} AND company_id = {id};
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('{kind}', NEW.{col}, {id})
          ON CONFLICT (kind, external_id) DO NOTHING;
          IF NOT EXISTS (SELECT 1 FROM platform.company_routes
                         WHERE kind = '{kind}' AND external_id = NEW.{col} AND company_id = {id}) THEN
            RAISE EXCEPTION 'TRINITY_ROUTE_TAKEN: {kind} % is connected to another company', NEW.{col};
          END IF;
        END IF;
        RETURN NULL;
      END $fn$"#
            ),
        )
        .await?;
        exec(conn, format!("DROP TRIGGER IF EXISTS {func} ON {s}.{table}")).await?;
        exec(
            conn,
            format!(
                "
      CREATE TRIGGER {func} AFTER INSERT OR DELETE OR UPDATE OF {col} ON {s}.{table}
      FOR EACH ROW EXECUTE FUNCTION {s}.{func}()"
            ),
        )
        .await?;
    }
    Ok(())
}

/// SQL: schema `s` còn kết nối/trang bán hàng đang dùng mã này không (`$1` = mã).
fn backed_by_sql(s: &str, kind: RouteKind) -> String {
    match kind {
        RouteKind::ShopeeShop => format!(
            "SELECT 1 FROM {s}.connector_accounts WHERE provider = 'shopee' AND status <> 'disconnected' AND settings->>'shop_id' = $1"
        ),
        RouteKind::LazadaSeller => format!(
            "SELECT 1 FROM {s}.connector_accounts WHERE provider = 'lazada' AND status <> 'disconnected' AND settings->>'seller_id' = $1"
        ),
        _ => format!(
            "SELECT 1 FROM {s}.settings WHERE key = 'online_store' AND lower(trim((value::json)->>'slug')) = $1"
        ),
    }
}

/// `str.slice(0, n)` của JS: cắt theo đơn vị UTF-16, không cắt đôi ký tự (JS để lại nửa cặp surrogate, Postgres
/// không nhận được chuỗi đó nên mã ngoài kiểu này vốn không lưu được).
fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// `String.prototype.trim` của JS: khoảng trắng Unicode và BOM.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

// ------------------------------------------------------------------------------------------------- Platform

struct Caches {
    companies: Mutex<HashMap<i32, (Option<CompanyRow>, Instant)>>,
    locks: Mutex<HashMap<i32, (ChannelLock, Instant)>>,
}

/// Truy cập schema `platform`, kèm cache như bản Node (công ty 30 giây, khoá kênh 10 giây). Clone rẻ; tạo **một**
/// bản mỗi tiến trình để cache dùng chung.
#[derive(Clone)]
pub struct Platform {
    db: PlatformDb,
    multi_tenant: bool,
    default_name: String,
    ensured: Arc<AtomicBool>,
    caches: Arc<Caches>,
}

impl std::fmt::Debug for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Platform")
            .field("multi_tenant", &self.multi_tenant)
            .finish_non_exhaustive()
    }
}

impl Platform {
    /// `default_company_name`: env `DEFAULT_COMPANY_NAME` (rỗng/thiếu ⇒ [`DEFAULT_COMPANY_NAME`]).
    pub fn new(db: &Db, default_company_name: Option<&str>) -> Self {
        let name = default_company_name.map(js_trim).filter(|n| !n.is_empty());
        Self {
            db: db.platform(),
            multi_tenant: db.multi_tenant(),
            default_name: name.unwrap_or(DEFAULT_COMPANY_NAME).to_owned(),
            ensured: Arc::new(AtomicBool::new(false)),
            caches: Arc::new(Caches {
                companies: Mutex::new(HashMap::new()),
                locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn multi_tenant(&self) -> bool {
        self.multi_tenant
    }

    /// Tạo schema `platform`, ghi công ty 1, cài trigger đồng bộ (`ensurePlatform`). Gọi lại bao nhiêu lần cũng được;
    /// trong một tiến trình chỉ chạy tới khi thành công một lần. Bản một công ty: không làm gì.
    pub async fn ensure(&self) -> Result<(), DbError> {
        if !self.multi_tenant || self.ensured.load(Ordering::Acquire) {
            return Ok(());
        }
        self.do_ensure().await?;
        self.ensured.store(true, Ordering::Release);
        Ok(())
    }

    async fn do_ensure(&self) -> Result<(), DbError> {
        let mut tx = self.db.begin().await?;
        // Nhiều tiến trình có thể boot cùng lúc.
        lock(&mut tx).await?;
        for stmt in PLATFORM_DDL {
            exec(&mut tx, (*stmt).to_owned()).await?;
        }
        let created = sqlx::query(
            "INSERT INTO platform.companies (id, name, schema_name) VALUES (1, $1, 'public') ON CONFLICT (id) DO NOTHING",
        )
        .bind(&self.default_name)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
        // Từ đây trigger trên `public` giữ logins/routes đồng bộ; phần chép bù chỉ chạy lần boot đầu (hoặc sửa khi
        // trigger của công ty 1 bị mất).
        if created || !sync_triggers_installed(&mut tx, "public").await? {
            exec(
                &mut tx,
                "SELECT setval(pg_get_serial_sequence('platform.companies', 'id'), GREATEST((SELECT max(id) FROM platform.companies), 1))".to_owned(),
            )
            .await?;
            // Người dùng và Page/OA có sẵn của công ty 1 (có trước trigger).
            exec(
                &mut tx,
                "INSERT INTO platform.company_logins (email, company_id)
           SELECT DISTINCT lower(email), 1 FROM public.users ON CONFLICT DO NOTHING"
                    .to_owned(),
            )
            .await?;
            for (table, column, kind) in ROUTE_TRIGGERS {
                let sql = format!(
                    "INSERT INTO platform.company_routes (kind, external_id, company_id)
             SELECT DISTINCT $1, {}, 1 FROM public.{}
           ON CONFLICT DO NOTHING",
                    quote_ident(column)?,
                    quote_ident(table)?
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(kind.as_str())
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;

        // Trigger: mỗi công ty cần cài (phiên bản mới hoặc schema mới) một giao dịch ngắn, để đổi phiên bản trên bản
        // cài lớn không vượt thời hạn một giao dịch. Các tiến trình boot cùng lúc xếp hàng trên cùng khoá.
        let sql = format!(
            "SELECT c.id, c.schema_name FROM platform.companies c
      WHERE EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = c.schema_name AND t.table_name = 'users')
        AND NOT EXISTS (SELECT 1 {})
      ORDER BY c.id",
            TRIGGERS_CURRENT_SQL.replacen("$2", "$1", 1)
        );
        let rows: Vec<(i32, String)> = {
            let mut conn = self.db.acquire().await?;
            sqlx::query_as(AssertSqlSafe(sql))
                .bind(SYNC_TRIGGER_VERSION)
                .fetch_all(&mut *conn)
                .await?
        };
        for (id, schema) in rows {
            let company = CompanyRef::new(i64::from(id))?;
            if company.schema() != schema {
                return Err(DbError::InvalidSchema(schema));
            }
            let mut tx = self.db.begin().await?;
            lock(&mut tx).await?;
            if !sync_triggers_installed(&mut tx, &schema).await? {
                install_sync_triggers(&mut tx, company).await?;
            }
            tx.commit().await?;
        }
        if let Err(e) = self.backfill_setting_routes().await {
            tracing::warn!("platform: backfill routes failed: {e}");
        }
        Ok(())
    }

    /// Mã có trước luật nhận mã: slug trang bán hàng và gian hàng Shopee/Lazada đang kết nối trong schema công ty
    /// được ghi (công ty id nhỏ hơn thắng), để công ty mới hơn không chiếm được. Idempotent; schema có bảng hoặc
    /// JSON không đọc được thì bỏ qua (`backfillSettingRoutes`).
    pub async fn backfill_setting_routes(&self) -> Result<(), DbError> {
        let mut conn = self.db.acquire().await?;
        let companies: Vec<(i32, String)> =
            sqlx::query_as("SELECT id, schema_name FROM platform.companies ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
        for (id, schema) in companies {
            let s = quote_ident(&schema)?;
            let statements = [
                (
                    RouteKind::StoreSlug,
                    format!(
                        "SELECT lower(trim(((value::json)->>'slug'))) AS ext FROM {s}.settings WHERE key = 'online_store'"
                    ),
                ),
                (
                    RouteKind::ShopeeShop,
                    format!(
                        "SELECT (settings->>'shop_id') AS ext FROM {s}.connector_accounts WHERE provider = 'shopee' AND status <> 'disconnected'"
                    ),
                ),
                (
                    RouteKind::LazadaSeller,
                    format!(
                        "SELECT (settings->>'seller_id') AS ext FROM {s}.connector_accounts WHERE provider = 'lazada' AND status <> 'disconnected'"
                    ),
                ),
            ];
            for (kind, select) in statements {
                let k = kind.as_str();
                // Trước hết là mã mồ côi: công ty này giữ nhưng không còn kết nối/trang bán hàng nào dùng.
                let orphans = format!(
                    "DELETE FROM platform.company_routes r WHERE r.kind = '{k}' AND r.company_id = {id} AND r.created_at < now() - interval '2 minutes'
             AND NOT EXISTS ({})",
                    backed_by_sql(&s, kind).replacen("= $1", "= r.external_id", 1)
                );
                let insert = format!(
                    "INSERT INTO platform.company_routes (kind, external_id, company_id)
             SELECT '{k}', ext, {id} FROM ({select}) q WHERE ext IS NOT NULL AND ext <> ''
           ON CONFLICT (kind, external_id) DO NOTHING"
                );
                // Bảng hoặc cột chưa có (schema chưa migrate): không có gì để chép bù.
                if exec(&mut conn, orphans).await.is_ok() {
                    let _ = exec(&mut conn, insert).await;
                }
            }
        }
        Ok(())
    }

    // --------------------------------------------------------------------------------------------- tra cứu

    /// Một công ty theo id (cache 30 giây). Bản một công ty: chỉ có công ty 1.
    pub async fn company(&self, id: i32) -> Result<Option<CompanyRow>, DbError> {
        if !self.multi_tenant {
            return Ok((id == 1).then(|| CompanyRow {
                id: 1,
                name: self.default_name.clone(),
                schema_name: "public".to_owned(),
                status: "active".to_owned(),
                created_at: DateTime::<Utc>::UNIX_EPOCH,
            }));
        }
        if let Some((row, at)) = self.caches.companies.lock().ok().and_then(|m| m.get(&id).cloned())
            && at.elapsed() < COMPANY_CACHE_TTL
        {
            return Ok(row);
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        let row: Option<CompanyRow> =
            sqlx::query_as("SELECT id, name, schema_name, status, created_at FROM platform.companies WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?;
        if let Ok(mut m) = self.caches.companies.lock() {
            m.insert(id, (row.clone(), Instant::now()));
        }
        Ok(row)
    }

    /// Quên cache công ty (`None` = tất cả).
    pub fn forget_company(&self, id: Option<i32>) {
        if let Ok(mut m) = self.caches.companies.lock() {
            match id {
                Some(id) => {
                    m.remove(&id);
                }
                None => m.clear(),
            }
        }
    }

    /// Công ty đang hoạt động theo id; không có hoặc bị treo ⇒ `None` (`activeCompanyRef`).
    pub async fn active_company(&self, id: i64) -> Result<Option<CompanyRef>, DbError> {
        let Ok(id) = i32::try_from(id) else { return Ok(None) };
        if id < 1 {
            return Ok(None);
        }
        Ok(match self.company(id).await? {
            Some(row) if row.status == "active" => Some(CompanyRef::from_schema(&row.schema_name)?),
            _ => None,
        })
    }

    /// Mọi công ty đang hoạt động, theo id.
    pub async fn list_active_companies(&self) -> Result<Vec<CompanyRef>, DbError> {
        if !self.multi_tenant {
            return Ok(vec![CompanyRef::DEFAULT]);
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        let rows: Vec<String> =
            sqlx::query_scalar("SELECT schema_name FROM platform.companies WHERE status = 'active' ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
        rows.iter().map(|s| CompanyRef::from_schema(s)).collect()
    }

    /// Công ty sở hữu email (đăng nhập). Bản một công ty: luôn 1.
    pub async fn company_for_email(&self, email: &str) -> Result<Option<i32>, DbError> {
        if !self.multi_tenant {
            return Ok(Some(1));
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        Ok(
            sqlx::query_scalar("SELECT company_id FROM platform.company_logins WHERE email = lower($1)")
                .bind(js_trim(email))
                .fetch_optional(&mut *conn)
                .await?,
        )
    }

    /// Công ty giữ mã ngoài (webhook Page/OA, callback OAuth…). Bản một công ty: luôn 1.
    pub async fn company_for_route(&self, kind: RouteKind, external_id: &str) -> Result<Option<i32>, DbError> {
        if !self.multi_tenant {
            return Ok(Some(1));
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        Ok(
            sqlx::query_scalar("SELECT company_id FROM platform.company_routes WHERE kind = $1 AND external_id = $2")
                .bind(kind.as_str())
                .bind(external_id)
                .fetch_optional(&mut *conn)
                .await?,
        )
    }

    /// Kiểm trước khi tạo người dùng: email không được thuộc công ty khác (`assertEmailAvailableForCurrentCompany`).
    pub async fn assert_email_available(&self, email: &str, current: CompanyRef) -> Result<(), PlatformError> {
        if !self.multi_tenant {
            return Ok(());
        }
        match self.company_for_email(email).await? {
            Some(owner) if owner != current.id() => Err(PlatformError::Conflict(
                "Email này đã được dùng cho một công ty khác trên Trinity",
            )),
            _ => Ok(()),
        }
    }

    /// Kiểm trước khi kết nối Page Facebook / OA Zalo: một Page/OA một công ty.
    pub async fn assert_route_available(
        &self,
        kind: RouteKind,
        external_id: &str,
        current: CompanyRef,
    ) -> Result<(), PlatformError> {
        if !matches!(kind, RouteKind::FacebookPage | RouteKind::ZaloOa) {
            return Err(PlatformError::WrongKind(kind));
        }
        if !self.multi_tenant {
            return Ok(());
        }
        match self.company_for_route(kind, external_id).await? {
            Some(owner) if owner != current.id() => Err(PlatformError::Conflict(kind.taken_message())),
            _ => Ok(()),
        }
    }

    /// Luồng kết nối OAuth: nhà cung cấp gọi lại callback công khai chỉ với `state`; nhớ công ty mở luồng để callback
    /// chạy đúng công ty. Xoá luôn `state` cũ hơn một ngày (`rememberOauthState`).
    pub async fn remember_oauth_state(&self, state: &str, current: CompanyRef) -> Result<(), DbError> {
        if !self.multi_tenant || state.is_empty() {
            return Ok(());
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        sqlx::query(
            "INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('oauth_state', $1, $2)
     ON CONFLICT (kind, external_id) DO NOTHING",
        )
        .bind(js_slice(state, 255))
        .bind(current.id())
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "DELETE FROM platform.company_routes WHERE kind = 'oauth_state' AND created_at < now() - interval '1 day'",
        )
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    /// Công ty đã mở luồng OAuth có `state` này.
    pub async fn company_for_oauth_state(&self, state: &str) -> Result<Option<i32>, DbError> {
        if state.is_empty() {
            return Ok(None);
        }
        self.company_for_route(RouteKind::OauthState, js_slice(state, 255))
            .await
    }

    /// Nhận mã ngoài (gian hàng Shopee/Lazada, slug trang bán hàng) cho công ty hiện tại; công ty đầu tiên thắng. Nhận
    /// lại mã của mình thì không làm gì. Mã của công ty khác mà công ty đó không còn dùng (mồ côi, nhận quá 2 phút)
    /// thì chuyển sang (`claimCompanyRoute`).
    pub async fn claim_route(
        &self,
        kind: RouteKind,
        external_id: &str,
        current: CompanyRef,
    ) -> Result<(), PlatformError> {
        if !kind.claimable() {
            return Err(PlatformError::WrongKind(kind));
        }
        if !self.multi_tenant || external_id.is_empty() {
            return Ok(());
        }
        self.ensure().await?;
        let sliced = js_slice(external_id, 255);
        let id = if kind == RouteKind::StoreSlug {
            sliced.to_lowercase()
        } else {
            sliced.to_owned()
        };
        let me = current.id();
        {
            let mut conn = self.db.acquire().await?;
            sqlx::query(
                "INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ($1, $2, $3)
       ON CONFLICT (kind, external_id) DO NOTHING",
            )
            .bind(kind.as_str())
            .bind(&id)
            .bind(me)
            .execute(&mut *conn)
            .await?;
        }
        let mut owner = self.company_for_route(kind, &id).await?;
        if let Some(holder) = owner.filter(|&o| o != me)
            && !self.holder_still_uses_route(holder, kind, &id).await?
        {
            {
                // Bên giữ không còn kết nối/trang bán hàng nào dùng mã này: mã mồ côi, không được chặn chủ thật.
                // Nguyên tử: chỉ khi vẫn của bên giữ và không vừa được nhận trong 2 phút (nhận trước khi lưu dòng
                // kết nối/trang bán hàng).
                let mut conn = self.db.acquire().await?;
                sqlx::query(
                    "UPDATE platform.company_routes SET company_id = $4, created_at = now() WHERE kind = $1 AND external_id = $2 AND company_id = $3
          AND created_at < now() - interval '2 minutes'",
                )
                .bind(kind.as_str())
                .bind(&id)
                .bind(holder)
                .bind(me)
                .execute(&mut *conn)
                .await?;
                drop(conn);
                owner = self.company_for_route(kind, &id).await?;
            }
        }
        match owner {
            Some(o) if o != me => Err(PlatformError::Conflict(kind.taken_message())),
            _ => Ok(()),
        }
    }

    /// Đúng trừ khi công ty giữ đã mất hoặc chắc chắn không còn kết nối/trang bán hàng dùng mã này. Không đọc được
    /// (thiếu bảng, JSON hỏng) tính là "còn dùng": không bao giờ chiếm mã khi còn nghi.
    async fn holder_still_uses_route(&self, holder: i32, kind: RouteKind, id: &str) -> Result<bool, DbError> {
        let mut conn = self.db.acquire().await?;
        let schema: Option<String> = sqlx::query_scalar("SELECT schema_name FROM platform.companies WHERE id = $1")
            .bind(holder)
            .fetch_optional(&mut *conn)
            .await?;
        let Some(schema) = schema else { return Ok(false) };
        let Ok(s) = quote_ident(&schema) else { return Ok(true) };
        let hit: Result<Option<i32>, _> = sqlx::query_scalar(AssertSqlSafe(backed_by_sql(&s, kind)))
            .bind(id)
            .fetch_optional(&mut *conn)
            .await;
        Ok(hit.map_or(true, |h| h.is_some()))
    }

    /// Nhả mã công ty hiện tại đang giữ (đổi slug, ngắt gian hàng). Không bao giờ đụng mã của công ty khác.
    pub async fn release_route(
        &self,
        kind: RouteKind,
        external_id: &str,
        current: CompanyRef,
    ) -> Result<(), PlatformError> {
        if !kind.claimable() {
            return Err(PlatformError::WrongKind(kind));
        }
        if !self.multi_tenant || external_id.is_empty() {
            return Ok(());
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        sqlx::query("DELETE FROM platform.company_routes WHERE kind = $1 AND external_id = $2 AND company_id = $3")
            .bind(kind.as_str())
            .bind(js_slice(external_id, 255))
            .bind(current.id())
            .execute(&mut *conn)
            .await?;
        Ok(())
    }

    // --------------------------------------------------------------------------------------------- khoá kênh

    /// Công tắc khoá kênh của một công ty (cache 10 giây). Bản một công ty không có công tắc: không bao giờ khoá.
    pub async fn channel_lock(&self, company_id: i32) -> Result<ChannelLock, DbError> {
        if !self.multi_tenant {
            return Ok(ChannelLock::default());
        }
        if let Some((v, at)) = self.caches.locks.lock().ok().and_then(|m| m.get(&company_id).cloned())
            && at.elapsed() < LOCK_CACHE_TTL
        {
            return Ok(v);
        }
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        let row: Option<(bool, Option<String>, Option<DateTime<Utc>>)> = sqlx::query_as(
            "SELECT channels_locked, channels_lock_reason, channels_locked_at FROM platform.companies WHERE id = $1",
        )
        .bind(company_id)
        .fetch_optional(&mut *conn)
        .await?;
        let v = row.map_or_else(ChannelLock::default, |(locked, reason, locked_at)| ChannelLock {
            locked,
            reason,
            locked_at,
        });
        if let Ok(mut m) = self.caches.locks.lock() {
            m.insert(company_id, (v.clone(), Instant::now()));
        }
        Ok(v)
    }

    /// Khoá/mở kênh gửi ra ngoài của một công ty (chủ nền tảng; CLI `channel:lock`). `false` nếu không có công ty.
    pub async fn set_channel_lock(
        &self,
        company_id: i32,
        locked: bool,
        reason: Option<&str>,
    ) -> Result<bool, PlatformError> {
        if !self.multi_tenant {
            return Err(PlatformError::NotMultiTenant);
        }
        self.ensure().await?;
        let reason = locked.then(|| {
            let r = reason
                .map(js_trim)
                .filter(|r| !r.is_empty())
                .unwrap_or(DEFAULT_LOCK_REASON);
            js_slice(r, 500).to_owned()
        });
        let mut conn = self.db.acquire().await?;
        let n = sqlx::query(
            "UPDATE platform.companies
        SET channels_locked = $2,
            channels_lock_reason = $3,
            channels_locked_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = $1",
        )
        .bind(company_id)
        .bind(locked)
        .bind(reason)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        if let Ok(mut m) = self.caches.locks.lock() {
            m.remove(&company_id);
        }
        Ok(n > 0)
    }

    /// Mọi công ty kèm trạng thái khoá kênh (CLI).
    pub async fn list_channel_locks(&self) -> Result<Vec<CompanyChannelLock>, DbError> {
        self.ensure().await?;
        let mut conn = self.db.acquire().await?;
        type Row = (i32, String, String, bool, Option<String>, Option<DateTime<Utc>>);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, name, status, channels_locked, channels_lock_reason, channels_locked_at FROM platform.companies ORDER BY id",
        )
        .fetch_all(&mut *conn)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, name, status, locked, reason, locked_at)| CompanyChannelLock {
                id,
                name,
                status,
                lock: ChannelLock {
                    locked,
                    reason,
                    locked_at,
                },
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cat_chuoi_nhu_js() {
        assert_eq!(js_slice("abc", 2), "ab");
        assert_eq!(js_slice("abc", 5), "abc");
        // "đ" là 1 đơn vị UTF-16 (2 byte UTF-8); emoji là 2 đơn vị.
        assert_eq!(js_slice("đđđ", 2), "đđ");
        assert_eq!(js_slice("a😀b", 2), "a");
        assert_eq!(js_slice("a😀b", 3), "a😀");
        assert_eq!(js_trim("\u{feff} a b \n"), "a b");
    }

    #[test]
    fn quote_ident_nhu_node() {
        assert_eq!(quote_ident("c_12").unwrap(), "\"c_12\"");
        assert_eq!(quote_ident("public").unwrap(), "\"public\"");
        for bad in ["", "C_1", "1a", "a-b", "a\"b", "a b"] {
            assert!(quote_ident(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cau_loi_dung_nguyen_van() {
        assert_eq!(
            RouteKind::FacebookPage.taken_message(),
            "Trang Facebook này đã được một công ty khác kết nối với Trinity"
        );
        let e = sqlx::Error::Protocol("TRINITY_EMAIL_TAKEN: a@b.c already belongs to another company".into());
        assert_eq!(conflict_from_trigger(&e), Some(EMAIL_TAKEN_TRIGGER_MESSAGE));
        let e = sqlx::Error::Protocol("TRINITY_ROUTE_TAKEN: zalo_oa 1 is connected to another company".into());
        assert_eq!(conflict_from_trigger(&e), Some(ROUTE_TAKEN_TRIGGER_MESSAGE));
        assert_eq!(conflict_from_trigger(&sqlx::Error::RowNotFound), None);
    }

    #[test]
    fn sql_trigger_hien_tai() {
        // `replace('$2', '$1')` của bản Node chỉ thay chỗ đầu; chỉ có một chỗ.
        assert_eq!(TRIGGERS_CURRENT_SQL.matches("$2").count(), 1);
        assert_eq!(TRIGGERS_CURRENT_SQL.matches("c.schema_name").count(), 2);
    }
}
