import * as fs from 'node:fs'
import * as path from 'node:path'
import { config } from './config.js'

/**
 * Độ phủ route của bộ hợp đồng (C14a). `call()` ghi mỗi lời gọi (phương thức, đường dẫn, mã trạng thái, có token hay không) vào
 * `<out>/coverage/<hồ sơ>/<pid>.jsonl`; `computeCoverage()` ghép với `server/contracts/routes.json` và tính, cho từng route của một cụm,
 * bốn loại ca: thành công, bị từ chối (401 không token / 403 thiếu quyền), đầu vào sai (400), không tồn tại hoặc ngoài phạm vi (404).
 * Cụm và các miễn trừ (có lý do) khai ở `tests/contract/coverage-clusters.json`.
 */
export interface RouteRow {
  method: string
  path: string
  access: string
  permissions: string[]
  controller: string
  status_ok: number | null
  upload: unknown
  raw_response: boolean
  param_pipes: string[]
  shape_permissions: string[]
  deprecated: boolean
}

export interface Call {
  method: string
  path: string
  status: number
  authed: boolean
}

const API = '/api/v1'
const covDir = (): string => path.join(config.outDir, 'coverage', config.profile)

export function recordCall(method: string, p: string, status: number, authed: boolean): void {
  try {
    const dir = covDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `${process.pid}.jsonl`), `${JSON.stringify({ method, path: p.split('?')[0], status, authed })}\n`)
  } catch {
    /* đo độ phủ không được làm hỏng ca test */
  }
}

export function loadCalls(profile: string = config.profile): Call[] {
  const dir = path.join(config.outDir, 'coverage', profile)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call),
    )
}

const repoRoot = path.resolve(__dirname, '../../..')
export const loadRoutes = (): RouteRow[] => (JSON.parse(fs.readFileSync(path.join(repoRoot, 'server/contracts/routes.json'), 'utf8')) as { routes: RouteRow[] }).routes

/** Mẫu `/api/v1/users/:id` → khớp đường dẫn thật; mẫu nhiều ký tự cố định hơn thắng (`/users/export` trước `/users/:id`). */
function matcher(r: RouteRow): { re: RegExp; literals: number; params: number } {
  const segs = r.path.split('/').filter(Boolean)
  const params = segs.filter((s) => s.startsWith(':')).length
  const re = new RegExp(`^/${segs.map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`)
  return { re, literals: segs.length - params, params }
}

export function matchRoute(routes: RouteRow[], method: string, p: string): RouteRow | undefined {
  const full = p.startsWith(API) ? p : `${API}${p}`
  let best: { r: RouteRow; literals: number; params: number } | undefined
  for (const r of routes) {
    if (r.method !== method || r.deprecated) continue
    const m = matcher(r)
    if (!m.re.test(full)) continue
    if (!best || m.literals > best.literals || (m.literals === best.literals && m.params < best.params)) best = { r, ...m }
    else if (m.literals === best.literals && m.params === best.params && best.r.path !== r.path) throw new Error(`Hai route cùng độ cụ thể khớp ${method} ${full}: ${best.r.path} và ${r.path}`)
  }
  return best?.r
}

export type Category = 'success' | 'deny' | 'invalid' | 'missing'
export interface ClusterDef {
  controllers: string[]
  /** Chỉ lấy route có đường dẫn (sau `/api/v1`) bắt đầu bằng một tiền tố trong danh sách: tên controller trùng giữa các service (`EmployeesController` của lương và của nhân sự). */
  prefixes?: string[]
  /** Miễn trừ: `"METHOD /đường/dẫn"` → { loại → lý do }. */
  waivers: Record<string, Partial<Record<Category, string>>>
}

export interface RouteCoverage {
  route: string
  required: Category[]
  covered: Category[]
  waived: Partial<Record<Category, string>>
  missing: Category[]
}

const has = (r: RouteRow): boolean => r.path.includes('/:')

/** Loại ca cần có cho một route, suy từ `routes.json`. */
export function requiredCategories(r: RouteRow): Category[] {
  const out: Category[] = ['success']
  if (r.access === 'auth' || r.access === 'can') out.push('deny')
  if (['POST', 'PUT', 'PATCH'].includes(r.method) || r.param_pipes.length > 0) out.push('invalid')
  if (has(r) && (r.access === 'auth' || r.access === 'can')) out.push('missing')
  return out
}

function categoriesOf(r: RouteRow, calls: Call[]): Set<Category> {
  const got = new Set<Category>()
  let unauth401 = false
  let forbidden403 = false
  for (const c of calls) {
    if (c.status >= 200 && c.status < 300) got.add('success')
    else if (c.status === 401 && !c.authed) unauth401 = true
    else if (c.status === 403) forbidden403 = true
    else if (c.status === 400 || c.status === 422) got.add('invalid')
    else if (c.status === 404) got.add('missing')
  }
  // `deny`: 401 phải là lời gọi KHÔNG token thật (401 của token hết hạn không tính); route `can` cần thêm 403 thiếu quyền.
  if (unauth401 && (r.access !== 'can' || forbidden403)) got.add('deny')
  return got
}

/** Route thuộc cụm: đúng controller, chưa bỏ, và (nếu cụm khai tiền tố) đường dẫn bắt đầu bằng một tiền tố. */
export function inClusterRoute(r: RouteRow, cluster: ClusterDef): boolean {
  if (!cluster.controllers.includes(r.controller) || r.deprecated) return false
  const p = r.path.startsWith(API) ? r.path.slice(API.length) : r.path
  return !cluster.prefixes || cluster.prefixes.some((x) => p.startsWith(x))
}

export function computeCoverage(routes: RouteRow[], calls: Call[], cluster: ClusterDef): RouteCoverage[] {
  const byRoute = new Map<RouteRow, Call[]>()
  for (const c of calls) {
    const r = matchRoute(routes, c.method, c.path)
    if (r) byRoute.set(r, [...(byRoute.get(r) ?? []), c])
  }
  const inCluster = routes.filter((r) => inClusterRoute(r, cluster))
  return inCluster.map((r) => {
    const key = `${r.method} ${r.path.replace(API, '')}`
    const waived = cluster.waivers[key] ?? {}
    const required = requiredCategories(r)
    const got = categoriesOf(r, byRoute.get(r) ?? [])
    const covered = required.filter((c) => got.has(c))
    const missing = required.filter((c) => !got.has(c) && !waived[c])
    return { route: key, required, covered, waived, missing }
  })
}
