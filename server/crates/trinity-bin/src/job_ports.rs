//! Cổng cho các job nền đăng ký ở `serve.rs`: cờ tính năng theo từng công ty cho job leads, và phạm vi quyền của chủ endpoint
//! webhook ra (`ActorProvider`).

use sqlx::PgConnection;
use trinity_db::{CompanyRef, TenantDb};
use trinity_integrations::webhooks::actors::{ActorFuture, ActorProvider};
use trinity_integrations::webhooks::payload::{ActorScopes, Scope as WhScope};
use trinity_rbac::{OwnerIds, PermissionService, ScopeService};

/// `OrgFeaturesService.isEnabled` cho một công ty, đọc trên chính kết nối job đang giữ (không xin thêm kết nối); đọc lỗi coi
/// là bật (fail-open).
pub struct CompanyFeatures {
    pub company: CompanyRef,
    pub multi_tenant: bool,
}

impl mod_leads::Features for CompanyFeatures {
    async fn enabled(&self, conn: &mut PgConnection, key: &str) -> bool {
        let ctx = mod_settings::Ctx {
            company_id: self.multi_tenant.then_some(self.company.id()),
        };
        match mod_settings::features::get(conn, ctx).await {
            Ok(flags) => flags
                .0
                .iter()
                .find(|(k, _)| *k == key)
                .is_none_or(|(_, on)| on.unwrap_or(true)),
            Err(_) => true,
        }
    }
}

/// Phạm vi của chủ endpoint webhook ra, tính từ quyền trong DB (không từ JWT). `None` khi tài khoản bị xoá/khoá hoặc không còn
/// quyền `integrations.webhooks`.
pub struct RbacActors {
    pub permissions: PermissionService,
    pub scopes: ScopeService,
}

fn to_webhook_scope(o: Option<OwnerIds>) -> WhScope {
    match o {
        Some(OwnerIds::All) => WhScope::All,
        Some(OwnerIds::Ids(ids)) => WhScope::Owners(ids),
        None => WhScope::None,
    }
}

impl RbacActors {
    async fn load(&self, tenant: &TenantDb, user: i32) -> Result<Option<ActorScopes>, String> {
        let company = tenant.company();
        let mut conn = tenant.acquire().await.map_err(|e| e.to_string())?;
        let account: Option<(bool, String)> =
            sqlx::query_as("SELECT (deleted_at IS NOT NULL), status FROM users WHERE id = $1")
                .bind(user)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
        if !matches!(account, Some((false, ref status)) if status == "active") {
            return Ok(None);
        }
        let role_ids: Vec<(i32,)> = sqlx::query_as("SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id")
            .bind(user)
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        drop(conn);
        let granted = self
            .permissions
            .grants_for(company, user)
            .await
            .map_err(|e| e.to_string())?;
        let grants = &granted.grants;
        if !grants.contains_key("integrations.webhooks") {
            return Ok(None);
        }
        let owners = |permission: &'static str| async move {
            self.scopes
                .owner_ids(company, user, grants, permission)
                .await
                .map(to_webhook_scope)
                .map_err(|e| e.to_string())
        };
        Ok(Some(ActorScopes {
            contacts_view: owners("contacts.view").await?,
            deals_view: owners("deals.view").await?,
            pos_sell: owners("pos.sell").await?,
            phone_full: owners("contacts.phone_full").await?,
            custom_view: owners("custom_records.view").await?,
            custom_phone_full: owners("custom_records.phone_full").await?,
            role_ids: role_ids.into_iter().map(|r| r.0).collect(),
            can_manage_custom_objects: grants.contains_key("custom_objects.manage"),
            can_social_post: granted.is_admin || grants.contains_key("social.post"),
        }))
    }
}

impl ActorProvider for RbacActors {
    fn scopes_for<'a>(&'a self, tenant: &'a TenantDb, user_id: i32) -> ActorFuture<'a> {
        Box::pin(self.load(tenant, user_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_ids_doi_sang_scope_webhook() {
        assert_eq!(to_webhook_scope(None), WhScope::None);
        assert_eq!(to_webhook_scope(Some(OwnerIds::All)), WhScope::All);
        assert_eq!(to_webhook_scope(Some(OwnerIds::Ids(vec![1, 2]))), WhScope::Owners(vec![1, 2]));
    }
}
