//! `sqlx::Error` → lỗi DB đã phân loại của kernel (K05; `KernelDbError`, khác `trinity_db::DbError` là lỗi cấu hình/kết nối): SQLSTATE, tên ràng buộc, câu lỗi. Module repository dùng để
//! bắt đúng ràng buộc như bản TS bắt `P2002` theo `meta.target`.

use trinity_kernel::error::{AppError, DbError as KernelDbError};

/// Lỗi Postgres → [`KernelDbError`] (lỗi không phải của Postgres thành loại `Other`).
pub fn db_error(e: &sqlx::Error) -> KernelDbError {
    // 25006 `read_only_sql_transaction`: handler ghi DB khi đang shadow (phiên chỉ đọc) ⇒ route "không shadow được" (K28).
    if let sqlx::Error::Database(d) = e
        && d.code().as_deref() == Some("25006")
    {
        trinity_kernel::shadow::record_violation("ghi DB");
    }
    match e {
        sqlx::Error::Database(d) => KernelDbError::from_postgres(d.code().as_deref(), d.constraint(), d.message()),
        other => KernelDbError::from_postgres(None, None, other.to_string()),
    }
}

/// Như [`db_error`], bọc thành [`AppError`] (không ai bắt thì 500, chi tiết chỉ vào log).
pub fn app_error(e: &sqlx::Error) -> AppError {
    db_error(e).into()
}
