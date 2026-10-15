import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { PermissionGuard } from './permission.guard'
import { Can, CanAny, AuthOnly, Public, Internal } from './decorators'
import type { JwtAuthGuard } from './jwt-auth.guard'
import type { PermissionService } from './permission.service'

function mkContext(opts: {
  handler?: (...args: unknown[]) => unknown
  klass?: new (...args: unknown[]) => unknown
  headers?: Record<string, string>
}): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const handler = opts.handler ?? function handler() {}
  const klass = opts.klass ?? class Controller {}
  const req: Record<string, unknown> = { headers: opts.headers ?? {} }
  const ctx = {
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

describe('PermissionGuard', () => {
  const reflector = new Reflector()
  let jwtGuard: { canActivate: jest.Mock }
  let permissionService: { grantsFor: jest.Mock }
  let guard: PermissionGuard
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV }
    jwtGuard = { canActivate: jest.fn().mockImplementation(async (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest() as Record<string, unknown>
      req.user = { userId: 7, email: 'a@x' }
      return true
    }) }
    permissionService = { grantsFor: jest.fn().mockResolvedValue({ grants: {}, isAdmin: false }) }
    guard = new PermissionGuard(
      reflector,
      jwtGuard as unknown as JwtAuthGuard,
      permissionService as unknown as PermissionService,
    )
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('không có metadata → 403 (luôn strict, không còn công tắc)', async () => {
    const { ctx } = mkContext({})
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException)
    expect(jwtGuard.canActivate).not.toHaveBeenCalled()
  })

  it('không có metadata + đặt RBAC_STRICT=off → VẪN 403 (biến đã gỡ)', async () => {
    process.env.RBAC_STRICT = 'off'
    const { ctx } = mkContext({})
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException)
  })

  it('@Public → true, không cần JWT', async () => {
    const handler = function handler() {}
    Public()(handler)
    const { ctx } = mkContext({ handler })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(jwtGuard.canActivate).not.toHaveBeenCalled()
  })

  it('@Internal đúng secret → true', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'bi-mat'
    const handler = function handler() {}
    Internal()(handler)
    const { ctx } = mkContext({ handler, headers: { 'x-service-secret': 'bi-mat' } })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('@Internal: chưa đặt INTERNAL_SERVICE_SECRET → dùng SERVICE_SECRET (giá trị chung)', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET
    process.env.SERVICE_SECRET = 'bi-mat-cu'
    const handler = function handler() {}
    Internal()(handler)
    const ok = mkContext({ handler, headers: { 'x-service-secret': 'bi-mat-cu' } })
    await expect(guard.canActivate(ok.ctx)).resolves.toBe(true)
    const bad = mkContext({ handler, headers: { 'x-service-secret': 'khac' } })
    await expect(guard.canActivate(bad.ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('@Internal: cả hai secret đặt khác nhau → nhận cả hai', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'moi'
    process.env.SERVICE_SECRET = 'cu'
    const handler = function handler() {}
    Internal()(handler)
    for (const v of ['moi', 'cu']) {
      const { ctx } = mkContext({ handler, headers: { 'x-service-secret': v } })
      await expect(guard.canActivate(ctx)).resolves.toBe(true)
    }
  })

  it('@Internal: không có secret nào được đặt → 401 kể cả header rỗng', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET
    delete process.env.SERVICE_SECRET
    const handler = function handler() {}
    Internal()(handler)
    const { ctx } = mkContext({ handler, headers: { 'x-service-secret': '' } })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('@Internal sai secret → 401', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'bi-mat'
    const handler = function handler() {}
    Internal()(handler)
    const { ctx } = mkContext({ handler, headers: { 'x-service-secret': 'sai' } })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('@AuthOnly hợp lệ → true, gắn req.user { userId, email, isAdmin, grants }', async () => {
    const handler = function handler() {}
    AuthOnly()(handler)
    permissionService.grantsFor.mockResolvedValue({ grants: { 'contacts.view': 'own' }, isAdmin: false })
    const { ctx, req } = mkContext({ handler, headers: { authorization: 'Bearer t' } })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.user).toEqual({
      userId: 7,
      email: 'a@x',
      isAdmin: false,
      grants: { 'contacts.view': 'own' },
    })
  })

  it('@Can thiếu quyền → 403', async () => {
    const handler = function handler() {}
    Can('contacts.export')(handler)
    permissionService.grantsFor.mockResolvedValue({ grants: { 'contacts.view': 'own' }, isAdmin: false })
    const { ctx } = mkContext({ handler })
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException)
  })

  it('@Can đủ quyền → true', async () => {
    const handler = function handler() {}
    Can('contacts.view')(handler)
    permissionService.grantsFor.mockResolvedValue({ grants: { 'contacts.view': 'own' }, isAdmin: false })
    const { ctx } = mkContext({ handler })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('@CanAny đủ 1 trong nhiều quyền → true', async () => {
    const handler = function handler() {}
    CanAny('contacts.export', 'contacts.view')(handler)
    permissionService.grantsFor.mockResolvedValue({ grants: { 'contacts.view': 'own' }, isAdmin: false })
    const { ctx } = mkContext({ handler })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('isAdmin=true → qua mọi @Can bất kể grants', async () => {
    const handler = function handler() {}
    Can('contacts.export', 'roles.manage')(handler)
    permissionService.grantsFor.mockResolvedValue({ grants: {}, isAdmin: true })
    const { ctx } = mkContext({ handler })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })
})
