//! Module nhân sự (M09 team và chức danh), chuyển từ `services/crm` (`teams`, `job-titles`).
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

pub mod job_titles;
mod nullable;
pub mod teams;

/// Độ dài như `String.length` của JS (đơn vị UTF-16), cho `@MinLength`/`@MaxLength`/`@Length`.
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `{ ok: true }` của `remove`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Ok {
    pub ok: bool,
}

pub(crate) const OK: Ok = Ok { ok: true };

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> trinity_kernel::error::AppError {
    trinity_db::pg_error::app_error(&e)
}
