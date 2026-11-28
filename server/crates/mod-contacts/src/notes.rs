//! Ghi chú của khách (`POST /contacts/:id/notes`, Ánh xanh khach — khối «Ghi nhanh cuộc gọi»). Lõi dùng chung với tool MCP
//! `add_contact_note` (`mod-mcp::tools::act_contacts`): một dòng `activities` `action = 'note'`, `details.description` = nội
//! dung (dòng thời gian của web đọc khoá này), `created_by` = người ghi.
//!
//! Quyền: `contacts.update` phủ chủ khách (`assigned_to`, `created_by_id`); khách không có, đã xoá hoặc ngoài phạm vi ⇒ 404
//! như `PATCH /contacts/:id`.
//!
//! Hoàn tác (`DELETE /contacts/:id/notes/:noteId`, nút Hoàn tác của toast «Đã lưu ghi chú»): chỉ NGƯỜI VỪA GHI, trong
//! [`NOTE_UNDO_SECONDS`] giây theo đồng hồ DB ⇒ xoá hẳn dòng `activities` (bảng không có `deleted_at`). Người khác ⇒ 403,
//! quá hạn ⇒ 409. Không có tool MCP tương ứng (không tool xoá).

use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::OwnerIds;

use crate::{assert_in_scope, db, http};

/// Trần nội dung một ghi chú (bằng `NOTE_MAX` của tool MCP), tính theo ký tự.
pub const NOTE_MAX: usize = 2000;

/// Cửa sổ Hoàn tác một ghi chú vừa ghi (giây, đồng hồ DB).
pub const NOTE_UNDO_SECONDS: i32 = 10;

/// Ghi chú vừa tạo.
#[derive(Debug, Serialize)]
pub struct NoteCreated {
    pub id: i32,
    pub contact_id: i32,
    pub action: String,
    pub details: Value,
    pub created_by: i32,
    pub created_at: Timestamp,
}

/// Body `{ note }` của `POST /contacts/:id/notes`: trường lạ, thiếu, `null`, không phải chuỗi, rỗng sau khi cắt khoảng trắng
/// hoặc dài quá [`NOTE_MAX`] ⇒ 400 (không cắt ngầm). Trả nội dung đã cắt khoảng trắng hai đầu, xuống dòng chuẩn `\n`.
pub fn parse_note_body(body: &Value) -> Result<String, AppError> {
    let mut errs: Vec<String> = body
        .as_object()
        .map(|o| {
            o.keys()
                .filter(|k| k.as_str() != "note")
                .map(|k| format!("property {k} should not exist"))
                .collect()
        })
        .unwrap_or_default();
    if !body.is_object() {
        errs.push("Dữ liệu gửi lên phải là đối tượng JSON".to_owned());
    }
    let note = match body.get("note") {
        Some(Value::String(s)) => {
            let t = s.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned();
            if t.is_empty() {
                errs.push("Nội dung ghi chú không được rỗng".to_owned());
            } else if t.chars().count() > NOTE_MAX {
                errs.push(format!("Ghi chú tối đa {NOTE_MAX} ký tự"));
            }
            t
        }
        None | Some(Value::Null) => {
            errs.push("note must be a string".to_owned());
            errs.push("Nội dung ghi chú không được rỗng".to_owned());
            String::new()
        }
        Some(_) => {
            errs.push("note must be a string".to_owned());
            String::new()
        }
    };
    if errs.is_empty() {
        Ok(note)
    } else {
        Err(HttpError::validation(errs).into())
    }
}

/// Thêm ghi chú cho khách `contact_id` trong phạm vi `update` (`contacts.update`). `extra` gộp vào `details` cạnh
/// `description` (vd `source`), `metadata` vào cột `metadata` (`None` ⇒ `NULL`). Nội dung phải đã kiểm.
pub async fn add_note(
    conn: &mut PgConnection,
    update: Option<&OwnerIds>,
    user_id: i32,
    contact_id: i32,
    note: &str,
    extra: Map<String, Value>,
    metadata: Option<Value>,
) -> Result<NoteCreated, AppError> {
    let owners: Option<(Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1 AND deleted_at IS NULL")
            .bind(contact_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let (assigned_to, created_by) = owners.ok_or_else(|| http(HttpError::not_found("Không tìm thấy khách hàng")))?;
    assert_in_scope(update, &[assigned_to, created_by])?;

    let mut d = extra;
    d.insert("description".into(), json!(note));
    let details = Value::Object(d);
    let (id, created_at): (i32, Timestamp) = sqlx::query_as(
        "INSERT INTO activities (contact_id, action, details, metadata, created_by)
         VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, $4) RETURNING id, created_at",
    )
    .bind(contact_id)
    .bind(details.to_string())
    .bind(metadata.as_ref().map(Value::to_string))
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    Ok(NoteCreated {
        id,
        contact_id,
        action: "note".to_owned(),
        details,
        created_by: user_id,
        created_at,
    })
}

/// Thu hồi (Hoàn tác) ghi chú `note_id` của khách `contact_id`. Thứ tự kiểm để không lộ dữ liệu: khách không có/đã xoá/ngoài
/// phạm vi `update` ⇒ 404; ghi chú không thuộc khách hoặc không phải `note` ⇒ 404; không phải người ghi ⇒ 403; quá
/// [`NOTE_UNDO_SECONDS`] giây ⇒ 409. Khoá dòng (`FOR UPDATE`) rồi xoá trong cùng giao dịch.
pub async fn revoke_note(
    conn: &mut PgConnection,
    update: Option<&OwnerIds>,
    user_id: i32,
    contact_id: i32,
    note_id: i32,
) -> Result<(), AppError> {
    let owners: Option<(Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1 AND deleted_at IS NULL")
            .bind(contact_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let (assigned_to, created_by) = owners.ok_or_else(|| http(HttpError::not_found("Không tìm thấy khách hàng")))?;
    assert_in_scope(update, &[assigned_to, created_by])?;

    let mut tx = sqlx::Connection::begin(&mut *conn).await.map_err(db)?;
    let row: Option<(Option<i32>, bool)> = sqlx::query_as(
        "SELECT created_by, created_at < now() - make_interval(secs => $3) FROM activities
         WHERE id = $1 AND contact_id = $2 AND action = 'note' FOR UPDATE",
    )
    .bind(note_id)
    .bind(contact_id)
    .bind(f64::from(NOTE_UNDO_SECONDS))
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let (author, expired) = row.ok_or_else(|| http(HttpError::not_found("Không tìm thấy ghi chú")))?;
    if author != Some(user_id) {
        return Err(http(HttpError::forbidden(
            "Chỉ người vừa ghi mới hoàn tác được ghi chú này",
        )));
    }
    if expired {
        return Err(http(HttpError::conflict(format!(
            "Đã quá {NOTE_UNDO_SECONDS} giây — ghi chú này không hoàn tác được nữa"
        ))));
    }
    sqlx::query("DELETE FROM activities WHERE id = $1")
        .bind(note_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn msgs(e: AppError) -> Vec<String> {
        match e {
            AppError::Http(h) => match h.body().message {
                trinity_kernel::error::Message::Many(m) => m,
                trinity_kernel::error::Message::One(m) => vec![m],
            },
            other => vec![other.to_string()],
        }
    }

    #[test]
    fn ghi_chu_hop_le_cat_khoang_trang_va_chuan_xuong_dong() {
        assert_eq!(
            parse_note_body(&json!({ "note": "  Khách hẹn\r\nthứ Hai  " })).unwrap(),
            "Khách hẹn\nthứ Hai"
        );
        let max = "a".repeat(NOTE_MAX);
        assert_eq!(parse_note_body(&json!({ "note": max })).unwrap().len(), NOTE_MAX);
    }

    #[test]
    fn ghi_chu_sai_la_400_khong_cat_ngam() {
        for body in [
            json!({}),
            json!({ "note": null }),
            json!({ "note": 12 }),
            json!({ "note": "   " }),
            json!({ "note": "a".repeat(NOTE_MAX + 1) }),
            json!({ "note": "ok", "contact_id": 1 }),
            json!([]),
        ] {
            let e = parse_note_body(&body).expect_err(&body.to_string());
            assert!(!msgs(e).is_empty());
        }
        let m = msgs(parse_note_body(&json!({ "note": "ok", "x": 1 })).unwrap_err());
        assert_eq!(m, vec!["property x should not exist".to_owned()]);
    }
}
