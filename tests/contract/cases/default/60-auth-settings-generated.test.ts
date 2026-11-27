import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { loadRoutes, type ClusterDef, type RouteRow } from '../../lib/coverage.js'
import { call, freshIp } from '../../lib/http.js'
import { makeUser, type U } from '../../lib/users.js'

afterAll(closeDb)

/**
 * C14a — ca SINH từ `server/contracts/routes.json` cho cụm `auth-settings` (`tests/contract/coverage-clusters.json`): mỗi route nhận
 * ca bị từ chối (401 không token; 403 thiếu quyền), đầu vào sai (id không phải số, thân sai) và không tồn tại (id lớn) từ chính
 * metadata của route, nên thêm route vào cụm là có ca ngay. Ca thành công cần dữ liệu thật: `61-auth-settings-flows.test.ts`.
 */
const clusters = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../coverage-clusters.json'), 'utf8')) as Record<string, ClusterDef>
const routes = loadRoutes().filter((r) => clusters['auth-settings'].controllers.includes(r.controller) && !r.deprecated)
const API = '/api/v1'
const withId = (r: RouteRow, id: string): string => r.path.replace(/:id/g, id)
const hasBody = (r: RouteRow): boolean => ['POST', 'PUT', 'PATCH'].includes(r.method)
/** Route POST không nhận thân (hành động theo id / phiên): không có "thân sai"; đầu vào sai của chúng là id không phải số. */
const NO_BODY = new Set(['POST /auth/logout', 'POST /api-keys/:id/rotate', 'POST /auth/invitations/:id/revoke', 'POST /roles/:id/clone'])
/** Thân hợp lệ tối thiểu cho route mà thân rỗng bị 400 trước khi tới bước tìm theo id (ca "id không tồn tại"). */
const MINIMAL_BODY: Record<string, unknown> = {
  'PUT /roles/:id/grants': { grants: {} },
  'PUT /users/:id/roles': { roleIds: [] },
  'PATCH /users/:id/team': { team_id: 1 },
}
/** Thân sai riêng cho route không từ chối khoá lạ (mọi trường tuỳ chọn, hoặc kiểm id trước thân). */
const BAD_BODY: Record<string, unknown> = {
  'PATCH /auth/profile': { full_name: 'a' },
  'PATCH /roles/:id': { name: 'a' },
  'POST /roles/:id/clone': { name: 'a' },
  'PATCH /users/:id': { email: 'khong-hop-le' },
  'PATCH /users/:id/reset-password': { password: 123 },
}
const asKey = (r: RouteRow): string => `${r.method} ${r.path.replace(API, '')}`

/** Mọi quyền mà route trong cụm đòi, để có người dùng "gần như quản trị" nhưng không phải người dùng gốc (ca không làm hỏng token quản trị). */
const allPerms = [...new Set(routes.flatMap((r) => r.permissions))]
let power: U
let none: U
beforeAll(async () => {
  power = await makeUser(Object.fromEntries(allPerms.map((p) => [p, true as const])))
  none = await makeUser({})
})

/** Chạy một ca cho từng route, gom các route sai mã trạng thái rồi khẳng định một lần (lỗi liệt kê hết, không dừng ở route đầu). */
async function sweep(list: RouteRow[], expected: number[], send: (r: RouteRow) => Promise<{ status: number }>): Promise<void> {
  const bad: string[] = []
  for (const r of list) {
    const res = await send(r)
    if (!expected.includes(res.status)) bad.push(`${asKey(r)} → ${res.status}`)
  }
  expect(bad, `mong đợi ${expected.join('/')}`).toEqual([])
}

describe('cụm auth-settings: ca sinh từ routes.json', () => {
  it('route cần đăng nhập, không token → 401', async () => {
    const list = routes.filter((r) => r.access === 'auth' || r.access === 'can')
    expect(list.length).toBeGreaterThan(40)
    await sweep(list, [401], (r) => call(r.method, withId(r, '1'), { ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('route cần quyền, token không có quyền → 403', async () => {
    const list = routes.filter((r) => r.access === 'can')
    await sweep(list, [403], (r) => call(r.method, withId(r, '1'), { token: none.token, ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('id không phải số (ParseIntPipe) → 400', async () => {
    const list = routes.filter((r) => r.param_pipes.some((p) => p.includes('ParseIntPipe')))
    expect(list.length).toBeGreaterThan(15)
    await sweep(list, [400], (r) => call(r.method, withId(r, 'abc'), { token: power.token, ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('thân sai (khoá lạ) → 400', async () => {
    const list = routes.filter((r) => hasBody(r) && !r.upload && r.access !== 'public' && !NO_BODY.has(asKey(r)))
    await sweep(list, [400], (r) => call(r.method, withId(r, '2147000000'), { token: power.token, ip: freshIp(), body: BAD_BODY[asKey(r)] ?? { khoa_la_khong_ton_tai: 1 } }))
  })

  it('id không tồn tại → 404', async () => {
    const list = routes.filter((r) => r.path.includes('/:id') && (r.access === 'auth' || r.access === 'can'))
    await sweep(list, [404], (r) => call(r.method, withId(r, '2147000000'), { token: power.token, ip: freshIp(), body: hasBody(r) ? (MINIMAL_BODY[asKey(r)] ?? {}) : undefined }))
  })
})
