/**
 * Khoảng ngày nhanh theo GIỜ VN (Asia/Ho_Chi_Minh). Toán ngày bằng UTC thuần
 * trên chuỗi `YYYY-MM-DD` để độc lập múi giờ/DST của máy client.
 */
import { todayVn } from "@/lib/format"

export interface DateRange {
  date_from: string
  date_to: string
}

export type DateRangePresetId =
  | "today" | "this_week" | "last7" | "last30" | "this_month" | "last_month" | "this_year"

export const DATE_RANGE_PRESETS: { id: DateRangePresetId; label: string }[] = [
  { id: "today", label: "Hôm nay" },
  { id: "this_week", label: "Tuần này" },
  { id: "last7", label: "7 ngày qua" },
  { id: "last30", label: "30 ngày qua" },
  { id: "this_month", label: "Tháng này" },
  { id: "last_month", label: "Tháng trước" },
  { id: "this_year", label: "Năm nay" },
]

const pad2 = (n: number) => String(n).padStart(2, "0")
const ymd = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`

function shiftDays(today: string, delta: number): string {
  const [y, m, d] = today.split("-").map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  base.setUTCDate(base.getUTCDate() + delta)
  return ymd(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate())
}

/** `today` mặc định = hôm nay giờ VN; truyền vào để test cố định. */
export function computeDateRangePreset(id: DateRangePresetId, today: string = todayVn()): DateRange {
  const [y, m, d] = today.split("-").map(Number)
  switch (id) {
    case "today":
      return { date_from: today, date_to: today }
    case "this_week": {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=CN
      return { date_from: shiftDays(today, -(dow === 0 ? 6 : dow - 1)), date_to: today }
    }
    case "last7":
      return { date_from: shiftDays(today, -6), date_to: today }
    case "last30":
      return { date_from: shiftDays(today, -29), date_to: today }
    case "this_month":
      return { date_from: ymd(y, m, 1), date_to: today }
    case "last_month": {
      const py = m === 1 ? y - 1 : y
      const pm = m === 1 ? 12 : m - 1
      return { date_from: ymd(py, pm, 1), date_to: ymd(py, pm, new Date(py, pm, 0).getDate()) }
    }
    case "this_year":
      return { date_from: ymd(y, 1, 1), date_to: today }
  }
}

/** Preset đang khớp khoảng hiện tại (để tô sáng), hoặc null. */
export function matchDateRangePreset(range: DateRange, today: string = todayVn()): DateRangePresetId | null {
  for (const p of DATE_RANGE_PRESETS) {
    const r = computeDateRangePreset(p.id, today)
    if (r.date_from === range.date_from && r.date_to === range.date_to) return p.id
  }
  return null
}
