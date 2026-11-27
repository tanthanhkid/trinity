//! Module hoạt động, thương vụ và dòng tương tác (M08), chuyển từ `services/crm/src/{activities,deals,interactions}`
//! (10 endpoint):
//!
//! | Route | Hàm |
//! |---|---|
//! | `GET /contacts/:contactId/activities` | [`activities::find_by_contact`] |
//! | `GET /deals`, `GET /deals/:id` | [`deals::find_all`], [`deals::find_one`] |
//! | `POST /deals`, `PATCH /deals/:id`, `DELETE /deals/:id` | [`deals::create`], [`deals::update`], [`deals::remove`] |
//! | `GET /deals/search-sales` | [`deals::search_sales`] |
//! | `GET /interactions`, `GET /interactions/stats` | [`interactions::list`], [`interactions::stats`] |
//! | `GET /interactions/comments/:id/thread` | [`interactions::thread`] |
//!
//! Dựa trên `mod-contacts`: dùng chung [`Actor`] và ảnh chụp thương vụ cho sự kiện outbox. Cách nối giống M07: mỗi hàm nhận
//! kết nối đã gắn công ty (`&mut PgConnection` cho việc đọc, `&TenantDb` cho việc cần giao dịch), [`Scopes`] do tầng route
//! lấy từ `ScopeService` (K13) và trả `AppError`; bảng route ở [`routes`] được `trinity-bin` so với `routes.json` (K14).
//!
//! Khác bản TS có chủ đích:
//! - thông báo "được giao thương vụ" ([`deals::Created::notifications`]) tạo trong CÙNG giao dịch tạo thương vụ nhưng trong
//!   SAVEPOINT: lỗi tạo thông báo chỉ rollback phần thông báo (ghi log), thương vụ và sự kiện outbox vẫn commit; bản TS gửi
//!   sau commit và nuốt lỗi. Socket nội bộ do tầng route đẩy từ danh sách trả về (rỗng khi lỗi);
//! - công tắc tính năng của tổ chức ([`interactions::Sources`]) tính từ `OrgFeatures` do tầng route nạp (K25), không đọc
//!   `settings` ở đây.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err, clippy::type_complexity)]

pub mod activities;
pub mod deals;
pub mod interactions;
mod nullable;
pub mod routes;

pub use mod_contacts::Actor;

use trinity_db::CompanyRef;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, OwnerIds, ScopeService};

/// Tập chủ sở hữu theo từng quyền mà module dùng; `None` = người gọi không có quyền đó (guard `@Can` đã chặn trước trong
/// luồng bình thường). `Default` = không quyền nào.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scopes {
    pub deals_view: Option<OwnerIds>,
    pub deals_manage: Option<OwnerIds>,
    pub deals_delete: Option<OwnerIds>,
    pub contacts_view: Option<OwnerIds>,
    pub phone_full: Option<OwnerIds>,
}

impl Scopes {
    /// Phạm vi của người gọi cho mọi quyền của module (có cache ở K13).
    pub async fn resolve(
        scope: &ScopeService,
        company: CompanyRef,
        user: i32,
        grants: &Grants,
    ) -> Result<Self, AppError> {
        let get = |p: &'static str| async move { scope.owner_ids(company, user, grants, p).await };
        Ok(Self {
            deals_view: get("deals.view").await.map_err(AppError::internal)?,
            deals_manage: get("deals.manage").await.map_err(AppError::internal)?,
            deals_delete: get("deals.delete").await.map_err(AppError::internal)?,
            contacts_view: get("contacts.view").await.map_err(AppError::internal)?,
            phone_full: get("contacts.phone_full").await.map_err(AppError::internal)?,
        })
    }

    pub(crate) fn masker(&self) -> trinity_rbac::PhoneMasker {
        trinity_rbac::PhoneMasker::new(self.phone_full.clone())
    }
}

/// `owner` có phủ người dùng `id` không (`'all'` hoặc nằm trong mảng).
pub(crate) fn covers(owner: Option<&OwnerIds>, id: i32) -> bool {
    match owner {
        Some(OwnerIds::All) => true,
        Some(OwnerIds::Ids(ids)) => ids.contains(&id),
        None => false,
    }
}

/// `assertInScope`: ngoài phạm vi ⇒ 404 "Không tìm thấy".
pub(crate) fn assert_in_scope(allowed: Option<&OwnerIds>, owners: &[Option<i32>]) -> Result<(), AppError> {
    trinity_rbac::assert_in_scope(allowed, owners).map_err(|e| AppError::Http(*e))
}

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

pub(crate) fn http(e: HttpError) -> AppError {
    AppError::Http(e)
}
