//! Module khách hàng (M07), chuyển từ `services/crm/src/contacts` (14 endpoint `/api/v1/contacts`):
//!
//! | Route | Hàm |
//! |---|---|
//! | `GET /contacts` | [`list::find_all`] |
//! | `GET /contacts/export` | [`export::export_xlsx`] |
//! | `GET /contacts/search` | [`read::search`] |
//! | `GET /contacts/assignable-users` | [`read::assignable_users`] |
//! | `GET /contacts/assignable-sales` | [`transfer::assignable_sales`] |
//! | `POST /contacts/bulk-transfer`, `POST /contacts/:id/transfer` | [`transfer::bulk_transfer`], [`transfer::transfer`] |
//! | `GET /contacts/recent`, `POST /contacts/:id/viewed` | [`recent::list_recent`], [`recent::record_view`] |
//! | `GET /contacts/:id` | [`read::find_by_id`] |
//! | `POST /contacts`, `PATCH /contacts/:id` | [`write::create`], [`write::update`] |
//! | `DELETE /contacts/:id`, `POST /contacts/:id/restore` | [`write::remove`], [`write::restore`] |
//!
//! Mỗi hàm nhận kết nối đã gắn công ty (`&mut PgConnection` cho việc đọc, `&TenantDb` cho việc cần giao dịch), [`Actor`]
//! (người gọi) và [`Scopes`] (tập chủ sở hữu theo từng quyền, do tầng route lấy từ `ScopeService` của K13), và trả
//! `AppError` của K05, nên tầng route chỉ còn: guard + extractor K15 → hàm ở đây → JSON.
//! Bảng route (`specs`, 14 route) và `api_router` nằm ở [`routes`]; `trinity-bin` khai vào `declared_routes` và mount ở `serve`.
//!
//! Khác bản TS có chủ đích:
//! - thông báo "được giao thương vụ" ([`write::Created::notifications`]) ghi trong CÙNG giao dịch tạo khách (K36 chạy trong
//!   savepoint nên lỗi gửi tin không làm hỏng việc tạo); bản TS gửi sau commit. Socket nội bộ do tầng route đẩy từ danh
//!   sách trả về;
//! - việc dọn bản ghi mẫu sau khi có khách thật đầu tiên (`SampleRecordsService.purgeIfReal`), xoá cache dashboard, đồng bộ
//!   thẻ @ và đẩy socket thuộc module khác: tầng route gọi [`routes::Hooks`] (do `serve` cài) sau [`write::create`] (hàm trả
//!   `Created`) và các thao tác ghi khác, và gọi [`list::CountCache::invalidate_with`] sau khi tạo, xoá, khôi phục;
//! - cache đếm tổng của danh sách ([`list::CountCache`]) nằm trong RAM từng tiến trình, như `ReadCache` của TS; ghi thì phát
//!   `NOTIFY cache` (`p` = `crm:contacts:count:`) và `serve` chuyển tin của tiến trình khác vào
//!   [`list::CountCache::on_sync_event`] (G12b); mất kết nối ⇒ xoá hết, TTL 60 giây là lưới an toàn.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err, clippy::type_complexity)]

pub mod export;
pub mod filter;
pub mod list;
mod nullable;
pub mod read;
pub mod recent;
pub mod routes;
pub mod snapshot;
pub mod third_party;
pub mod transfer;
pub mod write;

use trinity_db::CompanyRef;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, OwnerIds, ScopeService};

/// Người gọi, đủ cho các kiểm quyền theo dữ liệu. Do guard xác thực (K11) điền vào.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub user_id: i32,
    pub is_admin: bool,
    /// Email, dùng làm tên người giao thương vụ trong thông báo (`Admin #<id>` khi không có).
    pub email: Option<String>,
}

/// Tập chủ sở hữu theo từng quyền mà module dùng; `None` = người gọi không có quyền đó (guard `@Can` đã chặn trước trong
/// luồng bình thường). `Default` = không quyền nào (mọi truy vấn theo phạm vi trả rỗng/404).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scopes {
    pub view: Option<OwnerIds>,
    pub update: Option<OwnerIds>,
    pub delete: Option<OwnerIds>,
    pub transfer: Option<OwnerIds>,
    pub phone_full: Option<OwnerIds>,
    pub deals_manage: Option<OwnerIds>,
}

impl Scopes {
    /// Phạm vi của người gọi cho mọi quyền của module (một lượt gọi `ScopeService`, có cache ở K13).
    pub async fn resolve(
        scope: &ScopeService,
        company: CompanyRef,
        user: i32,
        grants: &Grants,
    ) -> Result<Self, AppError> {
        let get = |p: &'static str| async move { scope.owner_ids(company, user, grants, p).await };
        Ok(Self {
            view: get("contacts.view").await.map_err(AppError::internal)?,
            update: get("contacts.update").await.map_err(AppError::internal)?,
            delete: get("contacts.delete").await.map_err(AppError::internal)?,
            transfer: get("contacts.transfer").await.map_err(AppError::internal)?,
            phone_full: get("contacts.phone_full").await.map_err(AppError::internal)?,
            deals_manage: get("deals.manage").await.map_err(AppError::internal)?,
        })
    }

    /// Tập chủ sở hữu rỗng khi thiếu quyền (như `scopeWhere(owner ?? [], …)`).
    pub(crate) fn view_or_empty(&self) -> OwnerIds {
        self.view.clone().unwrap_or(OwnerIds::Ids(Vec::new()))
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

/// Cửa sổ Hoàn tác phía máy chủ (`RESTORE_WINDOW_MS`).
pub const RESTORE_WINDOW_MINUTES: i32 = 10;

/// Số chữ số tối thiểu khi tra SĐT mà không có `contacts.phone_full` toàn công ty (chống dò từng chữ số).
pub const MIN_MASKED_PHONE_SEARCH_DIGITS: usize = 9;

/// Câu thông báo của một lỗi (dùng cho `failed[].error` của chuyển hàng loạt, như `err.message` của Nest).
pub(crate) fn error_message(e: &AppError) -> String {
    match e {
        AppError::Http(h) => match h.body().message {
            trinity_kernel::error::Message::One(m) => m,
            trinity_kernel::error::Message::Many(m) => m.join(", "),
        },
        other => other.to_string(),
    }
}
