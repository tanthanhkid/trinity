import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService, activeCompanyRef, enterCompany, isMultiTenant } from '@trinity/prisma'
import type { Request } from 'express'
import { TokenBlacklistService } from './session/token-blacklist.service'
import { ActiveSessionService } from './session/active-session.service'

interface JwtPayload {
  sub: number
  email: string
  // — sessionId phiên đăng nhập, CHỈ có khi tính năng "1 phiên/tài
  // khoản" đang bật lúc login. Thiếu field này ⇒ fail-open (không kiểm tra).
  sid?: string
  // Company (multi-tenant). Tokens minted before multi-tenancy have none = company 1.
  cid?: number
  // Refresh token mang type='refresh' — KHÔNG được dùng làm access token.
  type?: string
  iat: number
  exp: number
}

/**
 * JWT guard DUY NHẤT dùng chung mọi service (thay 3-4 bản riêng lẻ trước đây —
 * Payload JWT KHÔNG còn `role`/`team_id`: quyền được tra riêng qua
 * `PermissionService.grantsFor` (packages/rbac-nest/src/permission.service.ts),
 * KHÔNG đọc từ token. Guard này CHỈ xác thực danh tính (`req.user = { userId,
 * email }`) — `PermissionGuard` (APP_GUARD) gọi guard này rồi tự gắn thêm
 * `isAdmin`/`grants`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly tokenBlacklist: TokenBlacklistService,
    private readonly activeSession: ActiveSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const token = this.extractTokenFromHeader(request)

    if (!token) {
      throw new UnauthorizedException('Token không được cung cấp')
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token)

      if (payload.type === 'refresh') {
        throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn')
      }

      // Bind the request to the token's company BEFORE any lookup: every query below runs in its schema.
      if (isMultiTenant()) {
        const company = await activeCompanyRef(payload.cid ?? 1)
        if (!company) throw new UnauthorizedException('Công ty của tài khoản này không còn hoạt động')
        enterCompany(company)
      } else if (payload.cid !== undefined && payload.cid !== 1) {
        // Multi-tenancy switched off: a token of another company must never act as company 1's user with the same id.
        throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn')
      }

      if (this.tokenBlacklist.isBlacklisted(payload.sub)) {
        throw new UnauthorizedException('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
      }

      // — token có `sid` (mint khi tính năng 1-phiên/tài khoản đang
      // bật) mà KHÔNG khớp phiên mới nhất đang lưu ⇒ đã bị 1 lần đăng nhập khác
      // thay thế. Thiếu `sid` hoặc chưa có phiên nào được theo dõi → fail-open.
      if (!this.activeSession.isCurrentSession(payload.sub, payload.sid)) {
        throw new UnauthorizedException(
          'Tài khoản vừa đăng nhập ở nơi khác, phiên này đã bị đăng xuất',
        )
      }

      // Hard guard: user bị soft-delete vĩnh viễn HOẶC bị khoá → reject ngay
      // lập tức (token cũ không thể xài được dù blacklist đã hết hạn, dù
      // restart làm mất in-memory blacklist).
      const account = await this.loadAccountStatus(payload.sub)
      if (!account) {
        throw new UnauthorizedException('Tài khoản không tồn tại')
      }
      if (account.deleted_at) {
        throw new UnauthorizedException('Tài khoản đã bị xoá, vui lòng liên hệ quản trị viên')
      }
      if (account.status !== 'active') {
        throw new UnauthorizedException('Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên')
      }

      ;(request as unknown as Record<string, unknown>)['user'] = {
        userId: payload.sub,
        email: payload.email,
        companyId: payload.cid ?? 1,
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn')
    }

    return true
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization
    if (!authHeader) return undefined

    const [type, token] = authHeader.split(' ')
    return type === 'Bearer' ? token : undefined
  }

  /**
   * Load chỉ những field cần thiết để gate request: deleted_at, status. Mỗi
   * request thêm 1 query DB — chấp nhận trade-off cho security (revoke token
   * tức thì khi soft-delete / lock user). Nếu performance critical, caller có
   * thể bọc Redis cache TTL ngắn (60s) ở tầng trên.
   */
  private async loadAccountStatus(
    userId: number,
  ): Promise<{ deleted_at: Date | null; status: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deleted_at: true, status: true },
    })
    if (!user) return null
    return { deleted_at: user.deleted_at, status: user.status }
  }
}
