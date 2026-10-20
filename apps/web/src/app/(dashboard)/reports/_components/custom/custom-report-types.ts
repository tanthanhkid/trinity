/** Khớp `services/crm/src/reports/custom/*` (#25). */

export interface CustomReportDef {
  id: string
  name: string
  /** `contacts` · `deals` · `x:<khoá bảng tuỳ biến>` */
  source: string
  date_field: string
  sum_fields: string[]
  group_by: string | null
  preset?: string
}

export interface CustomReportListItem extends CustomReportDef {
  source_label: string
}

export interface CustomReportList {
  reports: CustomReportListItem[]
  can_manage: boolean
}

export type ReportFieldRole = "date" | "number" | "group"

export interface CustomReportSource {
  source: string
  label: string
  fields: { key: string; label: string; role: ReportFieldRole }[]
}

export interface ReportNumbers {
  count: number
  sums: Record<string, number>
}

export interface CustomReportResult extends ReportNumbers {
  report: CustomReportDef
  period: { value: string; label: string }
  missing_date: number
  groups: (ReportNumbers & { key: string | null; label: string })[]
  by_month: (ReportNumbers & { month: string })[]
  fields: { date: string; sums: { key: string; label: string }[]; group: string | null }
}

/** Kỳ: `this_month` · `month:YYYY-MM` · `year:YYYY` · `all`. */
export type PeriodKind = "this_month" | "month" | "year" | "all"

export function periodValue(kind: PeriodKind, month: string, year: string): string {
  if (kind === "month" && /^\d{4}-\d{2}$/.test(month)) return `month:${month}`
  if (kind === "year" && /^\d{4}$/.test(year)) return `year:${year}`
  if (kind === "all") return "all"
  return "this_month"
}

/** `YYYY-MM` → `MM/YYYY`. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-")
  return `${m}/${y}`
}

/** Mã báo cáo từ tên: bỏ dấu, a-z0-9_, không trùng danh sách có sẵn. */
export function reportIdFromName(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40) || "bao_cao"
  let id = base
  for (let i = 2; taken.has(id) || RESERVED.has(id); i++) id = `${base}_${i}`
  return id
}

const RESERVED = new Set(["sources", "definitions", "presets"])
