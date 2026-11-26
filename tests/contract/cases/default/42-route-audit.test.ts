import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { call, freshIp } from '../../lib/http.js'

interface Route {
  method: string
  path: string
  access: string
  permissions: string[]
}

/**
 * Kiểm route theo hợp đồng (chuyển từ `route-audit.e2e-spec.ts`, 2 ca). Boot-check của bản TS quét metadata bằng Nest
 * (`auditRoutes`, đã chạy mỗi lần khởi động); ở hộp đen kiểm kết quả của nó trên `server/contracts/routes.json`, là bảng route
 * mà Rust phải khớp (K14).
 */
const EXPORT_RE = /(export|excel|xlsx|csv|download)/i
const routes = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../server/contracts/routes.json'), 'utf8')) as { routes: Route[] }).routes

describe('kiểm route', () => {
  it('không route nào thiếu khai báo quyền / route xuất file thiếu *.export', () => {
    const missing = routes.filter((r) => !['public', 'auth', 'can', 'internal'].includes(r.access) || (r.access === 'can' && r.permissions.length === 0))
    const exportWithoutPerm = routes.filter(
      (r) => EXPORT_RE.test(r.path) && r.access !== 'public' && r.access !== 'internal' && !(r.access === 'can' && r.permissions.some((p) => p.endsWith('.export'))),
    )
    expect({ missing: missing.map((r) => `${r.method} ${r.path}`), exportWithoutPerm: exportWithoutPerm.map((r) => `${r.method} ${r.path}`) }).toEqual({
      missing: [],
      exportWithoutPerm: [],
    })
    expect(routes.length).toBeGreaterThan(500)
  })

  it('/health /ready /live là public (không cần token)', async () => {
    for (const p of ['health', 'ready', 'live']) {
      const res = await call('GET', `/api/v1/${p}`, { ip: freshIp() })
      expect(res.status, p).toBe(200)
    }
  })
})
