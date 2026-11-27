import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedContact, seedUser } from '../../lib/db.js'
import { crossCursor } from '../../lib/cursor.js'
import { golden, snap, type Role } from '../../lib/golden.js'
import { api, freshIp, type Res } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'
import { makeUser, type U } from '../../lib/users.js'
import { resetCustom } from '../../lib/custom.js'

afterAll(closeDb)

/**
 * C14c — ca thành công, golden 3 vai và con trỏ phân trang cho cụm `custom-reports` (bảng tuỳ biến, liên kết bản ghi, báo cáo).
 * Ca từ chối / đầu vào sai / không tồn tại được sinh ở `62-custom-reports-generated.test.ts`.
 */
const ok = <T>(res: Res, status: number | number[], what: string): T => {
  expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status)
  return res.body as T
}
const t = (u: U) => ({ token: u.token, ip: freshIp() })
const qs = (p: string, query: Record<string, string>): string => `${p}?${new URLSearchParams(query).toString()}`

const ADMIN_GRANTS = {
  'custom_objects.manage': true,
  'custom_records.view': 'all',
  'custom_records.manage': 'all',
  'custom_records.delete': 'all',
  'custom_records.export': 'all',
  'custom_records.phone_full': 'all',
  'contacts.view': 'all',
  'deals.view': 'all',
  'kanban.view': 'all',
} as const

let admin: U
let objectId = 0
let recordIds: number[] = []
let recordCodes: string[] = []

beforeAll(async () => {
  await resetCustom()
  admin = await makeUser(ADMIN_GRANTS)
  const obj = ok<{ id: number }>(await api.post('/custom-objects', { ...t(admin), body: { key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh' } }), 201, 'tạo bảng')
  objectId = obj.id
  for (const f of [
    { label: 'Tên', key: 'ten', type: 'text' },
    { label: 'Điểm', key: 'diem', type: 'number' },
    { label: 'SĐT', key: 'sdt', type: 'phone' },
  ]) ok(await api.post('/custom-objects/hoc_sinh/fields', { ...t(admin), body: f }), 201, `thêm trường ${f.key}`)
  for (let i = 1; i <= 5; i++) {
    const r = ok<{ id: number; code?: string }>(await api.post('/custom-objects/hoc_sinh/records', { ...t(admin), body: { data: { ten: `Học sinh ${i}`, diem: i * 2, sdt: `09000001${i}0` } } }), 201, `tạo bản ghi ${i}`)
    recordIds.push(r.id)
    if (r.code) recordCodes.push(r.code)
  }
})

describe('bảng tuỳ biến: trường, màn xem, tra cứu', () => {
  it('sửa trường, đổi thứ tự trường', async () => {
    ok(await api.patch('/custom-objects/hoc_sinh/fields/diem', { ...t(admin), body: { label: 'Điểm số' } }), 200, 'sửa trường')
    const obj = ok<{ fields: { key: string }[] }>(await api.get('/custom-objects/hoc_sinh', t(admin)), 200, 'chi tiết bảng')
    const keys = obj.fields.map((f) => f.key).reverse()
    ok(await api.put('/custom-objects/hoc_sinh/fields/order', { ...t(admin), body: { keys } }), 200, 'đổi thứ tự trường')
  })

  it('màn xem: danh sách và một màn', async () => {
    // Màn tạo qua MCP (không có route REST tạo màn): seed bằng SQL một màn danh sách cho bảng.
    await q(`INSERT INTO custom_views (object_id, key, label, type, config, created_by) VALUES ($1, 'tat_ca', 'Tất cả học sinh', 'list', '{}', $2)`, [objectId, admin.id])
    const views = ok<{ key?: string; id?: string; name?: string }[] | { views: { key?: string; id?: string }[] }>(await api.get('/custom-objects/hoc_sinh/views', t(admin)), 200, 'danh sách màn')
    const list = Array.isArray(views) ? views : views.views
    expect(list.length, 'đã seed một màn danh sách bằng SQL nhưng danh sách màn rỗng').toBeGreaterThan(0)
    const view = list[0].key ?? list[0].id
    ok(await api.get(`/custom-objects/hoc_sinh/views/${view}`, t(admin)), 200, 'một màn')
  })

  it('tra cứu khách và người dùng cho trường liên kết', async () => {
    ok(await api.get(qs('/custom-objects/lookup/contacts', { q: 'a' }), t(admin)), 200, 'tra cứu khách')
    ok(await api.get(qs('/custom-objects/lookup/users', { q: 'a' }), t(admin)), 200, 'tra cứu người dùng')
  })
})

describe('liên kết bản ghi (refs)', () => {
  it('gợi ý, giải mã theo mã, xem trước và liên kết ngược', async () => {
    ok(await api.get(qs('/refs/suggest', { q: 'HS' }), t(admin)), 200, 'gợi ý')
    expect(recordCodes, 'mỗi bản ghi tạo ra phải có mã').toHaveLength(5)
    const resolved = ok<unknown>(await api.get(qs('/refs/resolve', { codes: recordCodes.slice(0, 2).join(',') }), t(admin)), 200, 'giải mã')
    const text = JSON.stringify(resolved)
    for (const [i, code] of recordCodes.slice(0, 2).entries()) {
      expect(text, `giải mã phải trả mã ${code}`).toContain(code)
      expect(text, `giải mã phải trả id bản ghi ${recordIds[i]}`).toMatch(new RegExp(`"id":\\s*${recordIds[i]}\\b`))
    }
    ok(await api.get(`/refs/record/${recordIds[0]}/preview`, t(admin)), 200, 'xem trước')
    ok(await api.get(`/refs/record/${recordIds[0]}/backlinks`, t(admin)), 200, 'liên kết ngược')
  })
})

describe('báo cáo tuỳ biến', () => {
  it('nguồn, định nghĩa, mẫu, cài mẫu, lưu, danh sách, chạy một báo cáo', async () => {
    ok(await api.get('/reports/custom/sources', t(admin)), 200, 'nguồn')
    ok(await api.get('/reports/custom/definitions', t(admin)), 200, 'định nghĩa')
    const presets = ok<{ key: string }[] | { presets: { key: string }[] }>(await api.get('/reports/custom/presets', t(admin)), 200, 'mẫu')
    const key = (Array.isArray(presets) ? presets : presets.presets)[0].key
    ok(await api.post(`/reports/custom/presets/${key}/install`, t(admin)), [200, 201], 'cài mẫu')
    ok(
      await api.put('/reports/custom', {
        ...t(admin),
        body: { reports: [{ id: 'khach_theo_nguon', name: 'Khách theo nguồn', source: 'contacts', date_field: 'created_at', sum_fields: [], group_by: 'source_id' }] },
      }),
      200,
      'lưu báo cáo',
    )
    expect((await api.put('/reports/custom', { ...t(admin), body: { reports: 'x' } })).status).toBe(400)
    ok(await api.get('/reports/custom', t(admin)), 200, 'danh sách báo cáo')
    ok(await api.get(qs('/reports/custom/khach_theo_nguon', { period: 'all' }), t(admin)), 200, 'chạy báo cáo')
  })
})

describe('báo cáo khách hàng và nhân viên: golden theo ba vai', () => {
  // Cửa sổ ngày CỐ ĐỊNH (rộng) để kết quả không phụ thuộc ngày chạy; dữ liệu seed tính tương đối nên luôn nằm trong cửa sổ.
  const RANGE = (): Record<string, string> => ({ date_from: '2020-01-01', date_to: '2099-12-31' })
  const ROUTES: [string, string, () => Record<string, string>][] = [
    ['report-customers-overview', '/reports/customers/overview', RANGE],
    ['report-customers-uncontacted', '/reports/customers/uncontacted', () => ({ days: '7' })],
    ['report-employee-performance', '/reports/employee-performance', RANGE],
    ['report-overview', '/reports/overview', RANGE],
    ['dashboard-channels', '/reports/dashboard-channels', () => ({})],
  ]

  it('leader thấy SĐT đầy đủ, sale bị che; mọi route trả 200 cho cả ba vai', async () => {
    const sale = await seedUser({ label: 'rp-sale', grants: { 'reports.customers': 'own', 'reports.staff': 'own', 'reports.overview': 'own', 'contacts.view': 'own' } })
    const leader = await seedUser({
      label: 'rp-leader',
      grants: { 'reports.customers': 'all', 'reports.staff': 'all', 'reports.overview': 'all', 'contacts.view': 'all', 'contacts.phone_full': 'all', 'reports.export': 'all' },
    })
    await seedContact({ phone: '0933111222', name: 'Khách báo cáo', ownerId: sale.id, daysAgo: 10 })
    await seedContact({ phone: '0933111333', name: 'Khách báo cáo hai', ownerId: leader.id, daysAgo: 12 })
    // Vai quản trị là người dùng seed đủ quyền xem báo cáo, KHÔNG dùng tài khoản gốc.
    const adminLike = await seedUser({ label: 'rp-admin', grants: { 'reports.customers': 'all', 'reports.staff': 'all', 'reports.overview': 'all', 'contacts.view': 'all', 'contacts.phone_full': 'all', 'reports.export': 'all' } })
    const tokens: [Role, string][] = [
      ['admin', (await loginSeeded(adminLike)).token],
      ['leader', (await loginSeeded(leader)).token],
      ['sale', (await loginSeeded(sale)).token],
    ]
    for (const [name, p, range] of ROUTES) {
      for (const [role, token] of tokens) {
        const res = await api.get(qs(p, range()), { token, ip: freshIp() })
        expect(res.status, `${p} (${role}): ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200)
        golden(name, role, snap(res))
        if (name === 'report-customers-uncontacted') {
          const text = JSON.stringify(res.body)
          if (role === 'sale') {
            expect(text, 'sale (không có contacts.phone_full) không được thấy SĐT đầy đủ').not.toContain('0933111222')
            expect(text).not.toContain('0933111333')
          } else {
            expect(text, `${role} phải thấy SĐT đầy đủ`).toContain('0933111222')
            expect(text, `${role} phải thấy SĐT đầy đủ`).toContain('0933111333')
          }
        }
      }
    }
    // xuất báo cáo nhân viên: cần reports.export
    const exp = await api.get(qs('/reports/employee-performance/export', RANGE()), { token: (await loginSeeded(leader)).token, ip: freshIp() })
    expect(exp.status, `export: ${JSON.stringify(exp.body).slice(0, 100)}`).toBe(200)
  })
})

describe('con trỏ phân trang do bên này phát, bên kia dùng', () => {
  it('trang 1 phát con trỏ; trang 2 dùng con trỏ của Node (record) hoặc của baseline (compare), khớp từng byte', async () => {
    const page1 = ok<{ items: { id: number }[]; next_cursor: string | null }>(await api.get(qs('/custom-objects/hoc_sinh/records', { limit: '2', sort: 'field:diem' }), t(admin)), 200, 'trang 1')
    expect(page1.items).toHaveLength(2)
    expect(page1.next_cursor, 'phải còn trang sau').toBeTypeOf('string')
    golden('records-page1', 'admin', snap({ status: 200, headers: new Headers(), body: page1 }))
    const cursor = crossCursor('records-page1', page1.next_cursor as string)
    const page2 = await api.get(qs('/custom-objects/hoc_sinh/records', { limit: '2', sort: 'field:diem', cursor }), t(admin))
    expect(page2.status).toBe(200)
    golden('records-page2', 'admin', snap(page2))
    const ids1 = page1.items.map((i) => i.id)
    const ids2 = (page2.body as { items: { id: number }[] }).items.map((i) => i.id)
    expect(ids2.filter((i) => ids1.includes(i)), 'trang 2 không trùng trang 1').toEqual([])
  })
})
