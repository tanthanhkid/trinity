import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { randomBytes } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Vòng đời phiên đăng nhập trên Postgres thật: đăng xuất thu hồi đúng phiên (kể cả sau khi đăng nhập lại), reset mật khẩu
 * thu hồi mọi phiên, khoá không ghi đè email và mở khoá dùng lại ngay, xoá nhân viên khoá tài khoản liên kết.
 */
describe('RBAC E2E — vòng đời phiên đăng nhập', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  const rand = () => `Aa1-${randomBytes(9).toString('hex')}`
  const PASSWORD = rand()
  const NEW_PASSWORD = rand()

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)
  afterAll(async () => { await close() })
  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM revoked_sessions`)
    await prisma.$executeRawUnsafe(`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await resetDb(prisma)
  })

  const makeLoginUser = async () => {
    const u = await makeUser(prisma, { grants: {} })
    const row = await prisma.user.update({ where: { id: u.id }, data: { password_hash: await bcrypt.hash(PASSWORD, 4) }, select: { email: true } })
    return { ...u, email: row.email }
  }
  const login = async (email: string) => (await api(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body as { access_token: string; refresh_token: string }
  const refresh = (rt: string) => api(app).post('/api/v1/auth/refresh').send({ refresh_token: rt })
  const sleepToNextSecond = () => new Promise((r) => setTimeout(r, 1100)) // iat của JWT có độ phân giải giây

  it('đăng xuất thu hồi refresh token của CHÍNH phiên đó, kể cả sau khi đăng nhập lại; phiên khác không bị ảnh hưởng', async () => {
    const u = await makeLoginUser()
    const a = await login(u.email)
    const b = await login(u.email)
    await refresh(a.refresh_token).expect(200)

    await api(app, a.access_token).post('/api/v1/auth/logout').send({ refresh_token: a.refresh_token }).expect(200)
    expect(await prisma.revokedSession.count()).toBe(1)

    await refresh(a.refresh_token).expect(401)
    // Đăng nhập lại (xoá blacklist trong RAM) KHÔNG làm phiên A sống lại.
    const c = await login(u.email)
    await refresh(a.refresh_token).expect(401)
    await refresh(b.refresh_token).expect(200)
    await refresh(c.refresh_token).expect(200)
  })

  it('refresh xoay vòng giữ cùng id phiên: đăng xuất bằng token mới nhất vẫn chặn token cũ của phiên', async () => {
    const u = await makeLoginUser()
    const a = await login(u.email)
    const rotated = (await refresh(a.refresh_token).expect(200)).body as { access_token: string; refresh_token: string }
    await api(app, rotated.access_token).post('/api/v1/auth/logout').send({ refresh_token: rotated.refresh_token }).expect(200)
    await refresh(a.refresh_token).expect(401)
    await refresh(rotated.refresh_token).expect(401)
  })

  it('đổi mật khẩu thu hồi MỌI refresh token cũ; phiên đăng nhập sau đó hoạt động', async () => {
    const u = await makeLoginUser()
    const a = await login(u.email)
    const b = await login(u.email)
    await sleepToNextSecond()
    await api(app, a.access_token).patch('/api/v1/auth/password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200)
    await refresh(a.refresh_token).expect(401)
    await refresh(b.refresh_token).expect(401)
    await sleepToNextSecond()
    const fresh = (await api(app).post('/api/v1/auth/login').send({ email: u.email, password: NEW_PASSWORD }).expect(200)).body
    await refresh(fresh.refresh_token).expect(200)
  })

  it('admin reset mật khẩu thu hồi mọi refresh token cũ của user', async () => {
    const u = await makeLoginUser()
    const a = await login(u.email)
    const admin = await makeUser(prisma, { admin: true })
    await sleepToNextSecond()
    await api(app, admin.token).patch(`/api/v1/users/${u.id}/reset-password`).send({ password: rand() }).expect(200)
    await refresh(a.refresh_token).expect(401)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).tokens_valid_after).not.toBeNull()
  })

  it('khoá không ghi đè email, thu hồi token cũ; mở khoá dùng lại được ngay (đăng nhập bằng email cũ)', async () => {
    const u = await makeLoginUser()
    const a = await login(u.email)
    const admin = await makeUser(prisma, { admin: true })
    await sleepToNextSecond()
    await api(app, admin.token).patch(`/api/v1/users/${u.id}`).send({ status: 'locked' }).expect(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email)
    await refresh(a.refresh_token).expect(401)
    await api(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(401)

    await api(app, admin.token).patch(`/api/v1/users/${u.id}`).send({ status: 'active' }).expect(200)
    await sleepToNextSecond()
    const again = await login(u.email)
    await refresh(again.refresh_token).expect(200)
    // Token cấp TRƯỚC lúc khoá không sống lại sau khi mở khoá.
    await refresh(a.refresh_token).expect(401)
  })

  it('xoá (soft-delete) nhân viên khoá tài khoản đăng nhập liên kết và thu hồi phiên; email giữ nguyên', async () => {
    const u = await makeLoginUser()
    const a = await login(u.email)
    const emp = await prisma.employee.create({ data: { user_id: u.id, position: 'sales' }, select: { id: true } })
    const hr = await makeUser(prisma, { grants: { 'employees.manage': 'all', 'employees.view': 'all' } })
    await sleepToNextSecond()
    await api(app, hr.token).delete(`/api/v1/management/employees/${emp.id}`).expect(200)

    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(user).toMatchObject({ status: 'locked', email: u.email, deleted_at: null })
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).deleted_at).not.toBeNull()
    await refresh(a.refresh_token).expect(401)
    await api(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(401)
  })
})
