import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, seedUser, type Scope } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { golden, snap, type Role } from '../../lib/golden.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/** C10 — chuyển từ `crm-kanban-reports-newsfeed.e2e-spec.ts` (11 ca): kanban boards, báo cáo tổng quan, bảng tin. */
async function as(label: string, grants: Record<string, Scope>) {
  const user = await seedUser({ label, grants })
  const { token } = await loginSeeded(user)
  return {
    get: (p: string) => api.get(p, { token, ip: freshIp() }),
    post: (p: string, body: unknown) => api.post(p, { token, body, ip: freshIp() }),
  }
}

describe('GET /kanban/boards — Mẫu A (kanban.view)', () => {
  it('không có quyền kanban.view → 403', async () => {
    const u = await as('kb-none', {})
    expect((await u.get('/kanban/boards')).status).toBe(403)
  })

  it('có kanban.view (scope own) → 200, danh sách hợp lệ', async () => {
    const u = await as('kb-own', { 'kanban.view': 'own' })
    const res = await u.get('/kanban/boards')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('admin (is_system) → 200, không cần khai grants riêng', async () => {
    const { token } = await loginAdmin()
    expect((await api.get('/kanban/boards', { token, ip: freshIp() })).status).toBe(200)
  })
})

describe('POST /kanban/boards — kanban.boards (không dùng kanban.view)', () => {
  it('chỉ có kanban.view, không có kanban.boards → 403 khi tạo board', async () => {
    const u = await as('kb-create-no', { 'kanban.view': 'all' })
    expect((await u.post('/kanban/boards', { name: 'Board test', visibility_role_ids: [] })).status).toBe(403)
  })

  it('có kanban.boards → tạo board thành công (200/201)', async () => {
    const u = await as('kb-create-ok', { 'kanban.boards': null, 'kanban.view': 'all' })
    const res = await u.post('/kanban/boards', { name: 'Board test hợp đồng', visibility_role_ids: [] })
    expect([200, 201]).toContain(res.status)
    expect((res.body as { name?: string }).name).toBe('Board test hợp đồng')
  })
})

describe('GET /reports/overview — Mẫu A (reports.overview)', () => {
  // Khoảng ngày tương đối so với hôm nay (máy chủ chạy TZ=UTC), không hằng ngày cứng.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const RANGE = `?date_from=${day(-27)}&date_to=${day(0)}`

  it('không có quyền reports.overview → 403', async () => {
    const u = await as('rp-none', {})
    expect((await u.get(`/reports/overview${RANGE}`)).status).toBe(403)
  })

  it('scope own → 200, không 500 dù chưa có dữ liệu', async () => {
    const u = await as('rp-own', { 'reports.overview': 'own' })
    const res = await u.get(`/reports/overview${RANGE}`)
    expect(res.status).toBe(200)
    expect(typeof res.body).toBe('object')
    expect(res.body).not.toBeNull()
  })

  it('scope all (chỉ là grant, không phải tên vai trò) vẫn 200', async () => {
    const u = await as('rp-all', { 'reports.overview': 'all' })
    expect((await u.get(`/reports/overview${RANGE}`)).status).toBe(200)
  })

  // `reports.overview` có `shape_permissions: contacts.phone_full`: golden ghi cho 3 vai (admin, leader, sale).
  it('golden ba vai: admin, leader, sale', async () => {
    const leader = await seedUser({
      label: 'rp-leader',
      grants: { 'reports.overview': 'all', 'contacts.view': 'all', 'contacts.phone_full': 'all' },
    })
    const sale = await seedUser({ label: 'rp-sale', grants: { 'reports.overview': 'own', 'contacts.view': 'own' } })
    const tokens: [Role, string][] = [
      ['admin', (await loginAdmin()).token],
      ['leader', (await loginSeeded(leader)).token],
      ['sale', (await loginSeeded(sale)).token],
    ]
    for (const [role, token] of tokens) {
      const res = await api.get(`/reports/overview${RANGE}`, { token, ip: freshIp() })
      expect(res.status, role).toBe(200)
      golden('reports-overview', role, snap(res))
    }
  })
})

describe('POST /newsfeed — Mẫu D (newsfeed.post, không theo phạm vi)', () => {
  it('không có quyền newsfeed.post → 403', async () => {
    const u = await as('nf-none', {})
    expect((await u.post('/newsfeed', { category: 'training', content: 'nội dung test' })).status).toBe(403)
  })

  it('có newsfeed.post → đăng bài thành công', async () => {
    const u = await as('nf-post', { 'newsfeed.post': null })
    expect([200, 201]).toContain((await u.post('/newsfeed', { category: 'training', content: 'nội dung test hợp đồng' })).status)
  })

  it('GET /newsfeed/permissions/me phản ánh đúng can_post theo grants', async () => {
    const u = await as('nf-perm', { 'newsfeed.post': null })
    const res = await u.get('/newsfeed/permissions/me')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ can_post: true, can_moderate: false })
  })
})
