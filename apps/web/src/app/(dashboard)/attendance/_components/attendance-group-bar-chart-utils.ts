import type { GroupStatBase } from "@/hooks/use-attendance"
import { CHART_STATUS } from "@/components/app-shell/charts/chart-colors"

/** 1 nhóm (Team/Phòng ban) để vẽ trên biểu đồ cột ghép. */
export interface AttendanceChartGroup {
  /** Key duy nhất: team_id?.toString() ?? "none" | department. */
  id: string
  /** Tên cụm hiển thị dưới biểu đồ + tiêu đề tooltip. */
  name: string
  /** Dòng phụ tuỳ chọn trong tooltip (vd "Trưởng phòng: Nguyễn A"). */
  meta?: string
  stat: GroupStatBase
}

/** Khoá các chỉ số ĐẾM được vẽ thành cột (loại các field không phải số đếm). */
type CountMetricKey =
  | "checked_in_people"
  | "present_people"
  | "late_people"
  | "absent_people"

export interface ChartMetric {
  key: CountMetricKey
  label: string
  color: string
}

/**
 * Nguồn DUY NHẤT cho 4 chỉ số được vẽ — dùng chung cho cột, nhãn số, chú thích
 * và tooltip nên không bao giờ lệch nhau. Màu giữ đúng biểu đồ chấm công cũ.
 */
export const CHART_METRICS: ChartMetric[] = [
  { key: "checked_in_people", label: "Đã chấm công", color: CHART_STATUS.good },
  { key: "present_people", label: "Có mặt", color: "var(--color-app-primary)" },
  { key: "late_people", label: "Đi muộn", color: CHART_STATUS.warn },
  { key: "absent_people", label: "Vắng", color: CHART_STATUS.bad },
]

/** Phần trăm 1 chỉ số trên tổng nhân viên của nhóm. Chặn chia cho 0 → 0 (không NaN). */
export function pctOfHeadcount(value: number, headcount: number): number {
  if (headcount <= 0) return 0
  return Math.round((value / headcount) * 100)
}

export interface GroupTooltipMetric {
  key: string
  label: string
  color: string
  value: number
  pct: number
}

export interface GroupTooltip {
  name: string
  meta?: string
  headcount: number
  metrics: GroupTooltipMetric[]
  attendanceRate: number
  insufficient: number
  lateMinutes: number
}

/** Dựng nội dung tooltip cho 1 cụm: 4 chỉ số (value + %) + 3 số liệu chân. */
export function buildGroupTooltip(group: AttendanceChartGroup): GroupTooltip {
  const { stat } = group
  return {
    name: group.name,
    meta: group.meta,
    headcount: stat.headcount,
    metrics: CHART_METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      color: m.color,
      value: stat[m.key],
      pct: pctOfHeadcount(stat[m.key], stat.headcount),
    })),
    attendanceRate: stat.attendance_rate,
    insufficient: stat.insufficient_people,
    lateMinutes: stat.total_late_minutes,
  }
}
