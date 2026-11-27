//! Module bảng tuỳ biến (docs/rust/PLAN.md mục 1.2 (module và endpoint) và 4.7 (RBAC)). M17: bảng, trường, màn xem, phiên bản
//! cấu trúc, menu và tra cứu. M18: bản ghi, liên kết (`record_links`, thẻ @), xuất tệp. Chuyển từ
//! `services/crm/src/custom-objects/*` (mẫu bảng và dựng hệ thống: M19). 27 route (15 cấu trúc + 8 bản ghi + 4 `/refs`) được nối
//! qua router K14 ([`routes`]).
//!
//! - [`access`]: quyền thấy bảng theo vai trò, nạp định nghĩa + trường.
//! - [`objects`], [`fields`], [`views`]: ba nhóm nghiệp vụ; [`versions`] và [`menu`]: dùng cho công cụ MCP/dựng hệ thống.
//! - [`values`], [`filters`], [`codes`], [`types`]: chuẩn hoá lựa chọn và tuỳ chọn, bộ lọc của màn xem, tiền tố mã, hằng số.
//! - [`record_values`], [`dates`]: chuẩn hoá MỘT giá trị bản ghi theo kiểu trường; [`record_query`]: lọc, sắp xếp, con trỏ, ô tìm.
//! - [`records`]: kiểm dữ liệu, tạo, sửa, xoá, danh sách, chi tiết; [`present`]: dựng bản ghi trả ra (che SĐT, công thức, nhãn).
//! - [`refs`]: tham chiếu `loại:id`, mã, gợi ý, liên kết ngược, xem nhanh; [`export`]: CSV và xlsx chống chèn công thức.

#![allow(clippy::result_large_err)]

pub mod access;
pub mod codes;
pub mod dates;
pub mod export;
pub mod fields;
pub mod filters;
pub mod lookups;
pub mod menu;
pub mod objects;
pub mod present;
pub mod record_query;
pub mod record_values;
pub mod records;
pub mod refs;
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

pub(crate) fn internal(m: &str) -> AppError {
    AppError::internal(m.to_owned())
}

pub(crate) fn forbidden(m: &str) -> AppError {
    HttpError::forbidden(m).into()
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
