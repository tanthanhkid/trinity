import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common'
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
  assertUserSlotAvailable,
  createInvitation,
  revokePendingInvitationsBy,
  revokePendingInvitationsForEmail,
  revokePendingInvitationsForRole,
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
  /** Người mời đã mất quyền users.manage (giả lập qua PermissionService). */
  const noManage = new Set<number>()
  let ipSeq = 0
  /** Mỗi lần nhận một IP khác để bộ giới hạn tốc độ (theo IP) không chặn các ca không liên quan. */
  const ip = () => `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
  /** Quyền giả lập theo người mời (thay cho PermissionService). */
  const grantsOverride = new Map<number, { grants: Record<string, unknown>; isAdmin: boolean }>()
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
      {
        grantsFor: async (id: number) =>
          grantsOverride.get(id) ?? (noManage.has(id) ? { grants: {}, isAdmin: false } : { grants: { 'users.manage': 'all' }, isAdmin: true }),
      } as never,
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
    // Thêm người trực tiếp (tạo user / mở khoá / nhân viên) cũng phải thấy hai lời mời đang chờ: 8 + 2 = 10 → chặn.
    const direct = await runWithCompany(B, () => db.$transaction((tx) => assertUserSlotAvailable(tx))).catch((e) => e)
    expect(direct).toBeInstanceOf(ConflictException)
    // Một đường ghi thẳng bỏ qua kiểm (mô phỏng dữ liệu cũ) đẩy lên 9 người + 2 lời mời: nhận i1 bị chặn, link còn nguyên.
    await runWithCompany(B, () => db.user.create({ data: { email: `b-direct-${stamp}@example.com`, password_hash: 'x', full_name: 'Direct', status: 'active' } }))
    const full = await publicRequest(() => auth.acceptInvitation({ token: i1.token, full_name: 'Người mười', password: 'matkhau-moi-1' }, null)).catch((e) => e)
    expect(full).toBeInstanceOf(ConflictException)
    expect(full.message).toBe('Gói hiện tại tối đa 10 người, liên hệ để nâng gói.')
    expect(await runWithCompany(B, () => db.user.count({ where: { email: `b-i1-${stamp}@example.com` } }))).toBe(0)
    await expect(publicRequest(() => auth.previewInvitation(i1.token))).resolves.toMatchObject({ company_name: 'Công ty B' })
    // Huỷ i3 → còn 9 người + 0 lời mời đang chờ khác → i1 nhận được.
    await runWithCompany(B, () => revokeInvitation(db, i3.id))
    await expect(publicRequest(() => auth.acceptInvitation({ token: i1.token, full_name: 'Người mười', password: 'matkhau-moi-1' }, null))).resolves.toMatchObject({ company: { id: B.id } })
    expect(await runWithCompany(B, () => db.user.count({ where: { status: 'active' } }))).toBe(10)
  })

  it('gói tuỳ biến (custom) không giới hạn số lời mời', async () => {
    await runWithCompany(A, () => db.setting.upsert({ where: { key: 'org_plan' }, update: { value: 'custom' }, create: { key: 'org_plan', value: 'custom' } }))
    for (let i = 0; i < 12; i++) {
      await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email: `many-${i}-${stamp}@example.com`, roleId: staffRoleA }))
    }
    expect((await runWithCompany(A, () => listInvitations(db, { pendingOnly: true }))).length).toBeGreaterThanOrEqual(12)
  })

  it('công ty đăng ký mới được ghi gói mặc định có giới hạn; thiếu dòng gói vẫn không thành "không giới hạn"', async () => {
    const plan = (c: CompanyRef) => runWithCompany(c, () => db.setting.findUnique({ where: { key: 'org_plan' } }))
    const c = (await provisionCompany({ companyName: 'Công ty C', adminEmail: `chu-c-${stamp}@example.com`, adminPassword: 'password-c-123', adminName: 'Chủ C' })).company
    expect((await plan(c))?.value).toBe('mac_dinh')
    // Xoá dòng gói (công ty cũ trước thay đổi này không có dòng): vẫn bị giới hạn 10 người như gói Mặc định, và vẫn bật được Fanpage / Zalo OA.
    await runWithCompany(c, async () => {
      await db.setting.delete({ where: { key: 'org_plan' } })
      for (let i = 0; i < 9; i++) await db.user.create({ data: { email: `c-fill-${i}-${stamp}@example.com`, password_hash: 'x', full_name: `F${i}`, status: 'active' } })
    })
    const err = await runWithCompany(c, () => db.$transaction((tx) => assertUserSlotAvailable(tx))).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictException)
    const { applyPlanToFeatures, resolveOrgFeatures, resolvePlanForCompany } = await import('@trinity/rbac')
    const features = applyPlanToFeatures(resolveOrgFeatures({}), resolvePlanForCompany(undefined, c.id))
    expect(features.facebook_page && features.zalo_oa && features.ai_briefing).toBe(true)
  })

  it('hai lượt thêm người đồng thời ở ngưỡng: chỉ một lượt qua (mọi đường dùng cùng khoá + cùng cách đếm, gồm lời mời đang chờ)', async () => {
    const c = (await provisionCompany({ companyName: 'Công ty D', adminEmail: `chu-d-${stamp}@example.com`, adminPassword: 'password-d-123', adminName: 'Chủ D' })).company
    await runWithCompany(c, async () => {
      for (let i = 0; i < 8; i++) await db.user.create({ data: { email: `d-fill-${i}-${stamp}@example.com`, password_hash: 'x', full_name: `F${i}`, status: 'active' } })
    })
    // 9 người: còn đúng một chỗ.
    const add = (n: number) =>
      runWithCompany(c, () =>
        db.$transaction(async (tx) => {
          await assertUserSlotAvailable(tx)
          await new Promise((r) => setTimeout(r, 150)) // giữ giao dịch mở để lượt kia phải chờ khoá
          await tx.user.create({ data: { email: `d-race-${n}-${stamp}@example.com`, password_hash: 'x', full_name: `R${n}`, status: 'active' } })
        }),
      )
    const results = await Promise.allSettled([add(1), add(2)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(await runWithCompany(c, () => db.user.count())).toBe(10)
    // Đủ 10: một lời mời mới cũng bị chặn, và huỷ chỗ trống rồi thì lượt thêm người trực tiếp thấy lời mời đang chờ.
    await runWithCompany(c, () => db.user.update({ where: { email: `d-race-1-${stamp}@example.com` }, data: { status: 'locked' } }).catch(() => db.user.update({ where: { email: `d-race-2-${stamp}@example.com` }, data: { status: 'locked' } })))
    const role = await runWithCompany(c, () => db.role.findFirstOrThrow())
    const owner = await runWithCompany(c, () => db.user.findFirstOrThrow({ where: { email: `chu-d-${stamp}@example.com` } }))
    await runWithCompany(c, () => createInvitation(db, adminOf(owner.id), { email: `d-inv-${stamp}@example.com`, roleId: role.id }))
    await expect(runWithCompany(c, () => db.$transaction((tx) => assertUserSlotAvailable(tx)))).rejects.toBeInstanceOf(ConflictException)
  })

  it('list/huỷ theo phạm vi users.manage: scope hẹp chỉ thấy/huỷ lời mời của người trong phạm vi', async () => {
    const role = staffRoleA
    const mine = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email: `sc-mine-${stamp}@example.com`, roleId: role }))
    const other = await runWithCompany(A, () => createInvitation(db, adminOf(4242), { email: `sc-other-${stamp}@example.com`, roleId: role }))
    const emails = async (owners: number[] | 'all') => (await runWithCompany(A, () => listInvitations(db, { pendingOnly: true, owners }))).map((i) => i.email)
    expect(await emails('all')).toEqual(expect.arrayContaining([mine.email, other.email]))
    const narrow = await emails([ownerA])
    expect(narrow).toContain(mine.email)
    expect(narrow).not.toContain(other.email)
    expect(await emails([])).toEqual([])
    await expect(runWithCompany(A, () => revokeInvitation(db, other.id, [ownerA]))).rejects.toBeInstanceOf(NotFoundException)
    await expect(runWithCompany(A, () => revokeInvitation(db, mine.id, [ownerA]))).resolves.toBeUndefined()
    await expect(runWithCompany(A, () => revokeInvitation(db, other.id, 'all'))).resolves.toBeUndefined()
  })

  it('tạo user/nhân viên trực tiếp cho email đang có lời mời chờ: huỷ lời mời trước khi kiểm chỗ (không tính hai chỗ)', async () => {
    const c = (await provisionCompany({ companyName: 'Công ty E', adminEmail: `chu-e-${stamp}@example.com`, adminPassword: 'password-e-123', adminName: 'Chủ E' })).company
    const owner = (await runWithCompany(c, () => db.user.findFirstOrThrow())).id
    const role = (await runWithCompany(c, () => db.role.findFirstOrThrow())).id
    await runWithCompany(c, async () => {
      for (let i = 0; i < 8; i++) await db.user.create({ data: { email: `e-fill-${i}-${stamp}@example.com`, password_hash: 'x', full_name: `F${i}`, status: 'active' } })
    })
    const email = `e-direct-${stamp}@example.com`
    await runWithCompany(c, () => createInvitation(db, adminOf(owner), { email, roleId: role })) // 9 người + 1 lời mời = 10
    // Không huỷ trước: đủ chỗ → bị chặn (đúng, vì lời mời giữ chỗ).
    await expect(runWithCompany(c, () => db.$transaction((tx) => assertUserSlotAvailable(tx)))).rejects.toBeInstanceOf(ConflictException)
    // Cùng transaction: huỷ lời mời của email đó rồi mới kiểm chỗ → qua, và chỉ tính một chỗ.
    await runWithCompany(c, () =>
      db.$transaction(async (tx) => {
        await revokePendingInvitationsForEmail(tx, email.toUpperCase())
        await assertUserSlotAvailable(tx)
        await tx.user.create({ data: { email, password_hash: 'x', full_name: 'Direct', status: 'active' } })
      }),
    )
    expect(await runWithCompany(c, () => db.userInvitation.count({ where: { email, accepted_at: null, revoked_at: null } }))).toBe(0)
    expect(await runWithCompany(c, () => db.user.count())).toBe(10)
  })

  it('mời lại cùng email: chỉ thay lời mời trong phạm vi của mình, của người ngoài phạm vi thì 409; chỉ một lời mời mở mỗi email (index)', async () => {
    const email = `rein-${stamp}@example.com`
    const first = await runWithCompany(A, () => createInvitation(db, adminOf(4242), { email, roleId: staffRoleA }))
    const err = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }, [ownerA])).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictException)
    await expect(publicRequest(() => auth.previewInvitation(first.token))).resolves.toMatchObject({ email }) // vẫn còn nguyên
    // Trong phạm vi (gồm người tạo 4242) thì thay được.
    const second = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }, [ownerA, 4242]))
    await expect(publicRequest(() => auth.previewInvitation(first.token))).rejects.toBeInstanceOf(GoneException)
    await expect(publicRequest(() => auth.previewInvitation(second.token))).resolves.toMatchObject({ email })
    // Chốt chặn ở DB: không chèn được lời mời mở thứ hai cho cùng email (kể cả viết hoa khác).
    await expect(
      runWithCompany(A, () =>
        db.userInvitation.create({ data: { email: email.toUpperCase(), role_id: staffRoleA, token_hash: `x-${stamp}`, expires_at: new Date(Date.now() + 1e6) } }),
      ),
    ).rejects.toThrow()
  })

  it('người mời mất quyền users.manage / bị khoá thì lời mời không nhận được (410); khoá người mời huỷ lời mời của họ', async () => {
    const inviterId = (await runWithCompany(A, () => db.user.create({ data: { email: `mgr-${stamp}@example.com`, password_hash: 'x', full_name: 'Quản lý', status: 'active' } }))).id
    const mk = (n: string) => runWithCompany(A, () => createInvitation(db, adminOf(inviterId), { email: `${n}-${stamp}@example.com`, roleId: staffRoleA }))
    const lost = await mk('lost')
    noManage.add(inviterId)
    await expect(publicRequest(() => auth.acceptInvitation({ token: lost.token, full_name: 'Mất quyền', password: 'matkhau-moi-1' }, null))).rejects.toBeInstanceOf(GoneException)
    noManage.delete(inviterId)
    await expect(publicRequest(() => auth.acceptInvitation({ token: lost.token, full_name: 'Có quyền lại', password: 'matkhau-moi-1' }, null))).resolves.toMatchObject({ company: { id: A.id } })
    const pending = await mk('pend')
    await runWithCompany(A, () => db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: inviterId }, data: { status: 'locked' } })
      await revokePendingInvitationsBy(tx, inviterId)
    }))
    await expect(publicRequest(() => auth.previewInvitation(pending.token))).rejects.toBeInstanceOf(GoneException)
    // Người mời bị khoá mà lời mời còn sót (không đi qua đường khoá) cũng không nhận được.
    await runWithCompany(A, () => db.user.update({ where: { id: inviterId }, data: { status: 'active' } }))
    const sneaky = await mk('sneaky')
    await runWithCompany(A, () => db.user.update({ where: { id: inviterId }, data: { status: 'locked' } }))
    await expect(publicRequest(() => auth.acceptInvitation({ token: sneaky.token, full_name: 'Sót', password: 'matkhau-moi-1' }, null))).rejects.toBeInstanceOf(GoneException)
  })

  it('nhận lời mời đồng thời với mời lại / huỷ cùng email: không deadlock, không lỗi 500, tối đa một người được tạo', async () => {
    for (let i = 0; i < 6; i++) {
      const email = `race-${i}-${stamp}@example.com`
      const inv = await runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA }))
      const results = await Promise.allSettled([
        publicRequest(() => auth.acceptInvitation({ token: inv.token, full_name: 'Đua một', password: 'matkhau-moi-1' }, ip())),
        runWithCompany(A, () => createInvitation(db, adminOf(ownerA), { email, roleId: staffRoleA })),
        runWithCompany(A, () => revokeInvitation(db, inv.id)),
      ])
      for (const r of results) {
        if (r.status === 'rejected') expect([GoneException, ConflictException, NotFoundException].some((E) => r.reason instanceof E)).toBe(true)
      }
      expect(await runWithCompany(A, () => db.user.count({ where: { email } }))).toBeLessThanOrEqual(1)
      expect(await runWithCompany(A, () => db.userInvitation.count({ where: { email, accepted_at: null, revoked_at: null } }))).toBeLessThanOrEqual(1)
    }
  })

  it('nhận lời mời kiểm lại không leo quyền: người mời không còn đủ quyền cho vai trò (hoặc vai trò hệ thống) thì 410', async () => {
    const mgr = (await runWithCompany(A, () => db.user.create({ data: { email: `esc-${stamp}@example.com`, password_hash: 'x', full_name: 'Esc', status: 'active' } }))).id
    grantsOverride.set(mgr, { grants: { 'users.manage': 'all', 'contacts.view': 'all' }, isAdmin: false })
    const inv = await runWithCompany(A, () => createInvitation(db, { userId: mgr, email: 'm@t', isAdmin: false, grants: { 'users.manage': 'all', 'contacts.view': 'all' } }, { email: `esc-inv-${stamp}@example.com`, roleId: staffRoleA }))
    // Người mời bị hạ quyền sau khi mời: vai trò Nhân viên (contacts.view) giờ vượt quyền của họ.
    grantsOverride.set(mgr, { grants: { 'users.manage': 'all' }, isAdmin: false })
    await expect(publicRequest(() => auth.acceptInvitation({ token: inv.token, full_name: 'Leo quyền', password: 'matkhau-moi-1' }, ip()))).rejects.toBeInstanceOf(GoneException)
    expect(await runWithCompany(A, () => db.user.count({ where: { email: `esc-inv-${stamp}@example.com` } }))).toBe(0)
    // Đủ quyền trở lại thì nhận được.
    grantsOverride.set(mgr, { grants: { 'users.manage': 'all', 'contacts.view': 'all' }, isAdmin: false })
    await expect(publicRequest(() => auth.acceptInvitation({ token: inv.token, full_name: 'Hợp lệ', password: 'matkhau-moi-1' }, ip()))).resolves.toMatchObject({ company: { id: A.id } })
    grantsOverride.delete(mgr)
  })

  it('người mời phạm vi hẹp: người mới nằm dưới người mời (manager_id) để họ quản lý được', async () => {
    const mgr = (await runWithCompany(A, () => db.user.create({ data: { email: `narrow-${stamp}@example.com`, password_hash: 'x', full_name: 'Hẹp', status: 'active' } }))).id
    const g = { 'users.manage': 'subtree', 'contacts.view': 'all' } as const
    grantsOverride.set(mgr, { grants: { ...g }, isAdmin: false })
    const inv = await runWithCompany(A, () => createInvitation(db, { userId: mgr, email: 'n@t', isAdmin: false, grants: { ...g } }, { email: `narrow-inv-${stamp}@example.com`, roleId: staffRoleA }, [mgr]))
    await publicRequest(() => auth.acceptInvitation({ token: inv.token, full_name: 'Dưới quyền', password: 'matkhau-moi-1' }, ip()))
    expect((await runWithCompany(A, () => db.user.findFirstOrThrow({ where: { email: `narrow-inv-${stamp}@example.com` } }))).manager_id).toBe(mgr)
    // Phạm vi rộng (all/admin): không gắn manager.
    expect((await runWithCompany(A, () => db.user.findFirstOrThrow({ where: { email: `nv1-${stamp}@example.com` } }))).manager_id).toBeNull()
    grantsOverride.delete(mgr)
  })

  it('lời mời không nhận được (người mời bị khoá, vai trò bị xoá) không giữ chỗ và hiện trạng thái hỏng; xoá vai trò huỷ lời mời của nó', async () => {
    const c = (await provisionCompany({ companyName: 'Công ty F', adminEmail: `chu-f-${stamp}@example.com`, adminPassword: 'password-f-123', adminName: 'Chủ F' })).company
    const owner = (await runWithCompany(c, () => db.user.findFirstOrThrow())).id
    const adminRole = await runWithCompany(c, () => db.role.findFirstOrThrow({ where: { is_system: true } }))
    const roleX = await runWithCompany(c, () => db.role.create({ data: { name: 'Tạm', is_system: false } }))
    await runWithCompany(c, async () => {
      for (let i = 0; i < 6; i++) await db.user.create({ data: { email: `f-fill-${i}-${stamp}@example.com`, password_hash: 'x', full_name: `F${i}`, status: 'active' } })
    })
    const mgr = (await runWithCompany(c, () => db.user.create({ data: { email: `f-mgr-${stamp}@example.com`, password_hash: 'x', full_name: 'Mgr', status: 'active' } }))).id
    await runWithCompany(c, () => db.userRole.create({ data: { user_id: mgr, role_id: adminRole.id } }))
    // 8 người; hai lời mời của người mời (admin) → đủ 10 chỗ.
    await runWithCompany(c, () => createInvitation(db, adminOf(mgr), { email: `f-a-${stamp}@example.com`, roleId: adminRole.id }))
    const bad = await runWithCompany(c, () => createInvitation(db, adminOf(mgr), { email: `f-b-${stamp}@example.com`, roleId: roleX.id }))
    await expect(runWithCompany(c, () => db.$transaction((tx) => assertUserSlotAvailable(tx)))).rejects.toBeInstanceOf(ConflictException)
    // Người mời bị khoá (không đi qua đường thu hồi): hai lời mời của họ hỏng, không giữ chỗ nữa.
    await runWithCompany(c, () => db.user.update({ where: { id: mgr }, data: { status: 'locked' } }))
    await expect(runWithCompany(c, () => db.$transaction((tx) => assertUserSlotAvailable(tx)))).resolves.toBeUndefined()
    const listed = await runWithCompany(c, () => listInvitations(db, { pendingOnly: true }))
    expect(listed.map((i) => i.status)).toEqual(['unusable', 'unusable'])
    // Mở khoá lại: lời mời dùng được lại; xoá vai trò → huỷ lời mời của vai trò đó, không còn chiếm chỗ.
    await runWithCompany(c, () => db.user.update({ where: { id: mgr }, data: { status: 'active' } }))
    expect((await runWithCompany(c, () => listInvitations(db, { pendingOnly: true }))).map((i) => i.status).sort()).toEqual(['pending', 'pending'])
    await runWithCompany(c, () =>
      db.$transaction(async (tx) => {
        await revokePendingInvitationsForRole(tx, roleX.id)
        await tx.role.delete({ where: { id: roleX.id } })
      }),
    )
    expect((await runWithCompany(c, () => db.userInvitation.findFirstOrThrow({ where: { id: bad.id } }))).revoked_at).not.toBeNull()
    expect(owner).toBeGreaterThan(0)
  })

  it('tạo trực tiếp cho email có lời mời chờ của người ngoài phạm vi: 409 như khi mời', async () => {
    const email = `scoped-direct-${stamp}@example.com`
    await runWithCompany(A, () => createInvitation(db, adminOf(4242), { email, roleId: staffRoleA }))
    const err = await runWithCompany(A, () => db.$transaction((tx) => revokePendingInvitationsForEmail(tx, email, [ownerA]))).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictException)
    await expect(runWithCompany(A, () => db.$transaction((tx) => revokePendingInvitationsForEmail(tx, email, [ownerA, 4242])))).resolves.toBeUndefined()
  })
})
