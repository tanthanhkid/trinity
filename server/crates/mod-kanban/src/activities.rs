//! Lịch sử thẻ và bình luận (M16): `GET /kanban/cards/:id/activities`, `POST /kanban/cards/:id/comments`. Bình luận là một
//! dòng `kanban_card_activities` có `action = 'comment'`. Mọi endpoint con gọi lại cổng của thẻ cha. Bản TS:
//! `cards/kanban-card-activities.service.ts`, `kanban-card-activity.helper.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::models::KanbanCardActivity;
use trinity_kernel::error::AppError;

use crate::cards::load_scoped;
use crate::{ACTIVITIES_MAX_LIMIT, Actor, db};

/// Ghi một dòng lịch sử NGAY TRONG giao dịch ghi (dữ liệu nghiệp vụ bắt buộc, không bỏ qua lỗi).
pub(crate) async fn log_activity(
    conn: &mut PgConnection,
    card_id: i32,
    actor_id: i32,
    action: &str,
    payload: &Value,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO kanban_card_activities (card_id, actor_id, action, payload) VALUES ($1, $2, $3, $4::text::jsonb)",
    )
    .bind(card_id)
    .bind(actor_id)
    .bind(action)
    .bind(payload.to_string())
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Dòng lịch sử kèm tên người thao tác (`null` khi không có hoặc ở kết quả của bình luận vừa tạo).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct ActivityDto {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub activity: KanbanCardActivity,
    pub actor_name: Option<String>,
}

/// Body `POST /cards/:id/comments` (K15: 1..5000 ký tự).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateComment {
    pub content: String,
}

/// `GET /cards/:id/activities`: mới nhất trước, tối đa 200 dòng (bảng nhỏ theo thẻ, chưa cần con trỏ).
pub async fn list(conn: &mut PgConnection, actor: &Actor, card_id: i32) -> Result<Vec<ActivityDto>, AppError> {
    load_scoped(conn, actor, card_id).await?;
    sqlx::query_as::<_, ActivityDto>(
        "SELECT a.id, a.card_id, a.actor_id, a.action, a.payload, a.created_at, u.full_name AS actor_name
         FROM kanban_card_activities a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.card_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2",
    )
    .bind(card_id)
    .bind(ACTIVITIES_MAX_LIMIT)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /cards/:id/comments`.
pub async fn add_comment(
    conn: &mut PgConnection,
    actor: &Actor,
    card_id: i32,
    input: &CreateComment,
) -> Result<ActivityDto, AppError> {
    load_scoped(conn, actor, card_id).await?;
    let activity = sqlx::query_as::<_, KanbanCardActivity>(
        "INSERT INTO kanban_card_activities (card_id, actor_id, action, payload) VALUES ($1, $2, 'comment', $3::text::jsonb)
         RETURNING id, card_id, actor_id, action, payload, created_at",
    )
    .bind(card_id)
    .bind(actor.user_id)
    .bind(json!({ "content": input.content }).to_string())
    .fetch_one(conn)
    .await
    .map_err(db)?;
    Ok(ActivityDto {
        activity,
        actor_name: None,
    })
}
