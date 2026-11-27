//! Cột (M15): 4 endpoint (`POST /kanban/boards/:boardId/columns`, `…/columns/reorder`, `PATCH`/`DELETE
//! /kanban/columns/:id`), quyền `kanban.boards`. Bản TS: `columns/kanban-columns.service.ts`.
//!
//! Xoá cột còn card BẮT BUỘC `move_to_column_id` (không xoá im lặng): card dồn sang cột đích kèm activity.

#![allow(clippy::result_large_err)]

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::models::KanbanColumn;
use trinity_kernel::error::{AppError, HttpError};

use crate::boards::assert_exists;
use crate::nullable::some_nullable;
use crate::position::{append, renormalized};
use crate::{COLUMN_COLS, KANBAN_REORDER_MAX_ITEMS, db, finish, is_hex_color, len16};

/// Body `POST /columns`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateColumn {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub wip_limit: Option<i32>,
    #[serde(default)]
    pub is_done: Option<bool>,
}

/// Body `PATCH /columns/:id`: `color` và `wip_limit` nhận `null` để xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateColumn {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub wip_limit: Option<Option<i32>>,
    #[serde(default)]
    pub is_done: Option<bool>,
    #[serde(default)]
    pub is_archived: Option<bool>,
}

/// Body `POST /columns/reorder`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReorderColumns {
    pub column_ids: Vec<i32>,
}

/// Kết quả `DELETE /columns/:id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Removed {
    pub deleted: bool,
    pub moved_cards: u64,
}

fn name_errors(name: &str, out: &mut Vec<String>) {
    if len16(name) > 255 {
        out.push("name tối đa 255 ký tự".to_owned());
    }
    if name.is_empty() {
        out.push("name không được rỗng".to_owned());
    }
}

fn color_errors(c: &str, out: &mut Vec<String>) {
    if !is_hex_color(c) {
        out.push("color phải là mã hex hợp lệ (vd #198754)".to_owned());
    }
    if len16(c) > 32 {
        out.push("color tối đa 32 ký tự".to_owned());
    }
}

fn wip_errors(w: i32, out: &mut Vec<String>) {
    if w > 10_000 {
        out.push("wip_limit vượt trần cho phép".to_owned());
    }
    if w < 1 {
        out.push("wip_limit tối thiểu 1".to_owned());
    }
}

impl CreateColumn {
    /// Luật của `CreateKanbanColumnDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        name_errors(&self.name, &mut e);
        if let Some(c) = &self.color {
            color_errors(c, &mut e);
        }
        if let Some(w) = self.wip_limit {
            wip_errors(w, &mut e);
        }
        finish(e)
    }
}

impl UpdateColumn {
    /// Luật của `UpdateKanbanColumnDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(n) = &self.name {
            name_errors(n, &mut e);
        }
        if let Some(Some(c)) = &self.color {
            color_errors(c, &mut e);
        }
        if let Some(Some(w)) = self.wip_limit {
            wip_errors(w, &mut e);
        }
        finish(e)
    }
}

impl ReorderColumns {
    /// Luật của `ReorderKanbanColumnsDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.column_ids.len() > KANBAN_REORDER_MAX_ITEMS {
            e.push(format!("column_ids tối đa {KANBAN_REORDER_MAX_ITEMS} phần tử"));
        }
        if self.column_ids.is_empty() {
            e.push("column_ids không được rỗng".to_owned());
        }
        finish(e)
    }
}

async fn load(conn: &mut PgConnection, id: i32) -> Result<KanbanColumn, AppError> {
    sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "SELECT {COLUMN_COLS} FROM kanban_columns WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(format!("Không tìm thấy cột ID {id}")).into())
}

/// `POST /boards/:boardId/columns`: thêm vào cuối. Gọi sau [`CreateColumn::validate`].
pub async fn create(conn: &mut PgConnection, board_id: i32, input: &CreateColumn) -> Result<KanbanColumn, AppError> {
    assert_exists(&mut *conn, board_id).await?;
    let last: Option<f64> = sqlx::query_scalar("SELECT max(position) FROM kanban_columns WHERE board_id = $1")
        .bind(board_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "INSERT INTO kanban_columns (board_id, name, color, position, wip_limit, is_done, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING {COLUMN_COLS}"
    )))
    .bind(board_id)
    .bind(&input.name)
    .bind(&input.color)
    .bind(append(last))
    .bind(input.wip_limit)
    .bind(input.is_done.unwrap_or(false))
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /columns/:id`. Đổi cờ `is_done` thì đồng bộ `completed_at` của card đang nằm trong cột (cùng bất biến với
/// khi chuyển card). Gọi sau [`UpdateColumn::validate`].
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateColumn) -> Result<KanbanColumn, AppError> {
    let cur = load(&mut *conn, id).await?;
    let done_changed = input.is_done.is_some_and(|d| d != cur.is_done);
    let (set_color, color) = match &input.color {
        Some(c) => (true, c.clone()),
        None => (false, None),
    };
    let (set_wip, wip) = match input.wip_limit {
        Some(w) => (true, w),
        None => (false, None),
    };
    let mut tx = conn.begin().await.map_err(db)?;
    let updated = sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "UPDATE kanban_columns SET name = COALESCE($2, name),
                color = CASE WHEN $3 THEN $4 ELSE color END,
                wip_limit = CASE WHEN $5 THEN $6 ELSE wip_limit END,
                is_done = COALESCE($7, is_done), is_archived = COALESCE($8, is_archived), updated_at = now()
         WHERE id = $1 RETURNING {COLUMN_COLS}"
    )))
    .bind(id)
    .bind(&input.name)
    .bind(set_color)
    .bind(color)
    .bind(set_wip)
    .bind(wip)
    .bind(input.is_done)
    .bind(input.is_archived)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if done_changed {
        let sql = if input.is_done == Some(true) {
            "UPDATE kanban_cards SET completed_at = now(), updated_at = now()
              WHERE column_id = $1 AND deleted_at IS NULL AND completed_at IS NULL"
        } else {
            "UPDATE kanban_cards SET completed_at = NULL, updated_at = now()
              WHERE column_id = $1 AND deleted_at IS NULL AND completed_at IS NOT NULL"
        };
        sqlx::query(sql).bind(id).execute(&mut *tx).await.map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(updated)
}

/// `POST /boards/:boardId/columns/reorder`: phải gồm ĐỦ và ĐÚNG các cột chưa ẩn của board. Gọi sau
/// [`ReorderColumns::validate`].
pub async fn reorder(
    conn: &mut PgConnection,
    board_id: i32,
    input: &ReorderColumns,
) -> Result<Vec<KanbanColumn>, AppError> {
    assert_exists(&mut *conn, board_id).await?;
    let existing: HashSet<i32> =
        sqlx::query_scalar::<_, i32>("SELECT id FROM kanban_columns WHERE board_id = $1 AND NOT is_archived")
            .bind(board_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
            .into_iter()
            .collect();
    let requested: HashSet<i32> = input.column_ids.iter().copied().collect();
    if existing.len() != requested.len() || !input.column_ids.iter().all(|id| existing.contains(id)) {
        return Err(
            HttpError::bad_request("Danh sách cột không khớp — phải gồm ĐỦ và ĐÚNG các cột chưa ẩn của board").into(),
        );
    }
    let positions = renormalized(input.column_ids.len());
    let mut tx = conn.begin().await.map_err(db)?;
    for (id, pos) in input.column_ids.iter().zip(positions) {
        sqlx::query("UPDATE kanban_columns SET position = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(pos)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "SELECT {COLUMN_COLS} FROM kanban_columns WHERE board_id = $1 AND NOT is_archived ORDER BY position ASC"
    )))
    .bind(board_id)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `DELETE /columns/:id?move_to_column_id=`: bắt buộc `move_to_column_id` nếu cột còn card chưa xoá mềm; card dồn sang
/// cuối cột đích kèm activity `moved` (`reason: column_deleted`); card đã xoá mềm trong cột bị dọn hẳn (khoá ngoại
/// card→cột là Restrict). Tất cả trong một giao dịch.
pub async fn remove(
    conn: &mut PgConnection,
    id: i32,
    move_to_column_id: Option<i32>,
    actor_user_id: i32,
) -> Result<Removed, AppError> {
    let column = load(&mut *conn, id).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
    if count == 0 {
        let mut tx = conn.begin().await.map_err(db)?;
        purge(&mut tx, id).await?;
        tx.commit().await.map_err(db)?;
        return Ok(Removed {
            deleted: true,
            moved_cards: 0,
        });
    }
    let Some(target_id) = move_to_column_id.filter(|t| *t != 0) else {
        return Err(HttpError::bad_request(format!(
            "Cột còn {count} card — phải chọn cột đích (move_to_column_id) để dồn card sang trước khi xoá"
        ))
        .into());
    };
    let target = sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "SELECT {COLUMN_COLS} FROM kanban_columns WHERE id = $1 AND board_id = $2"
    )))
    .bind(target_id)
    .bind(column.board_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| {
        AppError::from(HttpError::bad_request(
            "Cột đích không thuộc cùng board hoặc không tồn tại",
        ))
    })?;
    if target.id == column.id {
        return Err(HttpError::bad_request("Cột đích phải khác cột đang xoá").into());
    }

    let mut tx = conn.begin().await.map_err(db)?;
    let cards: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NULL ORDER BY position ASC",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let still: Option<i32> = sqlx::query_scalar("SELECT id FROM kanban_columns WHERE id = $1 FOR SHARE")
        .bind(target.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
    if still.is_none() {
        return Err(HttpError::not_found("Cột đích không tồn tại").into());
    }
    let mut cursor: Option<f64> =
        sqlx::query_scalar("SELECT max(position) FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NULL")
            .bind(target.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    let payload = format!(
        r#"{{"reason": "column_deleted", "from_column_id": {id}, "to_column_id": {}}}"#,
        target.id
    );
    for card in &cards {
        let pos = append(cursor);
        cursor = Some(pos);
        sqlx::query(
            "UPDATE kanban_cards SET column_id = $2, position = $3,
                    completed_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now()
              WHERE id = $1",
        )
        .bind(card)
        .bind(target.id)
        .bind(pos)
        .bind(target.is_done)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query(
            "INSERT INTO kanban_card_activities (card_id, actor_id, action, payload) VALUES ($1, $2, 'moved', $3::jsonb)",
        )
        .bind(card)
        .bind(actor_user_id)
        .bind(&payload)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    purge(&mut tx, id).await?;
    tx.commit().await.map_err(db)?;
    Ok(Removed {
        deleted: true,
        moved_cards: cards.len() as u64,
    })
}

/// Dọn card đã xoá mềm còn nằm trong cột rồi xoá cột.
async fn purge(tx: &mut PgConnection, id: i32) -> Result<(), AppError> {
    sqlx::query("DELETE FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NOT NULL")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM kanban_columns WHERE id = $1")
        .bind(id)
        .execute(tx)
        .await
        .map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(r: Result<(), HttpError>) -> Vec<String> {
        match r.unwrap_err().body().message {
            trinity_kernel::error::Message::Many(m) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn validate_cot() {
        assert!(
            CreateColumn {
                name: "Mới".into(),
                ..Default::default()
            }
            .validate()
            .is_ok()
        );
        let bad = CreateColumn {
            name: String::new(),
            color: Some("xanh".into()),
            wip_limit: Some(0),
            is_done: None,
        };
        assert_eq!(
            msgs(bad.validate()),
            [
                "name không được rỗng",
                "color phải là mã hex hợp lệ (vd #198754)",
                "wip_limit tối thiểu 1"
            ]
        );
        assert!(ReorderColumns { column_ids: vec![] }.validate().is_err());
    }

    #[test]
    fn sua_cot_phan_biet_vang_mat_va_null() {
        let u: UpdateColumn = serde_json::from_str(r#"{"wip_limit":null}"#).unwrap();
        assert_eq!(u.wip_limit, Some(None));
        assert_eq!(u.color, None);
    }
}
