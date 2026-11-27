//! Module Kanban (M15 bảng, cột, nhãn màu, trường tuỳ biến), chuyển từ `services/crm/src/kanban`
//! (`boards`, `columns`, `field-defs`, `common`). Thẻ (cards), checklist, đính kèm thuộc issue khác.
//!
//! Mỗi hàm nhận `&mut PgConnection` đã gắn công ty và trả `AppError` của K05; tầng route chỉ việc: extractor K15 →
//! `validate()` → hàm ở đây → JSON. 18 endpoint:
//!
//! | Quyền | Endpoint | Hàm |
//! |---|---|---|
//! | `kanban.view` | `GET /kanban/boards`, `GET /kanban/boards/:id` | [`boards::find_all_visible`], [`boards::find_one_detail`] |
//! | `kanban.view` | `POST/PATCH/DELETE /kanban/boards/:id/labels[/:labelId]` | [`labels::create`], [`labels::update`], [`labels::remove`] |
//! | `kanban.boards` | `POST /kanban/boards`, `PATCH/DELETE /kanban/boards/:id` | [`boards::create`], [`boards::update`], [`boards::remove`] |
//! | `kanban.boards` | `GET /kanban/boards/templates`, `POST /kanban/boards/from-template` | [`boards::list_templates`], [`boards::create_from_template`] |
//! | `kanban.boards` | `POST /kanban/boards/:boardId/columns[/reorder]`, `PATCH/DELETE /kanban/columns/:id` | [`columns`] |
//! | `kanban.boards` | `POST /kanban/boards/:boardId/field-defs[/reorder]`, `PATCH/DELETE /kanban/field-defs/:id` | [`field_defs`] |

#![allow(clippy::result_large_err)]

pub mod boards;
pub mod columns;
pub mod field_defs;
pub mod labels;
mod nullable;
pub mod position;
pub mod templates;

use trinity_kernel::error::{AppError, HttpError};

/// Người gọi, đủ cho lọc hiển thị board (`kanban.boards` thấy mọi board; vai trò còn lại theo `visibility_role_ids`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    /// Giữ quyền `kanban.boards`.
    pub can_manage_boards: bool,
    /// `user_roles.role_id` của người gọi.
    pub role_ids: Vec<i32>,
}

pub const KANBAN_BOARD_LABEL_MAX_DEFS: usize = 30;
pub const KANBAN_REORDER_MAX_ITEMS: usize = 200;

/// Độ dài như `String.length` của JS (đơn vị UTF-16).
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `#abc` hoặc `#aabbcc` (`KANBAN_BOARD_LABEL_COLOR_PATTERN`).
pub(crate) fn is_hex_color(v: &str) -> bool {
    let Some(h) = v.strip_prefix('#') else { return false };
    matches!(h.len(), 3 | 6) && h.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> AppError {
    trinity_db::pg_error::app_error(&e)
}

pub(crate) fn board_not_found(id: i32) -> AppError {
    HttpError::not_found(format!("Không tìm thấy board ID {id}")).into()
}

/// Cột của `kanban_boards` theo thứ tự model [`trinity_db::models::KanbanBoard`].
pub(crate) const BOARD_COLS: &str = "id, name, description, icon, color, is_active, visibility_role_ids, card_prefix, \
     settings, label_defs, created_by, created_at, updated_at, deleted_at";
pub(crate) const COLUMN_COLS: &str =
    "id, board_id, name, color, position, wip_limit, is_done, is_archived, created_at, updated_at";
pub(crate) const FIELD_DEF_COLS: &str =
    "id, board_id, key, label, type, options, required, show_on_card, position, created_at, updated_at";

/// `{ ok: true }`-kiểu kết quả xoá.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Deleted {
    pub deleted: bool,
}
