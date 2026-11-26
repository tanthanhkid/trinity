import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedContact, seedUser, type SeededUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'

const made: SeededUser[] = []
const mk = async (o: Parameters<typeof seedUser>[0]) => {
  const u = await seedUser(o)
  made.push(u)
  return u
}

/** Dọn mọi dòng file này seed (POS, khách mẫu, thông báo) để DB dùng chung không dính rác sang ca khác. */
afterAll(async () => {
  const ids = made.map((u) => u.id)
  await q(`DELETE FROM pos_payments WHERE order_id IN (SELECT id FROM pos_orders WHERE code LIKE 'C11-POS-%')`)
  await q(`DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE code LIKE 'C11-POS-%')`)
  await q(`DELETE FROM pos_orders WHERE code LIKE 'C11-POS-%'`)
  await q(`DELETE FROM pos_shifts WHERE opened_by = ANY($1)`, [ids])
  await q(`DELETE FROM contacts WHERE phone IN ('0971100001', '0971100002')`)
  await q(`DELETE FROM notification_logs WHERE recipient_id = ANY($1)`, [ids])
  await closeDb()
})

/**
 * Chuyển từ `apps/monolith/test/rbac/pos-dashboard.e2e-spec.ts` (6 ca): POS + Tổng quan (`@Can` + phạm vi).
 * Thiếu quyền → 403; đơn đã thu/ca ngoài phạm vi `pos.sell` → 404; huỷ đơn đã thu cần `pos.manage`;
 * lọc Tổng quan ngoài phạm vi → rỗng (không nới).
 */
const o = async (u: SeededUser) => ({ token: (await loginSeeded(u)).token, ip: freshIp() })
const admin = async () => ({ token: (await loginAdmin()).token, ip: freshIp() })

async function seedPaid(owner: number, code: string): Promise<{ id: number; shiftId: number }> {
  const [shift] = await q<{ id: number }>(`INSERT INTO pos_shifts (opened_by, status) VALUES ($1, 'closed') RETURNING id`, [owner])
  const [order] = await q<{ id: number }>(
    `INSERT INTO pos_orders (code, shift_id, status, created_by, paid_by, paid_at, total)
     VALUES ($1, $2, 'paid', $3, $3, now(), 1000) RETURNING id`,
    [code, shift.id, owner],
  )
  return { id: order.id, shiftId: shift.id }
}

describe('POS + Tổng quan: quyền + phạm vi', () => {
  beforeAll(async () => {
    await control.flushCache()
  })

  it('không có quyền POS → 403 mọi route; chỉ pos.sell không sửa được cấu hình', async () => {
    const none = await mk({ label: 'none', grants: {} })
    expect((await api.get('/pos/orders', await o(none))).status).toBe(403)
    expect((await api.get('/pos/reports/daily', await o(none))).status).toBe(403)
    const seller = await mk({ label: 'seller', grants: { 'pos.sell': 'own' } })
    expect((await api.get('/pos/orders', await o(seller))).status).toBe(200)
    expect((await api.patch('/pos/settings', { ...(await o(seller)), body: {} })).status).toBe(403)
    expect((await api.get('/pos/reports/daily', await o(seller))).status).toBe(403)
  })

  it('pos.sell own: đơn đã thu của người khác → 404, không thấy trong list; ca người khác → 404', async () => {
    const a = await mk({ label: 'a', grants: { 'pos.sell': 'own' } })
    const b = await mk({ label: 'b', grants: { 'pos.sell': 'own' } })
    const orderB = await seedPaid(b.id, 'C11-POS-0001')
    expect((await api.get(`/pos/orders/${orderB.id}`, await o(a))).status).toBe(404)
    const list = await api.get('/pos/orders', await o(a))
    expect(list.status).toBe(200)
    expect((list.body as { data: unknown[] }).data).toHaveLength(0)
    expect((await api.get(`/pos/shifts/${orderB.shiftId}/summary`, await o(a))).status).toBe(404)
    expect((await api.post(`/pos/shifts/${orderB.shiftId}/close`, { ...(await o(a)), body: { closing_cash_counted: 0 } })).status).toBe(404)
    expect((await api.get(`/pos/orders/${orderB.id}`, await o(b))).status).toBe(200)
  })

  it('huỷ đơn đã thu: pos.sell → 403, pos.manage (+ pos.sell all) → 200', async () => {
    const seller = await mk({ label: 'seller2', grants: { 'pos.sell': 'own' } })
    const order = await seedPaid(seller.id, 'C11-POS-0002')
    expect((await api.post(`/pos/orders/${order.id}/void`, { ...(await o(seller)), body: { reason: 'sai' } })).status).toBe(403)
    const mgr = await mk({ label: 'mgr', grants: { 'pos.sell': 'all', 'pos.manage': null } })
    expect((await api.post(`/pos/orders/${order.id}/void`, { ...(await o(mgr)), body: { reason: 'sai' } })).status).toBe(201)
  })

  it('Tổng quan: không có reports.overview → 403; scope own bị 403 ở roster, bộ lọc bị bỏ qua', async () => {
    const none = await mk({ label: 'none2', grants: {} })
    expect((await api.get('/reports/dashboard-overview', await o(none))).status).toBe(403)
    const own = await mk({ label: 'own', grants: { 'reports.overview': 'own' } })
    expect((await api.get('/reports/dashboard-overview', await o(own))).status).toBe(200)
    expect((await api.get('/reports/dashboard-filter-roster', await o(own))).status).toBe(403)
    expect((await api.get('/reports/dashboard-tasks?user_id=1', await o(own))).status).toBe(200)
  })

  it('Tổng quan scope team: lọc user ngoài phạm vi → rỗng (không nới)', async () => {
    const lead = await mk({ label: 'lead', grants: { 'reports.overview': 'team' } })
    const inTeam = await mk({ label: 'inteam', grants: {}, managerId: lead.id })
    const outsider = await mk({ label: 'outsider', grants: {} })
    await seedContact({ phone: '0971100001', name: 'c11-dash-in', ownerId: inTeam.id })
    await seedContact({ phone: '0971100002', name: 'c11-dash-out', ownerId: outsider.id })
    await control.flushCache()
    const all = await api.get('/reports/dashboard-overview', await o(lead))
    expect(all.status).toBe(200)
    expect((all.body as { customers: { total: number } }).customers.total).toBe(1)
    const out = await api.get(`/reports/dashboard-overview?user_id=${outsider.id}`, await o(lead))
    expect(out.status).toBe(200)
    expect((out.body as { customers: { total: number } }).customers.total).toBe(0)
    const inn = await api.get(`/reports/dashboard-overview?user_id=${inTeam.id}`, await o(lead))
    expect(inn.status).toBe(200)
    expect((inn.body as { customers: { total: number } }).customers.total).toBe(1)
    const roster = await api.get('/reports/dashboard-filter-roster', await o(lead))
    expect(roster.status).toBe(200)
    const r = roster.body as { dept_heads: { id: number }[]; team_leads: { id: number }[]; sales: { id: number }[] }
    const ids = [...r.dept_heads, ...r.team_leads, ...r.sales].map((x) => x.id)
    expect(ids).not.toContain(outsider.id)
  })

  it('Quản trị (isAdmin): mọi route POS/Tổng quan qua, scope all, roster + lọc dùng được', async () => {
    const other = await mk({ label: 'other', grants: {} })
    const order = await seedPaid(other.id, 'C11-POS-0003')
    expect((await api.get(`/pos/orders/${order.id}`, await admin())).status).toBe(200)
    expect((await api.get('/pos/reports/daily', await admin())).status).toBe(200)
    expect((await api.get('/reports/dashboard-filter-roster', await admin())).status).toBe(200)
    const ov = await api.get(`/reports/dashboard-overview?user_id=${other.id}`, await admin())
    expect(ov.status).toBe(200)
    expect((ov.body as { scope_label: string }).scope_label).toBe('theo bộ lọc')
  })
})
