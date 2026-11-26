import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { goldenThreeRoles } from '../../lib/roles.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * C08, từ `apps/monolith/test/rbac/deals.e2e-spec.ts` (8 ca). Owner của Deal = `assigned_to`, `created_by`. `contact.phone` lồng trong
 * response được che theo `contacts.phone_full` khoá bởi owner CỦA CONTACT, cùng owner với màn Khách hàng.
 */
async function makeDeal(d: { title: string; assignedTo: number; createdBy: number; contactId?: number | null }): Promise<number> {
  const [r] = await q<{ id: number }>(
    `INSERT INTO deals (title, assigned_to, created_by, contact_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now() - interval '1 day', now()) RETURNING id`,
    [d.title, d.assignedTo, d.createdBy, d.contactId ?? null],
  )
  return r.id
}

async function makeContact(phone: string, assignedTo: number): Promise<number> {
  const [c] = await q<{ id: number }>(
    `INSERT INTO contacts (phone, full_name, assigned_to, created_at, updated_at) VALUES ($1, 'KH deal', $2, now() - interval '2 days', now()) RETURNING id`,
    [phone, assignedTo],
  )
  return c.id
}

const token = async (u: Awaited<ReturnType<typeof seedUser>>): Promise<string> => (await loginSeeded(u)).token

describe('RBAC — Deals', () => {
  it('GET /deals không có quyền deals.view → 403', async () => {
    const u = await seedUser({ label: 'no-view', grants: {} })
    expect((await api.get('/deals', { token: await token(u), ip: freshIp() })).status).toBe(403)
  })

  it("GET /deals scope 'own' → chỉ thấy deal mình assigned_to/created_by, KHÔNG thấy deal người khác", async () => {
    const u = await seedUser({ label: 'own', grants: { 'deals.view': 'own' } })
    const other = await seedUser({ label: 'other', grants: {} })
    const mine = await makeDeal({ title: 'E2E deal mine', assignedTo: u.id, createdBy: u.id })
    const theirs = await makeDeal({ title: 'E2E deal other', assignedTo: other.id, createdBy: other.id })
    const res = await api.get('/deals', { token: await token(u), ip: freshIp() })
    expect(res.status).toBe(200)
    const ids = (res.body as { data: { id: number }[] }).data.map((d) => d.id)
    expect(ids).toContain(mine)
    expect(ids, 'bản e2e cũ chỉ kiểm có; ca hộp đen kiểm luôn không thấy deal người khác').not.toContain(theirs)
  })

  it('GET /deals/:id ngoài phạm vi deals.view → 404', async () => {
    const u = await seedUser({ label: 'scoped', grants: { 'deals.view': 'own' } })
    const other = await seedUser({ label: 'other', grants: {} })
    const deal = await makeDeal({ title: 'E2E deal outsider', assignedTo: other.id, createdBy: other.id })
    const res = await api.get(`/deals/${deal}`, { token: await token(u), ip: freshIp() })
    expect(res.status).toBe(404)
    golden('deals-detail-out-of-scope', 'sale', snap(res))
  })

  it('GET /deals/:id trong phạm vi NHƯNG thiếu contacts.phone_full → SĐT contact lồng bên trong bị che', async () => {
    const u = await seedUser({ label: 'masked', grants: { 'deals.view': 'own' } })
    const contact = await makeContact('0900000168', u.id)
    const deal = await makeDeal({ title: 'E2E deal with contact', assignedTo: u.id, createdBy: u.id, contactId: contact })
    const res = await goldenThreeRoles('deals-detail-masked', `/deals/${deal}`, await token(u))
    expect(res.status).toBe(200)
    const phone = String((res.body as { contact: { phone: string } }).contact.phone)
    expect(phone).not.toBe('0900000168')
    expect(phone).toContain('***')
  })

  it('GET /deals/:id có contacts.phone_full phủ owner contact → SĐT contact lồng bên trong đầy đủ', async () => {
    const u = await seedUser({ label: 'full', grants: { 'deals.view': 'own', 'contacts.phone_full': 'own' } })
    const contact = await makeContact('0900000168', u.id)
    const deal = await makeDeal({ title: 'E2E deal with contact full', assignedTo: u.id, createdBy: u.id, contactId: contact })
    const res = await goldenThreeRoles('deals-detail-full', `/deals/${deal}`, await token(u))
    expect(res.status).toBe(200)
    expect((res.body as { contact: { phone: string } }).contact.phone).toBe('0900000168')
  })

  it('GET /deals/:id: deal của mình nhưng contact của người khác → SĐT vẫn che (khoá theo owner contact, không theo owner deal)', async () => {
    const u = await seedUser({ label: 'mixed', grants: { 'deals.view': 'own', 'contacts.phone_full': 'own' } })
    const other = await seedUser({ label: 'other', grants: {} })
    const contact = await makeContact('0900000469', other.id)
    const deal = await makeDeal({ title: 'E2E deal contact người khác', assignedTo: u.id, createdBy: u.id, contactId: contact })
    const res = await goldenThreeRoles('deals-detail-contact-of-other', `/deals/${deal}`, await token(u))
    expect(res.status).toBe(200)
    expect((res.body as { contact: { phone: string } }).contact.phone).toBe('***469')
  })

  it('POST /deals không có quyền deals.manage → 403', async () => {
    const u = await seedUser({ label: 'no-manage', grants: {} })
    const res = await api.post('/deals', { token: await token(u), body: { title: 'E2E deal blocked', assigned_to: u.id }, ip: freshIp() })
    expect(res.status).toBe(403)
    expect((await q(`SELECT 1 FROM deals WHERE title = 'E2E deal blocked'`)).length, 'không tạo deal').toBe(0)
  })

  it('DELETE /deals/:id ngoài phạm vi deals.delete → 404', async () => {
    const u = await seedUser({ label: 'del', grants: { 'deals.delete': 'own' } })
    const other = await seedUser({ label: 'other', grants: {} })
    const deal = await makeDeal({ title: 'E2E deal to delete', assignedTo: other.id, createdBy: other.id })
    const res = await api.del(`/deals/${deal}`, { token: await token(u), ip: freshIp() })
    expect(res.status).toBe(404)
    expect((await q(`SELECT 1 FROM deals WHERE id = $1`, [deal])).length, 'deal không bị xoá').toBe(1)
  })
})
