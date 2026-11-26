import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConflictException, ForbiddenException, GoneException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import {
  CompanyRef,
  DEFAULT_COMPANY,
  PrismaService,
  companyIdForEmail,
  createPrismaService,
  ensurePlatform,
  getBaseClient,
  installSyncTriggers,
  provisionCompany,
  runInTenantScope,
  runWithCompany,
  setFallbackCompany,
} from '@trinity/prisma'
import {
  ActiveSessionService,
  TokenBlacklistService,
  createInvitation,
  hashInviteToken,
  listInvitations,
  revokeInvitation,
  type AuthUser,
} from '@trinity/rbac-nest'
import { AuthService } from './auth.service'
import { AuditLogService } from './services/audit-log.service'
import { RateLimiterService } from './services/rate-limiter.service'

/**
 * Mời nhân viên bằng link trên Postgres THẬT, chế độ nhiều công ty: tạo lời mời → xem → nhận → user nằm đúng công ty,
 * công ty khác không thấy; hết chỗ theo gói bị chặn; email của công ty khác bị chặn; link dùng một lần / huỷ / hết hạn.
 * Tự bỏ qua khi thiếu TEST_DATABASE_URL (CI: job "Tests with Postgres").
 */
const PG_URL = process.env.TEST_DATABASE_URL ?? ''
const isLocal = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(PG_URL).hostname)
  } catch {
    return false
  }
})()
const describePg = PG_URL ? describe : describe.skip

const adminOf = (id: number): AuthUser => ({ userId: id, email: `admin${id}@t`, isAdmin: true, grants: { 'users.manage': 'all' } })

describePg('mời nhân viên bằng link (Postgres, nhiều công ty)', () => {
  let db: PrismaService
  let auth: AuthService
  let A: CompanyRef
  let B: CompanyRef
  let ownerA: number
  let staffRoleA: number
  const prevMt = process.env.MULTI_TENANT
  const stamp = Date.now()
  const emailA = `chu-a-${stamp}@example.com`
  const emailB = `chu-b-${stamp}@example.com`

  /** Một request công khai: phạm vi trống + fallback công ty 1, đúng như guard của route @Public(). */
  const publicRequest = <T,>(fn: () => Promise<T>): Promise<T> =>
    runInTenantScope(() => {
      setFallbackCompany(DEFAULT_COMPANY)
      return fn()
    })

  async function dropTenantObjects(): Promise<void> {
    const base = getBaseClient()
    const schemas = await base.$queryRawUnsafe<Array<{ nspname: string }>>(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^c_[0-9]+$'`)
    for (const s of schemas) await base.$executeRawUnsafe(`DROP SCHEMA "${s.nspname}" CASCADE`)
    for (const [trg, table] of [
      ['trinity_platform_sync_login', 'users'],
      ['trinity_platform_sync_facebook_page', 'facebook_pages'],
      ['trinity_platform_sync_zalo_oa', 'zalo_oa_connections'],
    ]) {
      await base.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg} ON public.${table}`)
    }
    await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS platform CASCADE`)
  }

  beforeAll(async () => {
    if (!isLocal) throw new Error('TEST_DATABASE_URL must point at a local/CI Postgres')
    process.env.DATABASE_URL = PG_URL
    process.env.MULTI_TENANT = 'true'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
    db = createPrismaService()
    await dropTenantObjects()
    await getBaseClient().$executeRawUnsafe('TRUNCATE TABLE public.users RESTART IDENTITY CASCADE')
    await ensurePlatform()
    const a = await provisionCompany({ companyName: 'Công ty A', adminEmail: emailA, adminPassword: 'password-a-123', adminName: 'Chủ A' })
    A = a.company
    ownerA = a.adminUserId
    B = (await provisionCompany({ companyName: 'Công ty B', adminEmail: emailB, adminPassword: 'password-b-123', adminName: 'Chủ B' })).company
    staffRoleA = await runWithCompany(A, async () => {
      const role = await db.role.create({ data: { name: 'Nhân viên', is_system: false } })
      await db.rolePermission.create({ data: { role_id: role.id, permission: 'contacts.view', scope: 'own' } })
      return role.id
    })
    auth = new AuthService(
      db,
      new JwtService({ secret: process.env.JWT_SECRET }),
      new RateLimiterService(),
      new TokenBlacklistService(),
      new AuditLogService(db),
      new ActiveSessionService(),
      { grantsFor: async () => ({ grants: {}, isAdmin: false }) } as never,
    )
  }, 180_000)

  afterAll(async () => {
    try {
      await dropTenantObjects()
    } finally {
      await db.$disconnect()
      process.env.MULTI_TENANT = prevMt
    }
  })

  it('công ty ≥ 2 không còn trigger "một user" (dựng mới và bản cũ để lại)', async () => {
    const base = getBaseClient()
    const has = async (schema: string) =>
      (await base.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace s ON s.oid = r.relnamespace
          WHERE s.nspname = $1 AND r.relname = 'users' AND t.tgname = 'trinity_single_user'`,
        schema,
      ))[0].n
    expect(await has(A.schema)).toBe(0)
    // Bản cài cũ: dựng lại trigger kiểu cũ rồi cho cả hai đường gỡ chạy.
    const mk = async () => {
      await base.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${B.schema}".trinity_single_user() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$`)
      await base.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER trinity_single_user AFTER INSERT ON "${B.schema}".users DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "${B.schema}".trinity_single_user()`)
    }
    await mk()
    expect(await has(B.schema)).toBe(1)
    await installSyncTriggers(base, B.id, B.schema)
    expect(await has(B.schema)).toBe(0)
    await mk()
    // Migration 0019 chạy với search_path của schema công ty (migrate:companies).
    const sql = readFileSync(join(__dirname, '../../../../packages/prisma/prisma/migrations/0019_user_invitations/migration.sql'), 'utf8')
    const drops = sql.split('\n').filter((l) => /^DROP (TRIGGER|FUNCTION)/.test(l))
    expect(drops).toHaveLength(2)
    await base.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${B.schema}"`)
      for (const d of drops) await tx.$executeRawUnsafe(d)
    })
    expect(await has(B.schema)).toBe(0)
  })

  it('tạo lời mời → xem → nhận: user vào đúng công ty, đăng nhập luôn, công ty khác không thấy', async () => {
    const email = `nv1-${stamp}@example.com`
    const inv = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }))
    expect(inv.token.startsWith(`c${A.id}.`)).toBe(true)
    expect(inv.path).toBe(`/invite/${inv.token}`)
    const stored = await runWithCompany(A, () => db.userInvitation.findFirstOrThrow({ where: { id: inv.id } }))
    expect(stored.token_hash).toBe(hashInviteToken(inv.token))
    expect(JSON.stringify(stored)).not.toContain(inv.token)
    expect((stored.expires_at.getTime() - stored.created_at.getTime()) / 86_400_000).toBeCloseTo(7, 1)

    const preview = await publicRequest(() => auth.previewInvitation(inv.token))
    expect(preview).toMatchObject({ company_name: 'Công ty A', email, role_name: 'Nhân viên' })

    const res = await publicRequest(() => auth.acceptInvitation({ token: inv.token, full_name: 'Nhân viên Một', password: 'matkhau-moi-1' }, '1.2.3.4'))
    expect(res.access_token).toBeTruthy()
    expect(res.user.email).toBe(email)
    expect(res.company).toMatchObject({ id: A.id, name: 'Công ty A' })

    const inA = await runWithCompany(A, () => db.user.findFirstOrThrow({ where: { email }, include: { user_roles: true, employee: true } }))
    expect(inA.user_roles.map((r) => r.role_id)).toEqual([staffRoleA])
    expect(inA.employee).not.toBeNull()
    expect(await runWithCompany(A, () => db.user.count())).toBe(2)
    expect(await runWithCompany(B, () => db.user.count({ where: { email } }))).toBe(0)
    expect(await runWithCompany(B, () => db.user.count())).toBe(1)
    expect(await companyIdForEmail(email)).toBe(A.id)
    expect(await runWithCompany(A, () => db.userInvitation.findFirstOrThrow({ where: { id: inv.id } }))).toMatchObject({ accepted_user_id: inA.id })

    // Dùng một lần: link đó hết tác dụng, xem cũng không được.
    await expect(publicRequest(() => auth.acceptInvitation({ token: inv.token, full_name: 'Kẻ nhận lại', password: 'matkhau-moi-1' }, null))).rejects.toBeInstanceOf(GoneException)
    await expect(publicRequest(() => auth.previewInvitation(inv.token))).rejects.toBeInstanceOf(GoneException)
    // Nhân viên đăng nhập được bằng mật khẩu vừa đặt (login chọn công ty theo email).
    const login = await publicRequest(() => auth.login({ email, password: 'matkhau-moi-1' } as never, null))
    expect(login.company).toMatchObject({ id: A.id })
  })

  it('đổi tiền tố sang công ty khác không mở được lời mời của công ty này', async () => {
    const inv = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email: `nv2-${stamp}@example.com`, roleId: staffRoleA }))
    const forged = inv.token.replace(`c${A.id}.`, `c${B.id}.`)
    await expect(publicRequest(() => auth.previewInvitation(forged))).rejects.toBeInstanceOf(GoneException)
    await expect(publicRequest(() => auth.acceptInvitation({ token: forged, full_name: 'Giả mạo', password: 'matkhau-moi-1' }, null))).rejects.toBeInstanceOf(GoneException)
    expect(await runWithCompany(B, () => db.user.count())).toBe(1)
    await runWithCompany(A, () => revokeInvitation(db, inv.id))
  })

  it('email đã thuộc công ty khác bị chặn, nói rõ; email đã có trong công ty cũng vậy', async () => {
    await expect(runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email: emailB.toUpperCase(), roleId: staffRoleA }))).rejects.toThrow(/công ty khác/)
    await expect(runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email: emailA, roleId: staffRoleA }))).rejects.toThrow(/đã có tài khoản/)
  })

  it('mời lại cùng email thay link cũ; huỷ và hết hạn đều làm link chết', async () => {
    const email = `nv3-${stamp}@example.com`
    const first = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }))
    const second = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }))
    await expect(publicRequest(() => auth.previewInvitation(first.token))).rejects.toBeInstanceOf(GoneException)
    await expect(publicRequest(() => auth.previewInvitation(second.token))).resolves.toMatchObject({ email })
    const pending = await runWithCompany(A, () => listInvitations(db, { pendingOnly: true }))
    expect(pending.filter((p) => p.email === email)).toHaveLength(1)

    await runWithCompany(A, () => revokeInvitation(db, second.id))
    await expect(publicRequest(() => auth.previewInvitation(second.token))).rejects.toBeInstanceOf(GoneException)
    await expect(runWithCompany(A, () => revokeInvitation(db, second.id))).rejects.toBeInstanceOf(ConflictException)

    const third = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }))
    await runWithCompany(A, () => db.userInvitation.update({ where: { id: third.id }, data: { expires_at: new Date(Date.now() - 1000) } }))
    await expect(publicRequest(() => auth.acceptInvitation({ token: third.token, full_name: 'Quá hạn', password: 'matkhau-moi-1' }, null))).rejects.toBeInstanceOf(GoneException)
    expect((await runWithCompany(A, () => listInvitations(db, { pendingOnly: false }))).find((p) => p.id === third.id)?.status).toBe('expired')
  })

  it('người không phải Quản trị không mời được vào vai trò Quản trị hay vai trò to hơn mình', async () => {
    const adminRole = await runWithCompany(A, () => db.role.findFirstOrThrow({ where: { is_system: true } }))
    const manager: AuthUser = { userId: 999, email: 'm@t', isAdmin: false, grants: { 'users.manage': 'all', 'contacts.view': 'all' } }
    const email = `nv4-${stamp}@example.com`
    await expect(runWithCompany(A, () => createInvitation(db, manager, { email, roleId: adminRole.id }))).rejects.toBeInstanceOf(ForbiddenException)
    const bigRole = await runWithCompany(A, async () => {
      const r = await db.role.create({ data: { name: 'Toàn quyền khách', is_system: false } })
      await db.rolePermission.create({ data: { role_id: r.id, permission: 'settings.features', scope: null } })
      return r.id
    })
    await expect(runWithCompany(A, () => createInvitation(db, manager, { email, roleId: bigRole }))).rejects.toBeInstanceOf(ForbiddenException)
    await expect(runWithCompany(A, () => createInvitation(db, manager, { email, roleId: staffRoleA }))).resolves.toMatchObject({ status: 'pending' })
  })

  it('vượt maxUsers của gói: không tạo được lời mời, báo số người; lời mời đang chờ cũng giữ chỗ; nhận khi đã đủ thì lùi lại', async () => {
    // Công ty B: gói Kết nối = tối đa 10 người. Chủ + 7 user = 8.
    await runWithCompany(B, async () => {
      await db.setting.upsert({ where: { key: 'org_plan' }, update: { value: 'ket_noi' }, create: { key: 'org_plan', value: 'ket_noi' } })
      const role = await db.role.create({ data: { name: 'Nhân viên', is_system: false } })
      for (let i = 0; i < 7; i++) {
        const u = await db.user.create({ data: { email: `b-fill-${i}-${stamp}@example.com`, password_hash: 'x', full_name: `Fill ${i}`, status: 'active' } })
        await db.userRole.create({ data: { user_id: u.id, role_id: role.id } })
      }
    })
    const role = await runWithCompany(B, () => db.role.findFirstOrThrow({ where: { name: 'Nhân viên' } }))
    const owner = (await runWithCompany(B, () => db.user.findFirstOrThrow({ where: { email: emailB } }))).id
    const i1 = await runWithCompany(B, () => createInvitation(db, adminOf(owner), { email: `b-i1-${stamp}@example.com`, roleId: role.id }))
    const i2 = await runWithCompany(B, () => createInvitation(db, adminOf(owner), { email: `b-i2-${stamp}@example.com`, roleId: role.id }))
    // 8 người + 2 lời mời đang chờ = 10 → lời mời thứ ba bị chặn.
    const err = await runWithCompany(B, () => createInvitation(db, adminOf(owner), { email: `b-i3-${stamp}@example.com`, roleId: role.id })).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictException)
    expect(err.message).toBe('Gói hiện tại tối đa 10 người, liên hệ để nâng gói.')
    // Huỷ một lời mời → chỗ trống lại.
    await runWithCompany(B, () => revokeInvitation(db, i2.id))
    const i3 = await runWithCompany(B, () => createInvitation(db, adminOf(owner), { email: `b-i3-${stamp}@example.com`, roleId: role.id }))
    // Chủ công ty thêm trực tiếp 1 người nữa (9), nhận i1 (10) được; nhận i3 khi đã đủ 10 thì bị chặn và link còn nguyên.
    await runWithCompany(B, () => db.user.create({ data: { email: `b-direct-${stamp}@example.com`, password_hash: 'x', full_name: 'Direct', status: 'active' } }))
    await expect(publicRequest(() => auth.acceptInvitation({ token: i1.token, full_name: 'Người mười', password: 'matkhau-moi-1' }, null))).resolves.toMatchObject({ company: { id: B.id } })
    const full = await publicRequest(() => auth.acceptInvitation({ token: i3.token, full_name: 'Người mười một', password: 'matkhau-moi-1' }, null)).catch((e) => e)
    expect(full).toBeInstanceOf(ConflictException)
    expect(full.message).toBe('Gói hiện tại tối đa 10 người, liên hệ để nâng gói.')
    expect(await runWithCompany(B, () => db.user.count({ where: { email: `b-i3-${stamp}@example.com` } }))).toBe(0)
    await expect(publicRequest(() => auth.previewInvitation(i3.token))).resolves.toMatchObject({ company_name: 'Công ty B' })
  })

  it('gói tuỳ biến (custom) không giới hạn số lời mời', async () => {
    await runWithCompany(A, () => db.setting.upsert({ where: { key: 'org_plan' }, update: { value: 'custom' }, create: { key: 'org_plan', value: 'custom' } }))
    for (let i = 0; i < 12; i++) {
      await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email: `many-${i}-${stamp}@example.com`, roleId: staffRoleA }))
    }
    expect((await runWithCompany(A, () => listInvitations(db, { pendingOnly: true }))).length).toBeGreaterThanOrEqual(12)
  })
})
