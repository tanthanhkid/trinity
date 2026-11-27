//! Module Kanban (M15 bảng, cột, nhãn màu, trường tuỳ biến; M16 thẻ, checklist, đính kèm, lịch sử), chuyển từ
//! `services/crm/src/kanban` (`boards`, `columns`, `field-defs`, `cards`, `checklist`, `attachments`, `common`).
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
//!
//! M16 (17 endpoint, bảng route ở [`routes`]): thẻ `GET/POST /kanban/cards`, `GET/PATCH/DELETE /kanban/cards/:id`, `move`,
//! `restore`, `activities`, `comments` ([`cards`], [`activities`]); checklist 5 route ([`checklist`]); đính kèm dạng liên kết 3
//! route ([`attachments`]). Quyền xem thẻ theo phạm vi `kanban.view` (người tạo hoặc người phụ trách nằm trong phạm vi) cộng
//! board hiển thị với vai trò; endpoint con luôn gọi lại cổng của thẻ cha ([`cards::load_scoped`]), ngoài phạm vi là 404.
//!
//! Handler HTTP và `api_router` (35 route, bảng ở [`routes`]) nằm ở [`http`]; `trinity-bin` khai vào `declared_routes` và mount ở `serve`.

#![allow(clippy::result_large_err, clippy::type_complexity)]

pub mod activities;
pub mod attachments;
pub mod attributes;
pub mod boards;
pub mod cards;
pub mod checklist;
pub mod columns;
pub mod field_defs;
pub mod http;
pub mod labels;
mod nullable;
pub mod position;
pub mod routes;
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

/// Người gọi cho các thao tác trên thẻ: [`Access`] của board cộng phạm vi `kanban.view` và quyền Danh bạ (hiển thị khách gắn
/// trên thẻ). Do tầng route dựng từ guard và `ScopeService`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub user_id: i32,
    /// Vai trò hệ thống "Quản trị": xoá/khôi phục thẻ của người khác.
    pub is_admin: bool,
    pub access: Access,
    /// Phạm vi `kanban.view` (`None` = không có quyền ⇒ không thẻ nào; fail-closed như `owner ?? []`).
    pub card_owner: Option<trinity_rbac::OwnerIds>,
    /// Giữ quyền `contacts.view` (không có thì khách trên thẻ bị ẩn hoàn toàn, kể cả id).
    pub can_view_contacts: bool,
    pub contact_view: Option<trinity_rbac::OwnerIds>,
    pub contact_phone_full: Option<trinity_rbac::OwnerIds>,
}

/// `Date.now() - deleted_at > RESTORE_WINDOW_MS`: cửa sổ Hoàn tác 10 phút.
pub const RESTORE_WINDOW_MINUTES: i32 = 10;

pub const CARDS_DEFAULT_LIMIT: i64 = 30;
pub const CARDS_MAX_LIMIT: i64 = 100;
pub const CARD_ASSIGNEES_MAX: usize = 20;
pub const CHECKLIST_ITEMS_MAX_PER_CARD: i64 = 200;
pub const ATTACHMENTS_MAX_PER_CARD: i64 = 50;
pub const ACTIVITIES_MAX_LIMIT: i64 = 200;

pub(crate) const CARD_COLS: &str = "c.id, c.code, c.board_id, c.column_id, c.position, c.title, c.description, c.contact_id, c.assignee_id, \
     c.created_by, c.due_at, c.priority, c.labels, c.attributes, c.completed_at, c.due_completed_at, c.created_at, c.updated_at, \
     c.deleted_at, c.deleted_by";

pub(crate) fn not_found(msg: String) -> AppError {
    HttpError::not_found(msg).into()
}

pub(crate) fn bad_request(msg: impl Into<trinity_kernel::error::Message>) -> AppError {
    HttpError::bad_request(msg).into()
}

pub(crate) fn forbidden(msg: &str) -> AppError {
    HttpError::forbidden(msg).into()
}

const INT4_MAX: i64 = 2_147_483_647;

/// `@Min(1)` (+ `@Max(INT4_MAX)` khi `cap`) cho id số nguyên tuỳ chọn.
pub(crate) fn check_id(field: &str, v: Option<i64>, cap: bool, out: &mut Vec<String>) {
    if let Some(v) = v {
        if v < 1 {
            out.push(format!("{field} không hợp lệ"));
        } else if cap && v > INT4_MAX {
            out.push(format!("{field} vượt trần cho phép"));
        }
    }
}

/// `@IsDateString`: ISO 8601 (`YYYY-MM-DD` hoặc có giờ); sai ⇒ lỗi `<field> phải là ngày ISO 8601 hợp lệ`.
pub(crate) fn check_date(field: &str, v: Option<&str>, out: &mut Vec<String>) {
    if let Some(v) = v
        && !crate::attributes::valid_iso(v)
    {
        out.push(format!("{field} phải là ngày ISO 8601 hợp lệ"));
    }
}

/// Chuỗi 1..max ký tự (UTF-16), như `@MinLength(1) @MaxLength(max)`.
pub(crate) fn check_text(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    if v.is_empty() {
        out.push(format!("{field} không được rỗng"));
    } else if len16(v) > max {
        out.push(format!("{field} tối đa {max} ký tự"));
    }
}
