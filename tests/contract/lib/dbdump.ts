import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'vitest'
import { config } from './config.js'
import { pool, q } from './db.js'
import { Normalizer } from './normalize.js'

/**
 * C16 — dump chuẩn hoá trạng thái DB sau một kịch bản ghi, để so hai lần chạy (Node với Node nay, Node với Rust sau này).
 * Quy tắc và danh sách cho phép: `tests/contract/DB-DUMP.md`.
 *
 * - Chỉ lấy dòng MỚI của kịch bản: `mark()` ghi `max(id)` từng bảng trước kịch bản, `dump()` lấy `id > mốc`.
 * - Thứ tự dòng cố định theo `ORDER BY id` (id tăng dần theo thứ tự ghi, nên giống nhau giữa hai lượt cùng kịch bản).
 * - Giá trị đi qua `Normalizer` của C06a (id → nhãn theo khoá, thời điểm → tương đối, token/email ẩn).
 * - Cột trong `ALLOW` là cột cho phép khác nhau giữa hai lượt (hoặc giữa Node và Rust): bị thay bằng `<allowed>`, không bị bỏ,
 *   nên việc cột vẫn có/không có giá trị (null hay không) vẫn được so.
 */
export interface TableSpec {
  table: string
  /** Cột thay bằng `<allowed>` (khi khác null). Mỗi mục phải có lý do trong DB-DUMP.md. */
  allow?: string[]
}

/** Cột cho phép khác nhau, áp cho mọi bảng (theo tên cột). */
export const ALLOW_EVERYWHERE = ['password_hash', 'updated_at', 'code'] as const

type Row = Record<string, unknown>

export async function mark(tables: TableSpec[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of tables) out[t.table] = Number((await q<{ m: string | null }>(`SELECT max(id)::text AS m FROM ${ident(t.table)}`))[0].m ?? 0)
  return out
}

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Tên bảng không an toàn: ${s}`)
  return `"${s}"`
}

function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return Number(v)
  if (Buffer.isBuffer(v)) return `<bytes:${v.length}>`
  return v
}

export async function dump(tables: TableSpec[], since: Record<string, number>, nowMs: number = Date.now()): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const t of tables) {
    const res = await pool.query<Row>(`SELECT * FROM ${ident(t.table)} WHERE id > $1 ORDER BY id`, [since[t.table] ?? 0])
    // int8 (bigserial, BigInt) pg trả chuỗi: đổi sang số để id đi qua bộ chuẩn hoá; `numeric` (tiền) giữ chuỗi để không mất độ chính xác.
    const int8 = new Set(res.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name))
    const rows = res.rows
    const allow = new Set([...ALLOW_EVERYWHERE, ...(t.allow ?? [])])
    const norm = new Normalizer(nowMs)
    result[t.table] = rows.map((r) => {
      const o: Row = {}
      for (const [k, v] of Object.entries(r)) {
        if (allow.has(k) && v !== null) o[k] = '<allowed>'
        else if (int8.has(k) && typeof v === 'string') o[k] = Number(v)
        else if (k === 'resource_id' && typeof v === 'string' && /^\d+$/.test(v)) o[k] = Number(v)
        else o[k] = plain(v)
      }
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
