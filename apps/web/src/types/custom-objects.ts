/** Thực thể tuỳ biến — kiểu dữ liệu FE, khớp `services/crm/src/custom-objects`. */

export type CustomFieldType =
  | "text" | "long_text" | "number" | "currency" | "percent" | "date" | "datetime" | "boolean"
  | "select" | "multi_select" | "email" | "phone" | "url" | "relation" | "user" | "formula" | "link"

export interface SelectChoice {
  value: string
  label: string
  color?: string
}

export interface CustomFieldOptions {
  choices?: SelectChoice[]
  target_object_id?: number
  target?: "contact"
  /** Chỉ có trong phản hồi định nghĩa (BE suy ra, người xem thấy được thực thể đích mới có). */
  target_key?: string
  target_label?: string
  multiple?: boolean
  expression?: string
  format?: "number" | "currency" | "percent"
  decimals?: number
}

export interface CustomFieldDef {
  id: number
  key: string
  label: string
  type: CustomFieldType
  required: boolean
  is_unique: boolean
  is_title: boolean
  show_in_list: boolean
  sort_order: number
  options: CustomFieldOptions
  help_text: string | null
}

export interface CustomObjectSummary {
  id: number
  key: string
  label: string
  label_plural: string
  icon: string | null
  description: string | null
  show_in_nav: boolean
  nav_order: number
  visible_role_ids: number[]
  is_active: boolean
  code_prefix?: string | null
  field_count: number
  record_count: number
}

export interface CustomObjectDef {
  id: number
  key: string
  label: string
  label_plural: string
  icon: string | null
  description: string | null
  show_in_nav: boolean
  nav_order: number
  visible_role_ids: number[]
  is_active: boolean
  /** Tiền tố mã bản ghi (SP → SP001). */
  code_prefix?: string | null
  code_prefix_aliases?: string[]
  created_at: string
  updated_at: string
  fields: CustomFieldDef[]
}

export interface CustomNavItem {
  key: string
  label: string
  label_plural: string
  icon: string | null
  nav_order: number
  /** mục menu trỏ tới một view (kanban/danh sách) thay vì trang mặc định `/x/<key>`. */
  href?: string
  /** Khoá mục menu duy nhất (bảng: khoá bảng; view: `<bảng>__<view>`). */
  menu_key?: string
}

export interface CustomRelationLabel {
  id: number
  /** null = đã xoá hoặc ngoài phạm vi của bạn. */
  title: string | null
  accessible: boolean
  /** Chỉ trường "Liên kết": loại + mã + bảng + đường mở. */
  type?: "record" | "contact" | "deal" | "task"
  code?: string | null
  table?: string
  href?: string | null
}

export type CustomRecordData = Record<string, unknown>

export interface CustomRecord {
  id: number
  /** Mã chung (SP001) — gắn thẻ @ ở màn khác. */
  code?: string | null
  title: string
  owner_id: number | null
  owner_name: string | null
  created_by: number | null
  created_at: string
  updated_at: string
  data: CustomRecordData
  relations: Record<string, CustomRelationLabel | CustomRelationLabel[]>
}

export interface CustomRecordPage {
  items: CustomRecord[]
  next_cursor: string | null
  total: number | null
}

export interface CustomLookupItem {
  id: number
  code?: string | null
  title: string
}

export interface CustomRelatedGroup {
  object: { key: string; label_plural: string }
  field: { key: string; label: string }
  total: number
  items: CustomLookupItem[]
}

export interface CustomTemplateInfo {
  key: string
  label: string
  description: string
  objects: { key: string; label: string; applied: boolean }[]
}

/** Màn xem của bảng tuỳ biến — AI tạo/sửa qua MCP theo quyền người kết nối (duyệt chỉ khi bật ai_require_approval). */
export interface CustomViewConfig {
  group_by?: string
  card_fields?: string[]
  columns?: string[]
  /** calendar: trường ngày / ngày giờ đặt bản ghi lên lịch + kiểu xem mặc định. */
  date_field?: string
  mode?: "month" | "week"
  sort?: { field: string; dir: "asc" | "desc" }
  filter?: Record<string, unknown>
}

export interface CustomViewDef {
  id: number
  key: string
  object_key: string
  label: string
  type: "list" | "kanban" | "calendar" | "table"
  config: CustomViewConfig
  icon: string | null
  show_in_nav: boolean
  nav_order: number
  href: string
}
