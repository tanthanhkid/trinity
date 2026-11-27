//! Chấm công, phần cấu hình (M13a): 11 endpoint `/api/v1/management/attendance/*` chuyển từ `services/crm/src/attendance`
//! (phần văn phòng, cấu hình ca, thứ 7 đi làm, cấu hình đơn, đặt lại thiết bị). Chấm công vào/ra và kiểm IP là M13b; danh sách,
//! thống kê là M14; đơn từ (M14a) ở [`requests`]: `POST/GET /requests`, `POST /requests/:id/approve|reject`.
//!
//! | Route | Hàm | Quyền |
//! |---|---|---|
//! | `GET/POST /offices`, `PATCH/DELETE /offices/:id` | [`offices::list`], [`offices::create`], [`offices::update`], [`offices::remove`] | `attendance.view` (xem), `attendance.config` |
//! | `POST /reset-device/:userId` | [`offices::reset_device`] | `attendance.config` |
//! | `GET/PATCH /settings` | [`config::get_shift`], [`config::update_shift`] | đăng nhập (xem), `attendance.config` |
//! | `GET/PATCH /working-saturdays` | [`config::get_saturdays`], [`config::set_saturdays`] | đăng nhập (xem), `attendance.config` |
//! | `GET/PATCH /request-config` | [`config::get_request_config`], [`config::update_request_config`] | đăng nhập (xem), `attendance.config` |
//!
//! M13b: `POST /check-in`, `POST /check-out` (đăng nhập; multipart `device_id`, `note`, tệp `selfie`) ở [`check`]: kiểm IP văn phòng bằng IP
//! khách từ hàm dùng chung `resolve_client_ip`, ngày làm việc theo giờ Việt Nam; router riêng [`routes::check_router`] (state `Arc<check::CheckCtx>`).
//!
//! Bảng `attendance_qr_sessions` (mô hình mã QR) không còn route nào dùng ở bản TS nên M13a không có endpoint QR; bảng giữ nguyên.
//! Cấu hình lưu ở `settings` (JSON): `attendance_shift_config`, `attendance_request_config`, `attendance_working_saturdays`.
//!
//! Cách nối như M10: `ValidJson` kiểm DTO bằng metadata class-validator thật rồi tới hàm nghiệp vụ; [`routes`] có bảng route (K14)
//! và router axum với state `Arc<mod_hr::employees::Ctx>`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod check;
pub mod config;
pub mod dto;
pub mod offices;
pub mod records;
pub mod requests;
pub mod routes;
pub mod stats;

use serde_json::Value;
use sqlx::PgConnection;
use trinity_kernel::error::AppError;

pub(crate) type R<T> = Result<T, AppError>;

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> AppError {
    trinity_db::pg_error::app_error(&e)
}

/// Đọc một dòng `settings`.
pub(crate) async fn setting(conn: &mut PgConnection, key: &str) -> R<Option<String>> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// Ghi một dòng `settings` (upsert).
pub(crate) async fn put_setting(conn: &mut PgConnection, key: &str, value: &str, user: i32) -> R<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .bind(user)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Số JS: nguyên thì ra số nguyên (`1`, không phải `1.0`), còn lại giữ số thực.
pub(crate) fn js_num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
    }
}
