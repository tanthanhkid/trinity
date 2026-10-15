import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { timingSafeEqual } from 'crypto'
import { can } from '@trinity/rbac'
import { RBAC_META, AccessMeta } from './decorators'
import { JwtAuthGuard } from './jwt-auth.guard'
import { PermissionService } from './permission.service'
import type { AuthUser } from './auth-user'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Guard toàn cục DUY NHẤT (đăng ký qua `APP_GUARD`) — làm cả xác thực lẫn
 * phân quyền, deny-by-default:
 *
 * 1. Đọc `AccessMeta` (handler ưu tiên hơn class).
 * 2. Không có metadata → 403 `'Route chưa khai báo quyền'` (luôn strict —
 *    đã gỡ biến `RBAC_STRICT`).
 * 3. `public` → true. `internal` → so `x-service-secret` với
 *    `INTERNAL_SERVICE_SECRET` HOẶC `SERVICE_SECRET` (giá trị nào đang đặt đều
 *    được) bằng `timingSafeEqual`.
 * 4. `auth`/`can` → chạy `JwtAuthGuard` rồi `PermissionService.grantsFor`.
 * 5. `can` → `mode:'all'` cần mọi quyền, `'any'` cần ≥1; `isAdmin` qua hết.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtGuard: JwtAuthGuard,
    private readonly permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<AccessMeta | undefined>(RBAC_META, [
      context.getHandler(),
      context.getClass(),
    ])

    if (!meta) {
      throw new ForbiddenException('Route chưa khai báo quyền')
    }

    if (meta.kind === 'public') return true

    if (meta.kind === 'internal') {
      this.assertInternalSecret(context)
      return true
    }

    // auth | can → xác thực trước
    await this.jwtGuard.canActivate(context)
    const request = context.switchToHttp().getRequest()
    const basicUser = request.user as { userId: number; email: string }
    const { grants, isAdmin } = await this.permissionService.grantsFor(basicUser.userId)
    const user: AuthUser = { userId: basicUser.userId, email: basicUser.email, isAdmin, grants }
    request.user = user

    if (meta.kind === 'auth') return true

    // meta.kind === 'can'
    if (user.isAdmin) return true
    const ok =
      meta.mode === 'all'
        ? meta.permissions.every((p) => can(user.grants, p))
        : meta.permissions.some((p) => can(user.grants, p))
    if (!ok) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này')
    }
    return true
  }

  private assertInternalSecret(context: ExecutionContext): void {
    const request = context.switchToHttp().getRequest()
    const provided = request.headers?.['x-service-secret']
    // Chấp nhận MỘT TRONG HAI secret đang đặt (bỏ giá trị rỗng): tránh 401 hàng loạt
    // nếu INTERNAL_SERVICE_SECRET khác SERVICE_SECRET trong khi caller nội bộ chỉ gửi
    // SERVICE_SECRET.
    const expected = [process.env.INTERNAL_SERVICE_SECRET, process.env.SERVICE_SECRET].filter(
      (v): v is string => Boolean(v),
    )
    if (typeof provided !== 'string' || !provided || !expected.some((e) => safeEqual(provided, e))) {
      throw new UnauthorizedException('Thiếu hoặc sai x-service-secret')
    }
  }
}
