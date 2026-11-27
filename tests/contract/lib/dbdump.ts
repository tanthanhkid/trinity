import * as fs from 'node:fs'
import * as path from 'node:path'
import pg from 'pg'
import { expect } from 'vitest'
import { config } from './config.js'
import { pool, q } from './db.js'
import { Normalizer } from './normalize.js'

/**
 * C16 — dump chuẩn hoá trạng thái DB sau một kịch bản ghi, để so hai lần chạy (Node với Node nay, Node với Rust sau này).
 * Quy tắc, danh sách cho phép và giới hạn: `tests/contract/DB-DUMP.md`.
 *
 * - Dòng lấy vào dump: dòng MỚI (`id > mốc`) cộng dòng CŨ bị sửa trong kịch bản (`updated_at >= lúc bắt đầu`, bảng có cột đó).
 * - Trước khi dump, `settle()` chờ ghi bất đồng bộ (outbox, audit…) xong: số dòng, id lớn nhất và `updated_at` lớn nhất ổn định.
 * - Thứ tự `ORDER BY id`. Cột `date` giữ chuỗi `YYYY-MM-DD` (không qua Date) để ra nhãn `<vn-day:n>`; `int8` và `int8[]` thành số.
 * - Id đổi thành nhãn THEO BẢNG (`<contacts:1>`) và lan sang cột khoá ngoại / id lồng trong jsonb, nên nối sai dòng thì nhãn lệch.
 * - Cột trong `ALLOW` (mọi độ sâu cho `ALLOW_EVERYWHERE`) thành `<allowed>` khi khác null: vẫn so được "có giá trị hay không".
 */
export interface TableSpec {
  table: string
  /** Cột thay bằng `<allowed>` (khi khác null) chỉ ở bảng này. Mỗi mục phải có lý do trong DB-DUMP.md. */
  allow?: string[]
}

export const ALLOW_EVERYWHERE = ['password_hash', 'updated_at', 'code'] as const

export interface Mark {
  ids: Record<string, number>
  /** `now()` của DB lúc bắt đầu kịch bản (cùng đồng hồ với `updated_at`). */
  startedAt: string
}

type Row = Record<string, unknown>

const ident = (s: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Tên không an toàn: ${s}`)
  return `"${s}"`
}

/** pg type parser cho truy vấn dump: date giữ chuỗi, int8/int8[] thành số, còn lại mặc định (timestamptz → Date). */
const types = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => {
    if (oid === 1082) return (v: string) => v
    if (oid === 20) return (v: string) => Number(v)
    if (oid === 1016) return (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(',').map(Number))
    return pg.types.getTypeParser(oid, format as 'text')
  },
}

const hasUpdatedAt = async (table: string): Promise<boolean> =>
  (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'updated_at'`, [table])).length > 0

export async function mark(tables: TableSpec[]): Promise<Mark> {
  const ids: Record<string, number> = {}
  for (const t of tables) ids[t.table] = Number((await q<{ m: string | null }>(`SELECT max(id)::text AS m FROM ${ident(t.table)}`))[0].m ?? 0)
  const [{ now }] = await q<{ now: Date }>(`SELECT now() AS now`)
  return { ids, startedAt: now.toISOString() }
}

/** Dấu vân tay của các bảng: đổi khi có dòng thêm/sửa. */
async function fingerprint(tables: TableSpec[]): Promise<string> {
  const parts: string[] = []
  for (const t of tables) {
    const u = (await hasUpdatedAt(t.table)) ? ', max(updated_at)::text AS u' : ", NULL AS u"
    const [r] = await q<{ c: string; m: string | null; u: string | null }>(`SELECT count(*)::text AS c, max(id)::text AS m${u} FROM ${ident(t.table)}`)
    parts.push(`${t.table}:${r.c}:${r.m}:${r.u}`)
  }
  return parts.join('|')
}

/** Chờ ghi bất đồng bộ xong: dấu vân tay không đổi qua 3 lần đọc cách nhau 150 ms (tối đa 10 s). */
export async function settle(tables: TableSpec[]): Promise<void> {
  let last = ''
  let stable = 0
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const fp = await fingerprint(tables)
    stable = fp === last ? stable + 1 : 0
    if (stable >= 3) return
    last = fp
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('Dữ liệu vẫn đổi sau 10 s: ghi bất đồng bộ chưa xong')
}

const plural = (s: string): string => (s.endsWith('s') ? s : `${s}s`)
/** Cột/khoá tham chiếu người dùng. */
const USER_REF = /^(assigned_to|owner_id|user_id|manager_id|actor_user_id|[a-z_]+_by|[a-z_]+_by_id|[a-z_]+_to|[a-z_]+_to_id)$/
const OPTION_REF = new Set(['source_id', 'stage_id', 'contact_status_id', 'status_id'])

/** Bảng mà một khoá id trỏ tới (`parent` là khoá cha trong jsonb, `sibling` là object chứa khoá). */
function tableOf(key: string, parent: string | null, own: string, sibling: Row): string | null {
  if (key === 'id') return parent ? plural(parent) : own
  if (key === 'resource_id') return typeof sibling.resource === 'string' ? plural(sibling.resource) : 'resources'
  if (USER_REF.test(key)) return 'users'
  if (OPTION_REF.has(key)) return 'setting_options'
  const m = /^(.*)_ids?$/.exec(key)
  return m ? plural(m[1]) : null
}

class Labels {
  private map = new Map<string, Map<number, string>>()
  private ext = new Map<string, number>()
  seed(table: string, ids: number[]): void {
    const m = this.table(table)
    ids.forEach((id, i) => m.set(id, `<${table}:${i + 1}>`))
  }
  private table(t: string): Map<number, string> {
    let m = this.map.get(t)
    if (!m) this.map.set(t, (m = new Map()))
    return m
  }
  label(table: string, id: number): string {
    const m = this.table(table)
    let l = m.get(id)
    if (!l) {
      const n = (this.ext.get(table) ?? 0) + 1
      this.ext.set(table, n)
      m.set(id, (l = `<${table}:ext${n}>`))
    }
    return l
  }
}

function walk(v: unknown, key: string, parent: string | null, own: string, sibling: Row, labels: Labels, allowAll: Set<string>): unknown {
  if (v === null || v === undefined) return v
  if (allowAll.has(key)) return '<allowed>'
  if (Array.isArray(v)) return v.map((x) => walk(x, key, parent, own, sibling, labels, allowAll))
  if (typeof v === 'number') {
    const t = tableOf(key, parent, own, sibling)
    return t ? labels.label(t, v) : v
  }
  if (typeof v === 'string' && key === 'resource_id' && /^\d+$/.test(v)) return labels.label(tableOf(key, parent, own, sibling) as string, Number(v))
  if (typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const o = v as Row
    const out: Row = {}
    for (const k of Object.keys(o)) out[k] = walk(o[k], k, key, own, o, labels, allowAll)
    return out
  }
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `<bytes:${v.length}>`
  return v
}

export async function dump(tables: TableSpec[], since: Mark, nowMs: number = Date.now()): Promise<Record<string, unknown>> {
  await settle(tables)
  const raw: Record<string, Row[]> = {}
  for (const t of tables) {
    const where = (await hasUpdatedAt(t.table)) ? `id > $1 OR updated_at >= $2` : `id > $1`
    const params: unknown[] = (await hasUpdatedAt(t.table)) ? [since.ids[t.table] ?? 0, since.startedAt] : [since.ids[t.table] ?? 0]
    raw[t.table] = (await pool.query({ text: `SELECT * FROM ${ident(t.table)} WHERE ${where} ORDER BY id`, values: params, types } as pg.QueryConfig)).rows as Row[]
  }
  const labels = new Labels()
  for (const t of tables) labels.seed(t.table, raw[t.table].map((r) => r.id as number))
  const result: Record<string, unknown> = {}
  for (const t of tables) {
    const norm = new Normalizer(nowMs)
    const all = new Set<string>(ALLOW_EVERYWHERE)
    const own = new Set(t.allow ?? [])
    result[t.table] = raw[t.table].map((r) => {
      const o: Row = {}
      for (const [k, v] of Object.entries(r)) o[k] = own.has(k) && v !== null ? '<allowed>' : walk(v, k, null, t.table, r, labels, all)
      // Nhãn id đã là chuỗi nên Normalizer chỉ lo thời điểm/ngày/email/token.
      return norm.normalize(o)
    })
  }
  return result
}

/** Ghi (record) hoặc so (compare) dump của một kịch bản: `<out>/<hồ sơ>/db/<ca>.json`. */
export function dbGolden(caseName: string, value: Record<string, unknown>): void {
  const rel = path.join(config.profile, 'db', `${caseName}.json`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (config.mode === 'record') {
    const f = path.join(config.outDir, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text)
    return
  }
  const base = process.env.CONTRACT_BASELINE_DIR
  if (!base) throw new Error('CONTRACT_MODE=compare cần CONTRACT_BASELINE_DIR (thư mục lượt record)')
  const f = path.join(base, rel)
  if (!fs.existsSync(f)) throw new Error(`Không có bản ghi để so: ${f}`)
  expect(value).toEqual(JSON.parse(fs.readFileSync(f, 'utf8')))
}
