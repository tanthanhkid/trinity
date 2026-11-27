//! "KHÁCH GẦN ĐÂY" ở sidebar (`ContactRecentViewsService`). Quyền được đánh giá LẠI lúc đọc (`contacts.view`), không tin
//! bảng `contact_recent_views`: khách có thể đã đổi chủ hoặc bị xoá mềm sau lần xem trước. Không hiện SĐT.

use serde::Serialize;
use sqlx::PgConnection;
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::OwnerIds;

use crate::{Actor, Scopes, assert_in_scope, db, http};

/// Giữ tối đa chừng này dòng mỗi người.
pub const CAP_PER_USER: i64 = 20;
pub const DEFAULT_LIMIT: i64 = 5;
pub const MAX_LIMIT: i64 = 10;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RecentContact {
    pub id: i32,
    pub full_name: Option<String>,
    pub viewed_at: Timestamp,
}

/// `POST /contacts/:id/viewed`: 404 nếu khách ngoài phạm vi `contacts.view` (cùng cổng với trang chi tiết).
pub async fn record_view(
    conn: &mut PgConnection,
    scopes: &Scopes,
    actor: &Actor,
    contact_id: i32,
) -> Result<(), AppError> {
    let owners: Option<(Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1 AND deleted_at IS NULL")
            .bind(contact_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((assigned_to, created_by)) = owners else {
        return Err(http(HttpError::not_found(format!(
            "Không tìm thấy khách hàng ID {contact_id}"
        ))));
    };
    assert_in_scope(scopes.view.as_ref(), &[assigned_to, created_by])?;
    sqlx::query(
        "INSERT INTO contact_recent_views (user_id, contact_id) VALUES ($1, $2)
         ON CONFLICT (user_id, contact_id) DO UPDATE SET viewed_at = now()",
    )
    .bind(actor.user_id)
    .bind(contact_id)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    sqlx::query(
        "DELETE FROM contact_recent_views WHERE user_id = $1 AND id NOT IN (
           SELECT id FROM contact_recent_views WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT $2)",
    )
    .bind(actor.user_id)
    .bind(CAP_PER_USER)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// `GET /contacts/recent?limit=`: mặc định 5, tối đa 10; bỏ khách đã xoá hoặc ngoài phạm vi hiện tại.
pub async fn list_recent(
    conn: &mut PgConnection,
    scopes: &Scopes,
    actor: &Actor,
    limit: Option<i64>,
) -> Result<Vec<RecentContact>, AppError> {
    let take = usize::try_from(limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)).unwrap_or(5);
    let rows: Vec<(i32, Option<String>, Option<i32>, Option<i32>, Timestamp)> = sqlx::query_as(
        "SELECT c.id, c.full_name, c.assigned_to, c.created_by_id, v.viewed_at
         FROM (SELECT contact_id, viewed_at FROM contact_recent_views WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT $2) v
         JOIN contacts c ON c.id = v.contact_id AND c.deleted_at IS NULL
         ORDER BY v.viewed_at DESC",
    )
    .bind(actor.user_id)
    .bind(CAP_PER_USER)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    let owner = scopes.view.clone().unwrap_or(OwnerIds::Ids(Vec::new()));
    Ok(rows
        .into_iter()
        .filter(|(_, _, assigned, created_by, _)| owner.contains_any(&[*assigned, *created_by]))
        .take(take)
        .map(|(id, full_name, _, _, viewed_at)| RecentContact {
            id,
            full_name,
            viewed_at,
        })
        .collect())
}
