/**
 * Nhãn + mô tả tiếng Việt cho lịch sử hoạt động card Kanban.
 * Whitelist action mirror `KANBAN_ACTIVITY_ACTIONS` — action lạ vẫn rơi
 * về nhãn chung, KHÔNG in mã thô ra UI.
 */
import type { KanbanActivityAction, KanbanCardActivity } from "@/types/kanban"

export const ACTIVITY_LABELS: Record<KanbanActivityAction, string> = {
  created: "Tạo card",
  moved: "Chuyển cột",
  updated: "Cập nhật",
  comment: "Bình luận",
  assigned: "Đổi người phụ trách",
  contact_linked: "Gắn khách hàng",
  contact_unlinked: "Gỡ khách hàng",
  deleted: "Xoá card",
  restored: "Khôi phục card",
  checklist_item_added: "Thêm việc checklist",
  checklist_item_toggled: "Cập nhật checklist",
  checklist_item_removed: "Xoá việc checklist",
  attachment_added: "Thêm đính kèm",
  attachment_removed: "Gỡ đính kèm",
}

/** Tên field DTO card → nhãn người dùng (payload `updated.fields`). */
const FIELD_LABELS: Record<string, string> = {
  title: "tiêu đề",
  description: "mô tả",
  priority: "mức ưu tiên",
  due_at: "hạn xử lý",
  due_completed_at: "trạng thái hoàn thành",
  labels: "nhãn",
  attributes: "trường tuỳ biến",
  assignee_id: "người phụ trách",
  assignee_ids: "người phụ trách",
  contact_id: "khách hàng",
  column_id: "cột",
  position: "vị trí",
}

export type ActivityTone = "neutral" | "info" | "success" | "danger"

export const ACTIVITY_TONE: Record<KanbanActivityAction, ActivityTone> = {
  created: "success",
  moved: "info",
  updated: "neutral",
  comment: "neutral",
  assigned: "info",
  contact_linked: "info",
  contact_unlinked: "neutral",
  deleted: "danger",
  restored: "success",
  checklist_item_added: "info",
  checklist_item_toggled: "success",
  checklist_item_removed: "neutral",
  attachment_added: "info",
  attachment_removed: "neutral",
}

export function activityLabel(action: string): string {
  return ACTIVITY_LABELS[action as KanbanActivityAction] ?? "Hoạt động khác"
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export function describeActivity(
  a: KanbanCardActivity,
  columnName: (id: unknown) => string,
): string {
  const p = a.payload
  switch (a.action) {
    case "comment":
      return str(p.content)
    case "moved":
      return `Chuyển từ cột "${columnName(p.from_column_id)}" sang cột "${columnName(p.to_column_id)}"`
    case "updated": {
      const raw = Array.isArray(p.fields) ? (p.fields as string[]) : []
      const names = [...new Set(raw.map((f) => FIELD_LABELS[f] ?? "thông tin khác"))]
      return names.length ? `Sửa ${names.join(", ")}` : "Cập nhật card"
    }
    case "created":
      return str(p.title) ? `Tạo card "${str(p.title)}"` : "Tạo card"
    case "checklist_item_added":
      return `Thêm việc "${str(p.text)}"`
    case "checklist_item_removed":
      return `Xoá việc "${str(p.text)}"`
    case "checklist_item_toggled":
      return `${p.is_done ? "Đánh dấu xong" : "Bỏ đánh dấu"} việc "${str(p.text)}"`
    case "attachment_added":
      return `Thêm đính kèm "${str(p.title) || str(p.url)}"`
    case "attachment_removed":
      return `Gỡ đính kèm "${str(p.title)}"`
    default:
      return activityLabel(a.action)
  }
}
