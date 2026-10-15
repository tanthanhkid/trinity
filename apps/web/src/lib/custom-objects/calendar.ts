/**
 * Lịch cho bảng tuỳ biến — phần THUẦN: lưới tháng/tuần (thứ Hai đầu tuần), khoảng lọc gửi BE, ngày của một bản ghi theo
 * GIỜ VIỆT NAM (UTC+7, không DST). Mọi ngày là chuỗi "YYYY-MM-DD" để không phụ thuộc múi giờ máy.
 */
const DAY_MS = 86_400_000
const VN_OFFSET_MS = 7 * 3_600_000

export type CalendarMode = "month" | "week"

const toYmd = (t: number): string => new Date(t).toISOString().slice(0, 10)
const fromYmd = (ymd: string): number => Date.parse(`${ymd}T00:00:00.000Z`)

export function addDays(ymd: string, n: number): string {
  return toYmd(fromYmd(ymd) + n * DAY_MS)
}

export function addMonths(ymd: string, n: number): string {
  const [y, m] = ymd.split("-").map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return toYmd(d.getTime())
}

/** Thứ Hai của tuần chứa ngày này. */
export function startOfWeek(ymd: string): string {
  const dow = new Date(fromYmd(ymd)).getUTCDay() // 0 = CN
  return addDays(ymd, dow === 0 ? -6 : 1 - dow)
}

export const firstOfMonth = (ymd: string): string => `${ymd.slice(0, 7)}-01`

/** Lưới tháng: các tuần (mỗi tuần 7 ngày, T2 → CN) phủ trọn tháng của `anchor`. */
export function monthGrid(anchor: string): string[][] {
  const first = firstOfMonth(anchor)
  const next = addMonths(first, 1)
  const weeks: string[][] = []
  for (let w = startOfWeek(first); w < next; w = addDays(w, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)))
  return weeks
}

export function weekDays(anchor: string): string[] {
  const s = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(s, i))
}

/** Khoảng ngày đang xem [đầu, cuối] (đúng lưới hiển thị). */
export function visibleRange(mode: CalendarMode, anchor: string): { from: string; to: string } {
  const days = mode === "week" ? weekDays(anchor) : monthGrid(anchor).flat()
  return { from: days[0], to: days[days.length - 1] }
}

/** Bộ lọc gửi BE: trường `date` lọc theo ngày; `datetime` lọc theo mốc ISO đầu/cuối ngày GIỜ VIỆT NAM. */
export function rangeFilter(type: "date" | "datetime", r: { from: string; to: string }): { from: string; to: string } {
  if (type === "date") return r
  return { from: new Date(fromYmd(r.from) - VN_OFFSET_MS).toISOString(), to: new Date(fromYmd(r.to) + DAY_MS - 1 - VN_OFFSET_MS).toISOString() }
}

/** Ngày (giờ VN) của giá trị trường ngày / ngày giờ; sai dạng → null. */
export function dayOf(value: unknown, type: "date" | "datetime"): string | null {
  if (typeof value !== "string") return null
  if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  const t = Date.parse(value)
  return Number.isFinite(t) ? toYmd(t + VN_OFFSET_MS) : null
}

/** "HH:mm" giờ VN của giá trị ngày giờ (trường `date` → ""). */
export function timeOf(value: unknown, type: "date" | "datetime"): string {
  if (type === "date" || typeof value !== "string") return ""
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t + VN_OFFSET_MS).toISOString().slice(11, 16) : ""
}

export const WEEKDAY_LABELS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]

export function monthTitle(anchor: string): string {
  const [y, m] = anchor.split("-")
  return `Tháng ${Number(m)}/${y}`
}

export function vnDay(ymd: string): string {
  const [y, m, d] = ymd.split("-")
  return `${d}/${m}/${y}`
}
