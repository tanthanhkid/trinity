/**
 * X13: quét mọi route GET `safe_for_shadow` trên BẢN SAO dữ liệu thật, Node và Rust cùng trỏ vào bản sao đó, so như shadow K28.
 * Runbook: docs/runbooks/sweep.md.   Chạy: `pnpm --filter @trinity/contract-tests sweep` (tsx sweep/run.ts).
 *
 * Biến môi trường (đều bắt buộc trừ khi ghi khác):
 *   SWEEP_NODE_URL, SWEEP_RUST_URL   gốc URL hai backend (vd http://127.0.0.1:3000), đã chạy với TRINITY_DISABLE_READ_CACHE=1
 *   SWEEP_DATABASE_URL               DB bản sao (chỉ để lấy id và chọn người dùng; script chỉ SELECT). Host phải là loopback
 *                                    trừ khi SWEEP_ALLOW_REMOTE_DB=1 (máy quét riêng)
 *   SWEEP_JWT_SECRET                 JWT_SECRET RIÊNG của máy quét (≥ 32 ký tự), cũng là JWT_SECRET của cả hai backend
 *   SWEEP_USER_IDS                   (tuỳ chọn) id người dùng, phân cách phẩy, mỗi người một token (nhiều vai); mặc định: một quản trị viên
 *   SWEEP_SCHEMA                     (tuỳ chọn) schema công ty, mặc định public; SWEEP_COMPANY_ID thêm claim `cid`
 *   SWEEP_ROUTES, SWEEP_OUT          (tuỳ chọn) routes.json và đường dẫn báo cáo (mặc định .out/sweep-report.json)
 * Mã thoát: 0 = mọi route đủ mẫu, không khác biệt, không lỗi; 1 = ngược lại; 2 = cấu hình sai.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import pg from 'pg'
import { compare, type Captured } from './compare.js'
import { signToken } from './jwt.js'
import { expandPaths, resolveParams, type ParamSource } from './param-map.js'
import { buildReport, findLeaks, newResult, record, type RouteResult } from './report.js'

interface RouteRow {
  method: string
  path: string
  cached?: boolean
  safe_for_shadow?: boolean
  min_samples?: number
}

const env = (n: string, d?: string): string => {
  const v = process.env[n] ?? d
  if (!v) {
    console.error(`Thiếu biến môi trường ${n}`)
    process.exit(2)
  }
  return v
}

/** Chỉ GET + safe_for_shadow: kiểm lại ở đây, không tin thứ tự lọc ở nơi khác. */
export function selectRoutes(rows: RouteRow[]): RouteRow[] {
  return rows.filter((r) => r.method === 'GET' && r.safe_for_shadow === true)
}

async function fetchOne(base: string, p: string, token: string): Promise<Captured> {
  const res = await fetch(`${base}${p}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes: new Uint8Array(await res.arrayBuffer()) }
}

async function main(): Promise<void> {
  const nodeUrl = env('SWEEP_NODE_URL').replace(/\/+$/, '')
  const rustUrl = env('SWEEP_RUST_URL').replace(/\/+$/, '')
  const dbUrl = env('SWEEP_DATABASE_URL')
  const secret = env('SWEEP_JWT_SECRET')
  const schema = process.env.SWEEP_SCHEMA ?? 'public'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('SWEEP_SCHEMA không hợp lệ')
  const host = new URL(dbUrl).hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && process.env.SWEEP_ALLOW_REMOTE_DB !== '1') {
    console.error('SWEEP_DATABASE_URL không phải loopback: chỉ chạy trên máy quét riêng, đặt SWEEP_ALLOW_REMOTE_DB=1 để xác nhận.')
    process.exit(2)
  }
  const routesFile = process.env.SWEEP_ROUTES ?? path.resolve(__dirname, '../../../server/contracts/routes.json')
  const outFile = process.env.SWEEP_OUT ?? path.resolve(__dirname, '../.out/sweep-report.json')
  const all = (JSON.parse(fs.readFileSync(routesFile, 'utf8')) as { routes: RouteRow[] }).routes
  const routes = selectRoutes(all)
  if (routes.length === 0) console.error('Cảnh báo: routes.json không có route safe_for_shadow nào.')

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2, options: `-c search_path=${schema} -c default_transaction_read_only=on` })
  try {
    const wanted = (process.env.SWEEP_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)
    const users =
      wanted.length > 0
        ? (await pool.query('SELECT id, email FROM users WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [wanted])).rows
        : (
            await pool.query(
              `SELECT u.id, u.email FROM users u
               LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
               WHERE u.status = 'active' AND u.deleted_at IS NULL
               ORDER BY (r.name ILIKE 'admin%') DESC NULLS LAST, u.id LIMIT 1`,
            )
          ).rows
    if (users.length === 0) throw new Error('Không tìm thấy người dùng để ký token')
    const cid = process.env.SWEEP_COMPANY_ID ? Number(process.env.SWEEP_COMPANY_ID) : undefined
    const tokens = users.map((u: { id: number; email: string }) => signToken(secret, { sub: u.id, email: u.email, ...(cid ? { cid } : {}) }))

    const results: RouteResult[] = []
    const cache = new Map<string, string[]>()
    const valuesFor = async (src: ParamSource, limit: number): Promise<string[]> => {
      if ('values' in src) return [...src.values]
      const key = `${src.sql}|${limit}`
      if (!cache.has(key)) cache.set(key, (await pool.query(src.sql, [limit])).rows.map((r: { v: unknown }) => String(r.v)))
      return cache.get(key) as string[]
    }

    for (const r of routes) {
      const min = r.min_samples ?? 50
      const res = newResult(`GET ${r.path.replace(/^\/api\/v1/, '').replace(/(:\w+)\([^)]*\)/g, '$1')}`, r.cached === true, min)
      results.push(res)
      const { sources, missing } = resolveParams(r.path)
      res.noSampler = missing
      const values = new Map<string, string[]>()
      for (const [p, src] of sources) values.set(p, await valuesFor(src, min))
      const paths = missing.length > 0 ? [] : expandPaths(r.path, values, min)
      res.distinctRequests = paths.length
      if (paths.length === 0) continue
      // Ít hơn min_samples đường dẫn riêng (route không tham số, bảng ít dòng): lặp lại, xoay vòng người dùng. Cache đã tắt nên mỗi lần đều đọc DB.
      for (let i = 0; i < Math.max(min, paths.length); i++) {
        const p = paths[i % paths.length] as string
        const token = tokens[i % tokens.length] as string
        try {
          const [a, b] = await Promise.all([fetchOne(nodeUrl, p, token), fetchOne(rustUrl, p, token)])
          record(res, compare(a, b))
        } catch {
          res.errors++ // chỉ đếm: thông điệp lỗi có thể chứa URL/id
        }
      }
    }

    const report = buildReport(results)
    const leaks = findLeaks(report)
    if (leaks.length > 0) throw new Error(`Báo cáo không qua kiểm không-dữ-liệu (${leaks.join(',')}); không ghi`)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`)
    const s = report.summary
    console.log(`Quét xong: ${s.routes} route, đủ mẫu ${s.reached_min_samples}, thiếu mẫu ${s.below_min_samples.length}, có khác biệt ${s.with_differences.length}. Báo cáo: ${outFile}`)
    const errors = results.reduce((a, r) => a + r.errors, 0)
    process.exitCode = s.below_min_samples.length > 0 || s.with_differences.length > 0 || errors > 0 || routes.length === 0 ? 1 : 0
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e: unknown) => {
    console.error(`Lỗi quét: ${e instanceof Error ? e.name : 'unknown'}`) // không in message: có thể chứa chuỗi kết nối
    process.exit(2)
  })
}
