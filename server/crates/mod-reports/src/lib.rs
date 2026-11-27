//! Báo cáo tổng quan (M20, docs/rust/PLAN.md mục 1.2): 7 route `/api/v1/reports/…` chuyển từ `services/crm/src/reports`.
//!
//! | Route | Hàm |
//! |---|---|
//! | `GET /reports/overview` | [`overview::get`] |
//! | `GET /reports/dashboard-overview` | [`dashboard::get_overview`] (cache 300 giây) |
//! | `GET /reports/dashboard-tasks` | [`tasks::get`] |
//! | `GET /reports/dashboard-filter-roster` | [`roster::get`] |
//! | `GET /reports/dashboard-channels` | [`channels::get`] |
//! | `GET /reports/dashboard-stats-today` | [`stats_today::get`] (cache 15 giây) |
//! | `GET /reports/dashboard-trend-14d` | [`trend::get`] (cache 120 giây) |
//!
//! Mỗi hàm nhận [`Ctx`] và [`Actor`] (do guard của router điền), trả `Value` đúng hình dạng bản TS. Router nối ở [`routes`].

#![allow(clippy::result_large_err)]

pub mod cache;
pub mod channels;
pub mod dashboard;
pub mod filter;
pub mod overview;
pub mod period;
pub mod roster;
pub mod routes;
pub mod stats_today;
pub mod tasks;
pub mod trend;

use chrono::{DateTime, Utc};
use trinity_db::pg_error::app_error;
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::AppError;
use trinity_rbac::{Grants, OwnerIds, ScopeService};

pub use routes::{api_router, specs};

pub type R<T> = Result<T, AppError>;

/// Phụ thuộc của module.
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
    pub cache: cache::ReadCache,
}

impl Ctx {
    pub async fn conn(&self, company: CompanyRef) -> R<trinity_db::TenantConn> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.acquire().await.map_err(AppError::internal)
    }

    /// Tập chủ sở hữu của một quyền (`None` = không có quyền).
    pub async fn owner_ids(&self, actor: &Actor, permission: &str) -> R<Option<OwnerIds>> {
        self.scopes
            .owner_ids(actor.company, actor.user_id, &actor.grants, permission)
            .await
            .map_err(AppError::internal)
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

/// Chuỗi khoá cache theo tập chủ sở hữu: `none` / `all` / id đã sắp nối `-`.
pub(crate) fn owner_part(o: Option<&OwnerIds>) -> String {
    match o {
        None => "none".to_owned(),
        Some(OwnerIds::All) => "all".to_owned(),
        Some(OwnerIds::Ids(v)) => {
            let mut v = v.clone();
            v.sort_unstable();
            v.iter().map(i32::to_string).collect::<Vec<_>>().join("-")
        }
    }
}

pub(crate) fn now() -> DateTime<Utc> {
    Utc::now()
}

/// `Date.toISOString()`: mili giây, hậu tố `Z`.
pub(crate) fn iso(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
