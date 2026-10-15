/**
 * Chương trình con (do trợ lý AI của khách viết, người duyệt rồi mới chạy). Chữ hiển thị tiếng Việt, KHÔNG dùng thuật ngữ kỹ thuật
 * (MCP/API/OAuth/token) ở phần người dùng đọc. Mã nguồn + tên + mô tả do AI soạn ⇒ chỉ hiển thị dạng text (không HTML).
 */
export type ExtensionStatus = "draft" | "approved" | "active" | "disabled"
export type ReviewStatus = "draft" | "approved" | "rejected"
export type ExtensionKind = "job" | "tool" | "api"

export interface ExtensionManifest {
  net: string[]
  tables: { read: string[]; write: string[] }
  schedule?: string
  input_schema?: Record<string, unknown>
  limits?: { timeoutMs?: number; memoryMb?: number }
}

export interface ExtensionVersion {
  version: number
  review_status: ReviewStatus
  review_note: string | null
  note: string | null
  manifest: ExtensionManifest
  created_at: string
  reviewed_at: string | null
  code?: string
}

export interface Extension {
  id: number
  key: string
  kind: ExtensionKind
  name: string
  description: string
  status: ExtensionStatus
  active_version: number | null
  latest_version: number
  disabled_reason: string | null
  consecutive_failures: number
  created_at: string
  updated_at: string
}

export interface ExtensionRun {
  id: number
  mode: "dry_run" | "schedule" | "manual" | "tool_call"
  outcome: string
  duration_ms: number
  started_at: string
  log: string
}

export const STATUS_LABEL: Record<ExtensionStatus, string> = {
  draft: "Chờ duyệt",
  approved: "Đã duyệt, chưa chạy",
  active: "Đang chạy",
  disabled: "Đã tắt",
}
export const STATUS_VARIANT: Record<ExtensionStatus, "soft" | "success" | "secondary" | "destructive"> = {
  draft: "soft",
  approved: "secondary",
  active: "success",
  disabled: "destructive",
}
export const REVIEW_LABEL: Record<ReviewStatus, string> = { draft: "Chờ duyệt", approved: "Đã duyệt", rejected: "Đã từ chối" }
export const KIND_LABEL: Record<ExtensionKind, string> = {
  job: "Chạy theo lịch",
  tool: "Công cụ cho trợ lý AI",
  api: "Điểm nối ngoài (chưa chạy được)",
}
export const OUTCOME_LABEL: Record<string, string> = {
  ok: "Thành công",
  error: "Lỗi",
  timeout: "Quá thời gian",
  oom: "Hết bộ nhớ",
  permission_denied: "Bị chặn quyền",
  disabled: "Đang tắt",
}
export const MODE_LABEL: Record<ExtensionRun["mode"], string> = { dry_run: "Chạy thử", schedule: "Theo lịch", manual: "Chạy tay", tool_call: "Được gọi" }

/** Quyền chương trình con XIN, bằng lời thường — người duyệt đọc từng dòng trước khi bấm Duyệt. */
export function describePermissions(m: ExtensionManifest, kind: ExtensionKind): string[] {
  const lines: string[] = []
  if (kind === "job" && m.schedule) lines.push(`Tự chạy theo lịch “${m.schedule}” (giờ Việt Nam).`)
  lines.push(m.net.length ? `Được kết nối ra các trang bên ngoài: ${m.net.join(", ")}.` : "Không được kết nối ra ngoài.")
  lines.push(m.tables.read.length ? `Được ĐỌC dữ liệu các bảng: ${m.tables.read.join(", ")}.` : "Không được đọc dữ liệu của hệ thống.")
  lines.push(m.tables.write.length ? `Được GHI dữ liệu vào các bảng: ${m.tables.write.join(", ")}.` : "Không được ghi dữ liệu vào hệ thống.")
  const l = m.limits
  if (l?.timeoutMs || l?.memoryMb) lines.push(`Giới hạn: ${l.timeoutMs ? `${Math.round(l.timeoutMs / 1000)} giây` : "thời gian mặc định"} mỗi lần, ${l.memoryMb ? `${l.memoryMb} MB bộ nhớ` : "bộ nhớ mặc định"}.`)
  return lines
}

export const extensionsDisabled = (err: unknown): boolean => (err as { response?: { status?: number } })?.response?.status === 404

export function extensionErrorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message
  if (Array.isArray(msg)) return msg.join("; ")
  return typeof msg === "string" && msg ? msg : fallback
}
