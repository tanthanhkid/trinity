//! Migrator tương thích `prisma migrate deploy` 6.19 (bản spike R005, K07 hoàn thiện thành `trinity migrate`).
//!
//! Mọi chi tiết dưới đây chép theo mã nguồn schema engine đúng bản Prisma đang dùng
//! (`prisma-engines` commit `c2990dca591cba766e3b7ef5d9e8a84796e47ab7`, đi kèm `prisma` 6.19.3), xem PLAN mục 4.5:
//!
//! - checksum = SHA-256 của nội dung `migration.sql` (đọc nguyên văn, UTF-8), hex thường, đủ 64 ký tự
//!   (`schema-connector/src/checksum.rs`). Khi so, Prisma chấp nhận cả bản đổi `\r\n` ↔ `\n` và dạng hex cũ thiếu
//!   số 0 (lỗi prisma-engines#1887); [`script_matches_checksum`] làm y hệt.
//! - advisory lock: `pg_advisory_lock(72707369)`, **một khoá cho cả DB** (không theo schema), chờ tối đa 10 giây
//!   (`sql-schema-connector/src/flavour/postgres.rs`). Prisma không mở khoá tường minh: khoá nhả khi kết nối đóng.
//! - bảng `_prisma_migrations` tạo đúng DDL của Prisma; mỗi migration ghi một dòng lúc bắt đầu (`id` uuid v4,
//!   `checksum`, `started_at`, `migration_name`), chạy script bằng simple query (nhiều câu, một giao dịch ngầm),
//!   thành công thì `applied_steps_count + 1` rồi `finished_at`; lỗi thì ghi `logs` và dừng
//!   (`schema-engine/commands/src/commands/apply_migrations.rs`).
//! - script có `BEGIN;`/`COMMIT;` riêng (Prisma sinh cho enum) lỗi giữa chừng thì phiên ở giao dịch hỏng: Rust
//!   `ROLLBACK` trước khi ghi `logs` (Prisma không làm bước này).
//! - schema chưa có `_prisma_migrations` mà đã có bảng ⇒ từ chối (P3005 của Prisma).
//!
//! Khác Prisma có chủ đích: Rust lấy khoá 72707369 ở chế độ **shared** cộng một khoá riêng theo schema, nên nhiều
//! worker Rust migrate song song các schema khác nhau, còn Prisma (khoá exclusive) và Rust vẫn loại trừ nhau.

use std::path::Path;

use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, PgConnection, Row};

/// Số advisory lock của Prisma Migrate trên Postgres.
pub const PRISMA_MIGRATE_LOCK: i64 = 72_707_369;

/// Thời gian chờ khoá, như `ADVISORY_LOCK_TIMEOUT` của Prisma.
pub const LOCK_TIMEOUT_MS: u32 = 10_000;

/// DDL bảng theo dõi, chép nguyên văn từ `create_migrations_table` của Prisma (Postgres).
const CREATE_MIGRATIONS_TABLE: &str = r#"CREATE TABLE _prisma_migrations (
    id                      VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum                VARCHAR(64) NOT NULL,
    finished_at             TIMESTAMPTZ,
    migration_name          VARCHAR(255) NOT NULL,
    logs                    TEXT,
    rolled_back_at          TIMESTAMPTZ,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count     INTEGER NOT NULL DEFAULT 0
);"#;

/// Lỗi của migrator.
#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("tên schema không hợp lệ: {0:?}")]
    InvalidSchema(String),
    #[error("đọc thư mục migration lỗi: {0}")]
    Io(#[from] std::io::Error),
    #[error("schema {0} đã có bảng nhưng chưa có _prisma_migrations (P3005 của Prisma)")]
    SchemaNotEmpty(String),
    #[error("schema {schema} có migration lỗi dở dang: {names:?} (P3009 của Prisma)")]
    FailedMigrations { schema: String, names: Vec<String> },
    #[error("migration {name} lỗi: {source}")]
    Script { name: String, source: sqlx::Error },
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Một thư mục migration: tên thư mục và nội dung `migration.sql` nguyên văn.
#[derive(Debug, Clone)]
pub struct Migration {
    pub name: String,
    pub script: String,
}

impl Migration {
    pub fn checksum(&self) -> String {
        checksum(&self.script)
    }
}

/// Một dòng `_prisma_migrations`.
#[derive(Debug, Clone)]
pub struct AppliedMigration {
    pub id: String,
    pub migration_name: String,
    pub checksum: String,
    pub finished: bool,
    pub rolled_back: bool,
    pub applied_steps_count: i32,
}

/// So sánh thư mục migration với `_prisma_migrations` của một schema.
#[derive(Debug, Default)]
pub struct Status {
    /// Có bảng `_prisma_migrations` chưa.
    pub initialized: bool,
    /// Migration trên đĩa chưa có dòng (không tính dòng đã rolled back).
    pub pending: Vec<String>,
    /// Đã chạy nhưng checksum không khớp nội dung hiện tại (Prisma gọi là "edited").
    pub checksum_mismatch: Vec<String>,
    /// Dòng có `finished_at` rỗng và chưa rolled back.
    pub failed: Vec<String>,
    /// Đã chạy, khớp checksum **từng ký tự** với [`checksum`] (không cần nới dòng mới hay dạng hex cũ).
    pub exact_checksum: usize,
}

impl Status {
    pub fn up_to_date(&self) -> bool {
        self.initialized && self.pending.is_empty() && self.failed.is_empty()
    }
}

/// SHA-256 hex thường 64 ký tự, như `render_checksum` của Prisma.
pub fn checksum(script: &str) -> String {
    hex(&Sha256::digest(script.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Dạng hex cũ không đệm số 0 (prisma-engines#1887).
fn hex_old(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:x}");
    }
    s
}

/// Như `script_matches_checksum` của Prisma: thử nguyên văn, `\r\n`→`\n`, `\n`→`\r\n`; checksum không đủ 64 ký tự
/// thì so với dạng hex cũ.
pub fn script_matches_checksum(script: &str, stored: &str) -> bool {
    let variants = [
        script.to_owned(),
        script.replace("\r\n", "\n"),
        script.replace('\n', "\r\n"),
    ];
    variants.iter().any(|v| {
        let digest = Sha256::digest(v.as_bytes());
        let rendered = if !stored.is_empty() && stored.len() != 64 {
            hex_old(&digest)
        } else {
            hex(&digest)
        };
        rendered == stored
    })
}

/// Đọc `*/migration.sql` trong thư mục migration, sắp theo tên thư mục (như Prisma). Thư mục không có
/// `migration.sql` bị bỏ qua.
pub fn read_migrations_dir(dir: &Path) -> Result<Vec<Migration>, MigrateError> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let file = entry.path().join("migration.sql");
        if !file.is_file() {
            continue;
        }
        out.push(Migration {
            name: entry.file_name().to_string_lossy().into_owned(),
            script: std::fs::read_to_string(file)?,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// `search_path` của kết nối không gắn công ty (schema không tồn tại, PLAN 4.3): truy vấn không định danh schema lỗi.
pub const NO_COMPANY_SEARCH_PATH: &str = "\"trinity_no_company\"";

/// Tên schema công ty: chỉ `public` (công ty 1) hoặc `^c_[0-9]+$` (như `clients.ts`, PLAN 4.3).
pub fn validate_schema(schema: &str) -> Result<(), MigrateError> {
    let ok = schema == "public"
        || schema
            .strip_prefix("c_")
            .is_some_and(|n| !n.is_empty() && n.len() <= 20 && n.bytes().all(|b| b.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(MigrateError::InvalidSchema(schema.to_owned()))
    }
}

async fn use_schema(conn: &mut PgConnection, schema: &str) -> Result<(), MigrateError> {
    validate_schema(schema)?;
    set_search_path(conn, &format!("\"{schema}\"")).await
}

async fn set_search_path(conn: &mut PgConnection, value: &str) -> Result<(), MigrateError> {
    sqlx::query("SELECT set_config('search_path', $1, false)")
        .bind(value)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn table_exists(conn: &mut PgConnection, schema: &str) -> Result<bool, MigrateError> {
    let row = sqlx::query("SELECT to_regclass(format('%I._prisma_migrations', $1::text)) IS NOT NULL AS ok")
        .bind(schema)
        .fetch_one(&mut *conn)
        .await?;
    Ok(row.try_get::<bool, _>("ok")?)
}

/// Đọc `_prisma_migrations` của schema (rỗng nếu chưa có bảng). Bảng luôn được định danh schema.
pub async fn applied(conn: &mut PgConnection, schema: &str) -> Result<Vec<AppliedMigration>, MigrateError> {
    validate_schema(schema)?;
    if !table_exists(conn, schema).await? {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id, migration_name, checksum, finished_at IS NOT NULL AS finished, \
         rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count \
         FROM \"{schema}\"._prisma_migrations ORDER BY started_at, migration_name"
    );
    let rows = sqlx::query(AssertSqlSafe(sql)).fetch_all(&mut *conn).await?;
    rows.iter()
        .map(|r| {
            Ok(AppliedMigration {
                id: r.try_get("id")?,
                migration_name: r.try_get("migration_name")?,
                checksum: r.try_get("checksum")?,
                finished: r.try_get("finished")?,
                rolled_back: r.try_get("rolled_back")?,
                applied_steps_count: r.try_get("applied_steps_count")?,
            })
        })
        .collect()
}

/// Trạng thái một schema so với thư mục migration; không ghi gì, không đổi `search_path`.
pub async fn status(conn: &mut PgConnection, schema: &str, migrations: &[Migration]) -> Result<Status, MigrateError> {
    validate_schema(schema)?;
    let initialized = table_exists(conn, schema).await?;
    let rows = applied(conn, schema).await?;
    let mut st = Status {
        initialized,
        ..Status::default()
    };
    st.failed = rows
        .iter()
        .filter(|r| !r.finished && !r.rolled_back)
        .map(|r| r.migration_name.clone())
        .collect();
    for m in migrations {
        // Mỗi migration đếm một lần dù có nhiều dòng sống cùng tên.
        let live: Vec<&AppliedMigration> = rows
            .iter()
            .filter(|r| !r.rolled_back && r.migration_name == m.name)
            .collect();
        if live.is_empty() {
            st.pending.push(m.name.clone());
        } else if live.iter().any(|r| r.checksum == m.checksum()) {
            st.exact_checksum += 1;
        } else if !live.iter().any(|r| script_matches_checksum(&m.script, &r.checksum)) {
            st.checksum_mismatch.push(m.name.clone());
        }
    }
    Ok(st)
}

/// Lấy khoá migrate: shared trên khoá của Prisma (loại trừ `prisma migrate`), exclusive theo schema (loại trừ worker
/// Rust khác cùng schema). Chờ tối đa [`LOCK_TIMEOUT_MS`], sau đó trả `lock_timeout` về giá trị cũ của phiên. Lỗi thì
/// chỉ nhả đúng khoá lần gọi này đã lấy. Khoá cấp phiên: gọi [`unlock`] với cùng `schema` khi xong.
pub async fn lock(conn: &mut PgConnection, schema: &str) -> Result<(), MigrateError> {
    validate_schema(schema)?;
    let old: String = sqlx::query_scalar("SELECT current_setting('lock_timeout')")
        .fetch_one(&mut *conn)
        .await?;
    sqlx::query("SELECT set_config('lock_timeout', $1, false)")
        .bind(format!("{LOCK_TIMEOUT_MS}ms"))
        .execute(&mut *conn)
        .await?;
    let mut shared = false;
    let mut per_schema = false;
    let res: Result<(), sqlx::Error> = async {
        sqlx::query("SELECT pg_advisory_lock_shared($1)")
            .bind(PRISMA_MIGRATE_LOCK)
            .execute(&mut *conn)
            .await?;
        shared = true;
        sqlx::query("SELECT pg_advisory_lock($1::int4, hashtext($2))")
            .bind(PRISMA_MIGRATE_LOCK as i32)
            .bind(schema)
            .execute(&mut *conn)
            .await?;
        per_schema = true;
        Ok(())
    }
    .await;
    let restore = sqlx::query("SELECT set_config('lock_timeout', $1, false)")
        .bind(&old)
        .execute(&mut *conn)
        .await;
    if res.is_err() || restore.is_err() {
        // Nhả đúng phần đã lấy; lỗi khi nhả không che lỗi gốc.
        let _ = release(conn, schema, shared, per_schema).await;
    }
    res?;
    restore?;
    Ok(())
}

async fn release(conn: &mut PgConnection, schema: &str, shared: bool, per_schema: bool) -> Result<(), MigrateError> {
    if per_schema {
        sqlx::query("SELECT pg_advisory_unlock($1::int4, hashtext($2))")
            .bind(PRISMA_MIGRATE_LOCK as i32)
            .bind(schema)
            .execute(&mut *conn)
            .await?;
    }
    if shared {
        sqlx::query("SELECT pg_advisory_unlock_shared($1)")
            .bind(PRISMA_MIGRATE_LOCK)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Nhả hai khoá mà [`lock`] đã lấy cho `schema` (không đụng advisory lock khác của phiên).
pub async fn unlock(conn: &mut PgConnection, schema: &str) -> Result<(), MigrateError> {
    validate_schema(schema)?;
    release(conn, schema, true, true).await
}

/// Như `prisma migrate deploy` cho một schema: tạo schema nếu thiếu, giữ khoá, chạy migration còn thiếu theo thứ tự,
/// ghi `_prisma_migrations` đúng cách Prisma ghi. Trả về tên các migration vừa chạy. Xong thì `search_path` về
/// [`NO_COMPANY_SEARCH_PATH`]. Lỗi migration được trả về nguyên vẹn; nếu sau đó nhả khoá cũng lỗi thì kết nối nên bị
/// đóng (đóng kết nối là nhả khoá).
pub async fn deploy(
    conn: &mut PgConnection,
    schema: &str,
    migrations: &[Migration],
) -> Result<Vec<String>, MigrateError> {
    validate_schema(schema)?;
    lock(conn, schema).await?;
    let res = match use_schema(conn, schema).await {
        Ok(()) => deploy_locked(conn, schema, migrations).await,
        Err(e) => Err(e),
    };
    // Dọn kể cả khi lỗi; lỗi migration được ưu tiên trả về.
    let reset = set_search_path(conn, NO_COMPANY_SEARCH_PATH).await;
    let unlocked = unlock(conn, schema).await;
    let done = res?;
    reset?;
    unlocked?;
    Ok(done)
}

async fn deploy_locked(
    conn: &mut PgConnection,
    schema: &str,
    migrations: &[Migration],
) -> Result<Vec<String>, MigrateError> {
    sqlx::raw_sql(AssertSqlSafe(format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\"")))
        .execute(&mut *conn)
        .await?;
    if !table_exists(conn, schema).await? {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = $1")
            .bind(schema)
            .fetch_one(&mut *conn)
            .await?;
        if n > 0 {
            return Err(MigrateError::SchemaNotEmpty(schema.to_owned()));
        }
        sqlx::raw_sql(CREATE_MIGRATIONS_TABLE).execute(&mut *conn).await?;
    }
    let rows = applied(conn, schema).await?;
    let failed: Vec<String> = rows
        .iter()
        .filter(|r| !r.finished && !r.rolled_back)
        .map(|r| r.migration_name.clone())
        .collect();
    if !failed.is_empty() {
        return Err(MigrateError::FailedMigrations {
            schema: schema.to_owned(),
            names: failed,
        });
    }
    let table = format!("\"{schema}\"._prisma_migrations");
    let mut done = Vec::new();
    for m in migrations {
        if rows.iter().any(|r| !r.rolled_back && r.migration_name == m.name) {
            continue;
        }
        // Như Prisma: id là uuid v4 sinh phía client.
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO {table} (id, checksum, started_at, migration_name) VALUES ($1, $2, now(), $3)"
        )))
        .bind(&id)
        .bind(m.checksum())
        .bind(&m.name)
        .execute(&mut *conn)
        .await?;
        match sqlx::raw_sql(AssertSqlSafe(m.script.clone())).execute(&mut *conn).await {
            Ok(_) => {
                // Script có thể đổi search_path; đặt lại cho migration sau.
                use_schema(conn, schema).await?;
                sqlx::query(AssertSqlSafe(format!(
                    "UPDATE {table} SET applied_steps_count = applied_steps_count + 1 WHERE id = $1"
                )))
                .bind(&id)
                .execute(&mut *conn)
                .await?;
                sqlx::query(AssertSqlSafe(format!(
                    "UPDATE {table} SET finished_at = now() WHERE id = $1"
                )))
                .bind(&id)
                .execute(&mut *conn)
                .await?;
                done.push(m.name.clone());
            }
            Err(e) => {
                // Script có `BEGIN;` riêng (Prisma sinh cho enum) lỗi giữa chừng thì phiên đang ở giao dịch hỏng
                // (25P02): ROLLBACK trước rồi mới ghi sổ. Không có giao dịch mở thì ROLLBACK chỉ là cảnh báo.
                sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await?;
                use_schema(conn, schema).await?;
                sqlx::query(AssertSqlSafe(format!("UPDATE {table} SET logs = $1 WHERE id = $2")))
                    .bind(e.to_string())
                    .bind(&id)
                    .execute(&mut *conn)
                    .await?;
                return Err(MigrateError::Script {
                    name: m.name.clone(),
                    source: e,
                });
            }
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_giong_test_cua_prisma() {
        // Ca `format_checksum_does_not_strip_zeros` trong checksum.rs của Prisma.
        assert_eq!(
            checksum("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(checksum("abcd").len(), 64);
    }

    #[test]
    fn so_checksum_khong_phan_biet_dong_moi() {
        let groups = [
            ["ab\ncd\nef\ngh\rab", "ab\r\ncd\r\nef\r\ngh\rab"],
            ["ab\ncd\nef\ngh\rab\n", "ab\r\ncd\r\nef\r\ngh\rab\r\n"],
        ];
        for g in groups {
            for a in g {
                for b in g {
                    assert!(script_matches_checksum(a, &checksum(b)));
                }
            }
        }
        assert!(!script_matches_checksum("abc", &checksum("abcd")));
        assert!(!script_matches_checksum("abc\n", &checksum("abc")));
    }

    #[test]
    fn so_checksum_dang_hex_cu() {
        // Băm có byte < 0x10 thì dạng cũ ngắn hơn 64 ký tự.
        let script = (0..)
            .map(|i| format!("-- {i}"))
            .find(|s| Sha256::digest(s.as_bytes()).iter().any(|b| *b < 0x10))
            .expect("có ca");
        let old = hex_old(&Sha256::digest(script.as_bytes()));
        assert!(old.len() < 64);
        assert!(script_matches_checksum(&script, &old));
    }

    #[test]
    fn ten_schema() {
        for ok in ["public", "c_2", "c_9001"] {
            assert!(validate_schema(ok).is_ok());
        }
        for bad in ["", "C_2", "c_", "c_1a", "r005_a", "a-b", "x\"; drop", "2abc", "Public"] {
            assert!(validate_schema(bad).is_err());
        }
    }
}
