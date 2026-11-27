//! Trường tuỳ biến của board (M15): 4 endpoint (`POST /kanban/boards/:boardId/field-defs[/reorder]`, `PATCH`/`DELETE
//! /kanban/field-defs/:id`), quyền `kanban.boards`. Bản TS: `field-defs/kanban-field-defs.service.ts`.

#![allow(clippy::result_large_err)]

use std::collections::HashSet;

use serde::Deserialize;
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::models::KanbanFieldDef;
use trinity_db::pg_error::db_error;
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

use crate::boards::lock_board;
use crate::nullable::some_nullable;
use crate::position::{append, renormalized};
use crate::{Deleted, FIELD_DEF_COLS, KANBAN_REORDER_MAX_ITEMS, db, finish, len16};

/// Kiểu trường (`KANBAN_FIELD_TYPES`).
pub const FIELD_TYPES: &[&str] = &[
    "text",
    "number",
    "money",
    "date",
    "select",
    "multi_select",
    "user",
    "checkbox",
    "url",
];

fn needs_options(t: &str) -> bool {
    matches!(t, "select" | "multi_select")
}

/// Một lựa chọn của trường select.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

/// Body `POST /field-defs`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateFieldDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub r#type: String,
    #[serde(default)]
    pub options: Option<Vec<FieldOption>>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub show_on_card: Option<bool>,
}

/// Body `PATCH /field-defs/:id` (không đổi được `key`, `type`): `options: null` xoá lựa chọn.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateFieldDef {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub options: Option<Option<Vec<FieldOption>>>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub show_on_card: Option<bool>,
}

/// Body `POST /field-defs/reorder`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReorderFieldDefs {
    pub field_def_ids: Vec<i32>,
}

/// `^[a-z][a-z0-9_]{0,63}$`.
fn valid_key(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn option_errors(opts: &[FieldOption], out: &mut Vec<String>) {
    if opts.len() > 100 {
        out.push("options tối đa 100 phần tử".to_owned());
    }
    for o in opts {
        if len16(&o.value) > 64 {
            out.push("value tối đa 64 ký tự".to_owned());
        }
        if o.value.is_empty() {
            out.push("value không được rỗng".to_owned());
        }
        if len16(&o.label) > 255 {
            out.push("label tối đa 255 ký tự".to_owned());
        }
        if o.label.is_empty() {
            out.push("label không được rỗng".to_owned());
        }
    }
}

impl CreateFieldDef {
    /// Luật của `CreateKanbanFieldDefDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if !valid_key(&self.key) {
            e.push("key chỉ chứa chữ thường/số/gạch dưới, bắt đầu bằng chữ, tối đa 64 ký tự".to_owned());
        }
        if len16(&self.label) > 255 {
            e.push("label tối đa 255 ký tự".to_owned());
        }
        if !FIELD_TYPES.contains(&self.r#type.as_str()) {
            e.push("type không hợp lệ".to_owned());
        }
        if let Some(o) = &self.options {
            option_errors(o, &mut e);
        }
        finish(e)
    }
}

impl UpdateFieldDef {
    /// Luật của `UpdateKanbanFieldDefDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(l) = &self.label
            && len16(l) > 255
        {
            e.push("label tối đa 255 ký tự".to_owned());
        }
        if let Some(Some(o)) = &self.options {
            option_errors(o, &mut e);
        }
        finish(e)
    }
}

impl ReorderFieldDefs {
    /// Luật của `ReorderKanbanFieldDefsDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.field_def_ids.len() > KANBAN_REORDER_MAX_ITEMS {
            e.push(format!("field_def_ids tối đa {KANBAN_REORDER_MAX_ITEMS} phần tử"));
        }
        if self.field_def_ids.is_empty() {
            e.push("field_def_ids không được rỗng".to_owned());
        }
        finish(e)
    }
}

fn assert_options_for_type(t: &str, options: Option<&[FieldOption]>) -> Result<(), AppError> {
    if needs_options(t) && options.is_none_or(<[FieldOption]>::is_empty) {
        return Err(HttpError::bad_request(format!(
            "Trường type=\"{t}\" bắt buộc phải có \"options\" (ít nhất 1 lựa chọn)"
        ))
        .into());
    }
    Ok(())
}

fn options_json(o: &[FieldOption]) -> serde_json::Value {
    serde_json::Value::Array(
        o.iter()
            .map(|x| serde_json::json!({ "value": x.value, "label": x.label }))
            .collect(),
    )
}

async fn load(conn: &mut PgConnection, id: i32) -> Result<KanbanFieldDef, AppError> {
    sqlx::query_as::<_, KanbanFieldDef>(AssertSqlSafe(format!(
        "SELECT {FIELD_DEF_COLS} FROM kanban_field_defs WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(format!("Không tìm thấy trường tuỳ biến ID {id}")).into())
}

/// `POST /boards/:boardId/field-defs`: khoá trùng trong board ⇒ 409 (cả khi hai request song song). Gọi sau
/// [`CreateFieldDef::validate`].
pub async fn create(
    conn: &mut PgConnection,
    board_id: i32,
    input: &CreateFieldDef,
) -> Result<KanbanFieldDef, AppError> {
    assert_options_for_type(&input.r#type, input.options.as_deref())?;
    // Khoá dòng board: hai lần thêm đồng thời không cùng lấy một `max(position)`.
    let mut tx = conn.begin().await.map_err(db)?;
    lock_board(&mut tx, board_id).await?;
    let last: Option<f64> = sqlx::query_scalar("SELECT max(position) FROM kanban_field_defs WHERE board_id = $1")
        .bind(board_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let row = sqlx::query_as::<_, KanbanFieldDef>(AssertSqlSafe(format!(
        "INSERT INTO kanban_field_defs (board_id, key, label, type, options, required, show_on_card, position, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING {FIELD_DEF_COLS}"
    )))
    .bind(board_id)
    .bind(&input.key)
    .bind(&input.label)
    .bind(&input.r#type)
    .bind(input.options.as_deref().map(options_json))
    .bind(input.required.unwrap_or(false))
    .bind(input.show_on_card.unwrap_or(false))
    .bind(append(last))
    .fetch_one(&mut *tx)
    .await;
    let row = row.map_err(|e| {
        if db_error(&e).is(DbErrorKind::UniqueViolation, None) {
            HttpError::conflict(format!("Trường \"{}\" đã tồn tại trong board này", input.key)).into()
        } else {
            db(e)
        }
    })?;
    tx.commit().await.map_err(db)?;
    Ok(row)
}

/// `PATCH /field-defs/:id`. Gọi sau [`UpdateFieldDef::validate`].
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateFieldDef) -> Result<KanbanFieldDef, AppError> {
    let cur = load(&mut *conn, id).await?;
    if let Some(o) = &input.options {
        assert_options_for_type(&cur.r#type, o.as_deref())?;
    }
    let (set_opts, opts) = match &input.options {
        Some(o) => (true, o.as_deref().map(options_json)),
        None => (false, None),
    };
    sqlx::query_as::<_, KanbanFieldDef>(AssertSqlSafe(format!(
        "UPDATE kanban_field_defs SET label = COALESCE($2, label),
                options = CASE WHEN $3 THEN $4 ELSE options END,
                required = COALESCE($5, required), show_on_card = COALESCE($6, show_on_card), updated_at = now()
         WHERE id = $1 RETURNING {FIELD_DEF_COLS}"
    )))
    .bind(id)
    .bind(&input.label)
    .bind(set_opts)
    .bind(opts)
    .bind(input.required)
    .bind(input.show_on_card)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `POST /boards/:boardId/field-defs/reorder`: phải gồm ĐỦ và ĐÚNG các trường của board. Gọi sau
/// [`ReorderFieldDefs::validate`].
pub async fn reorder(
    conn: &mut PgConnection,
    board_id: i32,
    input: &ReorderFieldDefs,
) -> Result<Vec<KanbanFieldDef>, AppError> {
    let existing: HashSet<i32> = sqlx::query_scalar::<_, i32>("SELECT id FROM kanban_field_defs WHERE board_id = $1")
        .bind(board_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        .into_iter()
        .collect();
    let requested: HashSet<i32> = input.field_def_ids.iter().copied().collect();
    if existing.len() != requested.len() || !input.field_def_ids.iter().all(|id| existing.contains(id)) {
        return Err(
            HttpError::bad_request("Danh sách trường không khớp — phải gồm ĐỦ và ĐÚNG các trường của board").into(),
        );
    }
    let positions = renormalized(input.field_def_ids.len());
    let mut tx = conn.begin().await.map_err(db)?;
    for (id, pos) in input.field_def_ids.iter().zip(positions) {
        sqlx::query("UPDATE kanban_field_defs SET position = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(pos)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    sqlx::query_as::<_, KanbanFieldDef>(AssertSqlSafe(format!(
        "SELECT {FIELD_DEF_COLS} FROM kanban_field_defs WHERE board_id = $1 ORDER BY position ASC"
    )))
    .bind(board_id)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `DELETE /field-defs/:id`: xoá thật; giá trị đã lưu trên card giữ nguyên trong JSON (mồ côi), không làm sập khi hiển thị.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<Deleted, AppError> {
    load(&mut *conn, id).await?;
    sqlx::query("DELETE FROM kanban_field_defs WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(Deleted { deleted: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> CreateFieldDef {
        CreateFieldDef {
            key: "muc_do_uu_tien".into(),
            label: "Mức độ".into(),
            r#type: "select".into(),
            options: Some(vec![FieldOption {
                value: "high".into(),
                label: "Cao".into(),
            }]),
            required: None,
            show_on_card: None,
        }
    }

    #[test]
    fn khoa_va_loai() {
        assert!(valid_key("a") && valid_key("a_1") && !valid_key("A") && !valid_key("1a") && !valid_key(""));
        assert!(!valid_key(&"a".repeat(65)));
        assert!(base().validate().is_ok());
        let bad = CreateFieldDef {
            key: "Bad".into(),
            r#type: "x".into(),
            ..base()
        };
        let n = match bad.validate().unwrap_err().body().message {
            trinity_kernel::error::Message::Many(m) => m.len(),
            other => panic!("{other:?}"),
        };
        assert_eq!(n, 2);
    }

    #[test]
    fn select_can_options() {
        assert!(assert_options_for_type("select", None).is_err());
        assert!(assert_options_for_type("multi_select", Some(&[])).is_err());
        assert!(assert_options_for_type("text", None).is_ok());
        assert!(assert_options_for_type("select", base().options.as_deref()).is_ok());
    }

    #[test]
    fn sua_options_phan_biet_vang_mat_va_null() {
        let u: UpdateFieldDef = serde_json::from_str(r#"{"options":null}"#).unwrap();
        assert_eq!(u.options, Some(None));
        let u: UpdateFieldDef = serde_json::from_str(r#"{"label":"x"}"#).unwrap();
        assert_eq!(u.options, None);
    }
}
