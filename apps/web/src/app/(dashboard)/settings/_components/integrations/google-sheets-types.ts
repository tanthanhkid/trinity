/** Kiểu dữ liệu + nhãn cho Cài đặt > Kết nối & AI > Google Sheets — khớp `services/crm/src/google`. */

export interface GoogleStatus {
  feature_enabled: boolean
  /** Máy chủ đã đặt GOOGLE_OAUTH_CLIENT_ID/SECRET (+ địa chỉ callback)? */
  configured: boolean
  secret_key_configured: boolean
  redirect_uri: string | null
  connection: { id: number; email: string | null; status: "active" | "revoked" | "error"; last_error: string | null; connected_at: string } | null
}

export type SyncDirection = "import" | "export"
export type SyncTargetKind = "contact" | "custom_object"
export type RunStatus = "running" | "ok" | "partial" | "error"

export interface GoogleSync {
  id: number
  name: string
  direction: SyncDirection
  spreadsheet_id: string
  sheet_title: string
  target_kind: SyncTargetKind
  target_object_key: string | null
  column_map: Record<string, string>
  dedupe_key: string
  actor_user_id: number
  contact_source_id: number | null
  schedule_minutes: number | null
  is_active: boolean
  last_run_at: string | null
  last_status: RunStatus | null
  last_error: string | null
}

export interface RunStats {
  read: number
  created: number
  updated: number
  unchanged: number
  duplicates_in_sheet: number
  invalid: number
  errors: number
  error_samples: string[]
}

export interface SyncRun {
  id: string
  trigger: "manual" | "schedule"
  started_at: string
  finished_at: string | null
  status: RunStatus
  stats: RunStats
  error: string | null
}

export interface TargetField {
  key: string
  label: string
  required?: boolean
}
export interface GoogleTargets {
  contact_fields: TargetField[]
  custom_objects: Array<{ key: string; label_plural: string; fields: Array<{ key: string; label: string; type: string; required: boolean }> }>
}

export interface InspectResult {
  spreadsheet_id: string
  title: string
  tabs: string[]
  headers: string[]
}

export const DIRECTION_LABELS: Record<SyncDirection, string> = { import: "Nhập từ Sheet", export: "Xuất ra Sheet" }
export const RUN_STATUS_LABELS: Record<RunStatus, string> = { running: "Đang chạy", ok: "Thành công", partial: "Một phần", error: "Lỗi" }
export const SCHEDULE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Chỉ chạy tay" },
  { value: "15", label: "Mỗi 15 phút" },
  { value: "60", label: "Mỗi giờ" },
  { value: "360", label: "Mỗi 6 giờ" },
  { value: "1440", label: "Mỗi ngày" },
]

/** Tóm tắt một lần chạy thành một câu tiếng Việt (không chứa dữ liệu khách). */
export function summarizeStats(s: RunStats, direction: SyncDirection): string {
  if (direction === "export") return `Đã ghi ${s.created} dòng`
  const parts = [`${s.created} mới`, `${s.updated} cập nhật`, `${s.unchanged} không đổi`]
  if (s.duplicates_in_sheet) parts.push(`${s.duplicates_in_sheet} trùng trong Sheet`)
  if (s.invalid) parts.push(`${s.invalid} dòng thiếu/sai khoá`)
  if (s.errors) parts.push(`${s.errors} lỗi`)
  return parts.join(" · ")
}

/** Gợi ý ánh xạ: cột có tên trùng nhãn/khoá trường (không phân biệt hoa thường) được chọn sẵn. */
export function guessMapping(fields: TargetField[], headers: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const hit = headers.find((h) => [f.label, f.key].some((n) => n.trim().toLowerCase() === h.trim().toLowerCase()))
    if (hit) out[f.key] = hit
  }
  return out
}
