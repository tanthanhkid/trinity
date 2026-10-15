import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * API quản trị vai trò + guardrail chống leo thang  +
 * "Quản trị cuối cùng". Monolith thật, Postgres thật.
 */
describe('RBAC E2E — quản trị vai trò', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  afterEach(async () => {
    await resetDb(prisma)
  })

  async function me(token: string) {
    return (await api(app, token).get('/api/v1/auth/me').expect(200)).body
  }

  describe('vòng đời: tạo vai trò → gán user → /auth/me phản ánh NGAY → sửa grants phản ánh NGAY', () => {
    it('chạy đủ chuỗi, kèm danh sách/chi tiết/người giữ/nhật ký', async () => {
      const admin = await makeUser(prisma, { admin: true })
      const staff = await makeUser(prisma, { grants: {} })

      const created = await api(app, admin.token)
        .post('/api/v1/roles')
        .send({ name: 'Kế toán', description: 'Xem khách', grants: { 'contacts.view': 'team', 'contacts.create': null } })
        .expect(201)
      const roleId = created.body.id as number
      expect(created.body).toMatchObject({ name: 'Kế toán', is_system: false, member_count: 0 })
      expect(created.body.grants).toEqual({ 'contacts.view': 'team', 'contacts.create': true })

      // chưa gán → chưa có quyền
      expect((await me(staff.token)).permissions).toEqual({})

      await api(app, admin.token).put(`/api/v1/users/${staff.id}/roles`).send({ roleIds: [roleId] }).expect(200)
      expect((await me(staff.token)).permissions).toEqual({ 'contacts.view': 'team', 'contacts.create': true })

      // sửa grants → request kế tiếp thấy ngay (cache đã vô hiệu)
      await api(app, admin.token)
        .put(`/api/v1/roles/${roleId}/grants`)
        .send({ grants: { 'contacts.view': 'all' } })
        .expect(200)
      expect((await me(staff.token)).permissions).toEqual({ 'contacts.view': 'all' })

      // response shape của GET /roles
      const list = await api(app, admin.token).get('/api/v1/roles').expect(200)
      const row = list.body.find((r: { id: number }) => r.id === roleId)
      expect(row).toEqual({ id: roleId, name: 'Kế toán', description: 'Xem khách', is_system: false, member_count: 1 })

      const detail = await api(app, admin.token).get(`/api/v1/roles/${roleId}`).expect(200)
      expect(detail.body.grants).toEqual({ 'contacts.view': 'all' })

      const members = await api(app, admin.token).get(`/api/v1/roles/${roleId}/members`).expect(200)
      expect(members.body.map((m: { id: number }) => m.id)).toEqual([staff.id])

      // gỡ hết vai trò → mất quyền ngay
      await api(app, admin.token).put(`/api/v1/users/${staff.id}/roles`).send({ roleIds: [] }).expect(200)
      expect((await me(staff.token)).permissions).toEqual({})

      const audit = await api(app, admin.token)
        .get(`/api/v1/rbac/audit?targetType=role&targetId=${roleId}`)
        .expect(200)
      const actions = audit.body.data.map((a: { action: string }) => a.action)
      expect(actions).toEqual(expect.arrayContaining(['role.create', 'role.grants', 'user.roles']))
      expect(audit.body.data[0].actor_id).toBe(admin.id)
    })

    it('đổi tên / mô tả, tên trùng (không phân biệt hoa thường) → 409, nhân bản', async () => {
      const admin = await makeUser(prisma, { admin: true })
      const a = await api(app, admin.token).post('/api/v1/roles').send({ name: 'Nhóm A', grants: {} }).expect(201)
      await api(app, admin.token).post('/api/v1/roles').send({ name: 'nhóm a', grants: {} }).expect(409)

      const renamed = await api(app, admin.token)
        .patch(`/api/v1/roles/${a.body.id}`)
        .send({ name: 'Nhóm B', description: 'mô tả' })
        .expect(200)
      expect(renamed.body).toMatchObject({ name: 'Nhóm B', description: 'mô tả' })

      const clone = await api(app, admin.token).post(`/api/v1/roles/${a.body.id}/clone`).expect(201)
      expect(clone.body.name).toBe('Nhóm B (bản sao)')
    })

    it('grants sai: khoá lạ / thiếu scope / scope lạ → 400', async () => {
      const admin = await makeUser(prisma, { admin: true })
      const post = (grants: Record<string, unknown>) =>
        api(app, admin.token).post('/api/v1/roles').send({ name: `r${Math.random()}`, grants })
      await post({ 'x.y': 'all' }).expect(400)
      await post({ 'contacts.view': null }).expect(400)
      await post({ 'contacts.view': 'everyone' }).expect(400)
      await post({ 'roles.manage': 'all' }).expect(400)
    })
  })

  describe('quyền truy cập endpoint', () => {
    it('không có roles.manage → 403 trên ghi; GET /roles mở cho users.manage / kanban.boards', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/roles').expect(403)
      await api(app, u.token).post('/api/v1/roles').send({ name: 'x1', grants: {} }).expect(403)
      await api(app, u.token).get('/api/v1/rbac/audit').expect(403)

      const k = await makeUser(prisma, { grants: { 'kanban.boards': true } })
      await api(app, k.token).get('/api/v1/roles').expect(200)
      await api(app, k.token).get('/api/v1/roles/1').expect(403)
      const m = await makeUser(prisma, { grants: { 'users.manage': 'own' } })
      await api(app, m.token).get('/api/v1/roles').expect(200)
    })
  })

  describe('sửa quyền vai trò: quyền mới ⊆ quyền người sửa', () => {
    it('vượt scope / vượt khoá → 403; trong phạm vi → 201', async () => {
      const mgr = await makeUser(prisma, { grants: { 'roles.manage': true, 'contacts.view': 'team' } })
      const create = (grants: Record<string, unknown>, name: string) =>
        api(app, mgr.token).post('/api/v1/roles').send({ name, grants })

      await create({ 'contacts.view': 'all' }, 'vuot-scope').expect(403)
      await create({ 'contacts.create': null }, 'vuot-khoa').expect(403)
      const ok = await create({ 'contacts.view': 'own' }, 'trong-pham-vi').expect(201)

      // sửa grants vai trò đó cũng bị chặn tương tự
      await api(app, mgr.token)
        .put(`/api/v1/roles/${ok.body.id}/grants`)
        .send({ grants: { 'contacts.view': 'subtree' } })
        .expect(403)
    })

    it('KHÔNG sửa/xoá được vai trò "to" hơn mình, KHÔNG nhân bản vai trò vượt quyền', async () => {
      const admin = await makeUser(prisma, { admin: true })
      const big = await api(app, admin.token)
        .post('/api/v1/roles')
        .send({ name: 'To', grants: { 'contacts.view': 'all', 'contacts.create': null } })
        .expect(201)
      const mgr = await makeUser(prisma, { grants: { 'roles.manage': true, 'contacts.view': 'team' } })

      await api(app, mgr.token).patch(`/api/v1/roles/${big.body.id}`).send({ name: 'Doi ten' }).expect(403)
      await api(app, mgr.token).put(`/api/v1/roles/${big.body.id}/grants`).send({ grants: {} }).expect(403)
      await api(app, mgr.token).delete(`/api/v1/roles/${big.body.id}`).expect(403)
      await api(app, mgr.token).post(`/api/v1/roles/${big.body.id}/clone`).expect(403)
    })

    it('vai trò hệ thống: không sửa quyền / đổi tên (kể cả Quản trị), xoá → 409', async () => {
      const admin = await makeUser(prisma, { admin: true })
      const sys = await prisma.role.findFirstOrThrow({ where: { is_system: true } })

      await api(app, admin.token).put(`/api/v1/roles/${sys.id}/grants`).send({ grants: {} }).expect(403)
      await api(app, admin.token).patch(`/api/v1/roles/${sys.id}`).send({ name: 'Khac' }).expect(403)
      await api(app, admin.token).delete(`/api/v1/roles/${sys.id}`).expect(409)
      const detail = await api(app, admin.token).get(`/api/v1/roles/${sys.id}`).expect(200)
      expect(detail.body.grants['contacts.view']).toBe('all')
    })

    it('xoá vai trò còn người giữ → 409; hết người → xoá được', async () => {
      const admin = await makeUser(prisma, { admin: true })
      const u = await makeUser(prisma, { grants: {} })
      const r = await api(app, admin.token).post('/api/v1/roles').send({ name: 'Tam', grants: {} }).expect(201)
      await api(app, admin.token).put(`/api/v1/users/${u.id}/roles`).send({ roleIds: [r.body.id] }).expect(200)

      await api(app, admin.token).delete(`/api/v1/roles/${r.body.id}`).expect(409)
      await api(app, admin.token).put(`/api/v1/users/${u.id}/roles`).send({ roleIds: [] }).expect(200)
      await api(app, admin.token).delete(`/api/v1/roles/${r.body.id}`).expect(200)
      await api(app, admin.token).get(`/api/v1/roles/${r.body.id}`).expect(404)
    })
  })

  describe('gán vai trò cho người', () => {
    async function setup() {
      const admin = await makeUser(prisma, { admin: true })
      const mgr = await makeUser(prisma, {
        grants: { 'users.manage': 'all', 'roles.manage': true, 'contacts.view': 'team' },
      })
      const small = await api(app, admin.token)
        .post('/api/v1/roles')
        .send({ name: 'Nho', grants: { 'contacts.view': 'own' } })
        .expect(201)
      const big = await api(app, admin.token)
        .post('/api/v1/roles')
        .send({ name: 'Lon', grants: { 'contacts.view': 'all', 'contacts.create': null } })
        .expect(201)
      const target = await makeUser(prisma, { grants: {} })
      return { admin, mgr, small: small.body.id as number, big: big.body.id as number, target }
    }
    const put = (token: string, userId: number, roleIds: number[]) =>
      api(app, token).put(`/api/v1/users/${userId}/roles`).send({ roleIds })

    it('luật 2: gán vai trò quyền ⊆ mình → 200; quyền vượt → 403', async () => {
      const s = await setup()
      await put(s.mgr.token, s.target.id, [s.small]).expect(200)
      await put(s.mgr.token, s.target.id, [s.big]).expect(403)
      expect((await me(s.target.token)).permissions).toEqual({ 'contacts.view': 'own' })
    })

    it('GET /roles/:id/members: email chỉ hiện với người trong phạm vi users.view (roles.manage không đủ)', async () => {
      const s = await setup()
      await put(s.admin.token, s.target.id, [s.small]).expect(200)
      const noView = await api(app, s.mgr.token).get(`/api/v1/roles/${s.small}/members`).expect(200)
      expect(noView.body).toHaveLength(1)
      expect(noView.body[0]).toMatchObject({ id: s.target.id, email: null })
      const full = await api(app, s.admin.token).get(`/api/v1/roles/${s.small}/members`).expect(200)
      expect(full.body[0].email).toEqual(expect.any(String))
    })

    it('luật 2: người thường không gán / không gỡ vai trò Quản trị', async () => {
      const s = await setup()
      const sys = await prisma.role.findFirstOrThrow({ where: { is_system: true } })
      await put(s.mgr.token, s.target.id, [sys.id]).expect(403)

      const otherAdmin = await makeUser(prisma, { admin: true })
      await put(s.mgr.token, otherAdmin.id, [s.small]).expect(403)
      expect((await me(otherAdmin.token)).isAdmin).toBe(true)
    })

    it('luật 2: người thường KHÔNG sửa được vai trò của người "to" hơn mình', async () => {
      const s = await setup()
      await put(s.admin.token, s.target.id, [s.big]).expect(200)
      await put(s.mgr.token, s.target.id, [s.small]).expect(403)
      expect((await me(s.target.token)).permissions['contacts.view']).toBe('all')
    })

    it('luật 4: người thường không tự đổi vai trò của chính mình', async () => {
      const s = await setup()
      await put(s.mgr.token, s.mgr.id, [s.small]).expect(403)
      await put(s.mgr.token, s.mgr.id, []).expect(403)
    })

    it('users.manage scope own: người ngoài phạm vi → 404 (không phải 403)', async () => {
      const s = await setup()
      const narrow = await makeUser(prisma, { grants: { 'users.manage': 'own' } })
      await put(narrow.token, s.target.id, [s.small]).expect(404)
    })

    it('roleIds: id không tồn tại → 404; trùng / không phải số → 400; user không tồn tại → 404', async () => {
      const s = await setup()
      await put(s.admin.token, s.target.id, [999999]).expect(404)
      await put(s.admin.token, s.target.id, [s.small, s.small]).expect(400)
      await api(app, s.admin.token).put(`/api/v1/users/${s.target.id}/roles`).send({ roleIds: ['a'] }).expect(400)
      await api(app, s.admin.token).put(`/api/v1/users/${s.target.id}/roles`).send({}).expect(400)
      await put(s.admin.token, 987654, [s.small]).expect(404)
    })

    it('Quản trị gán nhiều vai trò → quyền cộng dồn, scope rộng nhất', async () => {
      const s = await setup()
      await put(s.admin.token, s.target.id, [s.small, s.big]).expect(200)
      expect((await me(s.target.token)).permissions).toEqual({ 'contacts.view': 'all', 'contacts.create': true })
    })
  })

  describe('Quản trị cuối cùng', () => {
    it('Quản trị duy nhất tự gỡ vai trò Quản trị → 409', async () => {
      const admin = await makeUser(prisma, { admin: true })
      await api(app, admin.token).put(`/api/v1/users/${admin.id}/roles`).send({ roleIds: [] }).expect(409)
      expect((await me(admin.token)).isAdmin).toBe(true)
    })

    it('còn Quản trị khác ĐANG HOẠT ĐỘNG → gỡ được; Quản trị khác bị khoá không tính', async () => {
      const a = await makeUser(prisma, { admin: true })
      const b = await makeUser(prisma, { admin: true })
      await prisma.user.update({ where: { id: b.id }, data: { status: 'locked' } })
      await api(app, a.token).put(`/api/v1/users/${a.id}/roles`).send({ roleIds: [] }).expect(409)

      await prisma.user.update({ where: { id: b.id }, data: { status: 'active' } })
      await api(app, a.token).put(`/api/v1/users/${a.id}/roles`).send({ roleIds: [] }).expect(200)
      // b giờ là Quản trị cuối cùng
      await api(app, b.token).put(`/api/v1/users/${b.id}/roles`).send({ roleIds: [] }).expect(409)
    })

    it('người thường không khoá / xoá / reset mật khẩu Quản trị → 403', async () => {
      const lone = await makeUser(prisma, { admin: true })
      const actor = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      await api(app, actor.token).delete(`/api/v1/users/${lone.id}`).expect(403)
      await api(app, actor.token).delete(`/api/v1/users/${lone.id}/permanent`).expect(403)
      await api(app, actor.token).patch(`/api/v1/users/${lone.id}`).send({ status: 'locked' }).expect(403)
      await api(app, actor.token)
        .patch(`/api/v1/users/${lone.id}/reset-password`)
        .send({ password: 'matkhau-moi-123' }) // gitleaks:allow
        .expect(403)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: lone.id } })).status).toBe('active')
    })
  })

  describe('nhật ký', () => {
    it('GET /rbac/audit: phân trang, mới nhất trước, có tên người sửa', async () => {
      const admin = await makeUser(prisma, { admin: true })
      for (const n of ['L1', 'L2', 'L3']) {
        await api(app, admin.token).post('/api/v1/roles').send({ name: n, grants: {} }).expect(201)
      }
      const res = await api(app, admin.token).get('/api/v1/rbac/audit?page=1&limit=2').expect(200)
      expect(res.body.total).toBe(3)
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data[0].after.name).toBe('L3')
      const self = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })
      expect(res.body.data[0].actor_name).toBe(self.full_name)
      await api(app, admin.token).get('/api/v1/rbac/audit?limit=1000').expect(400)
    })
  })
})
