import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, setSetting } from '../../lib/db.js'
import { inClusterRoute, loadRoutes, type ClusterDef, type RouteRow } from '../../lib/coverage.js'
import { call, control, freshIp } from '../../lib/http.js'
import { loginAdmin } from '../../lib/session.js'
import { makeUser, type U } from '../../lib/users.js'

let saved: Record<string, string | null> = {}
beforeAll(async () => {
  // DB mới ở trạng thái "chưa dựng quy trình": module cứng tắt. Bật như hệ thống đã dựng; trang bán hàng (`online_store`) mặc định TẮT
  // (DEFAULT_OFF_FEATURES) nên bật rõ ràng, nếu không route ghi của `/store` trả 403 trước khi kiểm đầu vào.
  const rows = await q<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key IN ('setup_status', 'org_features')`)
  saved = { setup_status: null, org_features: null, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) }
  await setSetting('setup_status', 'da_dung')
  await setSetting('org_features', JSON.stringify({ online_store: true }))
  await control.flushCache()
})
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === null) await q(`DELETE FROM settings WHERE key = $1`, [key])
    else await setSetting(key, value)
  }
  await control.flushCache()
  await closeDb()
})

/**
 * C14e — ca SINH từ `server/contracts/routes.json` cho cụm `sales-payroll` (sản phẩm, danh mục, thuộc tính, dự án, POS, trang bán hàng,
 * phiếu lương, KPI, bảo hiểm, thuế, quy tắc và thành phần lương, nhân viên của lương, thông báo): 401 không token, 403 thiếu quyền,
 * 400 id không phải số / thân sai, 404 id không tồn tại. Ca thành công, tệp (xlsx, pdf), golden và vòng đời: `68-sales-payroll-flows.test.ts`.
 */
const clusters = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../coverage-clusters.json'), 'utf8')) as Record<string, ClusterDef>
const routes = loadRoutes().filter((r) => inClusterRoute(r, clusters['sales-payroll']))
const API = '/api/v1'
/** `:id`, `:categoryId` → số; `:slug`, `:code` → chuỗi. */
const fill = (r: RouteRow, num: string): string => r.path.replace(/:(\w+)(\([^)]*\))?/g, (_m, name: string) => (name === 'slug' ? 'khong-co-cua-hang' : name === 'code' ? 'KHONGCO' : num))
const hasBody = (r: RouteRow): boolean => ['POST', 'PUT', 'PATCH'].includes(r.method)
const asKey = (r: RouteRow): string => `${r.method} ${r.path.replace(API, '')}`
const isUpload = (r: RouteRow): boolean => Boolean(r.upload)

/** POST/PATCH không đọc thân (hành động theo id): đầu vào sai của chúng là id không phải số, không có "thân sai". */
const NO_BODY = new Set<string>(['PATCH /notifications/:id/read', 'POST /products/:id/restore'])
/** DTO lenient (lương, thông báo): khoá lạ bị bỏ lặng lẽ, nên "thân sai" là giá trị sai kiểu. */
const INVALID_BODY: Record<string, unknown> = {
  'PATCH /employees/:id': { status: 'x' },
  'PATCH /payslips/:id': { base_salary: 'abc' },
  'PATCH /salary-rules/:id': { name: 5 },
  // Lưu cấu hình trang bán hàng nhận mọi khoá lạ (bỏ qua); đầu vào sai là giá trị không hợp lệ của khoá có luật.
  'PUT /store/settings': { slug: 'A' },
}
/** Thân hợp lệ tối thiểu cho ca "id không tồn tại" (route kiểm thân trước khi tìm theo id). */
const MINIMAL_BODY: Record<string, unknown> = {
  'PATCH /payslips/:id/approve': { action: 'approve' },
  'POST /pos/orders/:id/pay': { payments: [{ method: 'cash', amount: 1, tendered: 1 }] },
  'POST /pos/orders/:id/void': { reason: 'xxx' },
  'POST /pos/shifts/:id/close': { closing_cash_counted: 0 },
  'PATCH /store/orders/:id': { status: 'confirmed' },
}
/** Route mà người dùng thường (kể cả có đủ quyền) không gọi được: cần Quản trị thật. */
/** Đối tượng cha không tồn tại KHÔNG trả 404 (miễn trừ ở `coverage-clusters.json`). */
const NO_404 = new Set(['GET /product-categories/:categoryId/attribute-defs', 'POST /product-categories/:categoryId/attribute-defs'])
const ADMIN_ONLY = new Set(['DELETE /products/:id/permanent'])

const allPerms = [...new Set(routes.flatMap((r) => r.permissions))]
let power: U
let none: U
beforeAll(async () => {
  power = await makeUser(Object.fromEntries(allPerms.map((p) => [p, true as const])))
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

describe('cụm sales-payroll: ca sinh từ routes.json', () => {
  it('route cần đăng nhập, không token → 401', async () => {
    const list = routes.filter((r) => r.access === 'auth' || r.access === 'can')
    expect(list.length).toBeGreaterThan(75)
    await sweep(list, [401], (r) => call(r.method, fill(r, '1'), { ip: freshIp(), body: hasBody(r) && !isUpload(r) ? {} : undefined }))
  })

  it('route cần quyền, token không có quyền → 403', async () => {
    const list = routes.filter((r) => r.access === 'can')
    await sweep(list, [403], (r) => call(r.method, fill(r, '1'), { token: none.token, ip: freshIp(), body: hasBody(r) && !isUpload(r) ? {} : undefined }))
  })

  it('id không phải số → 400 (ParseIntPipe)', async () => {
    const list = routes.filter((r) => r.param_pipes.length > 0)
    expect(list.length).toBeGreaterThan(30)
    await sweep(list, [400], (r) => call(r.method, fill(r, 'abc'), { token: power.token, ip: freshIp(), body: hasBody(r) && !isUpload(r) ? {} : undefined }))
  })

  it('thân sai (khoá lạ) → 400', async () => {
    const list = routes.filter((r) => hasBody(r) && r.access !== 'public' && !NO_BODY.has(asKey(r)) && !isUpload(r))
    expect(list.length).toBeGreaterThan(20)
    await sweep(list, [400], (r) => call(r.method, fill(r, '2147000000'), { token: power.token, ip: freshIp(), body: INVALID_BODY[asKey(r)] ?? { khoa_la_khong_ton_tai: 1 } }))
  })

  it('id không tồn tại → 404', async () => {
    const list = routes.filter((r) => /:\w+/.test(r.path) && (r.access === 'auth' || r.access === 'can') && !isUpload(r) && !NO_404.has(asKey(r)))
    expect(list.length).toBeGreaterThan(30)
    const admin = await loginAdmin()
    // Thu tiền đơn đòi ca đang mở (400 "chưa mở ca") TRƯỚC khi tìm đơn: mở ca cho người dùng thử rồi mới quét.
    expect((await call('POST', '/api/v1/pos/shifts/open', { token: power.token, ip: freshIp(), body: { opening_cash: 0 } })).status).toBe(201)
    await sweep(list, [404], (r) => call(r.method, fill(r, '2147000000'), { token: ADMIN_ONLY.has(asKey(r)) ? admin.token : power.token, ip: freshIp(), body: hasBody(r) ? (MINIMAL_BODY[asKey(r)] ?? {}) : undefined }))
  })
})
