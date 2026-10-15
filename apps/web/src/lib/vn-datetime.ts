/**
 * Helper THUẦN cho ô chọn ngày giờ `dd/mm/yyyy HH:mm`. Giá trị
 * lưu/ phát đi luôn là chuỗi kiểu `datetime-local` — `YYYY-MM-DDTHH:mm` (giờ
 * địa phương, KHÔNG múi giờ) — để thay thế trực tiếp `<input type="datetime-local">`
 * mà không đổi contract của các form/handler đang dùng.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/

export interface LocalDateTimeParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
}

export function splitLocalDateTime(v: string | null | undefined): LocalDateTimeParts | null {
  if (!v) return null
  const m = LOCAL_RE.exec(v)
  if (!m) return null
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

export function joinLocalDateTime(p: LocalDateTimeParts): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** `YYYY-MM-DDTHH:mm` → `dd/mm/yyyy HH:mm`; rỗng/sai → "". */
export function localToVnDateTime(v: string | null | undefined): string {
  const p = splitLocalDateTime(v)
  if (!p) return ""
  return `${pad(p.day)}/${pad(p.month)}/${pad(p.year, 4)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** Mask khi gõ: chỉ giữ chữ số (tối đa 12) rồi chèn `/`, khoảng trắng, `:`. */
export function autoMaskVnDateTime(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 12)
  let out = d.slice(0, 2)
  if (d.length > 2) out += "/" + d.slice(2, 4)
  if (d.length > 4) out += "/" + d.slice(4, 8)
  if (d.length > 8) out += " " + d.slice(8, 10)
  if (d.length > 10) out += ":" + d.slice(10, 12)
  return out
}

/**
 * `dd/mm/yyyy HH:mm` → `YYYY-MM-DDTHH:mm`. Trả "" nếu rỗng, `undefined` nếu
 * chưa đủ ký tự hoặc ngày giờ không có thật (31/02, 24:00, 12:60).
 */
export function parseVnDateTime(text: string): string | undefined | "" {
  const t = text.trim()
  if (!t) return ""
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(t)
  if (!m) return undefined
  const [day, month, year, hour, minute] = [+m[1], +m[2], +m[3], +m[4], +m[5]]
  if (year < 1900 || year > 2999 || month < 1 || month > 12) return undefined
  if (day < 1 || day > new Date(year, month, 0).getDate()) return undefined
  if (hour > 23 || minute > 59) return undefined
  return joinLocalDateTime({ year, month, day, hour, minute })
}

export interface CalendarCell {
  year: number
  month: number // 1-12
  day: number
  inMonth: boolean
}

/** Lưới tháng 6 hàng × 7 cột, tuần bắt đầu Thứ Hai (chuẩn VN). */
export function buildMonthGrid(year: number, month: number): CalendarCell[][] {
  const first = new Date(year, month - 1, 1)
  const offset = (first.getDay() + 6) % 7 // Thứ Hai = 0
  const weeks: CalendarCell[][] = []
  for (let w = 0; w < 6; w++) {
    const row: CalendarCell[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(year, month - 1, 1 - offset + w * 7 + i)
      row.push({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        inMonth: d.getMonth() === month - 1,
      })
    }
    weeks.push(row)
  }
  return weeks
}

export function nowLocalParts(now: Date = new Date()): LocalDateTimeParts {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
  }
}

/** Giờ VN (+07:00) của chuỗi `YYYY-MM-DDTHH:mm` → ISO UTC (để gửi BE). */
export function vnLocalToIso(v: string): string {
  return new Date(`${v}:00+07:00`).toISOString()
}

/** ISO UTC (từ BE) → `YYYY-MM-DDTHH:mm` theo giờ VN (+07:00); rỗng/sai → "". */
export function isoToVnLocal(iso: string | null | undefined): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  return new Date(t + 7 * 3600_000).toISOString().slice(0, 16)
}
