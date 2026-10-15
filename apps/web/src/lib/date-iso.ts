/**
 * Cầu nối ISO `YYYY-MM-DD` <-> `Date` cho lịch (react-day-picker).
 *
 * KHÔNG dùng `toISOString().slice(0,10)` (lệch 1 ngày khi máy client không ở
 * +07 hoặc lúc 00:00-06:59 VN). Ta dựng `Date` bằng THÀNH PHẦN địa phương
 * (năm, tháng, ngày lúc 00:00 local) và đọc ngược cũng bằng thành phần địa
 * phương → vòng khứ hồi luôn trả đúng ngày, độc lập múi giờ máy.
 * "Hôm nay" luôn lấy từ `todayVn()` (giờ VN), không từ `new Date()`.
 */
import { todayVn } from "@/lib/format"

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/

/** `YYYY-MM-DD` -> Date local 00:00; rỗng/sai/ngày không có thật -> undefined. */
export function isoToDate(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined
  const m = ISO_RE.exec(iso)
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined
  return date
}

/** Date (thành phần local) -> `YYYY-MM-DD`. */
export function dateToIso(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0")
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** Hôm nay theo giờ VN dưới dạng Date local 00:00 (để truyền `today` cho lịch). */
export function todayVnDate(): Date {
  return isoToDate(todayVn()) as Date
}
