/**
 * Bộ chuẩn hoá: thay giá trị động bằng nhãn ổn định để hai lần chạy (kể cả khác ngày, khác bản Node/Rust) so được từng byte.
 *
 * - id số (khoá `id`, `*_id`, `*_ids`) → `<id:1>`, `<id:2>`… theo thứ tự xuất hiện;
 * - thời điểm trong ±10 phút quanh "bây giờ" → `<now>`; xa hơn → `<time:-3d>` (số ngày làm tròn, tương đối với bây giờ);
 * - ngày `YYYY-MM-DD` → `<vn-day:0>`, `<vn-day:-1>`… (ngày Việt Nam, UTC+7, tương đối với hôm nay);
 * - JWT, khoá `*token*`/`*secret*`/`api_key` → `<token>`; UUID → `<uuid:n>`; email `@contract.test` → `<email:n>`;
 * - khoá object sắp theo chữ cái (thứ tự khoá không phải hợp đồng).
 * Con trỏ phân trang (`cursor`, `next_cursor`) KHÔNG bị che: giữ nguyên từng byte sau khi thay id.
 */
const DAY_MS = 86_400_000
const VN_OFFSET_MS = 7 * 3_600_000
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_KEY = /(^|_)ids?$/
const SECRET_KEY = /token|secret|api_?key|password_hash/i

export function vnDayIndex(ms: number): number {
  return Math.floor((ms + VN_OFFSET_MS) / DAY_MS)
}

export class Normalizer {
  private ids = new Map<number, number>()
  private uuids = new Map<string, number>()
  private emails = new Map<string, number>()
  constructor(private readonly nowMs: number = Date.now()) {}

  private label<K>(m: Map<K, number>, k: K): number {
    let n = m.get(k)
    if (n === undefined) {
      n = m.size + 1
      m.set(k, n)
    }
    return n
  }

  private str(key: string, s: string): string {
    if (SECRET_KEY.test(key) || JWT.test(s)) return '<token>'
    if (UUID.test(s)) return `<uuid:${this.label(this.uuids, s.toLowerCase())}>`
    if (s.endsWith('@contract.test')) return `<email:${this.label(this.emails, s)}>`
    if (ISO_DT.test(s)) {
      const t = Date.parse(s)
      const d = t - this.nowMs
      return Math.abs(d) <= 600_000 ? '<now>' : `<time:${d >= 0 ? '+' : '-'}${Math.round(Math.abs(d) / DAY_MS)}d>`
    }
    if (ISO_DAY.test(s)) {
      const diff = Math.round(Date.parse(`${s}T00:00:00Z`) / DAY_MS) - vnDayIndex(this.nowMs)
      return `<vn-day:${diff}>`
    }
    return s
  }

  private walk(key: string, v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.walk(key, x))
    if (v === null || v === undefined) return v
    if (typeof v === 'number') return ID_KEY.test(key) ? `<id:${this.label(this.ids, v)}>` : v
    if (typeof v === 'string') return this.str(key, v)
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) out[k] = this.walk(k, (v as Record<string, unknown>)[k])
      return out
    }
    return v
  }

  normalize<T>(value: T): unknown {
    return this.walk('', value)
  }
}

/** Số ngày tương đối (cho trường kiểu "còn N ngày"): trả `<days:N>` thay vì N thô khi N phụ thuộc ngày chạy. */
export const relDays = (n: number): string => `<days:${n}>`
