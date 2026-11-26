//! `sqlx::Error` → lỗi DB đã phân loại của kernel (K05; `KernelDbError`, khác `trinity_db::DbError` là lỗi cấu hình/kết nối): SQLSTATE, tên ràng buộc, câu lỗi. Module repository dùng để
//! bắt đúng ràng buộc như bản TS bắt `P2002` theo `meta.target`.

use trinity_kernel::error::{AppError, DbError as KernelDbError};

/// Lỗi Postgres → [`KernelDbError`] (lỗi không phải của Postgres thành loại `Other`).
pub fn db_error(e: &sqlx::Error) -> KernelDbError {
    match e {
        sqlx::Error::Database(d) => KernelDbError::from_postgres(d.code().as_deref(), d.constraint(), d.message()),
        other => KernelDbError::from_postgres(None, None, other.to_string()),
    }
}

/// Như [`db_error`], bọc thành [`AppError`] (không ai bắt thì 500, chi tiết chỉ vào log).
pub fn app_error(e: &sqlx::Error) -> AppError {
    db_error(e).into()
}
