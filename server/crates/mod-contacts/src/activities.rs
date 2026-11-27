//! Dòng thời gian hoạt động của một khách (`GET /contacts/:contactId/activities`, `ActivitiesController.findByContact`).
//!
//! Route chỉ đòi đăng nhập (`AuthOnly`) nhưng KHÔNG được để lộ timeline theo id: cổng thật là phạm vi `contacts.view` trên
//! chủ sở hữu của khách (`assigned_to`, `created_by_id`), ngoài phạm vi ⇒ 404 như `GET /contacts/:id`. Khách không tồn tại ⇒
//! 404 `Không tìm thấy khách hàng ID <id>` (bản TS không lọc `deleted_at` ở bước kiểm này nên bản Rust cũng không lọc).

use serde::Serialize;
use sqlx::PgConnection;
use trinity_db::types::{JsonValue, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::OwnerIds;

use crate::{assert_in_scope, db, http};

/// Trần và mặc định của một trang (`MAX_LIMIT`, `DEFAULT_LIMIT`).
pub const MAX_LIMIT: i64 = 200;
pub const DEFAULT_LIMIT: i64 = 20;

/// Một hoạt động kèm người tạo (`ACTIVITY_SELECT` + `user`); `user` là `null` khi không có `created_by` hoặc người đó đã xoá.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ActivityItem {
    pub id: i32,
    pub contact_id: Option<i32>,
    pub action: String,
    pub details: Option<JsonValue>,
    pub metadata: Option<JsonValue>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub user: Option<JsonValue>,
}

/// Trang hoạt động, mới nhất trước.
#[derive(Debug, Serialize)]
pub struct ActivityPage {
    pub data: Vec<ActivityItem>,
    pub next_cursor: Option<i32>,
}

/// `Number(cursor)` của bản TS rồi truyền cho Prisma: `0`/rỗng ⇒ không có con trỏ (falsy); không phải số nguyên int4 ⇒
/// Prisma báo lỗi kiểu, tức 500 (không phải 400).
pub fn parse_cursor(raw: Option<&str>) -> Result<Option<i32>, AppError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let n: f64 = raw
        .trim()
        .parse()
        .map_err(|_| AppError::internal(format!("cursor không phải số: {raw}")))?;
    if n == 0.0 {
        return Ok(None);
    }
    if n.fract() != 0.0 || n < f64::from(i32::MIN) || n > f64::from(i32::MAX) {
        return Err(AppError::internal(format!("cursor ngoài int4: {raw}")));
    }
    Ok(Some(n as i32))
}

/// `Math.min(Math.max(Number(limit) || 20, 1), 200)`: thiếu/rỗng/`0`/rác ⇒ 20; số thực không nguyên ⇒ Prisma báo lỗi (500).
pub fn parse_limit(raw: Option<&str>) -> Result<i64, AppError> {
    let n = raw
        .filter(|s| !s.is_empty())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(DEFAULT_LIMIT as f64);
    let n = n.clamp(1.0, MAX_LIMIT as f64);
    if n.fract() != 0.0 {
        return Err(AppError::internal(format!("limit không phải số nguyên: {n}")));
    }
    Ok(n as i64)
}

/// `GET /contacts/:contactId/activities`: kiểm khách tồn tại và trong phạm vi `contacts.view` rồi đọc trang. Con trỏ không
/// còn trong bảng ⇒ trang rỗng (như Prisma).
pub async fn find_by_contact(
    conn: &mut PgConnection,
    view: Option<&OwnerIds>,
    contact_id: i32,
    cursor: Option<i32>,
    limit: i64,
) -> Result<ActivityPage, AppError> {
    let owners: Option<(Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1")
            .bind(contact_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let (assigned_to, created_by) = owners.ok_or_else(|| {
        http(HttpError::not_found(format!(
            "Không tìm thấy khách hàng ID {contact_id}"
        )))
    })?;
    assert_in_scope(view, &[assigned_to, created_by])?;

    if let Some(c) = cursor {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM activities WHERE id = $1)")
            .bind(c)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
        if !exists {
            return Ok(ActivityPage {
                data: Vec::new(),
                next_cursor: None,
            });
        }
    }
    let mut data: Vec<ActivityItem> = sqlx::query_as(
        "SELECT a.id, a.contact_id, a.action, a.details, a.metadata, a.created_by, a.created_at,
           (SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'avatar_url', u.avatar_url)
            FROM users u WHERE u.id = a.created_by) AS \"user\"
         FROM activities a WHERE a.contact_id = $1 AND ($2::int4 IS NULL OR a.id < $2)
         ORDER BY a.id DESC LIMIT $3",
    )
    .bind(contact_id)
    .bind(cursor)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let has_more = data.len() as i64 > limit;
    if has_more {
        data.truncate(limit as usize);
    }
    let next_cursor = if has_more { data.last().map(|a| a.id) } else { None };
    Ok(ActivityPage { data, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn con_tro_nhu_number_cua_js() {
        assert_eq!(parse_cursor(None).unwrap(), None);
        assert_eq!(parse_cursor(Some("")).unwrap(), None);
        assert_eq!(parse_cursor(Some("0")).unwrap(), None);
        assert_eq!(parse_cursor(Some("42")).unwrap(), Some(42));
        assert_eq!(parse_cursor(Some("42.0")).unwrap(), Some(42));
        assert!(parse_cursor(Some("abc")).is_err());
        assert!(parse_cursor(Some("1.5")).is_err());
        assert!(parse_cursor(Some("3000000000")).is_err());
    }

    #[test]
    fn gioi_han_nhu_math_min_max() {
        assert_eq!(parse_limit(None).unwrap(), 20);
        assert_eq!(parse_limit(Some("abc")).unwrap(), 20);
        assert_eq!(parse_limit(Some("0")).unwrap(), 20);
        assert_eq!(parse_limit(Some("-5")).unwrap(), 1);
        assert_eq!(parse_limit(Some("999")).unwrap(), 200);
        assert_eq!(parse_limit(Some("7")).unwrap(), 7);
        assert!(parse_limit(Some("2.5")).is_err());
    }
}
