/**
 * So hai response như shadow K28 (`server/crates/trinity-http/src/strangler/shadow.rs`, hàm `compare`/`diff_json`): CHẶT (không phải
 * `shape_only`), chỉ ghi đường dẫn + loại khác biệt, không ghi giá trị. Cùng DB và cùng id nên so thẳng thân JSON thô, không qua
 * `Normalizer` của golden (bộ đó đánh số lại id, sẽ che mất khác biệt id thật). Hai chuỗi RFC 3339 cách ≤ 2 giây và gần "bây giờ"
 * ≤ 10 phút coi là cùng giờ máy chủ. Giữ đồng bộ với bản Rust khi sửa một bên.
 */
export type DiffKind = 'type' | 'missing_in_rust' | 'missing_in_node' | 'array_length' | 'value' | 'content_type' | 'body'

export interface Captured {
  status: number
  contentType: string
  bytes: Uint8Array
}

export interface Diff {
  statusMismatch: boolean
  /** `đường dẫn|loại`, đã sắp, tối đa MAX_PATHS. */
  entries: string[]
}

export const MAX_PATHS = 50

const kindOf = (v: unknown): number => {
  if (v === null) return 0
  if (Array.isArray(v)) return 4
  switch (typeof v) {
    case 'boolean':
      return 1
    case 'number':
      return 2
    case 'string':
      return 3
    default:
      return 5
  }
}

const isJson = (c: string): boolean => {
  const m = c.split(';')[0]?.trim().toLowerCase() ?? ''
  return m === 'application/json' || m.endsWith('+json')
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function sameRecentInstant(a: string, b: string, nowMs: number): boolean {
  if (!RFC3339.test(a) || !RFC3339.test(b)) return false
  const x = Date.parse(a)
  const y = Date.parse(b)
  if (Number.isNaN(x) || Number.isNaN(y)) return false
  return Math.abs(x - y) <= 2000 && Math.abs(nowMs - x) <= 600_000
}

function diffJson(a: unknown, b: unknown, path: string, nowMs: number, out: Set<string>): void {
  if (out.size >= MAX_PATHS) return
  if (kindOf(a) !== kindOf(b)) {
    out.add(`${path}|type`)
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const p = `${path}[]`
    if (a.length !== b.length) out.add(`${p}|array_length`)
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) diffJson(a[i], b[i], p, nowMs, out)
    return
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const x = a as Record<string, unknown>
    const y = b as Record<string, unknown>
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      const p = `${path}.${k}`
      if (k in x && k in y) diffJson(x[k], y[k], p, nowMs, out)
      else out.add(`${p}|${k in x ? 'missing_in_rust' : 'missing_in_node'}`)
    }
    return
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a !== b && !sameRecentInstant(a, b, nowMs)) out.add(`${path}|value`)
    return
  }
  if (a !== b) out.add(`${path}|value`)
}

const text = (c: Captured): string => Buffer.from(c.bytes).toString('utf8')

export function compare(node: Captured, rust: Captured, nowMs: number = Date.now()): Diff {
  const entries = new Set<string>()
  if (node.contentType !== rust.contentType) entries.add('<content-type>|content_type')
  let parsed: [unknown, unknown] | null = null
  if (isJson(node.contentType) && isJson(rust.contentType)) {
    try {
      parsed = [JSON.parse(text(node)), JSON.parse(text(rust))]
    } catch {
      parsed = null
    }
  }
  if (parsed) diffJson(parsed[0], parsed[1], '$', nowMs, entries)
  else if (Buffer.compare(Buffer.from(node.bytes), Buffer.from(rust.bytes)) !== 0) entries.add('<body>|body')
  return { statusMismatch: node.status !== rust.status, entries: [...entries].sort().slice(0, MAX_PATHS) }
}
