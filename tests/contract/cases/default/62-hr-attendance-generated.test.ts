import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { inClusterRoute, loadRoutes, type ClusterDef, type RouteRow } from '../../lib/coverage.js'
import { call, freshIp } from '../../lib/http.js'
import { loginAdmin } from '../../lib/session.js'
import { makeUser, type U } from '../../lib/users.js'

afterAll(closeDb)

/**
 * C14d — ca SINH từ `server/contracts/routes.json` cho cụm `hr-attendance` (nhân sự, chấm công, hợp đồng, tuyển dụng, tổ chức):
 * mỗi route nhận ca bị từ chối (401 không token; 403 thiếu quyền), đầu vào sai (id không phải số, thân sai) và không tồn tại (id lớn)
 * từ chính metadata của route. Ca thành công, tệp (xlsx, ảnh minh chứng, hợp đồng) và vòng đời: `63-hr-attendance-flows.test.ts`.
 */
const clusters = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../coverage-clusters.json'), 'utf8')) as Record<string, ClusterDef>
const routes = loadRoutes().filter((r) => inClusterRoute(r, clusters['hr-attendance']))
const API = '/api/v1'
/** `:id`, `:id(\d+)`, `:userId`, `:tid`, `:slot` → giá trị. `ids` điền mọi tham số số; `slot` luôn là chuỗi hợp lệ. */
const fill = (r: RouteRow, id: string): string => r.path.replace(/:(\w+)(\([^)]*\))?/g, (_m, name: string) => (name === 'slot' ? 'in' : id))
const hasBody = (r: RouteRow): boolean => ['POST', 'PUT', 'PATCH'].includes(r.method)
const asKey = (r: RouteRow): string => `${r.method} ${r.path.replace(API, '')}`
/** Route nhận tệp multipart (thân JSON thành 400/415 chứ không phải 401/403 vì guard chạy trước: dùng chung ca). */
const isUpload = (r: RouteRow): boolean => Boolean(r.upload)
/** Đường dẫn có `(\d+)`: id không phải số không khớp route (Nest trả 404), nên ca "id sai" của chúng là 404, không phải 400. */
const DIGIT_ONLY = (r: RouteRow): boolean => /\(\\d\+\)/.test(r.path)

/** Route POST/PATCH không đọc thân (hành động theo id): đầu vào sai của chúng là id không phải số, không có "thân sai". */
const NO_BODY = new Set([
  'POST /management/attendance/requests/:id/approve',
  'POST /management/attendance/reset-device/:userId',
  'PATCH /management/employees/:id/lock',
  'PATCH /management/employees/:id/unlock',
])
/** Thân hợp lệ tối thiểu cho ca "id không tồn tại" (route kiểm thân trước khi tìm theo id). */
const MINIMAL_BODY: Record<string, unknown> = {
  'POST /management/teams/:id/members': { user_ids: [1] },
}
/** Route mà người dùng thường (kể cả có đủ quyền) không gọi được: cần Quản trị thật. */
const ADMIN_ONLY = new Set(['PATCH /management/employees/:id/unlock'])
/** Quyền mà mọi route trong cụm đòi, để có người dùng "gần như quản trị" mà không phải người dùng gốc. */
const allPerms = [...new Set(routes.flatMap((r) => r.permissions))]
let power: U
let none: U
beforeAll(async () => {
  power = await makeUser(Object.fromEntries(allPerms.map((p) => [p, 'all' as const])))
  none = await makeUser({})
})

async function sweep(list: RouteRow[], expected: number[], send: (r: RouteRow) => Promise<{ status: number }>): Promise<void> {
  const bad: string[] = []
  for (const r of list) {
    const res = await send(r)
    if (!expected.includes(res.status)) bad.push(`${asKey(r)} → ${res.status}`)
  }
  expect(bad, `mong đợi ${expected.join('/')}`).toEqual([])
}

describe('cụm hr-attendance: ca sinh từ routes.json', () => {
  it('route cần đăng nhập, không token → 401', async () => {
    const list = routes.filter((r) => r.access === 'auth' || r.access === 'can')
    expect(list.length).toBeGreaterThan(75)
    await sweep(list, [401], (r) => call(r.method, `${fill(r, '1')}`, { ip: freshIp(), body: hasBody(r) && !isUpload(r) ? {} : undefined }))
  })

  it('route cần quyền, token không có quyền → 403', async () => {
    const list = routes.filter((r) => r.access === 'can')
    await sweep(list, [403], (r) => call(r.method, fill(r, '1'), { token: none.token, ip: freshIp(), body: hasBody(r) && !isUpload(r) ? {} : undefined }))
  })

  it('id không phải số → 400 (ParseIntPipe); đường dẫn `(\\d+)` → 404', async () => {
    const list = routes.filter((r) => r.param_pipes.some((p) => p.includes('ParseIntPipe')))
    expect(list.length).toBeGreaterThan(20)
    await sweep(list, [400, 404], async (r) => {
      const res = await call(r.method, fill(r, 'abc'), { token: power.token, ip: freshIp(), body: hasBody(r) && !isUpload(r) ? {} : undefined })
      if (DIGIT_ONLY(r) && res.status !== 404) return { status: -res.status }
      if (!DIGIT_ONLY(r) && res.status !== 400) return { status: -res.status }
      return res
    })
  })

  it('thân sai (khoá lạ) → 400; route nhận tệp mà thiếu tệp → 400', async () => {
    const list = routes.filter((r) => hasBody(r) && r.access !== 'public' && !NO_BODY.has(asKey(r)))
    expect(list.length).toBeGreaterThan(20)
    await sweep(list, [400], (r) => call(r.method, fill(r, '2147000000'), { token: power.token, ip: freshIp(), body: { khoa_la_khong_ton_tai: 1 } }))
  })

  it('id không tồn tại → 404', async () => {
    const admin = await loginAdmin()
    const list = routes.filter((r) => /:\w+/.test(r.path) && (r.access === 'auth' || r.access === 'can') && !isUpload(r))
    expect(list.length).toBeGreaterThan(30)
    await sweep(list, [404], (r) => {
      const token = ADMIN_ONLY.has(asKey(r)) ? admin.token : power.token
      return call(r.method, fill(r, '2147000000'), { token, ip: freshIp(), body: hasBody(r) ? (MINIMAL_BODY[asKey(r)] ?? {}) : undefined })
    })
  })
})
