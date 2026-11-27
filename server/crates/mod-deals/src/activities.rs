//! `GET /contacts/:contactId/activities`: dòng thời gian hoạt động của một khách (`ActivitiesController.findByContact`).
//!
//! Chỉ cần đăng nhập, nên cổng `contacts.view` viết thẳng ở đây: `activities` gom dữ liệu nhiều module (ghi chú nội bộ,
//! lịch sử chuyển khách), không có cổng riêng thì rò theo cả bảng. Ngoài phạm vi ⇒ 404 (id đến thẳng từ URL).

use serde::Serialize;
use sqlx::PgConnection;
use trinity_db::types::{JsonValue, Timestamp};
use trinity_kernel::error::{AppError, HttpError};

use crate::{Scopes, assert_in_scope, db, http};

const MAX_LIMIT: i64 = 200;
const DEFAULT_LIMIT: i64 = 20;

/// Người tạo như `attachCreators` (một truy vấn cho cả trang, không N+1).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Creator {
    pub id: i32,
    pub full_name: String,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct Row {
    id: i32,
    contact_id: Option<i32>,
    action: String,
    details: Option<JsonValue>,
    metadata: Option<JsonValue>,
    created_by: Option<i32>,
    created_at: Timestamp,
}

#[derive(Debug, Serialize)]
pub struct Activity {
    pub id: i32,
    pub contact_id: Option<i32>,
    pub action: String,
    pub details: Option<JsonValue>,
    pub metadata: Option<JsonValue>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub user: Option<Creator>,
}

#[derive(Debug, Serialize)]
pub struct Timeline {
    pub data: Vec<Activity>,
    pub next_cursor: Option<i32>,
}

/// `Number(cursor)` rồi `cursor ? … : undefined`: rỗng, 0, NaN, không phải số nguyên dương ⇒ không có con trỏ.
fn parse_cursor(raw: Option<&str>) -> Option<i32> {
    let n: f64 = raw?.trim().parse().ok()?;
    if n.fract() == 0.0 && n >= 1.0 && n <= f64::from(i32::MAX) {
        Some(n as i32)
    } else {
        None
    }
}

/// `Math.min(Math.max(Number(limit) || 20, 1), 200)`; thiếu `limit` ⇒ 20.
fn parse_limit(raw: Option<&str>) -> i64 {
    let n: f64 = raw.and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
    let n = if n.is_finite() && n != 0.0 {
        n
    } else {
        DEFAULT_LIMIT as f64
    };
    (n.clamp(1.0, MAX_LIMIT as f64)) as i64
}

/// `cursor`/`limit` là chuỗi query nguyên văn (bản TS đọc `@Query('cursor') string`).
pub async fn find_by_contact(
    conn: &mut PgConnection,
    scopes: &Scopes,
    contact_id: i32,
    cursor: Option<&str>,
    limit: Option<&str>,
) -> Result<Timeline, AppError> {
    let owners: Option<(Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1")
            .bind(contact_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((assigned_to, created_by)) = owners else {
        return Err(http(HttpError::not_found(format!(
            "Không tìm thấy khách hàng ID {contact_id}"
        ))));
    };
    assert_in_scope(scopes.contacts_view.as_ref(), &[assigned_to, created_by])?;

    let take = parse_limit(limit);
    let rows: Vec<Row> = match parse_cursor(cursor) {
        // Con trỏ trỏ vào dòng không tồn tại ⇒ rỗng (Prisma không tìm được điểm bắt đầu).
        Some(c) => {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM activities WHERE id = $1)")
                .bind(c)
                .fetch_one(&mut *conn)
                .await
                .map_err(db)?;
            if !exists {
                Vec::new()
            } else {
                sqlx::query_as(
                    "SELECT id, contact_id, action, details, metadata, created_by, created_at FROM activities
                     WHERE contact_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
                )
                .bind(contact_id)
                .bind(c)
                .bind(take + 1)
                .fetch_all(&mut *conn)
                .await
                .map_err(db)?
            }
        }
        None => sqlx::query_as(
            "SELECT id, contact_id, action, details, metadata, created_by, created_at FROM activities
             WHERE contact_id = $1 ORDER BY id DESC LIMIT $2",
        )
        .bind(contact_id)
        .bind(take + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?,
    };

    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > take;
    let page: Vec<Row> = rows.into_iter().take(usize::try_from(take).unwrap_or(0)).collect();
    let mut ids: Vec<i32> = page.iter().filter_map(|a| a.created_by).collect();
    ids.sort_unstable();
    ids.dedup();
    let users: Vec<Creator> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, full_name, email, avatar_url FROM users WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    let next_cursor = if has_more { page.last().map(|a| a.id) } else { None };
    let data = page
        .into_iter()
        .map(|a| {
            let user = a.created_by.and_then(|id| {
                users.iter().find(|u| u.id == id).map(|u| Creator {
                    id: u.id,
                    full_name: u.full_name.clone(),
                    email: u.email.clone(),
                    avatar_url: u.avatar_url.clone(),
                })
            });
            Activity {
                id: a.id,
                contact_id: a.contact_id,
                action: a.action,
                details: a.details,
                metadata: a.metadata,
                created_by: a.created_by,
                created_at: a.created_at,
                user,
            }
        })
        .collect();
    Ok(Timeline { data, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn con_tro_va_gioi_han_nhu_js() {
        assert_eq!(parse_cursor(None), None);
        assert_eq!(parse_cursor(Some("")), None);
        assert_eq!(parse_cursor(Some("0")), None);
        assert_eq!(parse_cursor(Some("abc")), None);
        assert_eq!(parse_cursor(Some("42")), Some(42));
        assert_eq!(parse_limit(None), 20);
        assert_eq!(parse_limit(Some("abc")), 20);
        assert_eq!(parse_limit(Some("0")), 20);
        assert_eq!(parse_limit(Some("-5")), 1);
        assert_eq!(parse_limit(Some("500")), 200);
        assert_eq!(parse_limit(Some("7")), 7);
    }
}
