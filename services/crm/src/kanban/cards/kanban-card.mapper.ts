import { KanbanCardContactDisplay } from '../common/kanban-contact.helper';

/** Select tối thiểu đủ cho hiển thị + kiểm quyền — KHÔNG `include` sâu.
 *
 * Gồm `assignees`/`checklist_items` (mảng NHỎ theo card — đọc trọn
 * để tính tổng/done ở JS, KHÔNG dùng tính năng `_count` filter-by-relation của
 * Prisma để tránh phụ thuộc version cụ thể) + `activities` lọc `action=comment`
 * (đếm bình luận) + `_count.attachments` (không filter, an toàn mọi version). */
export const KANBAN_CARD_SELECT = {
  id: true,
  code: true,
  board_id: true,
  column_id: true,
  position: true,
  title: true,
  description: true,
  contact_id: true,
  assignee_id: true,
  created_by: true,
  due_at: true,
  due_completed_at: true,
  priority: true,
  labels: true,
  attributes: true,
  completed_at: true,
  created_at: true,
  updated_at: true,
  assignees: { select: { user_id: true } },
  checklist_items: { select: { is_done: true } },
  activities: { where: { action: 'comment' }, select: { id: true } },
  _count: { select: { attachments: true } },
} as const;

export type KanbanCardRow = {
  id: number;
  code: string | null;
  board_id: number;
  column_id: number;
  position: number;
  title: string;
  description: string | null;
  contact_id: number | null;
  assignee_id: number | null;
  created_by: number;
  due_at: Date | null;
  due_completed_at: Date | null;
  priority: string | null;
  labels: string[];
  attributes: unknown;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  assignees: { user_id: number }[];
  checklist_items: { is_done: boolean }[];
  activities: { id: number }[];
  _count: { attachments: number };
};

export interface KanbanCardDto
  extends Omit<KanbanCardRow, 'assignees' | 'checklist_items' | 'activities' | '_count'> {
  contact: KanbanCardContactDisplay | null;
  is_overdue: boolean;
  assignee_ids: number[];
  checklist_total: number;
  checklist_done: number;
  comment_count: number;
  attachment_count: number;
}

/**
 * ⚠️ Khi `contact` resolve ra `null` do actor KHÔNG được xem contact đó
 * (người dùng bị chặn Danh bạ, hoặc contact ngoài phạm vi RBAC — xem
 * `resolveKanbanCardContactDisplays`), redact LUÔN `contact_id` số thô về
 * `null` trong response — "show nothing" phải là KHÔNG rò cả con số ID, không
 * chỉ ẩn tên/SĐT (giữ nguyên `contact_id` sẽ vẫn để lộ card này CÓ gắn
 * đúng contact nào cho actor đủ kiên nhẫn dò từng id).
 *
 * Quá hạn (`is_overdue`) xét THÊM `due_completed_at` — đánh dấu
 * hoàn thành hạn (độc lập cột `is_done`) cũng tắt trạng thái quá hạn, mirror
 * Trello due-date-complete.
 */
export function toKanbanCardDto(
  card: KanbanCardRow,
  contact: KanbanCardContactDisplay | null,
): KanbanCardDto {
  const { assignees, checklist_items, activities, _count, ...rest } = card;
  const isOverdue =
    rest.due_at != null &&
    rest.due_completed_at == null &&
    rest.completed_at == null &&
    rest.due_at.getTime() < Date.now();
  const contact_id = contact == null ? null : rest.contact_id;
  const assigneeIds = Array.from(
    new Set([...(rest.assignee_id != null ? [rest.assignee_id] : []), ...assignees.map((a) => a.user_id)]),
  );
  return {
    ...rest,
    contact_id,
    contact,
    is_overdue: isOverdue,
    assignee_ids: assigneeIds,
    checklist_total: checklist_items.length,
    checklist_done: checklist_items.filter((i) => i.is_done).length,
    comment_count: activities.length,
    attachment_count: _count.attachments,
  };
}
