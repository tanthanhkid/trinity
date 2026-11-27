//! Bảng (M15): 7 endpoint `/api/v1/kanban/boards`. Bản TS: `boards/kanban-boards.service.ts`,
//! `common/kanban-rbac.helper.ts`.

#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::models::{KanbanBoard, KanbanColumn, KanbanFieldDef};
use trinity_db::types::{JsonValue, PgList, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;

use crate::labels::{LabelDef, parse_label_defs};
use crate::nullable::some_nullable;
use crate::position::renormalized;
use crate::templates::{self, TEMPLATES};
use crate::{Access, BOARD_COLS, COLUMN_COLS, FIELD_DEF_COLS, board_not_found, db, finish, len16};

/// Một dòng `GET /boards`: board kèm số cột và số card chưa xoá.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct BoardListRow {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub is_active: bool,
    pub visibility_role_ids: PgList<i32>,
    pub card_prefix: Option<String>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub column_count: i64,
    pub card_count: i64,
}

/// `GET /boards/:id`: board (nhãn đã chuẩn hoá) + cột chưa ẩn + trường tuỳ biến, theo `position`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoardDetail {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub is_active: bool,
    pub visibility_role_ids: PgList<i32>,
    pub card_prefix: Option<String>,
    pub settings: JsonValue,
    pub label_defs: Vec<LabelDef>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
    pub columns: Vec<KanbanColumn>,
    pub field_defs: Vec<KanbanFieldDef>,
}

/// `POST /boards/from-template`: board vừa tạo kèm các cột.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoardWithColumns {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub is_active: bool,
    pub visibility_role_ids: PgList<i32>,
    pub card_prefix: Option<String>,
    pub settings: JsonValue,
    pub label_defs: JsonValue,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
    pub columns: Vec<KanbanColumn>,
}

/// Một mẫu trong `GET /boards/templates`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateRow {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub columns: Vec<&'static str>,
}

/// Body `POST /boards`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateBoard {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub visibility_role_ids: Option<Vec<i32>>,
    #[serde(default)]
    pub card_prefix: Option<String>,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
}

/// Body `PATCH /boards/:id`: trường vắng = giữ nguyên; `description`/`icon`/`color`/`card_prefix` nhận `null` để xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateBoard {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub visibility_role_ids: Option<Vec<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub card_prefix: Option<Option<String>>,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Body `POST /boards/from-template`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBoardFromTemplate {
    pub template_key: String,
    #[serde(default)]
    pub name: Option<String>,
}

fn max(field: &str, v: &str, n: usize, out: &mut Vec<String>) {
    if len16(v) > n {
        out.push(format!("{field} tối đa {n} ký tự"));
    }
}

fn common_errors(
    name: Option<&str>,
    description: Option<&str>,
    icon: Option<&str>,
    color: Option<&str>,
    roles: Option<&[i32]>,
    card_prefix: Option<&str>,
    out: &mut Vec<String>,
) {
    if let Some(n) = name {
        max("name", n, 255, out);
        if n.is_empty() {
            out.push("name không được rỗng".to_owned());
        }
    }
    if let Some(v) = description {
        max("description", v, 2000, out);
    }
    if let Some(v) = icon {
        max("icon", v, 64, out);
    }
    if let Some(v) = color {
        max("color", v, 32, out);
    }
    if let Some(r) = roles {
        if r.len() > 200 {
            out.push("visibility_role_ids có quá nhiều phần tử".to_owned());
        }
        if r.iter().any(|x| *x < 1) {
            out.push("visibility_role_ids phải là id hợp lệ".to_owned());
        }
    }
    if let Some(v) = card_prefix {
        max("card_prefix", v, 16, out);
    }
}

impl CreateBoard {
    /// Luật của `CreateKanbanBoardDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        common_errors(
            Some(&self.name),
            self.description.as_deref(),
            self.icon.as_deref(),
            self.color.as_deref(),
            self.visibility_role_ids.as_deref(),
            self.card_prefix.as_deref(),
            &mut e,
        );
        if self.settings.as_ref().is_some_and(|s| !s.is_object()) {
            e.push("settings phải là object".to_owned());
        }
        finish(e)
    }
}

impl UpdateBoard {
    /// Luật của `UpdateKanbanBoardDto` (trường vắng bỏ qua).
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        common_errors(
            self.name.as_deref(),
            self.description.as_ref().and_then(|v| v.as_deref()),
            self.icon.as_ref().and_then(|v| v.as_deref()),
            self.color.as_ref().and_then(|v| v.as_deref()),
            self.visibility_role_ids.as_deref(),
            self.card_prefix.as_ref().and_then(|v| v.as_deref()),
            &mut e,
        );
        if self.settings.as_ref().is_some_and(|s| !s.is_object()) {
            e.push("settings phải là object".to_owned());
        }
        finish(e)
    }
}

impl CreateBoardFromTemplate {
    /// Luật của `CreateKanbanBoardFromTemplateDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if templates::find(&self.template_key).is_none() {
            e.push("template_key không hợp lệ".to_owned());
        }
        if let Some(n) = &self.name {
            max("name", n, 255, &mut e);
            if n.is_empty() {
                e.push("name không được rỗng".to_owned());
            }
        }
        finish(e)
    }
}

/// Board hiển thị với người gọi (`isBoardVisibleToUser`).
pub fn is_visible(access: &Access, board: &KanbanBoard) -> bool {
    if board.deleted_at.is_some() {
        return false;
    }
    if access.can_manage_boards {
        return true;
    }
    board.is_active
        && (board.visibility_role_ids.0.is_empty()
            || board
                .visibility_role_ids
                .0
                .iter()
                .any(|id| access.role_ids.contains(id)))
}

/// Nạp board và kiểm hiển thị: 404 (không phải 403) nếu ngoài phạm vi hoặc không tồn tại/đã xoá.
pub async fn load_visible(conn: &mut PgConnection, access: &Access, id: i32) -> Result<KanbanBoard, AppError> {
    let sql = format!("SELECT {BOARD_COLS} FROM kanban_boards WHERE id = $1 AND deleted_at IS NULL");
    let board = sqlx::query_as::<_, KanbanBoard>(AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    match board {
        Some(b) if is_visible(access, &b) => Ok(b),
        _ => Err(board_not_found(id)),
    }
}

pub(crate) async fn assert_exists(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let found = sqlx::query_scalar::<_, i32>("SELECT id FROM kanban_boards WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    found.map(|_| ()).ok_or_else(|| board_not_found(id))
}

/// Khoá dòng board chưa xoá mềm (`FOR UPDATE`) trong giao dịch đang mở; không có ⇒ 404.
pub(crate) async fn lock_board(tx: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let found =
        sqlx::query_scalar::<_, i32>("SELECT id FROM kanban_boards WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
            .bind(id)
            .fetch_optional(tx)
            .await
            .map_err(db)?;
    found.map(|_| ()).ok_or_else(|| board_not_found(id))
}

/// `GET /boards`: board người gọi thấy, theo tên.
pub async fn find_all_visible(conn: &mut PgConnection, access: &Access) -> Result<Vec<BoardListRow>, AppError> {
    sqlx::query_as::<_, BoardListRow>(
        "SELECT b.id, b.name, b.description, b.icon, b.color, b.is_active, b.visibility_role_ids, b.card_prefix,
                b.created_by, b.created_at, b.updated_at,
                (SELECT count(*) FROM kanban_columns c WHERE c.board_id = b.id) AS column_count,
                (SELECT count(*) FROM kanban_cards k WHERE k.board_id = b.id AND k.deleted_at IS NULL) AS card_count
         FROM kanban_boards b
         WHERE b.deleted_at IS NULL
           AND ($1 OR (b.is_active AND (cardinality(b.visibility_role_ids) = 0 OR b.visibility_role_ids && $2)))
         ORDER BY b.name ASC",
    )
    .bind(access.can_manage_boards)
    .bind(&access.role_ids)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `GET /boards/:id`.
pub async fn find_one_detail(conn: &mut PgConnection, access: &Access, id: i32) -> Result<BoardDetail, AppError> {
    let b = load_visible(&mut *conn, access, id).await?;
    let columns = sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "SELECT {COLUMN_COLS} FROM kanban_columns WHERE board_id = $1 AND NOT is_archived ORDER BY position ASC"
    )))
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let field_defs = sqlx::query_as::<_, KanbanFieldDef>(AssertSqlSafe(format!(
        "SELECT {FIELD_DEF_COLS} FROM kanban_field_defs WHERE board_id = $1 ORDER BY position ASC"
    )))
    .bind(id)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(BoardDetail {
        label_defs: parse_label_defs(&b.label_defs.0),
        id: b.id,
        name: b.name,
        description: b.description,
        icon: b.icon,
        color: b.color,
        is_active: b.is_active,
        visibility_role_ids: b.visibility_role_ids,
        card_prefix: b.card_prefix,
        settings: b.settings,
        created_by: b.created_by,
        created_at: b.created_at,
        updated_at: b.updated_at,
        deleted_at: b.deleted_at,
        columns,
        field_defs,
    })
}

/// `POST /boards`. Gọi sau [`CreateBoard::validate`].
pub async fn create(conn: &mut PgConnection, input: &CreateBoard, user_id: i32) -> Result<KanbanBoard, AppError> {
    let sql = format!(
        "INSERT INTO kanban_boards (name, description, icon, color, visibility_role_ids, card_prefix, settings,
                                    created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING {BOARD_COLS}"
    );
    sqlx::query_as::<_, KanbanBoard>(AssertSqlSafe(sql))
        .bind(&input.name)
        .bind(&input.description)
        .bind(&input.icon)
        .bind(&input.color)
        .bind(input.visibility_role_ids.clone().unwrap_or_default())
        .bind(&input.card_prefix)
        .bind(input.settings.clone().unwrap_or_else(|| serde_json::json!({})))
        .bind(user_id)
        .fetch_one(conn)
        .await
        .map_err(db)
}

/// `PATCH /boards/:id`: 404 nếu không có hoặc đã xoá. Gọi sau [`UpdateBoard::validate`].
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateBoard) -> Result<KanbanBoard, AppError> {
    assert_exists(&mut *conn, id).await?;
    let flat = |v: &Option<Option<String>>| match v {
        Some(x) => (true, x.clone()),
        None => (false, None),
    };
    let (set_desc, desc) = flat(&input.description);
    let (set_icon, icon) = flat(&input.icon);
    let (set_color, color) = flat(&input.color);
    let (set_prefix, prefix) = flat(&input.card_prefix);
    let sql = format!(
        "UPDATE kanban_boards SET name = COALESCE($2, name),
                description = CASE WHEN $3 THEN $4 ELSE description END,
                icon = CASE WHEN $5 THEN $6 ELSE icon END,
                color = CASE WHEN $7 THEN $8 ELSE color END,
                visibility_role_ids = COALESCE($9, visibility_role_ids),
                card_prefix = CASE WHEN $10 THEN $11 ELSE card_prefix END,
                settings = COALESCE($12, settings),
                is_active = COALESCE($13, is_active),
                updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING {BOARD_COLS}"
    );
    sqlx::query_as::<_, KanbanBoard>(AssertSqlSafe(sql))
        .bind(id)
        .bind(&input.name)
        .bind(set_desc)
        .bind(desc)
        .bind(set_icon)
        .bind(icon)
        .bind(set_color)
        .bind(color)
        .bind(&input.visibility_role_ids)
        .bind(set_prefix)
        .bind(prefix)
        .bind(&input.settings)
        .bind(input.is_active)
        .fetch_optional(conn)
        .await
        .map_err(db)?
        .ok_or_else(|| board_not_found(id))
}

/// `DELETE /boards/:id`: xoá mềm (giữ cột/card/lịch sử), trả board đã có `deleted_at`.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<KanbanBoard, AppError> {
    assert_exists(&mut *conn, id).await?;
    let sql = format!(
        "UPDATE kanban_boards SET deleted_at = now(), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL RETURNING {BOARD_COLS}"
    );
    sqlx::query_as::<_, KanbanBoard>(AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?
        .ok_or_else(|| board_not_found(id))
}

/// `GET /boards/templates`.
pub fn list_templates() -> Vec<TemplateRow> {
    TEMPLATES
        .iter()
        .map(|t| TemplateRow {
            key: t.key,
            name: t.name,
            description: t.description,
            columns: t.columns.iter().map(|c| c.name).collect(),
        })
        .collect()
}

/// `POST /boards/from-template`: board và các cột trong một giao dịch. Gọi sau [`CreateBoardFromTemplate::validate`].
pub async fn create_from_template(
    conn: &mut PgConnection,
    input: &CreateBoardFromTemplate,
    user_id: i32,
) -> Result<BoardWithColumns, AppError> {
    let t = templates::find(&input.template_key)
        .ok_or_else(|| AppError::from(HttpError::bad_request("template_key không hợp lệ")))?;
    let positions = renormalized(t.columns.len());
    let name = input
        .name
        .as_deref()
        .map(trim_js)
        .filter(|n| !n.is_empty())
        .unwrap_or(t.name);
    let mut tx = conn.begin().await.map_err(db)?;
    let b = sqlx::query_as::<_, KanbanBoard>(AssertSqlSafe(format!(
        "INSERT INTO kanban_boards (name, description, created_by, updated_at) VALUES ($1, $2, $3, now())
         RETURNING {BOARD_COLS}"
    )))
    .bind(name)
    .bind(t.description)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let mut columns = Vec::with_capacity(t.columns.len());
    for (col, pos) in t.columns.iter().zip(positions) {
        columns.push(
            sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
                "INSERT INTO kanban_columns (board_id, name, position, is_done, updated_at) VALUES ($1, $2, $3, $4, now())
                 RETURNING {COLUMN_COLS}"
            )))
            .bind(b.id)
            .bind(col.name)
            .bind(pos)
            .bind(col.is_done)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?,
        );
    }
    tx.commit().await.map_err(db)?;
    Ok(BoardWithColumns {
        id: b.id,
        name: b.name,
        description: b.description,
        icon: b.icon,
        color: b.color,
        is_active: b.is_active,
        visibility_role_ids: b.visibility_role_ids,
        card_prefix: b.card_prefix,
        settings: b.settings,
        label_defs: b.label_defs,
        created_by: b.created_by,
        created_at: b.created_at,
        updated_at: b.updated_at,
        deleted_at: b.deleted_at,
        columns,
    })
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
    fn validate_tao_board() {
        let ok = CreateBoard {
            name: "Bán hàng".into(),
            ..Default::default()
        };
        assert!(ok.validate().is_ok());
        let bad = CreateBoard {
            name: String::new(),
            card_prefix: Some("x".repeat(17)),
            visibility_role_ids: Some(vec![0]),
            ..Default::default()
        };
        assert_eq!(
            msgs(bad.validate()),
            [
                "name không được rỗng",
                "visibility_role_ids phải là id hợp lệ",
                "card_prefix tối đa 16 ký tự"
            ]
        );
    }

    #[test]
    fn sua_phan_biet_vang_mat_va_null() {
        let u: UpdateBoard = serde_json::from_str(r#"{"icon":null,"name":"A"}"#).unwrap();
        assert_eq!(u.icon, Some(None));
        assert_eq!(u.color, None);
        assert!(u.validate().is_ok());
    }

    #[test]
    fn mau_mac_dinh() {
        let t = list_templates();
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].columns, ["Mới", "Đã liên hệ", "Báo giá", "Chốt", "Thua"]);
        assert!(
            CreateBoardFromTemplate {
                template_key: "x".into(),
                name: None
            }
            .validate()
            .is_err()
        );
    }
}
