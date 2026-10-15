import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { JwtAuthGuard } from './jwt-auth.guard'
import { TokenBlacklistService } from './session/token-blacklist.service'
import { ActiveSessionService } from './session/active-session.service'

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
    expect(req.user).toEqual({ userId: 7, email: 'a@x' })
  })
})
