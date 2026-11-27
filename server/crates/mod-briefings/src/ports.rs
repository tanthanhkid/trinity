//! Cài đặt thật của [`Ports`] trên `trinity-rbac` và cờ tổ chức của `mod-settings`: người nhận, phạm vi `reports.overview`
//! và cờ `ai_briefing`.
//!
//! Mọi truy vấn chạy trên kết nối bên gọi đưa vào (không xin thêm kết nối từ pool): `run_slot` đang giữ MỘT kết nối khi gọi
//! [`Ports::owners_for`], nên không dùng `PermissionService`/`ScopeService` (hai dịch vụ đó tự mượn kết nối).

use sqlx::PgConnection;
use trinity_db::CompanyRef;
use trinity_rbac::{Grant, Scope, normalize_grant};

use crate::service::{PERMISSION, Ports, roster_with_permission};
use crate::types::Owners;

/// Khoá cờ tổ chức của bản tin.
pub const FEATURE: &str = "ai_briefing";

/// [`Ports`] của MỘT công ty (cờ gói phụ thuộc công ty khi nhiều công ty).
#[derive(Debug, Clone, Copy)]
pub struct RbacPorts {
    pub company: CompanyRef,
    /// `Db::multi_tenant()`: chỉ khi nhiều công ty mới đọc gói theo công ty.
    pub multi_tenant: bool,
}

impl RbacPorts {
    pub fn new(company: CompanyRef, multi_tenant: bool) -> Self {
        Self { company, multi_tenant }
    }
}

/// Phạm vi rộng nhất của [`PERMISSION`] trong các vai trò người dùng giữ. `None` = không có quyền; `Some(None)` = vai trò hệ
/// thống (mọi quyền, phạm vi `all`).
async fn widest_scope(conn: &mut PgConnection, user_id: i32) -> Result<Option<Scope>, sqlx::Error> {
    let rows: Vec<(bool, bool, Option<String>)> = sqlx::query_as(
        "SELECT r.is_system, rp.permission IS NOT NULL, rp.scope
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = $2
         WHERE ur.user_id = $1",
    )
    .bind(user_id)
    .bind(PERMISSION)
    .fetch_all(&mut *conn)
    .await?;
    let mut best: Option<Scope> = None;
    for (is_system, has, scope) in rows {
        if is_system {
            return Ok(Some(Scope::All));
        }
        if !has {
            continue;
        }
        if let Some(Grant::Scope(s)) = normalize_grant(PERMISSION, scope.as_deref()) {
            best = Some(best.map_or(s, |b| b.max(s)));
        }
    }
    Ok(best)
}

/// Người dùng trong phạm vi: `team` = mình và cấp dưới trực tiếp, `subtree` = cả cây `manager_id` (như `ScopeService`).
async fn scope_ids(conn: &mut PgConnection, user_id: i32, scope: Scope) -> Result<Vec<i32>, sqlx::Error> {
    match scope {
        Scope::All => Ok(Vec::new()),
        Scope::Own => Ok(vec![user_id]),
        Scope::Team => {
            let mut ids = vec![user_id];
            let rows: Vec<(i32,)> = sqlx::query_as("SELECT id FROM users WHERE manager_id = $1 ORDER BY id")
                .bind(user_id)
                .fetch_all(&mut *conn)
                .await?;
            ids.extend(rows.into_iter().map(|r| r.0));
            Ok(ids)
        }
        Scope::Subtree => {
            // UNION (không ALL) loại trùng: vòng lặp manager không treo.
            let rows: Vec<(i32,)> = sqlx::query_as(
                "WITH RECURSIVE t(id) AS (
                   SELECT $1::int
                   UNION
                   SELECT u.id FROM users u JOIN t ON u.manager_id = t.id
                 ) SELECT id FROM t ORDER BY id",
            )
            .bind(user_id)
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows.into_iter().map(|r| r.0).collect())
        }
    }
}

impl Ports for RbacPorts {
    async fn feature_on(&self, conn: &mut PgConnection) -> bool {
        let ctx = mod_settings::Ctx {
            company_id: self.multi_tenant.then_some(self.company.id()),
        };
        let feature = FEATURE;
        // Như `OrgFeaturesService.isEnabled`: lỗi đọc coi là bật (fail-open).
        match mod_settings::features::get(conn, ctx).await {
            Ok(flags) => flags
                .0
                .iter()
                .find(|(key, _)| *key == feature)
                .is_none_or(|(_, on)| on.unwrap_or(true)),
            Err(_) => true,
        }
    }

    async fn recipients(&self, conn: &mut PgConnection) -> Vec<i32> {
        match roster_with_permission(conn, PERMISSION).await {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("Đọc danh sách người nhận bản tin lỗi: {e}");
                Vec::new()
            }
        }
    }

    async fn owners_for(&self, conn: &mut PgConnection, user_id: i32, _email: &str) -> Option<Owners> {
        let scope = match widest_scope(conn, user_id).await {
            Ok(Some(s)) => s,
            Ok(None) => return None,
            Err(e) => {
                tracing::warn!("Đọc quyền của người dùng {user_id} lỗi: {e}");
                return None;
            }
        };
        if scope == Scope::All {
            return Some(Owners::All);
        }
        match scope_ids(conn, user_id, scope).await {
            Ok(ids) => Some(Owners::Users(ids)),
            Err(e) => {
                tracing::warn!("Đọc phạm vi của người dùng {user_id} lỗi: {e}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khoa_co_dung_ten() {
        assert_eq!(FEATURE, "ai_briefing");
    }

    #[test]
    fn quyen_xem_bao_cao_la_quyen_co_pham_vi() {
        // Thiếu hoặc sai phạm vi ⇒ hẹp nhất (own), không bao giờ nới.
        assert_eq!(
            normalize_grant(PERMISSION, None),
            Some(Grant::Scope(Scope::Own)),
            "reports.overview phải là quyền có phạm vi trong catalog"
        );
        assert_eq!(
            normalize_grant(PERMISSION, Some("subtree")),
            Some(Grant::Scope(Scope::Subtree))
        );
    }
}
