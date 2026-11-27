/* Trung tâm điều hành — logic THUẦN (không React), test được riêng. */

export type PeriodKey = 'today' | '7d' | 'month'

export const PERIODS: readonly { key: PeriodKey; label: string; aside: string }[] = [
  { key: 'today', label: 'Hôm nay', aside: 'hôm nay' },
  { key: '7d', label: '7 ngày', aside: '7 ngày' },
  { key: 'month', label: 'Tháng này', aside: 'tháng này' },
]

const addDays = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Khoảng ngày `YYYY-MM-DD` (giờ VN) của một kỳ chọn, tính từ `today` (cũng giờ VN). */
export function periodRange(key: PeriodKey, today: string): { from: string; to: string } {
  if (key === 'today') return { from: today, to: today }
  if (key === '7d') return { from: addDays(today, -6), to: today }
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

const f1 = (x: number) => x.toLocaleString('vi-VN', { maximumFractionDigits: 1 })

/** Tiền gọn cho ô hẹp: "482,6 tr", "1,2 tỷ"; dưới 1 triệu in đủ kèm ₫. */
export function formatMoneyTr(v: number): string {
  if (Math.abs(v) >= 1e9) return `${f1(v / 1e9)} tỷ`
  if (Math.abs(v) >= 1e6) return `${f1(v / 1e6)} tr`
  return `${v.toLocaleString('vi-VN')} ₫`
}

export interface Delta {
  dir: 'up' | 'down' | 'flat'
  /** Chữ hiển thị, đã có ▲/▼. `null` = không có gì để so. */
  text: string | null
}

/** So `cur` với `prev`: ▲/▼ + phần trăm (khi kỳ trước > 0) + chênh tuyệt đối. Kỳ trước = 0 thì chỉ nêu chênh tuyệt đối. */
export function deltaOf(cur: number, prev: number): Delta {
  const diff = cur - prev
  if (diff === 0) return { dir: 'flat', text: cur === 0 ? null : '= kỳ trước' }
  const dir = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '▲' : '▼'
  const abs = `${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('vi-VN')}`
  if (prev <= 0) return { dir, text: `${arrow} ${abs}` }
  return { dir, text: `${arrow} ${f1(Math.abs(diff / prev) * 100)}% · ${abs}` }
}

/** Phần trăm một chữ số thập phân kiểu Việt: 50 → "50,0%". */
export const formatPct = (p: number): string => `${p.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

/** Độ rộng (%) của thanh phễu so với tầng đầu; tầng có số > 0 luôn thấy được (tối thiểu 4%). */
export function funnelWidths(counts: number[]): number[] {
  const top = Math.max(0, ...counts)
  return counts.map((c) => (top <= 0 || c <= 0 ? 0 : Math.max(4, Math.round((c / top) * 1000) / 10)))
}

/** Tỉ lệ chuyển tầng (%), `null` khi tầng trước = 0. */
export function stepRate(from: number, to: number): number | null {
  return from > 0 ? Math.round((to / from) * 1000) / 10 : null
}

/** Mức đậm 0..100 của một ô nhiệt so với ô cao nhất. */
export function heatLevel(v: number, max: number): number {
  return max <= 0 || v <= 0 ? 0 : Math.max(8, Math.round((v / max) * 100))
}

export const HEAT_DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] as const

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

/** "Cao điểm: 10:00–11:00 và 15:00–16:00"; rỗng khi chưa có hoạt động. */
export function peakLabel(hours: number[]): string {
  if (hours.length === 0) return ''
  return `Cao điểm: ${hours.map((h) => `${hh(h)}–${hh((h + 1) % 24)}`).join(' và ')}`
}

export const initialOf = (name: string): string => (name.trim().charAt(0) || '?').toUpperCase()
