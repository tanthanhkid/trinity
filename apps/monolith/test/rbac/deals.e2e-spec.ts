import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Ma trận quyền + phạm vi cho Deal . Owner Deal =
 * `['assigned_to','created_by']`. `contact.phone` lồng trong response được
 * che theo `contacts.phone_full` khoá bởi owner CỦA CONTACT (`assigned_to`/
 * `created_by_id`) — cùng owner với màn Khách hàng.
 */
describe('RBAC E2E — Deals', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp())
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM deals WHERE title LIKE 'E2E deal%'`)
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE phone LIKE '09e2ed%'`)
    await resetDb(prisma)
  })

  async function makeDeal(data: {
    title: string
    assigned_to: number
    created_by: number
    contactId?: number | null
  }) {
    return prisma.deal.create({
      data: {
        title: data.title,
        assigned_to: data.assigned_to,
        created_by: data.created_by,
        contact_id: data.contactId ?? null,
      },
      select: { id: true, assigned_to: true, created_by: true },
    })
  }

  it('GET /deals không có quyền deals.view → 403', async () => {
    const u = await makeUser(prisma, { grants: {} })
    await api(app, u.token).get('/api/v1/deals').expect(403)
  })

  it("GET /deals scope 'own' → chỉ thấy deal mình assigned_to/created_by, KHÔNG thấy deal người khác", async () => {
    const u = await makeUser(prisma, { grants: { 'deals.view': 'own' } })
    const other = await makeUser(prisma, { grants: {} })
    const mine = await makeDeal({ title: 'E2E deal mine', assigned_to: u.id, created_by: u.id })
    await makeDeal({ title: 'E2E deal other', assigned_to: other.id, created_by: other.id })

    const res = await api(app, u.token).get('/api/v1/deals').expect(200)
    const ids: number[] = res.body.data.map((d: { id: number }) => d.id)
    expect(ids).toContain(mine.id)
  })

  it('GET /deals/:id ngoài phạm vi deals.view → 404', async () => {
    const u = await makeUser(prisma, { grants: { 'deals.view': 'own' } })
    const other = await makeUser(prisma, { grants: {} })
    const deal = await makeDeal({ title: 'E2E deal outsider', assigned_to: other.id, created_by: other.id })

    await api(app, u.token).get(`/api/v1/deals/${deal.id}`).expect(404)
  })

  it('GET /deals/:id trong phạm vi NHƯNG thiếu contacts.phone_full → SĐT contact lồng bên trong bị che', async () => {
    const u = await makeUser(prisma, { grants: { 'deals.view': 'own' } })
    const contact = await prisma.contact.create({
      data: { phone: '0900000168', full_name: 'KH deal', assigned_to: u.id },
      select: { id: true },
    })
    const deal = await makeDeal({
      title: 'E2E deal with contact',
      assigned_to: u.id,
      created_by: u.id,
      contactId: contact.id,
    })

    const res = await api(app, u.token).get(`/api/v1/deals/${deal.id}`).expect(200)
    expect(res.body.contact.phone).not.toBe('0900000168')
    expect(String(res.body.contact.phone)).toContain('***')
  })

  it('GET /deals/:id có contacts.phone_full phủ owner contact → SĐT contact lồng bên trong đầy đủ', async () => {
    const u = await makeUser(prisma, {
      grants: { 'deals.view': 'own', 'contacts.phone_full': 'own' },
    })
    const contact = await prisma.contact.create({
      data: { phone: '0900000168', full_name: 'KH deal', assigned_to: u.id },
      select: { id: true },
    })
    const deal = await makeDeal({
      title: 'E2E deal with contact full',
      assigned_to: u.id,
      created_by: u.id,
      contactId: contact.id,
    })

    const res = await api(app, u.token).get(`/api/v1/deals/${deal.id}`).expect(200)
    expect(res.body.contact.phone).toBe('0900000168')
  })

  it('GET /deals/:id: deal của mình nhưng contact của người khác → SĐT vẫn che (khoá theo owner contact, không theo owner deal)', async () => {
    const u = await makeUser(prisma, { grants: { 'deals.view': 'own', 'contacts.phone_full': 'own' } })
    const other = await makeUser(prisma, { grants: {} })
    const contact = await prisma.contact.create({
      data: { phone: '0900000469', full_name: 'KH deal', assigned_to: other.id },
      select: { id: true },
    })
    const deal = await makeDeal({ title: 'E2E deal contact người khác', assigned_to: u.id, created_by: u.id, contactId: contact.id })
    const res = await api(app, u.token).get(`/api/v1/deals/${deal.id}`).expect(200)
    expect(res.body.contact.phone).toBe('***469')
  })

  it('POST /deals không có quyền deals.manage → 403', async () => {
    const u = await makeUser(prisma, { grants: {} })
    await api(app, u.token)
      .post('/api/v1/deals')
      .send({ title: 'E2E deal blocked', assigned_to: u.id })
      .expect(403)
  })

  it('DELETE /deals/:id ngoài phạm vi deals.delete → 404', async () => {
    const u = await makeUser(prisma, { grants: { 'deals.delete': 'own' } })
    const other = await makeUser(prisma, { grants: {} })
    const deal = await makeDeal({ title: 'E2E deal to delete', assigned_to: other.id, created_by: other.id })

    await api(app, u.token).delete(`/api/v1/deals/${deal.id}`).expect(404)
  })
})
