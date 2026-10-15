import { queueWhenLabel } from "./social-queue"

/** Luật lặp — khớp `RecurrenceRule` phía BE (giờ Việt Nam, UTC+7). */
export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly"
  interval: number
  weekdays?: number[]
  month_day?: number
  time: string
}

const DAY = 86_400_000
const MINUTE = 60_000
const VN_OFFSET_MS = 7 * 3_600_000
const parseDay = (s: string): number => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY)
const dayNumOf = (ms: number) => Math.floor((ms + VN_OFFSET_MS) / DAY)
const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate()

/** Bản sao phía trình duyệt của `nextOccurrence` (BE): lần đăng ĐẦU TIÊN sau `after`, tính theo mốc `startsOn` (YYYY-MM-DD). */
export function nextOccurrence(rule: RecurrenceRule, after: number, startsOn: string): number | null {
  const start = parseDay(startsOn)
  if (Number.isNaN(start) || !/^\d{2}:\d{2}$/.test(rule.time)) return null
  const mins = Number(rule.time.slice(0, 2)) * 60 + Number(rule.time.slice(3, 5))
  const interval = Math.max(1, rule.interval || 1)
  const sd = new Date(start * DAY)
  const monday = (d: number) => d - ((new Date(d * DAY).getUTCDay() + 6) % 7)
  const weekdays = rule.weekdays?.length ? rule.weekdays : [sd.getUTCDay()]
  for (let d = Math.max(dayNumOf(after), start), n = 0; n < 800; d++, n++) {
    const dt = new Date(d * DAY)
    let hit: boolean
    if (rule.freq === "daily") hit = (d - start) % interval === 0
    else if (rule.freq === "weekly") hit = weekdays.includes(dt.getUTCDay()) && ((monday(d) - monday(start)) / 7) % interval === 0
    else {
      const months = (dt.getUTCFullYear() - sd.getUTCFullYear()) * 12 + dt.getUTCMonth() - sd.getUTCMonth()
      hit = months % interval === 0 && dt.getUTCDate() === Math.min(rule.month_day ?? sd.getUTCDate(), lastDayOf(dt.getUTCFullYear(), dt.getUTCMonth()))
    }
    if (!hit) continue
    const at = d * DAY + mins * MINUTE - VN_OFFSET_MS
    if (at > after) return at
  }
  return null
}

/** Trạng thái form "Lặp lại" của ô soạn. */
export interface RecurrenceForm {
  freq: RecurrenceRule["freq"]
  interval: number
  weekdays: number[]
  monthDay: number
  time: string
  startsOn: string
  endMode: "never" | "date" | "count"
  endsOn: string
  maxCount: number
}

export const emptyRecurrence = (today: string): RecurrenceForm => ({ freq: "weekly", interval: 1, weekdays: [], monthDay: 1, time: "09:00", startsOn: today, endMode: "never", endsOn: "", maxCount: 10 })

/** Thứ hiện trong form: T2 đầu tuần, Chủ nhật cuối (0). */
export const RECURRENCE_WEEKDAYS: ReadonlyArray<{ weekday: number; label: string }> = [
  { weekday: 1, label: "T2" }, { weekday: 2, label: "T3" }, { weekday: 3, label: "T4" }, { weekday: 4, label: "T5" }, { weekday: 5, label: "T6" }, { weekday: 6, label: "T7" }, { weekday: 0, label: "CN" },
]
const WEEKDAY_NAMES = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"]

export function ruleOf(f: RecurrenceForm): RecurrenceRule {
  return {
    freq: f.freq,
    interval: f.interval,
    time: f.time,
    ...(f.freq === "weekly" && f.weekdays.length ? { weekdays: [...f.weekdays].sort((a, b) => a - b) } : {}),
    ...(f.freq === "monthly" ? { month_day: f.monthDay } : {}),
  }
}

/** Mô tả luật: "Hằng tuần, mỗi 2 tuần vào Thứ Hai, Thứ Năm lúc 09:00". */
export function ruleText(r: RecurrenceRule): string {
  const n = r.interval
  const base =
    r.freq === "daily"
      ? `Hằng ngày${n > 1 ? `, mỗi ${n} ngày` : ""}`
      : r.freq === "weekly"
        ? `Hằng tuần${n > 1 ? `, mỗi ${n} tuần` : ""}${r.weekdays?.length ? ` vào ${r.weekdays.map((w) => WEEKDAY_NAMES[w]).join(", ")}` : ""}`
        : `Hằng tháng${n > 1 ? `, mỗi ${n} tháng` : ""}${r.month_day ? ` vào ngày ${r.month_day}` : ""}`
  return `${base} lúc ${r.time}`
}

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

/** Lỗi của form (null = hợp lệ). */
export function recurrenceError(f: RecurrenceForm, now = Date.now()): string | null {
  if (!Number.isInteger(f.interval) || f.interval < 1 || f.interval > 12) return "Khoảng lặp phải từ 1 đến 12."
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time)) return "Chọn giờ đăng."
  if (f.freq === "weekly" && f.weekdays.length === 0) return "Chọn ít nhất một thứ trong tuần."
  if (f.freq === "monthly" && (!Number.isInteger(f.monthDay) || f.monthDay < 1 || f.monthDay > 31)) return "Ngày trong tháng phải từ 1 đến 31."
  if (!isDay(f.startsOn)) return "Chọn ngày bắt đầu."
  if (f.endMode === "date") {
    if (!isDay(f.endsOn)) return "Chọn ngày kết thúc."
    if (f.endsOn < f.startsOn) return "Ngày kết thúc phải sau ngày bắt đầu."
  }
  if (f.endMode === "count" && (!Number.isInteger(f.maxCount) || f.maxCount < 1 || f.maxCount > 1000)) return "Số lần đăng phải từ 1 đến 1000."
  return nextTimes(f, 1, now).length === 0 ? "Với lựa chọn này không còn lần đăng nào trong tương lai." : null
}

/** `n` lần đăng tới (ms), theo luật + ngày bắt đầu + cách kết thúc. */
export function nextTimes(f: RecurrenceForm, n = 3, now = Date.now()): number[] {
  const rule = ruleOf(f)
  const out: number[] = []
  let cursor = now
  while (out.length < n && (f.endMode !== "count" || out.length < f.maxCount)) {
    const t = nextOccurrence(rule, cursor, f.startsOn)
    if (t === null) break
    if (f.endMode === "date" && f.endsOn && dayNumOf(t) > parseDay(f.endsOn)) break
    out.push(t)
    cursor = t
  }
  return out
}

/** "3 lần đăng tới: 09:00 Thứ Ba 20/10 · …" */
export function nextTimesLine(f: RecurrenceForm, now = Date.now()): string {
  const t = nextTimes(f, 3, now)
  return t.length ? `${t.length} lần đăng tới: ${t.map((x) => queueWhenLabel(new Date(x).toISOString())).join(" · ")}` : "Không còn lần đăng nào."
}

/** Form → phần luật/lịch của thân `POST /social/recurrences`. */
export function recurrenceSchedule(f: RecurrenceForm) {
  return { rule: ruleOf(f), starts_on: f.startsOn, ends_on: f.endMode === "date" ? f.endsOn : null, max_count: f.endMode === "count" ? f.maxCount : null }
}
