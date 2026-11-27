//! Phụ thuộc của các tool: DB, `ScopeService`, ngữ cảnh báo cáo; dựng `Scopes`/`Actor` của từng module từ [`Principal`] ĐÃ GIỚI
//! HẠN cho AI (không có `*.phone_full`, nên mọi SĐT đều bị che bởi chính module nghiệp vụ).

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_kernel::error::AppError;
use trinity_rbac::{ScopeService, can};

use crate::auth::Principal;
use crate::exec::ToolError;

pub struct ToolDeps {
    pub db: Db,
    pub scopes: ScopeService,
    pub reports: Arc<mod_reports::Ctx>,
}

/// `AppError` → lỗi tool theo nhánh của `failure()` bản TS: 404 ⇒ không thấy/ngoài phạm vi, 403 ⇒ từ chối, <500 ⇒ "Yêu cầu không
/// hợp lệ", còn lại ⇒ lỗi hệ thống.
pub fn app_err(e: AppError) -> ToolError {
    let (status, body) = e.response(true);
    let message = match body.message {
        trinity_kernel::error::Message::One(s) => s,
        trinity_kernel::error::Message::Many(m) => m.join("; "),
    };
    match status {
        404 => ToolError::NotFound,
        s => ToolError::Http { status: s, message },
    }
}

/// Struct Serialize → `Value` (không dùng `to_value`: lint `json-value`).
pub fn to_json<T: Serialize>(t: &T) -> Result<Value, ToolError> {
    let s = serde_json::to_string(t).map_err(|e| ToolError::Internal(e.to_string()))?;
    serde_json::from_str(&s).map_err(|e| ToolError::Internal(e.to_string()))
}

impl ToolDeps {
    pub async fn conn(&self, company: CompanyRef) -> Result<TenantConn, ToolError> {
        let t = self
            .db
            .tenant(company)
            .await
            .map_err(|e| ToolError::Internal(e.to_string()))?;
        t.acquire().await.map_err(|e| ToolError::Internal(e.to_string()))
    }

    pub async fn contact_scopes(&self, p: &Principal) -> Result<mod_contacts::Scopes, ToolError> {
        mod_contacts::Scopes::resolve(&self.scopes, p.company, p.user_id, &p.grants)
            .await
            .map_err(app_err)
    }

    pub async fn deal_scopes(&self, p: &Principal) -> Result<mod_deals::Scopes, ToolError> {
        mod_deals::Scopes::resolve(&self.scopes, p.company, p.user_id, &p.grants)
            .await
            .map_err(app_err)
    }

    pub fn report_actor(&self, p: &Principal) -> mod_reports::Actor {
        mod_reports::Actor {
            user_id: p.user_id,
            company: p.company,
            grants: p.grants.clone(),
            is_admin: false,
        }
    }

    /// Người gọi cho module kanban: quyền xem board, phạm vi thẻ và quyền Danh bạ (hiển thị khách trên thẻ). Tự mượn kết nối ngắn để
    /// đọc vai trò rồi trả NGAY: người gọi phải gọi hàm này TRƯỚC khi giữ kết nối của riêng mình (không giữ kết nối rồi xin kết nối
    /// thứ hai từ pool).
    pub async fn kanban_actor(&self, p: &Principal) -> Result<mod_kanban::Actor, ToolError> {
        let owner = |perm: &'static str| async move {
            self.scopes
                .owner_ids(p.company, p.user_id, &p.grants, perm)
                .await
                .map_err(|e| ToolError::Internal(e.to_string()))
        };
        let card_owner = owner("kanban.view").await?;
        let contact_view = owner("contacts.view").await?;
        let contact_phone_full = owner("contacts.phone_full").await?;
        let role_ids: Vec<i32> = {
            let mut conn = self.conn(p.company).await?;
            sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id = $1")
                .bind(p.user_id)
                .fetch_all(&mut *conn)
                .await
                .map_err(|e| ToolError::Internal(e.to_string()))?
        };
        Ok(mod_kanban::Actor {
            user_id: p.user_id,
            is_admin: false,
            access: mod_kanban::Access {
                can_manage_boards: can(&p.grants, "kanban.boards", None),
                role_ids,
            },
            card_owner,
            can_view_contacts: can(&p.grants, "contacts.view", None),
            contact_view,
            contact_phone_full,
        })
    }
}
