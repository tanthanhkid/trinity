import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { call, freshIp } from '../../lib/http.js'
import { asKey, clusterRoutes, fillPath, hasBody, sweep } from '../../lib/sweeps.js'
import { makeUser, type U } from '../../lib/users.js'

afterAll(closeDb)

/**
 * C14c — ca SINH từ `server/contracts/routes.json` cho cụm `custom-reports` (bảng tuỳ biến, liên kết bản ghi, báo cáo):
 * 401 không token, 403 thiếu quyền, 400 id không phải số / thân sai, 404 đối tượng hoặc id không tồn tại.
 * Ca thành công, golden 3 vai và con trỏ phân trang: `63-custom-reports-flows.test.ts`.
 */
const routes = clusterRoutes('custom-reports')
const GENERIC_PATH = (r: Parameters<typeof fillPath>[0]) => fillPath(r, '1', 'x')

/** Thân hợp lệ tối thiểu để vượt bước kiểm thân và tới bước tìm đối tượng (ca 404). */
const MINIMAL_BODY: Record<string, unknown> = {
  'POST /custom-objects/:key/fields': { label: 'Trường', type: 'text' },
  'PATCH /custom-objects/:key': { label: 'Nhãn mới' },
  'PATCH /custom-objects/:key/fields/:fieldKey': { label: 'Nhãn mới' },
  'PUT /custom-objects/:key/fields/order': { keys: ['x'] },
  'POST /custom-objects/:key/records': { data: {} },
  'PATCH /custom-objects/:key/records/:id': { data: {} },
  'POST /custom-objects/templates/:template/apply': {},
}

/** POST không nhận thân (hành động theo khoá): không có "thân sai" (khoá lạ trả 404, không phải 400). */
const NO_BODY = new Set(['POST /reports/custom/presets/:key/install'])

const allPerms = [...new Set(routes.flatMap((r) => r.permissions))]
let power: U
let none: U
beforeAll(async () => {
  power = await makeUser(Object.fromEntries(allPerms.map((p) => [p, p.startsWith('custom_objects.') ? true : ('all' as const)])))
  none = await makeUser({})
})

describe('cụm custom-reports: ca sinh từ routes.json', () => {
  it('không token → 401', async () => {
    const list = routes.filter((r) => r.access === 'auth' || r.access === 'can')
    expect(list.length).toBeGreaterThan(35)
    await sweep(list, [401], (r) => call(r.method, GENERIC_PATH(r), { ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('token không có quyền → 403', async () => {
    const list = routes.filter((r) => r.access === 'can')
    await sweep(list, [403], (r) => call(r.method, GENERIC_PATH(r), { token: none.token, ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('id không phải số (ParseIntPipe) → 400', async () => {
    const list = routes.filter((r) => r.param_pipes.some((p) => p.includes('ParseIntPipe')))
    expect(list.length).toBeGreaterThan(4)
    await sweep(list, [400], (r) => call(r.method, fillPath(r, 'abc', 'x'), { token: power.token, ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('đối tượng hoặc id không tồn tại → 404', async () => {
    const list = routes.filter((r) => (r.path.includes('/:key') || r.path.includes('/:id') || r.path.includes('/:template')) && (r.access === 'auth' || r.access === 'can'))
    await sweep(list, [404], (r) =>
      call(r.method, fillPath(r, '2147000000', 'khong_co', { type: 'contact' }), { token: power.token, ip: freshIp(), body: hasBody(r) ? (MINIMAL_BODY[asKey(r)] ?? {}) : undefined }),
    )
  })

  it('thân sai (khoá lạ) → 400', async () => {
    const list = routes.filter((r) => hasBody(r) && r.access !== 'public' && !NO_BODY.has(asKey(r)))
    expect(list.length).toBeGreaterThan(5)
    await sweep(list, [400], (r) => call(r.method, fillPath(r, '2147000000', 'khong_co'), { token: power.token, ip: freshIp(), body: { khoa_la_khong_ton_tai: 1 } }))
  })
})
