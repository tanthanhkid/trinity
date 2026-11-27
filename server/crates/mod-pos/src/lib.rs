//! Module POS (M26): sơ đồ bàn, tuỳ chọn món, cấu hình quán, menu, ca và báo cáo ngày, chuyển từ
//! `services/commerce/src/pos` (`pos-layout`, `pos-catalog`, `pos-shifts`, `pos-reports`). Đơn và thanh toán (M27) thuộc
//! issue khác nhưng dùng chung các bảng `pos_orders`, `pos_payments`.
//!
//! Mỗi hàm nhận `&mut PgConnection` đã gắn công ty và trả `AppError` của K05; tầng route chỉ việc: extractor K15 →
//! `normalize()` + `validate()` → hàm ở đây → JSON. Bảng route (K14) ở [`routes`]. 18 endpoint:
//!
//! | Quyền | Endpoint | Hàm |
//! |---|---|---|
//! | `pos.sell` | `GET /pos/areas`, `/pos/tables`, `/pos/modifiers`, `/pos/settings`, `/pos/menu` | [`layout`], [`catalog`] |
//! | `pos.manage` | `POST/PATCH /pos/areas[/:id]`, `/pos/tables[/:id]`, `/pos/modifiers[/:id]`, `PATCH /pos/settings` | [`layout`], [`catalog`] |
//! | `pos.sell` | `POST /pos/shifts/open`, `GET /pos/shifts[/current]`, `GET /pos/shifts/:id/summary`, `POST /pos/shifts/:id/close` | [`shifts`] |
//! | `pos.report` | `GET /pos/reports/daily` | [`reports`] |
//!
//! Tiền là số nguyên VND (`i64`), trần [`MAX_MONEY`].

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod catalog;
pub mod layout;
pub mod reports;
pub mod routes;
pub mod shifts;

use trinity_kernel::error::HttpError;

/// Trần an toàn cho mọi số tiền (VND): 1.000 tỉ, xa dưới 2^53 nên số JSON không mất chính xác.
pub const MAX_MONEY: i64 = 1_000_000_000_000;

/// Độ dài như `String.length` của JS (đơn vị UTF-16).
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `@Transform(trim)` của class-transformer.
pub(crate) fn trim(s: &mut String) {
    let t = s.trim();
    if t.len() != s.len() {
        *s = t.to_owned();
    }
}

pub(crate) fn trim_opt(s: &mut Option<String>) {
    if let Some(v) = s {
        trim(v);
    }
}

pub(crate) fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

/// `@MaxLength(max)` rồi `@MinLength(min)` (class-validator báo theo thứ tự decorator từ dưới lên).
pub(crate) fn text(field: &str, v: &str, min: usize, max: usize, out: &mut Vec<String>) {
    let n = len16(v);
    if n > max {
        out.push(format!("{field} must be shorter than or equal to {max} characters"));
    }
    if n < min {
        out.push(format!("{field} must be longer than or equal to {min} characters"));
    }
}

/// `@Max(max)` rồi `@Min(min)` cho số nguyên.
pub(crate) fn range(field: &str, v: i64, min: i64, max: i64, out: &mut Vec<String>) {
    if v > max {
        out.push(format!("{field} must not be greater than {max}"));
    }
    if v < min {
        out.push(format!("{field} must not be less than {min}"));
    }
}

/// `Option<Option<T>>` cho trường PATCH: không có khoá = `None` (giữ nguyên), `null` = `Some(None)`.
pub(crate) fn some_nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(d).map(Some)
}

/// Người gọi, do guard xác thực (K11) điền vào; phạm vi dữ liệu của `pos.sell` (K13) truyền riêng bằng
/// [`trinity_rbac::OwnerIds`] (`None` từ `ScopeService` = không có quyền ⇒ bên gọi truyền `Ids(vec![])`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Actor {
    pub user_id: i32,
}
