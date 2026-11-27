//! Đính kèm dạng liên kết của thẻ (M16): `GET/POST /kanban/cards/:cardId/attachments`, `DELETE /kanban/attachments/:id`.
//! Mọi thao tác gọi lại cổng của thẻ cha. Bản TS: `attachments/kanban-attachments.service.ts`.

use serde::Deserialize;
use serde_json::json;
use sqlx::{Connection, PgConnection};
use trinity_db::models::KanbanCardAttachment;
use trinity_kernel::error::AppError;
use trinity_kernel::vi::trim_js;

use crate::activities::log_activity;
use crate::cards::load_scoped;
use crate::{ATTACHMENTS_MAX_PER_CARD, Actor, Deleted, bad_request, db, forbidden, not_found};

const COLS: &str = "id, card_id, url, title, created_by, created_at";

/// Body `POST /cards/:cardId/attachments` (K15: URL http/https ≤ 2000 ký tự, tiêu đề ≤ 255).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAttachment {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// `GET /cards/:cardId/attachments`: mới nhất trước.
pub async fn list(conn: &mut PgConnection, actor: &Actor, card_id: i32) -> Result<Vec<KanbanCardAttachment>, AppError> {
    load_scoped(conn, actor, card_id).await?;
    sqlx::query_as::<_, KanbanCardAttachment>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM kanban_card_attachments WHERE card_id = $1 ORDER BY created_at DESC, id DESC"
    )))
    .bind(card_id)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /cards/:cardId/attachments`: tối đa 50 mỗi thẻ; tiêu đề rỗng sau khi cắt khoảng trắng thành `null`.
pub async fn create(
    conn: &mut PgConnection,
    actor: &Actor,
    card_id: i32,
    input: &CreateAttachment,
) -> Result<KanbanCardAttachment, AppError> {
    load_scoped(conn, actor, card_id).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM kanban_card_attachments WHERE card_id = $1")
        .bind(card_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    if count >= ATTACHMENTS_MAX_PER_CARD {
        return Err(bad_request(format!(
            "Card đã đạt trần {ATTACHMENTS_MAX_PER_CARD} đính kèm"
        )));
    }
    let title = input
        .title
        .as_deref()
        .map(trim_js)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let mut tx = conn.begin().await.map_err(db)?;
    let a = sqlx::query_as::<_, KanbanCardAttachment>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO kanban_card_attachments (card_id, url, title, created_by) VALUES ($1, $2, $3, $4) RETURNING {COLS}"
    )))
    .bind(card_id)
    .bind(&input.url)
    .bind(&title)
    .bind(actor.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    log_activity(
        &mut tx,
        card_id,
        actor.user_id,
        "attachment_added",
        &json!({ "attachment_id": a.id, "title": a.title, "url": a.url }),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(a)
}

/// `DELETE /attachments/:id`: người đính kèm, chủ thẻ hoặc Quản trị (sai ⇒ 403).
pub async fn remove(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<Deleted, AppError> {
    let a = sqlx::query_as::<_, KanbanCardAttachment>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM kanban_card_attachments WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| not_found(format!("Không tìm thấy đính kèm ID {id}")))?;
    let card = load_scoped(conn, actor, a.card_id).await?.card;
    if a.created_by != actor.user_id && card.created_by != actor.user_id && !actor.is_admin {
        return Err(forbidden("Chỉ người đính kèm, chủ card hoặc Quản trị mới được xoá"));
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("DELETE FROM kanban_card_attachments WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    log_activity(
        &mut tx,
        a.card_id,
        actor.user_id,
        "attachment_removed",
        &json!({ "attachment_id": id, "title": a.title }),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(Deleted { deleted: true })
}
