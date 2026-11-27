//! Checklist phẳng của thẻ (M16): 5 endpoint. Mọi endpoint gọi lại cổng của thẻ cha (ngoài phạm vi ⇒ 404). Bản TS:
//! `checklist/kanban-checklist.service.ts`.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::json;
use sqlx::{Connection, PgConnection};
use trinity_db::models::KanbanChecklistItem;
use trinity_kernel::error::AppError;

use crate::activities::log_activity;
use crate::cards::load_scoped;
use crate::position::{append, renormalized};
use trinity_kernel::error::HttpError;

use crate::{Actor, CHECKLIST_ITEMS_MAX_PER_CARD, Deleted, bad_request, check_text, db, finish, not_found};

const COLS: &str = "id, card_id, text, is_done, position, created_by, created_at, updated_at";

/// Body `POST /cards/:cardId/checklist-items` (K15: 1..500 ký tự).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateItem {
    pub text: String,
}

/// Body `PATCH /checklist-items/:id`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateItem {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub is_done: Option<bool>,
}

/// Body `POST /cards/:cardId/checklist-items/reorder` (K15: 1..200 số nguyên).
#[derive(Debug, Clone, Deserialize)]
pub struct ReorderItems {
    pub item_ids: Vec<i32>,
}

pub const TEXT_MAX_LENGTH: usize = 500;

impl CreateItem {
    /// Luật của `CreateKanbanChecklistItemDto`: `text` 1..500 ký tự.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        check_text("text", &self.text, TEXT_MAX_LENGTH, &mut e);
        finish(e)
    }
}

impl UpdateItem {
    /// Luật của `UpdateKanbanChecklistItemDto`: trường vắng bỏ qua; `text` có mặt thì 1..500.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(t) = &self.text {
            check_text("text", t, TEXT_MAX_LENGTH, &mut e);
        }
        finish(e)
    }
}

impl ReorderItems {
    /// Luật của `ReorderKanbanChecklistItemsDto`: 1..200 phần tử.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.item_ids.is_empty() {
            e.push("item_ids không được rỗng".to_owned());
        }
        if i64::try_from(self.item_ids.len()).unwrap_or(i64::MAX) > CHECKLIST_ITEMS_MAX_PER_CARD {
            e.push(format!("item_ids tối đa {CHECKLIST_ITEMS_MAX_PER_CARD} phần tử"));
        }
        finish(e)
    }
}

async fn items(conn: &mut PgConnection, card_id: i32) -> Result<Vec<KanbanChecklistItem>, AppError> {
    sqlx::query_as::<_, KanbanChecklistItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM kanban_checklist_items WHERE card_id = $1 ORDER BY position ASC, id ASC"
    )))
    .bind(card_id)
    .fetch_all(conn)
    .await
    .map_err(db)
}

async fn load_item(conn: &mut PgConnection, id: i32) -> Result<KanbanChecklistItem, AppError> {
    sqlx::query_as::<_, KanbanChecklistItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM kanban_checklist_items WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| not_found(format!("Không tìm thấy mục checklist ID {id}")))
}

/// `GET /cards/:cardId/checklist-items`.
pub async fn list(conn: &mut PgConnection, actor: &Actor, card_id: i32) -> Result<Vec<KanbanChecklistItem>, AppError> {
    load_scoped(conn, actor, card_id).await?;
    items(conn, card_id).await
}

/// `POST /cards/:cardId/checklist-items`: tối đa 200 mục mỗi thẻ, nối cuối.
pub async fn create(
    conn: &mut PgConnection,
    actor: &Actor,
    card_id: i32,
    input: &CreateItem,
) -> Result<KanbanChecklistItem, AppError> {
    load_scoped(conn, actor, card_id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    // Khoá hàng thẻ: đếm trần và đọc vị trí cuối trong cùng giao dịch, hai request cùng lúc không vượt trần hay trùng vị trí.
    sqlx::query("SELECT id FROM kanban_cards WHERE id = $1 FOR UPDATE")
        .bind(card_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM kanban_checklist_items WHERE card_id = $1")
        .bind(card_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if count >= CHECKLIST_ITEMS_MAX_PER_CARD {
        return Err(bad_request(format!(
            "Card đã đạt trần {CHECKLIST_ITEMS_MAX_PER_CARD} mục checklist"
        )));
    }
    let last: Option<f64> = sqlx::query_scalar(
        "SELECT position FROM kanban_checklist_items WHERE card_id = $1 ORDER BY position DESC LIMIT 1",
    )
    .bind(card_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let created = sqlx::query_as::<_, KanbanChecklistItem>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO kanban_checklist_items (card_id, text, position, created_by, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING {COLS}"
    )))
    .bind(card_id)
    .bind(&input.text)
    .bind(append(last))
    .bind(actor.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    log_activity(
        &mut tx,
        card_id,
        actor.user_id,
        "checklist_item_added",
        &json!({ "item_id": created.id, "text": created.text }),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(created)
}

/// `PATCH /checklist-items/:id`: đổi nội dung và/hoặc đánh dấu xong; chỉ khi trạng thái xong thật sự đổi mới ghi hoạt động.
pub async fn update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: i32,
    input: &UpdateItem,
) -> Result<KanbanChecklistItem, AppError> {
    let item = load_item(conn, id).await?;
    load_scoped(conn, actor, item.card_id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    let next = sqlx::query_as::<_, KanbanChecklistItem>(sqlx::AssertSqlSafe(format!(
        "UPDATE kanban_checklist_items SET text = COALESCE($2, text), is_done = COALESCE($3, is_done), updated_at = now()
         WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(&input.text)
    .bind(input.is_done)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if let Some(done) = input.is_done.filter(|d| *d != item.is_done) {
        log_activity(
            &mut tx,
            item.card_id,
            actor.user_id,
            "checklist_item_toggled",
            &json!({ "item_id": id, "is_done": done, "text": next.text }),
        )
        .await?;
    }
    tx.commit().await.map_err(db)?;
    Ok(next)
}

/// `POST /cards/:cardId/checklist-items/reorder`: danh sách phải gồm ĐỦ và ĐÚNG các mục hiện có.
pub async fn reorder(
    conn: &mut PgConnection,
    actor: &Actor,
    card_id: i32,
    input: &ReorderItems,
) -> Result<Vec<KanbanChecklistItem>, AppError> {
    load_scoped(conn, actor, card_id).await?;
    let existing: HashSet<i32> = sqlx::query_scalar("SELECT id FROM kanban_checklist_items WHERE card_id = $1")
        .bind(card_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        .into_iter()
        .collect();
    let requested: HashSet<i32> = input.item_ids.iter().copied().collect();
    if existing.len() != requested.len()
        || input.item_ids.len() != existing.len()
        || !input.item_ids.iter().all(|i| existing.contains(i))
    {
        return Err(bad_request(
            "Danh sách mục không khớp — phải gồm ĐỦ và ĐÚNG các mục hiện có của card",
        ));
    }
    let positions = renormalized(input.item_ids.len());
    let mut tx = conn.begin().await.map_err(db)?;
    for (id, p) in input.item_ids.iter().zip(&positions) {
        sqlx::query("UPDATE kanban_checklist_items SET position = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(p)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    items(conn, card_id).await
}

/// `DELETE /checklist-items/:id`: người tạo mục, chủ thẻ hoặc Quản trị (sai ⇒ 400 như bản TS, không 403).
pub async fn remove(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<Deleted, AppError> {
    let item = load_item(conn, id).await?;
    let card = load_scoped(conn, actor, item.card_id).await?.card;
    if item.created_by.is_some_and(|c| c != actor.user_id) && !actor.is_admin && card.created_by != actor.user_id {
        return Err(bad_request("Chỉ người tạo mục, chủ card hoặc Quản trị mới được xoá"));
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("DELETE FROM kanban_checklist_items WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    log_activity(
        &mut tx,
        item.card_id,
        actor.user_id,
        "checklist_item_removed",
        &json!({ "item_id": id, "text": item.text }),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(Deleted { deleted: true })
}

#[cfg(test)]
mod validate_tests {
    use super::*;

    fn msgs(r: Result<(), HttpError>) -> Vec<String> {
        match r.unwrap_err().body().message {
            trinity_kernel::error::Message::Many(m) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn validate_checklist() {
        assert!(CreateItem { text: "a".into() }.validate().is_ok());
        assert_eq!(
            msgs(CreateItem { text: String::new() }.validate()),
            ["text không được rỗng"]
        );
        assert_eq!(
            msgs(CreateItem { text: "x".repeat(501) }.validate()),
            ["text tối đa 500 ký tự"]
        );
        assert!(UpdateItem::default().validate().is_ok(), "trường vắng bỏ qua");
        assert_eq!(
            msgs(
                UpdateItem {
                    text: Some(String::new()),
                    is_done: None
                }
                .validate()
            ),
            ["text không được rỗng"]
        );
        assert_eq!(
            msgs(ReorderItems { item_ids: vec![] }.validate()),
            ["item_ids không được rỗng"]
        );
        assert_eq!(
            msgs(ReorderItems { item_ids: vec![1; 201] }.validate()),
            ["item_ids tối đa 200 phần tử"]
        );
        assert!(ReorderItems { item_ids: vec![1; 200] }.validate().is_ok());
    }
}
