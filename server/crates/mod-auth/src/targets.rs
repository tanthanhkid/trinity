//! Danh sách ÁP DỤNG của kiểm đăng nhập theo Wi-Fi (`login-wifi-check-targets.service.ts`): roster, danh sách đã cấu hình,
//! thay toàn bộ. Quyền `settings.integrations` kiểm ở route.

use std::collections::{BTreeSet, HashMap};

use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::CompanyRef;
use trinity_kernel::error::HttpError;

use crate::dto::TargetItem;
use crate::{AuthService, GrantsSource, Res, internal};

type UserRow = (i32, String, String, bool, String);

/// Danh sách đang cấu hình kèm tên/email để hiển thị.
async fn list_in(conn: &mut PgConnection) -> Res<Value> {
    let rows: Vec<(i32, String, i32)> =
        sqlx::query_as("SELECT id, scope_type, target_user_id FROM login_wifi_check_targets ORDER BY id ASC")
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| internal("danh sách áp dụng", e))?;
    if rows.is_empty() {
        return Ok(json!([]));
    }
    let ids: Vec<i32> = rows.iter().map(|r| r.2).collect();
    let users: Vec<UserRow> = sqlx::query_as(
        "SELECT id, full_name, email, (deleted_at IS NULL) AS live, status FROM users WHERE id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| internal("người dùng được áp dụng", e))?;
    let by_id: HashMap<i32, &UserRow> = users.iter().map(|u| (u.0, u)).collect();
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, scope, target)| {
            let u = by_id.get(target);
            json!({
                "id": id,
                "scope_type": scope,
                "target_user_id": target,
                "target_name": u.map(|u| u.1.clone()),
                "target_email": u.map(|u| u.2.clone()),
                "target_active": u.is_some_and(|u| u.3 && u.4 == "active"),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

/// Đếm số id hợp lệ theo `sql` (tham số `$1` = mảng id) và so với số id khác nhau.
async fn all_valid(conn: &mut PgConnection, sql: &'static str, ids: &BTreeSet<i32>) -> Res<bool> {
    if ids.is_empty() {
        return Ok(true);
    }
    let list: Vec<i32> = ids.iter().copied().collect();
    let n: i64 = sqlx::query_scalar(sql)
        .bind(&list)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| internal("kiểm danh sách áp dụng", e))?;
    Ok(usize::try_from(n).is_ok_and(|n| n == ids.len()))
}

const VALID_TEAM: &str = "SELECT count(*) FROM users u WHERE u.id = ANY($1) AND u.deleted_at IS NULL \
     AND u.status = 'active' AND EXISTS (SELECT 1 FROM users m WHERE m.manager_id = u.id)";
const VALID_DEPARTMENT: &str = "SELECT count(*) FROM users u WHERE u.id = ANY($1) AND u.deleted_at IS NULL \
     AND u.status = 'active' AND EXISTS (SELECT 1 FROM users m WHERE m.manager_id = u.id \
     AND EXISTS (SELECT 1 FROM users g WHERE g.manager_id = m.id))";
const VALID_USER: &str =
    "SELECT count(*) FROM users u WHERE u.id = ANY($1) AND u.deleted_at IS NULL AND u.status = 'active'";

const INSERT_TARGET: &str =
    "INSERT INTO login_wifi_check_targets (scope_type, target_user_id, created_by) VALUES ($1, $2, $3)";

fn ids_of(items: &[TargetItem], scope: &str) -> BTreeSet<i32> {
    items
        .iter()
        .filter(|i| i.scope_type == scope)
        .map(|i| i.target_user_id)
        .collect()
}

/// "Phòng"/"Team" thuần cấu trúc theo cây `manager_id`.
async fn assert_valid(conn: &mut PgConnection, items: &[TargetItem]) -> Res<()> {
    if !all_valid(conn, VALID_TEAM, &ids_of(items, "team")).await? {
        return Err(HttpError::bad_request(
            "Có Team không hợp lệ (đã xoá/khoá/không đang quản lý ai) trong danh sách",
        )
        .into());
    }
    if !all_valid(conn, VALID_DEPARTMENT, &ids_of(items, "department")).await? {
        return Err(HttpError::bad_request(
            "Có Phòng không hợp lệ (đã xoá/khoá/không quản lý cấp trung gian) trong danh sách",
        )
        .into());
    }
    if !all_valid(conn, VALID_USER, &ids_of(items, "user")).await? {
        return Err(HttpError::bad_request("Có nhân viên không hợp lệ (đã xoá/khoá) trong danh sách").into());
    }
    Ok(())
}

impl<G: GrantsSource> AuthService<G> {
    /// `GET /auth/settings/login-wifi-check-targets/roster`.
    pub async fn targets_roster(&self, company: CompanyRef) -> Res<Value> {
        let mut c = self.conn(company).await?;
        let users: Vec<(i32, String, String, Option<i32>)> = sqlx::query_as(
            "SELECT id, full_name, email, manager_id FROM users WHERE deleted_at IS NULL ORDER BY full_name ASC, id ASC",
        )
        .fetch_all(&mut *c)
        .await
        .map_err(|e| internal("roster", e))?;
        let roles: Vec<(i32, String)> = sqlx::query_as(
            "SELECT ur.user_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id ORDER BY ur.id",
        )
        .fetch_all(&mut *c)
        .await
        .map_err(|e| internal("vai trò roster", e))?;
        let mut by_user: HashMap<i32, Vec<String>> = HashMap::new();
        for (user, name) in roles {
            by_user.entry(user).or_default().push(name);
        }
        let out: Vec<Value> = users
            .into_iter()
            .map(|(id, full_name, email, manager_id)| {
                json!({
                    "id": id,
                    "full_name": full_name,
                    "email": email,
                    "roles": by_user.remove(&id).unwrap_or_default(),
                    "manager_id": manager_id,
                })
            })
            .collect();
        Ok(Value::Array(out))
    }

    /// `GET /auth/settings/login-wifi-check-targets`.
    pub async fn targets_list(&self, company: CompanyRef) -> Res<Value> {
        let mut c = self.conn(company).await?;
        list_in(&mut c).await
    }

    /// `PUT /auth/settings/login-wifi-check-targets`: thay TOÀN BỘ danh sách (rỗng = xoá sạch).
    pub async fn targets_replace(&self, company: CompanyRef, items: &[TargetItem], actor: i32) -> Res<Value> {
        let mut deduped: Vec<TargetItem> = Vec::new();
        for i in items {
            if !deduped.contains(i) {
                deduped.push(i.clone());
            }
        }
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(|e| internal("tenant", e))?
            .begin()
            .await
            .map_err(|e| internal("begin", e))?;
        assert_valid(&mut tx, &deduped).await?;
        sqlx::query("DELETE FROM login_wifi_check_targets")
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("xoá danh sách áp dụng", e))?;
        for i in &deduped {
            sqlx::query(INSERT_TARGET)
                .bind(&i.scope_type)
                .bind(i.target_user_id)
                .bind(actor)
                .execute(&mut *tx)
                .await
                .map_err(|e| internal("ghi danh sách áp dụng", e))?;
        }
        let out = list_in(&mut tx).await?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        Ok(out)
    }
}
