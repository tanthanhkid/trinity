/**
 * Bộ chuẩn hoá: thay giá trị động bằng nhãn ổn định để hai lần chạy (kể cả khác ngày, khác bản Node/Rust) so được từng byte.
 *
 * - id số (khoá `id`, `*_id`, `*_ids`) → `<id:khoá:1>`… đánh số theo từng khoá; khoá tham chiếu người dùng (`assigned_to`, `*_by`, `*_to`, `user_id`…) chung dãy `<user:n>`;
 * - thời điểm trong ±10 phút quanh "bây giờ" → `<now>`; xa hơn → `<time:-3d>` (số ngày làm tròn); CHỈ trong ±400 ngày, ngoài cửa sổ giữ nguyên;
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
/** Khoá tham chiếu người dùng (đều là id số): chung một dãy nhãn `<user:n>`, vì cùng người có thể xuất hiện ở nhiều khoá. */
const USER_KEY = /^(assigned_to|owner_id|user_id|manager_id|[a-z_]+_by|[a-z_]+_by_id|[a-z_]+_to|[a-z_]+_to_id)$/
const ID_KEY = /(^|_)ids?$/
/** Chỉ đổi ngày/giờ sang nhãn tương đối khi nằm trong cửa sổ này quanh hôm nay; ngoài cửa sổ là dữ liệu cố định, giữ nguyên. */
const WINDOW_DAYS = 400
const SECRET_KEY = /token|secret|api_?key|password_hash/i

export function vnDayIndex(ms: number): number {
  return Math.floor((ms + VN_OFFSET_MS) / DAY_MS)
}

export class Normalizer {
  /** Nhãn id đánh số theo KHOÁ (`<id:contact_id:1>`): thêm/bớt id ở khoá khác không làm lệch nhãn khoá này. */
  private ids = new Map<string, Map<number, number>>()
  private uuids = new Map<string, number>()
  private emails = new Map<string, number>()
  constructor(private readonly nowMs: number = Date.now()) {}

  private bucket(key: string): Map<number, number> {
    let m = this.ids.get(key)
    if (!m) this.ids.set(key, (m = new Map()))
    return m
  }

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
      const d = Date.parse(s) - this.nowMs
      if (Math.abs(d) > WINDOW_DAYS * DAY_MS) return s
      return Math.abs(d) <= 600_000 ? '<now>' : `<time:${d >= 0 ? '+' : '-'}${Math.round(Math.abs(d) / DAY_MS)}d>`
    }
    if (ISO_DAY.test(s)) {
      const diff = Math.round(Date.parse(`${s}T00:00:00Z`) / DAY_MS) - vnDayIndex(this.nowMs)
      return Math.abs(diff) > WINDOW_DAYS ? s : `<vn-day:${diff}>`
    }
    return s
  }

  private walk(key: string, v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.walk(key, x))
    if (v === null || v === undefined) return v
    if (typeof v === 'number') {
      if (USER_KEY.test(key)) return `<user:${this.label(this.bucket('user'), v)}>`
      return ID_KEY.test(key) ? `<id:${key}:${this.label(this.bucket(key), v)}>` : v
    }
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
