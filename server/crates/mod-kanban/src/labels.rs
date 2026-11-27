//! Nhãn màu của board (`KanbanBoard.label_defs`, JSON): 3 endpoint `/api/v1/kanban/boards/:id/labels`.
//! Bản TS: `common/kanban-label.helper.ts`. Cả ba chỉ cần board HIỂN THỊ với người gọi (404 nếu không), không cần
//! quyền `kanban.boards`.

#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgConnection};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;

use crate::boards::load_visible;
use crate::nullable::some_nullable;
use crate::{Access, KANBAN_BOARD_LABEL_MAX_DEFS, board_not_found, db, finish, is_hex_color, len16};

/// Một nhãn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelDef {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// Kết quả cả ba endpoint: danh sách nhãn sau khi đổi.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Labels {
    pub labels: Vec<LabelDef>,
}

/// Đọc `label_defs`: phần tử sai hình dạng bị bỏ, JSON hỏng coi như rỗng (không làm sập cả board).
pub fn parse_label_defs(raw: &serde_json::Value) -> Vec<LabelDef> {
    let Some(arr) = raw.as_array() else { return Vec::new() };
    arr.iter()
        .filter_map(|v| {
            let o = v.as_object()?;
            Some(LabelDef {
                id: o.get("id")?.as_str()?.to_owned(),
                name: o.get("name")?.as_str()?.to_owned(),
                color: o.get("color")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

/// Body `POST /labels`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateLabel {
    pub name: String,
    pub color: String,
}

/// Body `PATCH /labels/:labelId`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateLabel {
    #[serde(default, deserialize_with = "some_nullable")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub color: Option<Option<String>>,
}

/// Tên nhãn được cắt khoảng trắng TRƯỚC khi kiểm (như `@Transform(trim)` rồi `@MinLength(1)`): tên toàn khoảng trắng
/// ⇒ rỗng ⇒ 400, độ dài tính trên chuỗi đã cắt (đúng giá trị sẽ lưu).
fn label_errors(name: Option<&str>, color: Option<&str>, out: &mut Vec<String>) {
    if let Some(n) = name {
        let n = trim_js(n);
        if len16(n) > 64 {
            out.push("name tối đa 64 ký tự".to_owned());
        }
        if n.is_empty() {
            out.push("name không được rỗng".to_owned());
        }
    }
    if let Some(c) = color
        && !is_hex_color(c)
    {
        out.push("color phải là mã hex hợp lệ (vd #eb5a46)".to_owned());
    }
}

impl CreateLabel {
    /// Luật của `CreateKanbanLabelDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        label_errors(Some(&self.name), Some(&self.color), &mut e);
        finish(e)
    }
}

impl UpdateLabel {
    /// Luật của `UpdateKanbanLabelDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        // `null` ở cột NOT NULL không phải "vắng mặt" ⇒ 400.
        if matches!(self.name, Some(None)) {
            e.push("name phải là chuỗi".to_owned());
        }
        if matches!(self.color, Some(None)) {
            e.push("color phải là mã hex hợp lệ (vd #eb5a46)".to_owned());
        }
        label_errors(
            self.name.as_ref().and_then(|v| v.as_deref()),
            self.color.as_ref().and_then(|v| v.as_deref()),
            &mut e,
        );
        finish(e)
    }
}

/// Nạp `label_defs` của board đang tồn tại, khoá dòng để hai thay đổi nhãn đồng thời không ghi đè nhau.
async fn lock_labels(tx: &mut PgConnection, board_id: i32) -> Result<Vec<LabelDef>, AppError> {
    let raw: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT label_defs FROM kanban_boards WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
            .bind(board_id)
            .fetch_optional(tx)
            .await
            .map_err(db)?;
    raw.map(|v| parse_label_defs(&v))
        .ok_or_else(|| board_not_found(board_id))
}

async fn save(tx: &mut PgConnection, board_id: i32, labels: &[LabelDef]) -> Result<(), AppError> {
    let json = serde_json::Value::Array(
        labels
            .iter()
            .map(|l| serde_json::json!({ "id": l.id, "name": l.name, "color": l.color }))
            .collect(),
    );
    sqlx::query("UPDATE kanban_boards SET label_defs = $2, updated_at = now() WHERE id = $1")
        .bind(board_id)
        .bind(json)
        .execute(tx)
        .await
        .map_err(db)?;
    Ok(())
}

fn label_not_found(id: &str) -> AppError {
    HttpError::not_found(format!("Không tìm thấy nhãn ID {id}")).into()
}

/// `POST /boards/:id/labels`: tối đa [`KANBAN_BOARD_LABEL_MAX_DEFS`] nhãn. Gọi sau [`CreateLabel::validate`].
pub async fn create(
    conn: &mut PgConnection,
    access: &Access,
    board_id: i32,
    input: &CreateLabel,
) -> Result<Labels, AppError> {
    load_visible(&mut *conn, access, board_id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    let mut labels = lock_labels(&mut tx, board_id).await?;
    if labels.len() >= KANBAN_BOARD_LABEL_MAX_DEFS {
        return Err(HttpError::bad_request(format!("Board đã đạt trần {KANBAN_BOARD_LABEL_MAX_DEFS} nhãn")).into());
    }
    labels.push(LabelDef {
        id: uuid::Uuid::new_v4().to_string(),
        name: trim_js(&input.name).to_owned(),
        color: input.color.clone(),
    });
    save(&mut tx, board_id, &labels).await?;
    tx.commit().await.map_err(db)?;
    Ok(Labels { labels })
}

/// `PATCH /boards/:id/labels/:labelId`. Gọi sau [`UpdateLabel::validate`].
pub async fn update(
    conn: &mut PgConnection,
    access: &Access,
    board_id: i32,
    label_id: &str,
    input: &UpdateLabel,
) -> Result<Labels, AppError> {
    load_visible(&mut *conn, access, board_id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    let mut labels = lock_labels(&mut tx, board_id).await?;
    let l = labels
        .iter_mut()
        .find(|l| l.id == label_id)
        .ok_or_else(|| label_not_found(label_id))?;
    if let Some(Some(n)) = &input.name {
        l.name = trim_js(n).to_owned();
    }
    if let Some(Some(c)) = &input.color {
        l.color.clone_from(c);
    }
    save(&mut tx, board_id, &labels).await?;
    tx.commit().await.map_err(db)?;
    Ok(Labels { labels })
}

/// `DELETE /boards/:id/labels/:labelId`: xoá nhãn và gỡ id khỏi mọi card đang gắn nó (một câu `array_remove`).
pub async fn remove(
    conn: &mut PgConnection,
    access: &Access,
    board_id: i32,
    label_id: &str,
) -> Result<Labels, AppError> {
    load_visible(&mut *conn, access, board_id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    let labels = lock_labels(&mut tx, board_id).await?;
    if !labels.iter().any(|l| l.id == label_id) {
        return Err(label_not_found(label_id));
    }
    let next: Vec<LabelDef> = labels.into_iter().filter(|l| l.id != label_id).collect();
    save(&mut tx, board_id, &next).await?;
    sqlx::query("UPDATE kanban_cards SET labels = array_remove(labels, $2) WHERE board_id = $1")
        .bind(board_id)
        .bind(label_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Labels { labels: next })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_nhan_bo_phan_tu_sai() {
        let v = serde_json::json!([{"id":"a","name":"x","color":"#fff"}, {"id":1}, "r", {"id":"b","name":"y"}]);
        assert_eq!(parse_label_defs(&v).len(), 1);
        assert!(parse_label_defs(&serde_json::json!({"a":1})).is_empty());
    }

    #[test]
    fn validate_nhan() {
        assert!(
            CreateLabel {
                name: "Gấp".into(),
                color: "#eb5a46".into()
            }
            .validate()
            .is_ok()
        );
        assert!(
            CreateLabel {
                name: String::new(),
                color: "red".into()
            }
            .validate()
            .is_err()
        );
        assert!(UpdateLabel::default().validate().is_ok());
    }

    #[test]
    fn nhan_toan_khoang_trang_hoac_null_bi_chan() {
        let ws = CreateLabel {
            name: "   ".into(),
            color: "#fff".into(),
        };
        assert!(ws.validate().is_err());
        let padded = CreateLabel {
            name: format!(" {} ", "a".repeat(64)),
            color: "#fff".into(),
        };
        assert!(padded.validate().is_ok());
        let nul: UpdateLabel = serde_json::from_str(r#"{"name":null,"color":null}"#).unwrap();
        assert_eq!(nul.validate().unwrap_err().body().status_code, 400);
    }
}
