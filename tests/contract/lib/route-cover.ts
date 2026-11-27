import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Độ phủ route theo cụm (C14): mỗi route của cụm trong `server/contracts/routes.json` phải có đủ các loại ca mà hợp đồng đòi.
 * Công thức đòi hỏi suy ra từ chính `routes.json` (không khai tay): thiếu token (mọi route cần đăng nhập), thiếu quyền
 * (route `can`), thành công (đúng `status_ok`), id sai kiểu (có `param_pipes`), cộng các loại do công thức của route khai
 * (thân/query sai ⇒ 400, id không có ⇒ 404, ngoài phạm vi theo id ⇒ 404, route đọc dữ liệu khách ⇒ golden 3 vai và SĐT bị che).
 * Thêm route vào cụm mà chưa có công thức ⇒ ca "độ phủ" đỏ.
 */
export interface RouteDef {
  method: string
  path: string
  access: string
  permissions: string[]
  status_ok: number | null
  param_pipes: string[]
  org_feature: string | null
  shape_permissions: string[]
  raw_response: boolean
  deprecated: boolean
}

export type Kind = 'ok' | 'unauth' | 'forbid' | 'badId' | 'badInput' | 'missing' | 'outOfScope' | 'golden3' | 'masked'

const file = path.resolve(__dirname, '../../../server/contracts/routes.json')

export const keyOf = (r: { method: string; path: string }): string => `${r.method} ${r.path.replace(/^\/api\/v1/, '')}`

export function clusterRoutes(prefixes: string[]): RouteDef[] {
  const all = (JSON.parse(fs.readFileSync(file, 'utf8')) as { routes: RouteDef[] }).routes
  return all.filter((r) => prefixes.some((p) => r.path.replace(/^\/api\/v1/, '').startsWith(p)))
}

/** Loại ca bắt buộc suy từ `routes.json`. */
export function requiredKinds(r: RouteDef): Kind[] {
  const k: Kind[] = ['ok']
  if (r.access !== 'public') k.push('unauth')
  if (r.access === 'can') k.push('forbid')
  if (r.param_pipes.length > 0) k.push('badId')
  if (r.shape_permissions.length > 0 && r.method === 'GET' && !r.raw_response) k.push('golden3')
  return k
}

const ledger = new Map<string, Set<Kind>>()

export function mark(key: string, kind: Kind): void {
  const s = ledger.get(key) ?? new Set<Kind>()
  s.add(kind)
  ledger.set(key, s)
}

export interface Coverage {
  total: number
  complete: number
  missing: string[]
}

/** `declared`: loại ca do công thức khai thêm cho từng route. */
export function coverage(routes: RouteDef[], declared: Record<string, Kind[]>): Coverage {
  const missing: string[] = []
  let complete = 0
  for (const r of routes) {
    const key = keyOf(r)
    const need = [...new Set([...requiredKinds(r), ...(declared[key] ?? [])])]
    const have = ledger.get(key) ?? new Set<Kind>()
    const lack = need.filter((k) => !have.has(k))
    if (lack.length === 0) complete += 1
    else missing.push(`${key}: thiếu ${lack.join(', ')}`)
  }
  return { total: routes.length, complete, missing }
}
