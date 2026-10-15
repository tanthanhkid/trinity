/**
 * Hằng số dùng chung cho module Kanban.
 */

/** Whitelist kiểu trường tuỳ biến — mirror `PRODUCT_ATTRIBUTE_TYPES`, KHÔNG phải
 * Prisma enum để tránh migration khi cần thêm kiểu mới sau này. */
export const KANBAN_FIELD_TYPES = [
  'text',
  'number',
  'money',
  'date',
  'select',
  'multi_select',
  'user',
  'checkbox',
  'url',
] as const;
export type KanbanFieldType = (typeof KANBAN_FIELD_TYPES)[number];

export const KANBAN_TEXT_MAX_LENGTH = 2000;
export const KANBAN_NUMBER_CEILING = 1_000_000_000_000;
/** Trần tiền VND — số nguyên, không âm (yêu cầu "money as integer VND"). */
export const KANBAN_MONEY_CEILING = 1_000_000_000_000;

export const KANBAN_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number];

/** Action ghi vào `kanban_card_activities.action` — whitelist cố định (mirror 
 * mọi action mới PHẢI đi kèm cập nhật whitelist hiển thị FE). */
export const KANBAN_ACTIVITY_ACTIONS = [
  'created',
  'moved',
  'updated',
  'comment',
  'assigned',
  'contact_linked',
  'contact_unlinked',
  'deleted',
  'restored',
  'checklist_item_added',
  'checklist_item_toggled',
  'checklist_item_removed',
  'attachment_added',
  'attachment_removed',
] as const;
export type KanbanActivityAction = (typeof KANBAN_ACTIVITY_ACTIONS)[number];

/** Khoảng cách mặc định giữa 2 vị trí liền kề khi thêm mới/renormalize — đủ rộng
 * để chèn nhiều lần trước khi cần renormalize lại. */
export const KANBAN_POSITION_GAP = 1024;

/** Ngưỡng khoảng cách tối thiểu giữa 2 vị trí — dưới ngưỡng này phải renormalize
 * (double precision còn đủ độ chính xác nhưng chia đôi mãi sẽ tiến về 0). */
export const KANBAN_POSITION_MIN_GAP = 1e-6;

export const KANBAN_CARD_TITLE_MAX_LENGTH = 500;
export const KANBAN_CARD_DESCRIPTION_MAX_LENGTH = 10_000;
export const KANBAN_COMMENT_MAX_LENGTH = 5000;
export const KANBAN_LABEL_MAX_ITEMS = 20;
export const KANBAN_LABEL_MAX_LENGTH = 64;

/** Cap cho danh sách card trả về 1 lần (per-column load) —
 * KHÔNG kéo toàn bộ card 1 lần. */
export const KANBAN_CARDS_DEFAULT_LIMIT = 30;
export const KANBAN_CARDS_MAX_LIMIT = 100;

/** Cap số cột/field-def reorder trong 1 lần gọi — bảng nhỏ, chặn payload rác. */
export const KANBAN_REORDER_MAX_ITEMS = 200;

/** Nhãn màu board (`KanbanBoard.label_defs`) — mirror giới hạn trần
 * của field-def/cột, bảng nhỏ theo board. */
export const KANBAN_BOARD_LABEL_MAX_DEFS = 30;
export const KANBAN_BOARD_LABEL_NAME_MAX_LENGTH = 64;
/** Hex 3/6 ký tự (`#abc` hoặc `#aabbcc`) — validate ở DTO, KHÔNG nhận tên màu CSS
 * tự do (tránh XSS qua `style` nội suy chuỗi ở FE). */
export const KANBAN_BOARD_LABEL_COLOR_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
/** Bảng màu mặc định gợi ý khi tạo nhãn mới — mirror bảng màu ưu tiên (WIP). */
export const KANBAN_LABEL_COLOR_PRESETS = [
  '#61bd4f',
  '#f2d600',
  '#ff9f1a',
  '#eb5a46',
  '#c377e0',
  '#0079bf',
  '#00c2e0',
  '#51e898',
  '#ff78cb',
  '#344563',
] as const;

/** Checklist (`kanban_checklist_items`). */
export const KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH = 500;
export const KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD = 200;

/** Đính kèm DẠNG LINK (`kanban_card_attachments` — MinIO chưa cài). */
export const KANBAN_ATTACHMENT_URL_MAX_LENGTH = 2000;
export const KANBAN_ATTACHMENT_TITLE_MAX_LENGTH = 255;
export const KANBAN_ATTACHMENTS_MAX_PER_CARD = 50;

/** Multi-assignee (`kanban_card_assignees`) — trần hợp lý cho 1 card. */
export const KANBAN_CARD_ASSIGNEES_MAX = 20;
