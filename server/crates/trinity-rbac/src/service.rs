//! Quyền của người dùng (`PermissionService.grantsFor`) và phạm vi theo cây quản lý (`ScopeService.ownerIds`).

use std::sync::Arc;

use sqlx::Row;
use trinity_db::{CompanyRef, Db, DbError};

use crate::cache::RbacCache;
use crate::catalog::catalog;
use crate::grants::{Grant, Grants, Scope, merge_grants, normalize_grant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantsResult {
    pub grants: Grants,
    pub is_admin: bool,
}

/// Vai trò hệ thống ("Quản trị") = mọi quyền, phạm vi `all` cho quyền scoped.
pub fn admin_grants() -> Grants {
    catalog()
        .permissions()
        .iter()
        .map(|p| {
            (
                p.key.clone(),
                if p.scoped {
                    Grant::Scope(Scope::All)
                } else {
                    Grant::Full
                },
            )
        })
        .collect()
}

/// `grants(user) = ⋃ role_permissions của mọi vai trò user giữ`, trùng quyền lấy phạm vi rộng nhất; có vai trò hệ thống
/// ⇒ admin. Cache RAM 60 giây theo (công ty, người dùng).
#[derive(Clone)]
pub struct PermissionService {
    db: Db,
    cache: Arc<RbacCache>,
}

impl PermissionService {
    pub fn new(db: Db, cache: Arc<RbacCache>) -> Self {
        Self { db, cache }
    }

    pub fn cache(&self) -> &Arc<RbacCache> {
        &self.cache
    }

    pub async fn grants_for(&self, company: CompanyRef, user: i32) -> Result<Arc<GrantsResult>, DbError> {
        if let Some(hit) = self.cache.get_grants(company.id(), user) {
            return Ok(hit);
        }
        let tenant = self.db.tenant(company).await?;
        let mut conn = tenant.acquire().await?;
        let rows = sqlx::query(
            "SELECT r.id AS role_id, r.is_system, rp.permission, rp.scope
             FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             LEFT JOIN role_permissions rp ON rp.role_id = r.id
             WHERE ur.user_id = $1",
        )
        .bind(user)
        .fetch_all(&mut *conn)
        .await?;
        let is_admin = rows.iter().any(|r| r.get::<bool, _>("is_system"));
        let grants = if is_admin {
            admin_grants()
        } else {
            let mut per_role: std::collections::BTreeMap<i32, Grants> = std::collections::BTreeMap::new();
            for r in &rows {
                let g = per_role.entry(r.get("role_id")).or_default();
                let perm: Option<String> = r.get("permission");
                let scope: Option<String> = r.get("scope");
                if let Some(v) = perm.and_then(|p| normalize_grant(&p, scope.as_deref()).map(|v| (p, v))) {
                    g.insert(v.0, v.1);
                }
            }
            merge_grants(per_role.values())
        };
        Ok(self
            .cache
            .set_grants(company.id(), user, GrantsResult { grants, is_admin }))
    }
}

/// Tập user id "sở hữu" hợp lệ cho một quyền.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerIds {
    All,
    /// Không có thứ tự bảo đảm (dùng như tập).
    Ids(Vec<i32>),
}

/// Chỉ theo cây `users.manager_id`, không dùng `team_id`.
#[derive(Clone)]
pub struct ScopeService {
    db: Db,
    cache: Arc<RbacCache>,
}

impl ScopeService {
    pub fn new(db: Db, cache: Arc<RbacCache>) -> Self {
        Self { db, cache }
    }

    /// `None` = user không có quyền này (guard `@Can` đã chặn trước trong luồng bình thường).
    pub async fn owner_ids(
        &self,
        company: CompanyRef,
        user: i32,
        grants: &Grants,
        permission: &str,
    ) -> Result<Option<OwnerIds>, DbError> {
        let scope = match grants.get(permission) {
            None => return Ok(None),
            Some(Grant::Full | Grant::Scope(Scope::All)) => return Ok(Some(OwnerIds::All)),
            Some(Grant::Scope(Scope::Own)) => return Ok(Some(OwnerIds::Ids(vec![user]))),
            Some(Grant::Scope(s)) => *s,
        };
        if let Some(hit) = self.cache.get_scope(company.id(), user, scope) {
            return Ok(Some(OwnerIds::Ids((*hit).clone())));
        }
        let tenant = self.db.tenant(company).await?;
        let mut conn = tenant.acquire().await?;
        let ids: Vec<i32> = if scope == Scope::Team {
            let mut v = vec![user];
            let rows: Vec<(i32,)> = sqlx::query_as("SELECT id FROM users WHERE manager_id = $1 ORDER BY id")
                .bind(user)
                .fetch_all(&mut *conn)
                .await?;
            v.extend(rows.into_iter().map(|r| r.0));
            v
        } else {
            // UNION (không ALL) loại trùng: vòng lặp manager không treo.
            let rows: Vec<(i32,)> = sqlx::query_as(
                "WITH RECURSIVE t(id) AS (
                   SELECT $1::int
                   UNION
                   SELECT u.id FROM users u JOIN t ON u.manager_id = t.id
                 ) SELECT id FROM t ORDER BY id",
            )
            .bind(user)
            .fetch_all(&mut *conn)
            .await?;
            rows.into_iter().map(|r| r.0).collect()
        };
        self.cache.set_scope(company.id(), user, scope, ids.clone());
        Ok(Some(OwnerIds::Ids(ids)))
    }
}
