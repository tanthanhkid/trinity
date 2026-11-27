//! Bảng `platform.export_files`: trạng thái và nội dung tệp xuất nền. Mọi truy vấn lọc theo công ty; đọc còn lọc theo
//! người xếp việc (người khác không thấy tệp của nhau, kể cả admin: tệp mang SĐT theo quyền của chủ nó).

use std::sync::Arc;

use serde::Serialize;
use sqlx::AssertSqlSafe;
use trinity_db::platform::PLATFORM_LOCK;
use trinity_db::{Db, DbError};

/// Tệp tối đa lưu được (bảo vệ DB); lớn hơn thì việc báo `failed`.
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
/// Tệp giữ bao lâu sau khi xếp việc.
pub const TTL_HOURS: i32 = 24;
/// Số việc đang chờ/chạy tối đa của một người.
pub const MAX_ACTIVE_PER_USER: i64 = 3;

const DDL: &[&str] = &[
    "CREATE SCHEMA IF NOT EXISTS platform",
    "CREATE TABLE IF NOT EXISTS platform.export_files (
       id bigserial PRIMARY KEY,
       company_id int NOT NULL,
       user_id int NOT NULL,
       kind varchar(50) NOT NULL,
       status varchar(10) NOT NULL DEFAULT 'queued',
       progress smallint NOT NULL DEFAULT 0,
       filename text,
       content_type text,
       size_bytes bigint,
       data bytea,
       error text,
       created_at timestamptz NOT NULL DEFAULT now(),
       finished_at timestamptz,
       expires_at timestamptz NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS export_files_owner_idx ON platform.export_files (company_id, user_id, created_at)",
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

/// Trạng thái một việc xuất (không gồm nội dung tệp).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct ExportStatus {
    pub id: i64,
    pub kind: String,
    /// `queued` | `running` | `done` | `failed`.
    pub status: String,
    /// 0..=100.
    pub progress: i16,
    pub filename: Option<String>,
    pub size_bytes: Option<i64>,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

/// Một tệp tải về.
#[derive(Debug)]
pub struct StoredFile {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub struct Store {
    db: Db,
    ready: Arc<tokio::sync::OnceCell<()>>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

async fn ensure_tables(db: &Db) -> Result<(), StoreError> {
    let mut tx = db.platform().begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PLATFORM_LOCK)
        .execute(&mut *tx)
        .await?;
    for stmt in DDL {
        sqlx::raw_sql(AssertSqlSafe((*stmt).to_owned()))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

const STATUS_COLUMNS: &str = "id, kind, status, progress, filename, size_bytes, error,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,
       to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS finished_at";

impl Store {
    pub fn new(db: &Db) -> Self {
        Self {
            db: db.clone(),
            ready: Arc::new(tokio::sync::OnceCell::new()),
        }
    }

    async fn ready(&self) -> Result<(), StoreError> {
        self.ready.get_or_try_init(|| ensure_tables(&self.db)).await?;
        Ok(())
    }

    /// Tạo dòng `queued`, dọn tệp hết hạn của công ty. `Ok(None)` = người này đang có quá [`MAX_ACTIVE_PER_USER`] việc.
    pub async fn create(&self, company: i32, user: i32, kind: &str) -> Result<Option<i64>, StoreError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        sqlx::query("DELETE FROM platform.export_files WHERE company_id = $1 AND expires_at < now()")
            .bind(company)
            .execute(&mut *conn)
            .await?;
        // Việc kẹt (worker chết hẳn) không được chặn người dùng mãi: chỉ đếm việc tạo trong 1 giờ qua.
        let (active,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM platform.export_files
              WHERE company_id = $1 AND user_id = $2 AND status IN ('queued', 'running')
                AND created_at > now() - interval '1 hour'",
        )
        .bind(company)
        .bind(user)
        .fetch_one(&mut *conn)
        .await?;
        if active >= MAX_ACTIVE_PER_USER {
            return Ok(None);
        }
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO platform.export_files (company_id, user_id, kind, expires_at)
             VALUES ($1, $2, $3, now() + $4 * interval '1 hour') RETURNING id",
        )
        .bind(company)
        .bind(user)
        .bind(kind)
        .bind(TTL_HOURS)
        .fetch_one(&mut *conn)
        .await?;
        Ok(Some(id))
    }

    /// Worker bắt đầu: `false` = dòng không còn ở `queued`/`running` (đã xong, hết hạn hoặc bị dọn) ⇒ bỏ qua việc.
    pub async fn mark_running(&self, id: i64, company: i32) -> Result<bool, StoreError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        let row: Option<(i64,)> = sqlx::query_as(
            "UPDATE platform.export_files SET status = 'running', progress = 10
              WHERE id = $1 AND company_id = $2 AND status IN ('queued', 'running') AND expires_at > now()
              RETURNING id",
        )
        .bind(id)
        .bind(company)
        .fetch_optional(&mut *conn)
        .await?;
        Ok(row.is_some())
    }

    /// Tiến độ giữa chừng (chỉ tăng).
    pub async fn set_progress(&self, id: i64, company: i32, progress: i16) -> Result<(), StoreError> {
        let mut conn = self.db.platform().acquire().await?;
        sqlx::query(
            "UPDATE platform.export_files SET progress = GREATEST(progress, $3)
              WHERE id = $1 AND company_id = $2 AND status = 'running'",
        )
        .bind(id)
        .bind(company)
        .bind(progress)
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    pub async fn finish(
        &self,
        id: i64,
        company: i32,
        filename: &str,
        content_type: &str,
        data: Vec<u8>,
    ) -> Result<(), StoreError> {
        let size = i64::try_from(data.len()).unwrap_or(i64::MAX);
        let mut conn = self.db.platform().acquire().await?;
        sqlx::query(
            "UPDATE platform.export_files
                SET status = 'done', progress = 100, filename = $3, content_type = $4, size_bytes = $5, data = $6,
                    error = NULL, finished_at = now()
              WHERE id = $1 AND company_id = $2",
        )
        .bind(id)
        .bind(company)
        .bind(filename)
        .bind(content_type)
        .bind(size)
        .bind(data)
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    pub async fn fail(&self, id: i64, company: i32, error: &str) -> Result<(), StoreError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        sqlx::query(
            "UPDATE platform.export_files SET status = 'failed', error = left($3, 500), finished_at = now()
              WHERE id = $1 AND company_id = $2",
        )
        .bind(id)
        .bind(company)
        .bind(error)
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    /// Trạng thái của việc thuộc `user`; không có / hết hạn / của người khác ⇒ `None`.
    pub async fn status(&self, id: i64, company: i32, user: i32) -> Result<Option<ExportStatus>, StoreError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        let sql = format!(
            "SELECT {STATUS_COLUMNS} FROM platform.export_files
              WHERE id = $1 AND company_id = $2 AND user_id = $3 AND expires_at > now()"
        );
        let row = sqlx::query_as::<_, ExportStatus>(AssertSqlSafe(sql))
            .bind(id)
            .bind(company)
            .bind(user)
            .fetch_optional(&mut *conn)
            .await?;
        Ok(row)
    }

    /// Nội dung tệp khi `status = done`.
    pub async fn file(&self, id: i64, company: i32, user: i32) -> Result<Option<StoredFile>, StoreError> {
        self.ready().await?;
        let mut conn = self.db.platform().acquire().await?;
        let row: Option<(Option<String>, Option<String>, Vec<u8>)> = sqlx::query_as(
            "SELECT filename, content_type, data FROM platform.export_files
              WHERE id = $1 AND company_id = $2 AND user_id = $3 AND status = 'done'
                AND data IS NOT NULL AND expires_at > now()",
        )
        .bind(id)
        .bind(company)
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?;
        Ok(row.map(|(filename, content_type, data)| StoredFile {
            filename: filename.unwrap_or_else(|| "export".to_owned()),
            content_type: content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
            data,
        }))
    }
}
