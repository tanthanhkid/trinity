import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * POS + Tổng quan (`@Can` + phạm vi), chạy qua guard thật.
 * Khoá: thiếu quyền → 403; đơn đã thu/ca ngoài phạm vi `pos.sell` → 404; huỷ đơn đã thu cần `pos.manage`;
 * lọc Tổng quan ngoài phạm vi → rỗng (không nới).
 */
describe('POS + Tổng quan — quyền + phạm vi (E2E)', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp())
  }, 60_000)
  afterAll(async () => close())
  afterEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE pos_payments, pos_order_items, pos_orders, pos_shifts RESTART IDENTITY CASCADE')
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE full_name LIKE 'e2e-dash-%'`)
    await resetDb(prisma)
  })

  async function seedPaid(owner: number, code: string) {
    const shift = await prisma.posShift.create({ data: { opened_by: owner, status: 'closed' } })
    return prisma.posOrder.create({
      data: { code, shift_id: shift.id, status: 'paid', created_by: owner, paid_by: owner, paid_at: new Date(), total: BigInt(1000) },
    })
  }

  it('không có quyền POS → 403 mọi route; chỉ pos.sell không sửa được cấu hình', async () => {
    const none = await makeUser(prisma, {})
    await api(app, none.token).get('/api/v1/pos/orders').expect(403)
    await api(app, none.token).get('/api/v1/pos/reports/daily').expect(403)
    const seller = await makeUser(prisma, { grants: { 'pos.sell': 'own' } })
    await api(app, seller.token).get('/api/v1/pos/orders').expect(200)
    await api(app, seller.token).patch('/api/v1/pos/settings').send({}).expect(403)
    await api(app, seller.token).get('/api/v1/pos/reports/daily').expect(403)
  })

  it('pos.sell own: đơn đã thu của người khác → 404, không thấy trong list; ca người khác → 404', async () => {
    const a = await makeUser(prisma, { grants: { 'pos.sell': 'own' } })
    const b = await makeUser(prisma, { grants: { 'pos.sell': 'own' } })
    const orderB = await seedPaid(b.id, '20260101-0001')
    await api(app, a.token).get(`/api/v1/pos/orders/${orderB.id}`).expect(404)
    const list = await api(app, a.token).get('/api/v1/pos/orders').expect(200)
    expect(list.body.data).toHaveLength(0)
    await api(app, a.token).get(`/api/v1/pos/shifts/${orderB.shift_id}/summary`).expect(404)
    await api(app, a.token).post(`/api/v1/pos/shifts/${orderB.shift_id}/close`).send({ closing_cash_counted: 0 }).expect(404)
    await api(app, b.token).get(`/api/v1/pos/orders/${orderB.id}`).expect(200)
  })

  it('huỷ đơn đã thu: pos.sell → 403, pos.manage (+ pos.sell all) → 200', async () => {
    const seller = await makeUser(prisma, { grants: { 'pos.sell': 'own' } })
    const order = await seedPaid(seller.id, '20260101-0002')
    await api(app, seller.token).post(`/api/v1/pos/orders/${order.id}/void`).send({ reason: 'sai' }).expect(403)
    const mgr = await makeUser(prisma, { grants: { 'pos.sell': 'all', 'pos.manage': true } })
    await api(app, mgr.token).post(`/api/v1/pos/orders/${order.id}/void`).send({ reason: 'sai' }).expect(201)
  })

  it('Tổng quan: không có reports.overview → 403; scope own bị 403 ở roster, bộ lọc bị bỏ qua', async () => {
    const none = await makeUser(prisma, {})
    await api(app, none.token).get('/api/v1/reports/dashboard-overview').expect(403)
    const own = await makeUser(prisma, { grants: { 'reports.overview': 'own' } })
    await api(app, own.token).get('/api/v1/reports/dashboard-overview').expect(200)
    await api(app, own.token).get('/api/v1/reports/dashboard-filter-roster').expect(403)
    await api(app, own.token).get('/api/v1/reports/dashboard-tasks?user_id=1').expect(200)
  })

  it('Tổng quan scope team: lọc user ngoài phạm vi → rỗng (không nới)', async () => {
    const lead = await makeUser(prisma, { grants: { 'reports.overview': 'team' } })
    const inTeam = await makeUser(prisma, { managerId: lead.id })
    const outsider = await makeUser(prisma, {})
    await prisma.contact.create({ data: { full_name: 'e2e-dash-in', phone: '0900000001', assigned_to: inTeam.id, created_by_id: inTeam.id } })
    await prisma.contact.create({ data: { full_name: 'e2e-dash-out', phone: '0900000002', assigned_to: outsider.id, created_by_id: outsider.id } })
    const all = await api(app, lead.token).get('/api/v1/reports/dashboard-overview').expect(200)
    expect(all.body.customers.total).toBe(1)
    const out = await api(app, lead.token).get(`/api/v1/reports/dashboard-overview?user_id=${outsider.id}`).expect(200)
    expect(out.body.customers.total).toBe(0)
    const inn = await api(app, lead.token).get(`/api/v1/reports/dashboard-overview?user_id=${inTeam.id}`).expect(200)
    expect(inn.body.customers.total).toBe(1)
    const roster = await api(app, lead.token).get('/api/v1/reports/dashboard-filter-roster').expect(200)
    const ids = [...roster.body.dept_heads, ...roster.body.team_leads, ...roster.body.sales].map((r: { id: number }) => r.id)
    expect(ids).not.toContain(outsider.id)
  })

  it('Quản trị (isAdmin): mọi route POS/Tổng quan qua, scope all, roster + lọc dùng được', async () => {
    const admin = await makeUser(prisma, { admin: true })
    const other = await makeUser(prisma, {})
    const order = await seedPaid(other.id, '20260101-0003')
    await api(app, admin.token).get(`/api/v1/pos/orders/${order.id}`).expect(200)
    await api(app, admin.token).get('/api/v1/pos/reports/daily').expect(200)
    await api(app, admin.token).get('/api/v1/reports/dashboard-filter-roster').expect(200)
    const ov = await api(app, admin.token).get(`/api/v1/reports/dashboard-overview?user_id=${other.id}`).expect(200)
    expect(ov.body.scope_label).toBe('theo bộ lọc')
  })
})
