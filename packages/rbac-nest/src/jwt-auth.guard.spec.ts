import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { JwtAuthGuard } from './jwt-auth.guard'
import { TokenBlacklistService } from './session/token-blacklist.service'
import { ActiveSessionService } from './session/active-session.service'
import { activeCompanyRef, currentCompany, runInTenantScope } from '@trinity/prisma'

jest.mock('@trinity/prisma', () => ({
  ...jest.requireActual('@trinity/prisma'),
  activeCompanyRef: jest.fn(),
}))

function makeContext(headers: Record<string, string>): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = { headers }
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

describe('JwtAuthGuard', () => {
  const jwtService = new JwtService({ secret: 't' })
  let prisma: { user: { findUnique: jest.Mock } }
  let tokenBlacklist: TokenBlacklistService
  let activeSession: ActiveSessionService
  let guard: JwtAuthGuard

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } }
    prisma.user.findUnique.mockResolvedValue({ status: 'active', deleted_at: null })
    tokenBlacklist = new TokenBlacklistService()
    activeSession = new ActiveSessionService()
    guard = new JwtAuthGuard(
      jwtService,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      tokenBlacklist,
      activeSession,
    )
  })

  it('không header → UnauthorizedException Token không được cung cấp', async () => {
    const { ctx } = makeContext({})
    await expect(guard.canActivate(ctx)).rejects.toThrow('Token không được cung cấp')
  })

  it('token sai chữ ký → 401', async () => {
    const { ctx } = makeContext({ authorization: 'Bearer token-gia' })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it("user status='locked' → 401 Tài khoản đã bị khoá", async () => {
    const token = jwtService.sign({ sub: 7, email: 'a@x' })
    prisma.user.findUnique.mockResolvedValue({ status: 'locked', deleted_at: null })
    const { ctx } = makeContext({ authorization: `Bearer ${token}` })
    await expect(guard.canActivate(ctx)).rejects.toThrow('Tài khoản đã bị khoá')
  })

  it('refresh token dùng làm Bearer → 401', async () => {
    const token = jwtService.sign({ sub: 7, email: 'a@x', type: 'refresh' })
    const { ctx } = makeContext({ authorization: `Bearer ${token}` })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('blacklisted → 401', async () => {
    const token = jwtService.sign({ sub: 7, email: 'a@x' })
    tokenBlacklist.blacklistUser(7)
    const { ctx } = makeContext({ authorization: `Bearer ${token}` })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it("hợp lệ → true, req.user = { userId: 7, email: 'a@x' }", async () => {
    const token = jwtService.sign({ sub: 7, email: 'a@x' })
    const { ctx, req } = makeContext({ authorization: `Bearer ${token}` })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.user).toEqual({ userId: 7, email: 'a@x', companyId: 1 })
  })

  it('single-tenant mode rejects a token issued to another company', async () => {
    const token = jwtService.sign({ sub: 7, email: 'a@x', cid: 5 })
    const { ctx } = makeContext({ authorization: `Bearer ${token}` })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  describe('multi-tenant', () => {
    const prev = process.env.MULTI_TENANT
    beforeEach(() => {
      process.env.MULTI_TENANT = 'true'
      ;(activeCompanyRef as jest.Mock).mockReset()
    })
    afterAll(() => {
      process.env.MULTI_TENANT = prev
    })

    it('binds the request to the company in the token before looking the user up', async () => {
      ;(activeCompanyRef as jest.Mock).mockResolvedValue({ id: 5, schema: 'c_5' })
      let seen: unknown = null
      prisma.user.findUnique.mockImplementation(async () => {
        seen = currentCompany()
        return { status: 'active', deleted_at: null }
      })
      const token = jwtService.sign({ sub: 7, email: 'a@x', cid: 5 })
      const { ctx, req } = makeContext({ authorization: `Bearer ${token}` })
      await runInTenantScope(() => guard.canActivate(ctx))
      expect(activeCompanyRef).toHaveBeenCalledWith(5)
      expect(seen).toEqual({ id: 5, schema: 'c_5' })
      expect(req.user).toEqual({ userId: 7, email: 'a@x', companyId: 5 })
    })

    it('token without cid = company 1 (issued before multi-tenancy)', async () => {
      ;(activeCompanyRef as jest.Mock).mockResolvedValue({ id: 1, schema: 'public' })
      const token = jwtService.sign({ sub: 7, email: 'a@x' })
      const { ctx } = makeContext({ authorization: `Bearer ${token}` })
      await runInTenantScope(() => guard.canActivate(ctx))
      expect(activeCompanyRef).toHaveBeenCalledWith(1)
    })

    it('unknown or suspended company → 401, no user lookup', async () => {
      ;(activeCompanyRef as jest.Mock).mockResolvedValue(null)
      const token = jwtService.sign({ sub: 7, email: 'a@x', cid: 9 })
      const { ctx } = makeContext({ authorization: `Bearer ${token}` })
      await expect(runInTenantScope(() => guard.canActivate(ctx))).rejects.toThrow(UnauthorizedException)
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('a blacklisted user id in company 5 does not block the same id in company 6', async () => {
      ;(activeCompanyRef as jest.Mock).mockImplementation(async (id: number) => ({ id, schema: `c_${id}` }))
      const t5 = jwtService.sign({ sub: 7, email: 'a@x', cid: 5 })
      await runInTenantScope(async () => {
        await guard.canActivate(makeContext({ authorization: `Bearer ${t5}` }).ctx)
        tokenBlacklist.blacklistUser(7)
      })
      const t6 = jwtService.sign({ sub: 7, email: 'b@y', cid: 6 })
      await expect(runInTenantScope(() => guard.canActivate(makeContext({ authorization: `Bearer ${t6}` }).ctx))).resolves.toBe(true)
      await expect(runInTenantScope(() => guard.canActivate(makeContext({ authorization: `Bearer ${t5}` }).ctx))).rejects.toThrow(UnauthorizedException)
    })
  })
})
