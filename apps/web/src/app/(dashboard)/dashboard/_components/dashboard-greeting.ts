/** Lời chào theo giờ + ngày dài kiểu "Thứ 3, 3 Tháng 10, 2026" — THUẦN, theo giờ VN (không toLocale*). */

const VN_TZ = 'Asia/Ho_Chi_Minh'
const WEEKDAYS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7']

export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return 'Chào buổi sáng'
  if (hour >= 11 && hour < 14) return 'Chào buổi trưa'
  if (hour >= 14 && hour < 18) return 'Chào buổi chiều'
  return 'Chào buổi tối'
}

/** Giờ (0–23) và các phần ngày theo múi giờ VN của `now`. */
export function vnClockParts(now: Date): { hour: number; weekday: number; day: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: VN_TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return {
    hour: Number(get('hour')) % 24, weekday: wd < 0 ? 0 : wd,
    day: Number(get('day')), month: Number(get('month')), year: Number(get('year')),
  }
}

export function formatLongDateVn(now: Date): string {
  const p = vnClockParts(now)
  return `${WEEKDAYS[p.weekday]}, ${p.day} Tháng ${p.month}, ${p.year}`
}
