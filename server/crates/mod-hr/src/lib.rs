//! Module nhân sự (M09 team và chức danh; M10 nhân viên và giai đoạn làm việc), chuyển từ `services/crm` (`teams`,
//! `job-titles`, `employees`). Nhân viên: [`employees`] (đọc, thống kê), [`employees_write`] (thêm, sửa, khoá, mở khoá, xoá),
//! [`employees_export`] (xlsx), [`routes`] (12 route `management/employees`, DTO kiểm bằng metadata class-validator thật).
//!
//! Mỗi hàm nhận `&mut PgConnection` đã gắn công ty (`TenantConn`/`TenantTx` deref ra kiểu này) và trả `AppError`
//! của K05; tầng route chỉ việc: extractor K15 → `validate()` → hàm ở đây → JSON. Quyền: `org.manage` cho mọi
//! endpoint ghi và cho `GET /management/teams`, `…/members`; `for-filter`, `lead-filter` và `job-titles` GET chỉ cần
//! đăng nhập (`contracts/routes.json`). 14 endpoint:
//!
//! | Endpoint | Hàm |
//! |---|---|
//! | `GET/POST /management/teams` | [`teams::find_all`], [`teams::create`] |
//! | `PATCH/DELETE /management/teams/:id` | [`teams::update`], [`teams::remove`] |
//! | `GET/POST /management/teams/:id/members` | [`teams::list_members`], [`teams::add_members`] |
//! | `DELETE /management/teams/:id/members/:userId` | [`teams::remove_member`] |
//! | `GET /management/teams/for-filter`, `/lead-filter` | [`teams::list_for_filter`], [`teams::list_team_lead_filter`] |
//! | `GET/POST /management/job-titles` | [`job_titles::find_all`], [`job_titles::create`] |
//! | `GET/PATCH/DELETE /management/job-titles/:id` | [`job_titles::find_one`], [`job_titles::update`], [`job_titles::remove`] |
//!
//! M12 (tuyển dụng, 10 endpoint `/management/recruitment/*`) ở [`recruitment`].

pub mod employee_dto;
pub mod employees;
pub mod employees_export;
pub mod employees_write;
pub mod job_titles;
mod nullable;
pub mod recruitment;
pub mod routes;
pub mod teams;

/// Độ dài như `String.length` của JS (đơn vị UTF-16), cho `@MinLength`/`@MaxLength`/`@Length`.
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `{ ok: true }` của `remove`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct OkBody {
    pub ok: bool,
}

pub(crate) const OK: OkBody = OkBody { ok: true };

/// `{ ok: true, id }` của `remove` (tuyển dụng).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct OkIdBody {
    pub ok: bool,
    pub id: i32,
}

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> trinity_kernel::error::AppError {
    trinity_db::pg_error::app_error(&e)
}

/// `Number(v)` của JS cho giá trị JSON; `None` khi ra NaN (hoặc `null`, vì `@Type` không đổi `null`).
pub(crate) fn js_number(v: &serde_json::Value) -> Option<f64> {
    use serde_json::Value;
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok().filter(|f| f.is_finite())
            }
        }
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}
