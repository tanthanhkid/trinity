//! Chấm điểm khách và nhắc việc treo (M24), chuyển từ `services/crm/src/{lead-scoring,stale-work}` (8 endpoint, 2 job):
//!
//! | Route | Hàm |
//! |---|---|
//! | `GET/PUT /lead-scoring/rules` | [`lead::get_rules`], [`lead::save_rules`] |
//! | `POST /lead-scoring/recompute-all` | [`lead::rescore_stale`] |
//! | `POST /lead-scoring/contacts/:id/recompute` | [`lead::recompute_one`] |
//! | `GET /stale-work/summary` | [`stale::summary_for`] |
//! | `GET/PUT /stale-work/config` | [`stale::get_config`], [`stale::save_config`] |
//! | `POST /stale-work/run` | [`stale::run_once`] với `force = true` |
//! | job `lead-scoring.run` (10 phút), `stale-work.digest` (15 phút) | [`jobs`] |
//!
//! Cách nối giống M07/M08: hàm nhận kết nối đã gắn công ty (`&mut PgConnection`) hoặc `&TenantDb` (khi cần giao dịch), trả
//! `AppError`; công tắc tính năng tổ chức (K25) đi qua [`Features`] vì `trinity-rbac` chưa có đọc DB; bảng route ở [`routes`]
//! được `trinity-bin` so với `routes.json` (K14).
//!
//! Khác bản TS có chủ đích:
//! - **Tổng hợp việc treo nhận lượt nguyên tử.** Bản TS đọc dấu `stale_work_last_digest`, gửi, rồi mới ghi dấu (hai tiến
//!   trình cùng lọt qua). Bản Rust làm MỘT giao dịch: nhận dấu hôm nay bằng `INSERT … ON CONFLICT DO UPDATE … WHERE value IS
//!   DISTINCT FROM <hôm nay>` (khoá hàng nên bên thứ hai chờ rồi thấy dấu đã có), tạo mọi thông báo, rồi commit; lỗi giữa chừng
//!   thì huỷ cả giao dịch (không ai nhận nửa vời, dấu không được ghi, lượt sau gửi lại). Scheduler K20 còn giữ khoá
//!   `platform.job_runs` theo công ty. Vì vậy đổi chủ job này (X01) chỉ cần làm ngoài khung giờ gửi hoặc khi dấu đã là hôm nay;
//! - lỗi của job chấm điểm được trả lên scheduler (ghi vào `job_runs.last_error`) thay vì nuốt;
//! - kết quả quét việc treo không có cache 60 giây trong RAM như bản TS (mỗi lần gọi `summary` quét lại, 4 truy vấn gộp);
//! - thông báo của job `stale-work.digest` phát chuông qua `NOTIFY` cho các tiến trình khác; socket trong chính tiến trình
//!   chạy job do tầng route đẩy từ [`stale::run_once`] khi chạy tay.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err, clippy::type_complexity)]

pub mod jobs;
pub mod lead;
pub mod routes;
pub mod rules;
pub mod stale;

use std::future::Future;

use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

/// Công tắc tính năng của tổ chức (`OrgFeaturesService.isEnabled`, đã tính gói); đọc lỗi thì coi là bật (fail-open).
pub trait Features: Send + Sync {
    fn enabled<'a>(&'a self, conn: &'a mut PgConnection, key: &'a str) -> impl Future<Output = bool> + Send + 'a;
}

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

pub(crate) fn http(e: HttpError) -> AppError {
    AppError::Http(e)
}

/// Đọc một dòng `settings`.
pub(crate) async fn setting(conn: &mut PgConnection, key: &str) -> Result<Option<String>, AppError> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// Ghi một dòng `settings` (upsert), `updated_by` có thể trống.
pub(crate) async fn put_setting(
    conn: &mut PgConnection,
    key: &str,
    value: &str,
    user: Option<i32>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
           updated_by = COALESCE(EXCLUDED.updated_by, settings.updated_by), updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .bind(user)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}
