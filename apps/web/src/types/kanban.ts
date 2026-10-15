/**
 * Kanban — mirror 1:1 các DTO/mapper phía BE
 * (`services/crm/src/kanban/**`).
 */

export const KANBAN_FIELD_TYPES = [
  "text",
  "number",
  "money",
  "date",
  "select",
  "multi_select",
  "user",
  "checkbox",
  "url",
] as const
export type KanbanFieldType = (typeof KANBAN_FIELD_TYPES)[number]

export const KANBAN_PRIORITIES = ["low", "normal", "high", "urgent"] as const
export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number]

export const KANBAN_ACTIVITY_ACTIONS = [
  "created",
  "moved",
  "updated",
  "comment",
  "assigned",
  "contact_linked",
  "contact_unlinked",
  "deleted",
  "restored",
  "checklist_item_added",
  "checklist_item_toggled",
  "checklist_item_removed",
  "attachment_added",
  "attachment_removed",
] as const
export type KanbanActivityAction = (typeof KANBAN_ACTIVITY_ACTIONS)[number]

/** Bảng màu gợi ý khi tạo nhãn mới — mirror `KANBAN_LABEL_COLOR_PRESETS` BE. */
export const KANBAN_LABEL_COLOR_PRESETS = [
  "#61bd4f",
  "#f2d600",
  "#ff9f1a",
  "#eb5a46",
  "#c377e0",
  "#0079bf",
  "#00c2e0",
  "#51e898",
  "#ff78cb",
  "#344563",
] as const

export interface KanbanFieldOption {
  value: string
  label: string
}

/** Nhãn màu dùng chung của board (`KanbanBoard.label_defs`). */
export interface KanbanLabelDef {
  id: string
  name: string
  color: string
}

export interface KanbanBoard {
  id: number
  name: string
  description: string | null
  icon: string | null
  color: string | null
  is_active: boolean
  /** RBAC quyền+phạm vi — id vai trò được thấy board này, rỗng = mọi người có `kanban.view`. */
  visibility_role_ids: number[]
  card_prefix: string | null
  created_by: number | null
  created_at: string
  updated_at: string
  column_count: number
  card_count: number
}

export interface KanbanColumn {
  id: number
  board_id: number
  name: string
  color: string | null
  position: number
  wip_limit: number | null
  is_done: boolean
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface KanbanFieldDef {
  id: number
  board_id: number
  key: string
  label: string
  type: KanbanFieldType
  options: KanbanFieldOption[] | null
  required: boolean
  show_on_card: boolean
  position: number
  created_at: string
  updated_at: string
}

export interface KanbanBoardDetail extends KanbanBoard {
  columns: KanbanColumn[]
  field_defs: KanbanFieldDef[]
  label_defs: KanbanLabelDef[]
}

export interface KanbanCardContact {
  id: number
  full_name: string | null
  phone: string
  masked: boolean
}

export interface KanbanCard {
  id: number
  /** Mã chung CV001… (có từ migration mã chung). */
  code?: string | null
  board_id: number
  column_id: number
  position: number
  title: string
  description: string | null
  contact_id: number | null
  assignee_id: number | null
  /** TOÀN BỘ người phụ trách (primary `assignee_id` LUÔN nằm trong
   * mảng này ở phần tử đầu nếu có) — dùng cho UI multi-avatar. */
  assignee_ids: number[]
  created_by: number
  due_at: string | null
  /** đánh dấu hoàn thành HẠN (độc lập cột `is_done`) — mirror
   * Trello due-date-complete checkbox. */
  due_completed_at: string | null
  priority: KanbanPriority | null
  labels: string[]
  attributes: Record<string, unknown>
  completed_at: string | null
  created_at: string
  updated_at: string
  contact: KanbanCardContact | null
  is_overdue: boolean
  checklist_total: number
  checklist_done: number
  comment_count: number
  attachment_count: number
}

export interface KanbanCardActivity {
  id: number
  card_id: number
  actor_id: number | null
  actor_name: string | null
  action: KanbanActivityAction
  payload: Record<string, unknown>
  created_at: string
}

export interface KanbanChecklistItem {
  id: number
  card_id: number
  text: string
  is_done: boolean
  position: number
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface KanbanCardAttachment {
  id: number
  card_id: number
  url: string
  title: string | null
  created_by: number
  created_at: string
}

export interface KanbanTemplate {
  key: string
  name: string
  description: string
  columns: string[]
}

export interface ListKanbanCardsResult {
  cards: KanbanCard[]
  next_cursor: number | null
  has_more: boolean
}

export interface QueryKanbanCardsParams {
  board_id?: number
  column_id?: number
  contact_id?: number
  assignee_id?: number
  label?: string
  overdue?: boolean
  search?: string
  cursor?: number
  limit?: number
}

export interface CreateKanbanBoardPayload {
  name: string
  description?: string | null
  icon?: string | null
  color?: string | null
  visibility_role_ids?: number[]
  card_prefix?: string | null
}

export type UpdateKanbanBoardPayload = Partial<CreateKanbanBoardPayload> & { is_active?: boolean }

export interface CreateKanbanColumnPayload {
  name: string
  color?: string | null
  wip_limit?: number | null
  is_done?: boolean
}
export type UpdateKanbanColumnPayload = Partial<CreateKanbanColumnPayload> & {
  is_archived?: boolean
}

export interface CreateKanbanFieldDefPayload {
  key: string
  label: string
  type: KanbanFieldType
  options?: KanbanFieldOption[]
  required?: boolean
  show_on_card?: boolean
}
export type UpdateKanbanFieldDefPayload = Partial<
  Omit<CreateKanbanFieldDefPayload, "key" | "type">
>

export interface CreateKanbanCardPayload {
  column_id: number
  title: string
  description?: string | null
  contact_id?: number | null
  /** Tương thích ngược — v1 chỉ 1 người. Gửi `assignee_ids` thì field này bị BỎ QUA. */
  assignee_id?: number | null
  /** THAY THẾ toàn bộ danh sách người phụ trách khi gửi. */
  assignee_ids?: number[]
  due_at?: string | null
  priority?: KanbanPriority | null
  labels?: string[]
  attributes?: Record<string, unknown>
}

export type UpdateKanbanCardPayload = Partial<Omit<CreateKanbanCardPayload, "column_id">> & {
  /** ISO khi đánh dấu hoàn thành hạn, `null` khi bỏ đánh dấu. */
  due_completed_at?: string | null
}

export interface MoveKanbanCardPayload {
  column_id: number
  before_card_id?: number
  after_card_id?: number
}

export interface MoveKanbanCardResult {
  card: KanbanCard
  wip_warning: string | null
}

export interface CreateKanbanLabelPayload {
  name: string
  color: string
}
export type UpdateKanbanLabelPayload = Partial<CreateKanbanLabelPayload>
export interface KanbanLabelListResult {
  labels: KanbanLabelDef[]
}

export interface CreateKanbanChecklistItemPayload {
  text: string
}
export interface UpdateKanbanChecklistItemPayload {
  text?: string
  is_done?: boolean
}

export interface CreateKanbanAttachmentPayload {
  url: string
  title?: string | null
}
