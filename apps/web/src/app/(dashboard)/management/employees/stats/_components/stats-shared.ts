import type { DonutSlice } from "@/app/(dashboard)/reports/_components/charts/donut-chart"
import { categoryColor, CHART_NEUTRAL } from "@/components/app-shell/charts/chart-colors"
import { CHART_PALETTE } from "@/components/app-shell/charts/chart-data"

/** Số lát tối đa trước khi gộp "Khác" — xem docblock `toSlices`. */
const MAX_SLICES = CHART_PALETTE.length - 1

// Nhãn tiếng Việt cho các enum (đồng bộ với /management/employees page.tsx).
export const STATUS_LABELS: Record<string, string> = {
  unclassified: "Chưa phân loại",
  active: "Đang làm việc",
  probation: "Thử việc",
  waiting: "Chờ vào làm",
  on_leave: "Tạm nghỉ",
  resigned: "Nghỉ việc",
}

export const GENDER_LABELS: Record<string, string> = {
  M: "Nam",
  F: "Nữ",
}

export const EDUCATION_LABELS: Record<string, string> = {
  dai_hoc_tro_len: "Đại học trở lên",
  cao_dang: "Cao đẳng",
  trung_cap: "Trung cấp",
  thpt_12: "THPT (12/12)",
  thcs: "THCS",
  khac: "Khác",
}

// 5 nhóm trạng thái cho biểu đồ cột chồng theo Team (khớp BE statusBucket).
export const STATUS_BUCKETS = [
  { key: "active", label: "Đang làm việc", color: categoryColor(0) },
  { key: "probation", label: "Thử việc", color: categoryColor(1) },
  { key: "on_leave", label: "Tạm nghỉ", color: categoryColor(2) },
  { key: "resigned", label: "Nghỉ việc", color: categoryColor(3) },
  { key: "other", label: "Khác", color: CHART_NEUTRAL },
] as const

// Nhãn tháng cho biểu đồ sinh nhật.
export const MONTH_LABELS = [
  "T1", "T2", "T3", "T4", "T5", "T6",
  "T7", "T8", "T9", "T10", "T11", "T12",
]

/**
 * Map `{ label, count }[]` → `DonutSlice[]`, GỘP đuôi thành "Khác".
 *
 * Số hạng mục (phòng ban / chức danh / team) do dữ liệu quyết định, nên không
 * xoay vòng màu: lát thứ 7 trở đi sẽ trùng màu lát 1 và chú giải không nối được
 * lát với nhãn. Vì vậy tối đa 5 lát + 1 lát "Khác" = 6 màu của bảng màu.
 *
 * Lát "Khác" chỉ sinh ra khi đuôi thực sự có giá trị > 0.
 */
export function toSlices(
  rows: { label: string; count: number }[],
  labelMap?: Record<string, string>,
): DonutSlice[] {
  const named = rows.map((r) => ({
    key: r.label,
    label: labelMap ? labelMap[r.label] ?? r.label : r.label,
    value: r.count,
  }))
  const sorted = [...named].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, MAX_SLICES)
  let rest = 0
  for (const r of sorted.slice(MAX_SLICES)) rest += r.value

  const slices: DonutSlice[] = head.map((r, i) => ({ ...r, color: categoryColor(i) }))
  if (rest > 0) {
    slices.push({ key: "__other__", label: "Khác", value: rest, color: CHART_NEUTRAL })
  }
  return slices
}
