//! Module bảng tuỳ biến, phần cấu trúc (M17, docs/rust/PLAN.md mục 1.2 (module và endpoint) và 4.7 (RBAC)): bảng, trường, màn xem, phiên bản cấu trúc, menu và
//! tra cứu. Chuyển từ `services/crm/src/custom-objects/*` (không gồm bản ghi, liên kết, nhập xuất: M18; mẫu bảng và dựng
//! hệ thống: M19). 15 route `/api/v1/custom-objects` được nối qua router K14 ([`routes`]).
//!
//! - [`access`]: quyền thấy bảng theo vai trò, nạp định nghĩa + trường.
//! - [`objects`], [`fields`], [`views`]: ba nhóm nghiệp vụ; [`versions`] và [`menu`]: dùng cho công cụ MCP/dựng hệ thống.
//! - [`values`], [`filters`], [`codes`], [`types`]: chuẩn hoá giá trị, bộ lọc của màn xem, tiền tố mã, hằng số.

#![allow(clippy::result_large_err)]

pub mod access;
pub mod codes;
pub mod fields;
pub mod filters;
pub mod lookups;
pub mod menu;
pub mod objects;
pub mod routes;
pub mod types;
pub mod values;
pub mod versions;
pub mod views;

use trinity_db::pg_error::{app_error, db_error};
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_rbac::{Grants, ScopeService};

pub use routes::{api_router, specs};

pub type R<T> = Result<T, AppError>;

/// Phụ thuộc của module.
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
}

impl Ctx {
    pub async fn conn(&self, company: CompanyRef) -> R<trinity_db::TenantConn> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.acquire().await.map_err(AppError::internal)
    }

    pub async fn begin(&self, company: CompanyRef) -> R<trinity_db::TenantTx> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.begin().await.map_err(AppError::internal)
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

/// Vi phạm ràng buộc duy nhất (P2002).
pub(crate) fn is_unique(e: &sqlx::Error) -> bool {
    db_error(e).is(DbErrorKind::UniqueViolation, None)
}

pub(crate) fn bad(m: impl Into<String>) -> AppError {
    HttpError::bad_request(m.into()).into()
}

pub(crate) fn conflict(m: impl Into<String>) -> AppError {
    HttpError::conflict(m.into()).into()
}

pub(crate) fn not_found(m: &str) -> AppError {
    HttpError::not_found(m).into()
}

/// Số JS: nguyên thì in không có `.0`.
pub(crate) fn js_number(n: f64) -> serde_json::Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        serde_json::Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)
    }
}

/// Model/danh sách ⇒ `Value` qua chuỗi JSON (giữ nguyên cách serialize của model: ngày ISO, số lớn…).
pub(crate) fn json_of<T: serde::Serialize + ?Sized>(v: &T) -> R<serde_json::Value> {
    let text = serde_json::to_string(v).map_err(AppError::internal)?;
    serde_json::from_str(&text).map_err(AppError::internal)
}
