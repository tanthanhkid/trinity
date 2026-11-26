import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { goldenThreeRoles } from '../../lib/roles.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * C08, từ `apps/monolith/test/rbac/contacts.e2e-spec.ts` (12 ca). Ma trận quyền + phạm vi của Danh bạ: 403 thiếu quyền, scope
 * `own`/`team`, 404 ngoài phạm vi theo id, che SĐT theo `contacts.phone_full`, quyền xuất Excel riêng khỏi `contacts.view`.
 */
async function makeContact(d: { phone: string; assignedTo?: number | null; createdBy?: number | null; name?: string }): Promise<number> {
  const [c] = await q<{ id: number }>(
    `INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now() - interval '2 days', now()) RETURNING id`,
    [d.phone, d.name ?? 'Khách E2E', d.assignedTo ?? null, d.createdBy ?? null],
  )
  return c.id
}

const token = async (u: Awaited<ReturnType<typeof seedUser>>): Promise<string> => (await loginSeeded(u)).token
const get = async (path: string, t: string) => api.get(path, { token: t, ip: freshIp() })
const ids = (res: { body: unknown }): number[] => (res.body as { data: { id: number }[] }).data.map((c) => c.id)

describe('RBAC — Contacts', () => {
  it('GET /contacts không có quyền contacts.view → 403', async () => {
    const u = await seedUser({ label: 'no-view', grants: {} })
    expect((await get('/contacts', await token(u))).status).toBe(403)
  })

  it("GET /contacts scope 'own' → chỉ thấy contact của chính mình, KHÔNG thấy của người khác", async () => {
    const owner = await seedUser({ label: 'own', grants: { 'contacts.view': 'own' } })
    const other = await seedUser({ label: 'other', grants: {} })
    const mine = await makeContact({ phone: '09e2e000001', assignedTo: owner.id })
    const theirs = await makeContact({ phone: '09e2e000002', assignedTo: other.id })
    const res = await get('/contacts', await token(owner))
    expect(res.status).toBe(200)
    expect(ids(res)).toContain(mine)
    expect(ids(res)).not.toContain(theirs)
  })

  it("GET /contacts scope 'team' (subtree manager_id) → thấy contact của cấp dưới, KHÔNG thấy người ngoài team", async () => {
    const manager = await seedUser({ label: 'manager', grants: { 'contacts.view': 'team' } })
    const subordinate = await seedUser({ label: 'sub', managerId: manager.id, grants: {} })
    const outsider = await seedUser({ label: 'outsider', grants: {} })
    const sub = await makeContact({ phone: '09e2e000003', assignedTo: subordinate.id })
    const out = await makeContact({ phone: '09e2e000004', assignedTo: outsider.id })
    const res = await get('/contacts', await token(manager))
    expect(res.status).toBe(200)
    expect(ids(res)).toContain(sub)
    expect(ids(res)).not.toContain(out)
  })

  it('GET /contacts/:id ngoài phạm vi contacts.view → 404 (KHÔNG phải 403)', async () => {
    const u = await seedUser({ label: 'scoped', grants: { 'contacts.view': 'own' } })
    const outsider = await seedUser({ label: 'outsider', grants: {} })
    const c = await makeContact({ phone: '09e2e000005', assignedTo: outsider.id })
    const res = await get(`/contacts/${c}`, await token(u))
    expect(res.status).toBe(404)
    golden('contacts-detail-out-of-scope', 'sale', snap(res))
  })

  it('GET /contacts/:id trong phạm vi NHƯNG thiếu contacts.phone_full → SĐT bị che', async () => {
    const u = await seedUser({ label: 'masked', grants: { 'contacts.view': 'own' } })
    const c = await makeContact({ phone: '0900000168', assignedTo: u.id })
    const res = await goldenThreeRoles('contacts-detail-masked', `/contacts/${c}`, await token(u))
    expect(res.status).toBe(200)
    const phone = String((res.body as { phone: string }).phone)
    expect(phone).not.toBe('0900000168')
    expect(phone).toMatch(/168$/)
    expect(phone).toContain('***')
  })

  it('GET /contacts/:id có contacts.phone_full phủ owner → SĐT đầy đủ', async () => {
    const u = await seedUser({ label: 'full', grants: { 'contacts.view': 'own', 'contacts.phone_full': 'own' } })
    const c = await makeContact({ phone: '0900000168', assignedTo: u.id })
    const res = await goldenThreeRoles('contacts-detail-full', `/contacts/${c}`, await token(u))
    expect(res.status).toBe(200)
    expect((res.body as { phone: string }).phone).toBe('0900000168')
  })

  it('GET /contacts/export không có quyền contacts.export → 403 (tách biệt khỏi contacts.view)', async () => {
    const u = await seedUser({ label: 'no-export', grants: { 'contacts.view': 'all' } })
    expect((await get('/contacts/export', await token(u))).status).toBe(403)
  })

  it('GET /contacts/export có quyền contacts.export → 200, trả file xlsx', async () => {
    const u = await seedUser({ label: 'export', grants: { 'contacts.view': 'all', 'contacts.export': 'all' } })
    await makeContact({ phone: '09e2e000006', assignedTo: u.id })
    const res = await get('/contacts/export', await token(u))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('DELETE /contacts/:id ngoài phạm vi contacts.delete → 404', async () => {
    const u = await seedUser({ label: 'del', grants: { 'contacts.delete': 'own' } })
    const outsider = await seedUser({ label: 'outsider', grants: {} })
    const c = await makeContact({ phone: '09e2e000007', assignedTo: outsider.id })
    const res = await api.del(`/contacts/${c}`, { token: await token(u), ip: freshIp() })
    expect(res.status).toBe(404)
    expect((await q(`SELECT 1 FROM contacts WHERE id = $1`, [c])).length, 'khách không bị xoá').toBe(1)
  })

  describe('GET /contacts/search (tra trùng, không lọc phạm vi nhưng che SĐT)', () => {
    it('thiếu contacts.phone_full: thấy khách của người khác nhưng SĐT bị che', async () => {
      const u = await seedUser({ label: 'search1', grants: { 'contacts.create': null } })
      const other = await seedUser({ label: 'other', grants: {} })
      await makeContact({ phone: '0900000501', assignedTo: other.id, name: 'Khách tra trùng E2E' })
      const res = await goldenThreeRoles('contacts-search-masked', '/contacts/search?q=0900000501', await token(u))
      expect(res.status).toBe(200)
      const data = (res.body as { data: { phone: string }[] }).data
      expect(data).toHaveLength(1)
      expect(data[0].phone).toBe('***501')
    })

    it('thiếu contacts.phone_full toàn công ty: tra < 9 chữ số → rỗng (chặn dò từng chữ số)', async () => {
      const u = await seedUser({ label: 'search2', grants: { 'contacts.create': null, 'contacts.phone_full': 'team' } })
      await makeContact({ phone: '0900000602', assignedTo: u.id, name: 'Khách tra trùng E2E' })
      const res = await get('/contacts/search?q=98765', await token(u))
      expect(res.status).toBe(200)
      expect((res.body as { data: unknown[] }).data).toHaveLength(0)
    })

    it('contacts.phone_full scope all: tra chuỗi ngắn được và thấy số thật', async () => {
      const u = await seedUser({ label: 'search3', grants: { 'contacts.create': null, 'contacts.phone_full': 'all' } })
      await makeContact({ phone: '0900000703', name: 'Khách tra trùng E2E' })
      const res = await get('/contacts/search?q=9000007', await token(u))
      expect(res.status).toBe(200)
      expect((res.body as { data: { phone: string }[] }).data.map((c) => c.phone)).toContain('0900000703')
    })
  })
})
