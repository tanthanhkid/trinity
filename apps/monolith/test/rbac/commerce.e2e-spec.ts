import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * RBAC e2e for the commerce service: products, product categories,
 * attribute definitions and projects.
 */
describe('RBAC E2E — commerce', () => {
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
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE products, product_categories, projects RESTART IDENTITY CASCADE`,
    )
    await resetDb(prisma)
  })

  it('health @Public → 200 không token', async () => {
    await api(app).get('/api/v1/health').expect(200)
  })

  // ───────────────────────────── Products / Projects ─────────────────────────────
  describe('/products, /product-categories, /product-attribute-defs, /projects', () => {
    it('GET: thiếu products.view → 403; có → 200; id không tồn tại → 404', async () => {
      const none = await makeUser(prisma)
      const viewer = await makeUser(prisma, { grants: { 'products.view': true } })
      for (const url of ['/api/v1/products', '/api/v1/product-categories', '/api/v1/projects']) {
        await api(app, none.token).get(url).expect(403)
        await api(app, viewer.token).get(url).expect(200)
      }
      await api(app, viewer.token).get('/api/v1/products/999999').expect(404)
      await api(app, viewer.token).get('/api/v1/projects/999999').expect(404)
    })

    it('ghi: products.view không đủ → 403 trên mọi route ghi', async () => {
      const viewer = await makeUser(prisma, { grants: { 'products.view': true } })
      await api(app, viewer.token).post('/api/v1/products').send({ code: 'AB-1', name: 'Sản phẩm' }).expect(403)
      await api(app, viewer.token).patch('/api/v1/products/1').send({ name: 'x' }).expect(403)
      await api(app, viewer.token).delete('/api/v1/products/1').expect(403)
      await api(app, viewer.token).post('/api/v1/product-categories').send({ code: 'c1', name: 'Danh mục' }).expect(403)
      await api(app, viewer.token).patch('/api/v1/product-attribute-defs/1').send({}).expect(403)
      await api(app, viewer.token).delete('/api/v1/product-attribute-defs/1').expect(403)
      await api(app, viewer.token).post('/api/v1/projects').send({ name: 'Dự án', code: 'DA1' }).expect(403)
      await api(app, viewer.token).delete('/api/v1/projects/1').expect(403)
    })

    it('products.manage: tạo sản phẩm thành công; sửa/xoá id không tồn tại → 404', async () => {
      const mgr = await makeUser(prisma, { grants: { 'products.manage': true } })
      await api(app, mgr.token).post('/api/v1/products').send({ code: 'AB-2', name: 'Sản phẩm hai' }).expect(201)
      await api(app, mgr.token).patch('/api/v1/products/999999').send({ name: 'xx' }).expect(404)
      await api(app, mgr.token).delete('/api/v1/projects/999999').expect(404)
    })

    it('DELETE /products/:id: xoá hẳn khi chưa tham chiếu; 409 khi liên hệ đang gắn', async () => {
      const mgr = await makeUser(prisma, { grants: { 'products.manage': true, 'products.view': true } })
      const free = await api(app, mgr.token).post('/api/v1/products').send({ code: 'DEL-1', name: 'Xoá được' }).expect(201)
      await api(app, mgr.token).delete(`/api/v1/products/${free.body.id}`).expect(200)
      await api(app, mgr.token).get(`/api/v1/products/${free.body.id}`).expect(404)

      const used = await api(app, mgr.token).post('/api/v1/products').send({ code: 'DEL-2', name: 'Đã dùng' }).expect(201)
      await prisma.$executeRawUnsafe(
        `INSERT INTO contacts (phone, product_id, created_at, updated_at) VALUES ('0900000217', ${Number(used.body.id)}, now(), now())`,
      )
      const res = await api(app, mgr.token).delete(`/api/v1/products/${used.body.id}`).expect(409)
      expect(res.body.message).toContain('chỉ có thể ẩn')
      await api(app, mgr.token).get(`/api/v1/products/${used.body.id}`).expect(200)
      await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE phone = '0900000217'`)
    })
  })
})
