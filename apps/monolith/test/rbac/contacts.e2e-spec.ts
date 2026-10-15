import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Ma trận quyền + phạm vi cho Danh bạ:
 * 403 khi thiếu quyền · scope 'own' · scope 'team' (subtree manager_id) ·
 * 404 khi ngoài phạm vi theo id  · che SĐT theo `contacts.phone_full` ·
 * quyền xuất Excel (`contacts.export`) riêng khỏi `contacts.view`.
 */
describe('RBAC E2E — Contacts', () => {
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
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE phone LIKE '09e2e%'`)
    await resetDb(prisma)
  })

  async function makeContact(data: {
    phone: string
    assigned_to?: number | null
    created_by_id?: number | null
    full_name?: string
  }) {
    return prisma.contact.create({
      data: {
        phone: data.phone,
        full_name: data.full_name ?? 'Khách E2E',
        assigned_to: data.assigned_to ?? null,
        created_by_id: data.created_by_id ?? null,
      },
      select: { id: true, phone: true, assigned_to: true, created_by_id: true },
    })
  }

  it('GET /contacts không có quyền contacts.view → 403', async () => {
    const u = await makeUser(prisma, { grants: {} })
    await api(app, u.token).get('/api/v1/contacts').expect(403)
  })

  it("GET /contacts scope 'own' → chỉ thấy contact của chính mình, KHÔNG thấy của người khác", async () => {
    const owner = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
    const other = await makeUser(prisma, { grants: {} })
    const mine = await makeContact({ phone: '09e2e000001', assigned_to: owner.id })
    await makeContact({ phone: '09e2e000002', assigned_to: other.id })

    const res = await api(app, owner.token).get('/api/v1/contacts').expect(200)
    const ids: number[] = res.body.data.map((c: { id: number }) => c.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(await (async () => {
      const o = await prisma.contact.findFirst({ where: { phone: '09e2e000002' } })
      return o!.id
    })())
  })

  it("GET /contacts scope 'team' (subtree manager_id) → thấy contact của cấp dưới, KHÔNG thấy người ngoài team", async () => {
    const manager = await makeUser(prisma, { grants: { 'contacts.view': 'team' } })
    const subordinate = await makeUser(prisma, { managerId: manager.id, grants: {} })
    const outsider = await makeUser(prisma, { grants: {} })

    const subContact = await makeContact({ phone: '09e2e000003', assigned_to: subordinate.id })
    const outsiderContact = await makeContact({ phone: '09e2e000004', assigned_to: outsider.id })

    const res = await api(app, manager.token).get('/api/v1/contacts').expect(200)
    const ids: number[] = res.body.data.map((c: { id: number }) => c.id)
    expect(ids).toContain(subContact.id)
    expect(ids).not.toContain(outsiderContact.id)
  })

  it('GET /contacts/:id ngoài phạm vi contacts.view → 404 (KHÔNG phải 403)', async () => {
    const u = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
    const outsider = await makeUser(prisma, { grants: {} })
    const contact = await makeContact({ phone: '09e2e000005', assigned_to: outsider.id })

    await api(app, u.token).get(`/api/v1/contacts/${contact.id}`).expect(404)
  })

  it('GET /contacts/:id trong phạm vi NHƯNG thiếu contacts.phone_full → SĐT bị che', async () => {
    const u = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
    const contact = await makeContact({ phone: '0900000168', assigned_to: u.id })

    const res = await api(app, u.token).get(`/api/v1/contacts/${contact.id}`).expect(200)
    expect(res.body.phone).not.toBe('0900000168')
    expect(String(res.body.phone)).toMatch(/168$/)
    expect(String(res.body.phone)).toContain('***')
  })

  it('GET /contacts/:id có contacts.phone_full phủ owner → SĐT đầy đủ', async () => {
    const u = await makeUser(prisma, {
      grants: { 'contacts.view': 'own', 'contacts.phone_full': 'own' },
    })
    const contact = await makeContact({ phone: '0900000168', assigned_to: u.id })

    const res = await api(app, u.token).get(`/api/v1/contacts/${contact.id}`).expect(200)
    expect(res.body.phone).toBe('0900000168')
  })

  it('GET /contacts/export không có quyền contacts.export → 403 (tách biệt khỏi contacts.view)', async () => {
    const u = await makeUser(prisma, { grants: { 'contacts.view': 'all' } })
    await api(app, u.token).get('/api/v1/contacts/export').expect(403)
  })

  it('GET /contacts/export có quyền contacts.export → 200, trả file xlsx', async () => {
    const u = await makeUser(prisma, {
      grants: { 'contacts.view': 'all', 'contacts.export': 'all' },
    })
    await makeContact({ phone: '09e2e000006', assigned_to: u.id })

    const res = await api(app, u.token).get('/api/v1/contacts/export').expect(200)
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })

  it('DELETE /contacts/:id ngoài phạm vi contacts.delete → 404', async () => {
    const u = await makeUser(prisma, { grants: { 'contacts.delete': 'own' } })
    const outsider = await makeUser(prisma, { grants: {} })
    const contact = await makeContact({ phone: '09e2e000007', assigned_to: outsider.id })

    await api(app, u.token).delete(`/api/v1/contacts/${contact.id}`).expect(404)
  })

  describe('GET /contacts/search (tra trùng — không lọc phạm vi, nhưng che SĐT)', () => {
    afterEach(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE full_name = 'Khách tra trùng E2E'`)
    })

    it('thiếu contacts.phone_full: thấy khách của người khác nhưng SĐT bị che', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.create': true } })
      const other = await makeUser(prisma, { grants: {} })
      await prisma.contact.create({
        data: { phone: '0900000501', full_name: 'Khách tra trùng E2E', assigned_to: other.id },
      })
      const res = await api(app, u.token).get('/api/v1/contacts/search?q=0900000501').expect(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].phone).toBe('***501')
    })

    it('thiếu contacts.phone_full toàn công ty: tra < 9 chữ số → rỗng (chặn dò từng chữ số)', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.create': true, 'contacts.phone_full': 'team' } })
      await prisma.contact.create({ data: { phone: '0900000602', full_name: 'Khách tra trùng E2E', assigned_to: u.id } })
      const res = await api(app, u.token).get('/api/v1/contacts/search?q=98765').expect(200)
      expect(res.body.data).toHaveLength(0)
    })

    it('contacts.phone_full scope all: tra chuỗi ngắn được và thấy số thật', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.create': true, 'contacts.phone_full': 'all' } })
      await prisma.contact.create({ data: { phone: '0900000703', full_name: 'Khách tra trùng E2E' } })
      const res = await api(app, u.token).get('/api/v1/contacts/search?q=9000007').expect(200)
      expect(res.body.data.map((c: { phone: string }) => c.phone)).toContain('0900000703')
    })
  })
})
