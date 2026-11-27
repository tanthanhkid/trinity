//! Module lương (M29): cấu hình thành phần lương, bảo hiểm, thuế TNCN, bảng lương theo vị trí và KPI, chuyển từ
//! `services/payroll` (`salary-components`, `insurance`, `tax`, `salary-rules`, `kpi`). Phiếu lương, nhân viên lương và
//! báo cáo thuộc M30b/M31. Bộ tính lương và thuế (hàm thuần, M30a) ở [`calc`]; công thức ở [`formula`].
//!
//! Mỗi hàm nhận `&mut PgConnection` đã gắn công ty và trả `AppError` của K05; tầng route chỉ việc: extractor K15 →
//! `normalize()`/`validate()` của DTO → hàm ở đây → JSON. Bảng route (K14) ở [`routes`]. 23 endpoint:
//!
//! | Quyền | Endpoint | Module |
//! |---|---|---|
//! | `payroll.manage` | `GET/POST /salary-components`, `PATCH/DELETE /salary-components/:id` | [`components`] |
//! | `payroll.manage` | `GET/POST /insurance-settings`, `PATCH/DELETE /insurance-settings/:id` | [`insurance`] |
//! | `payroll.manage` | `GET /tax-config`, `POST /tax-config/brackets\|settings`, `PATCH/DELETE /tax-config/brackets/:id`, `PATCH /tax-config/settings/:id` | [`tax`] |
//! | `payroll.manage` | `GET/POST /salary-rules`, `GET/PATCH /salary-rules/:id` | [`rules`] |
//! | `payroll.manage` | `GET/POST /kpi/configs`, `POST /kpi/calculate\|close-month` | [`kpi`] |
//! | đăng nhập | `GET /kpi` (chỉ KPI của chính mình) | [`kpi`] |
//!
//! Tiền là số nguyên VND (`i64`); tỷ lệ và mục tiêu là `numeric` (ra JSON dạng chuỗi như `Decimal` của Prisma).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod calc;
pub mod components;
pub mod formula;
pub mod insurance;
pub mod kpi;
pub mod routes;
pub mod rules;
pub mod tax;

use serde::Deserialize;
use sqlx::{Postgres, QueryBuilder};
use trinity_kernel::error::HttpError;

/// Độ dài như `String.length` của JS (đơn vị UTF-16).
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

pub(crate) fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

/// `@IsNotEmpty()` + `@MaxLength(max)`: MaxLength báo trước.
pub(crate) fn not_empty(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    if len16(v) > max {
        out.push(format!("{field} must be shorter than or equal to {max} characters"));
    }
    if v.is_empty() {
        out.push(format!("{field} should not be empty"));
    }
}

/// `@Max(max)` rồi `@Min(min)` cho số nguyên; `None` = không chặn.
pub(crate) fn range(field: &str, v: i64, min: Option<i64>, max: Option<i64>, out: &mut Vec<String>) {
    if let Some(m) = max
        && v > m
    {
        out.push(format!("{field} must not be greater than {m}"));
    }
    if let Some(m) = min
        && v < m
    {
        out.push(format!("{field} must not be less than {m}"));
    }
}

/// Như [`range`] cho số thực.
pub(crate) fn frange(field: &str, v: f64, min: Option<f64>, max: Option<f64>, out: &mut Vec<String>) {
    if let Some(m) = max
        && v > m
    {
        out.push(format!("{field} must not be greater than {m}"));
    }
    if let Some(m) = min
        && v < m
    {
        out.push(format!("{field} must not be less than {m}"));
    }
}

/// `^\d{4}-(0[1-9]|1[0-2])$`.
pub(crate) fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && matches!((b[5], b[6]), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'))
}

pub(crate) fn month(v: &str, msg: &str, out: &mut Vec<String>) {
    if !is_month(v) {
        out.push(msg.to_owned());
    }
}

pub(crate) fn is_in(field: &str, v: &str, set: &[&str], out: &mut Vec<String>) {
    if !set.contains(&v) {
        out.push(format!(
            "{field} must be one of the following values: {}",
            set.join(", ")
        ));
    }
}

/// `Option<Option<T>>` cho trường PATCH nhận `null` (xoá): không có khoá = `None`, `null` = `Some(None)`.
pub(crate) fn some_nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    <Option<T> as Deserialize>::deserialize(d).map(Some)
}

/// Trường PATCH không nhận `null` (bản TS: `PartialType(..., { skipNullProperties: false })` vẫn kiểm kiểu khi giá trị là
/// `null`, nên `null` ⇒ 400): có khoá thì phải có giá trị thật.
pub(crate) fn not_null<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

/// Chữ số thập phân của một số thực giống `String(number)` của JS ở mọi giá trị thường gặp (không dùng dạng mũ), để ghi
/// vào cột `numeric` qua `::text::numeric`.
pub(crate) fn dec(v: f64) -> String {
    v.to_string()
}

/// `effective_to >= effective_from` (tháng `YYYY-MM` so theo chữ); `to` trống = không giới hạn.
pub(crate) fn assert_period(from: &str, to: Option<&str>) -> Result<(), trinity_kernel::error::AppError> {
    if to.is_some_and(|t| t < from) {
        return Err(HttpError::bad_request("effective_to phải lớn hơn hoặc bằng effective_from").into());
    }
    Ok(())
}

/// `, col = $n` cho giá trị bất kỳ.
pub(crate) fn set<T>(qb: &mut QueryBuilder<Postgres>, col: &str, v: T)
where
    T: 'static + sqlx::Encode<'static, Postgres> + sqlx::Type<Postgres>,
{
    qb.push(", ").push(col).push(" = ").push_bind(v);
}

/// `, col = $n::text::numeric` (`None` ⇒ `NULL`).
pub(crate) fn set_num(qb: &mut QueryBuilder<Postgres>, col: &str, v: Option<f64>) {
    qb.push(", ")
        .push(col)
        .push(" = ")
        .push_bind(v.map(dec))
        .push("::text::numeric");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thang_va_lam_tron() {
        assert!(is_month("2026-03") && is_month("2026-12") && is_month("0000-01"));
        assert!(!is_month("2026-13") && !is_month("2026-00") && !is_month("2026-3") && !is_month("2026-03 "));
        assert_eq!(dec(10.5), "10.5");
    }
}
