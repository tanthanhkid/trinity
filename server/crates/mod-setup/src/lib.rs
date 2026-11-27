//! Dựng hệ thống (M19, `docs/rust/PLAN.md`): mẫu bảng dựng sẵn, "Dựng hệ thống" một lần bấm, wizard bắt đầu, trạng thái dựng
//! và bản ghi mẫu. Chuyển từ `services/crm/src/{setup,onboarding,sample-records}` và `custom-objects/custom-object-templates.service.ts`.
//!
//! | Route | Hàm |
//! |---|---|
//! | `GET /setup/status`, `GET /setup/connect-prompt`, `GET /setup/onboarding`, `POST /setup/onboarding/seen`, `POST /setup/complete` | [`status`], [`connect`] |
//! | `POST /setup/build` | [`build::build`] |
//! | `GET /setup/wizard`, `POST /setup/wizard/{confirm,skip}`, `GET|PUT /setup/wizard/config` | [`wizard`] |
//! | `GET /custom-objects/templates`, `POST /custom-objects/templates/:template/apply` (M17 để lại) | [`templates`] |
//!
//! Danh mục mẫu bảng, ngành và prompt nối agent nhúng từ `contracts/setup/catalog.json` do `setup-catalog-contract.spec.ts`
//! sinh từ mã TS ([`catalog`]). Bản ghi mẫu ([`samples`]) là "dữ liệu giả để xem thử": tự xoá mềm khi có bản ghi thật đầu tiên;
//! tầng route của khách/bản ghi gọi [`samples::purge_if_real`] sau khi tạo (lưới an toàn: màn trạng thái và wizard cũng gọi).
//!
//! Sự kiện sản phẩm `onboarding_step`, `table_created`, `workspace_built` gửi qua [`Ctx::events`] (`trinity_obs::ProductEvents`);
//! xoá cache đếm khách sau khi dọn mẫu qua [`Ctx::contacts_changed`].

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod build;
pub mod catalog;
pub mod connect;
pub mod industry;
pub mod routes;
pub mod sample_value;
pub mod samples;
pub mod status;
pub mod templates;
pub mod wizard;

use std::sync::Arc;

use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::Grants;

pub use routes::{api_router, specs};

pub type R<T> = Result<T, AppError>;

/// Tra biến môi trường (để test được và để tầng serve truyền cấu hình đã nạp).
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Báo "khách hàng vừa bị xoá hàng loạt" để tầng serve xoá cache đếm tổng của danh sách (`crm:contacts:count:`).
pub type ContactsChanged = Arc<dyn Fn(CompanyRef) + Send + Sync>;

/// Phụ thuộc của module.
pub struct Ctx {
    pub db: Db,
    pub env: Env,
    pub contacts_changed: Option<ContactsChanged>,
    /// Sự kiện sản phẩm (`onboarding_step`, `table_created`, `workspace_built`); mặc định tắt.
    pub events: trinity_obs::ProductEvents,
}

impl Ctx {
    /// Đọc cấu hình từ biến môi trường của tiến trình.
    pub fn new(db: Db) -> Self {
        Self {
            db,
            env: Arc::new(|k| std::env::var(k).ok()),
            contacts_changed: None,
            events: trinity_obs::ProductEvents::disabled(),
        }
    }

    pub async fn conn(&self, company: CompanyRef) -> R<trinity_db::TenantConn> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.acquire().await.map_err(AppError::internal)
    }

    pub async fn begin(&self, company: CompanyRef) -> R<trinity_db::TenantTx> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.begin().await.map_err(AppError::internal)
    }

    pub(crate) fn env(&self, k: &str) -> Option<String> {
        (self.env)(k)
    }
}

/// Người gọi, do guard của router điền.
#[derive(Debug, Clone)]
pub struct Actor {
    pub user_id: i32,
    pub company: CompanyRef,
    pub grants: Grants,
    pub is_admin: bool,
}

pub(crate) fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

pub(crate) fn bad(m: impl Into<String>) -> AppError {
    HttpError::bad_request(m.into()).into()
}

/// Đọc một dòng `settings`; `None` nếu chưa có.
pub(crate) async fn read_setting(conn: &mut PgConnection, key: &str) -> R<Option<String>> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)
}

/// `setting.upsert`: ghi giá trị và người sửa.
pub(crate) async fn write_setting(conn: &mut PgConnection, key: &str, value: &str, user: Option<i32>) -> R<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .bind(user)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// `new Date().toISOString()`.
pub(crate) fn now_iso() -> String {
    iso(Utc::now())
}

pub(crate) fn iso(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `Date.parse` cho mọi dạng `@IsISO8601` cho qua mà V8 đọc được (`YYYY`, `YYYY-MM`, `±hhmm`…); giờ không múi coi là giờ Việt
/// Nam (máy chủ Node của Trinity chạy `TZ=Asia/Ho_Chi_Minh`). `None` = `NaN`. Dùng chung bộ đọc của M10.
pub(crate) fn js_parse_date(s: &str) -> Option<DateTime<Utc>> {
    trinity_kernel::instant::parse_instant_with(s.trim(), 7 * 60)
}
