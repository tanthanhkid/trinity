import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { RateLimiterService } from './services/rate-limiter.service'
import { AuditLogService } from './services/audit-log.service'
import { LoginWifiCheckTargetsController } from './login-wifi-check-targets.controller'
import { LoginWifiCheckTargetsService } from './login-wifi-check-targets.service'

// RBAC quyền + phạm vi — guard xác
// thực + phân quyền là 1 bản DUY NHẤT toàn cục (`PermissionGuard`,
// `@trinity/rbac-nest`, đăng ký qua `APP_GUARD` ở `RbacModule`, `@Global()`).
// `TokenBlacklistService`/`ActiveSessionService` CHỈ được cung cấp bởi `RbacModule`
// (`@Global`, `packages/rbac-nest`). TUYỆT ĐỐI KHÔNG khai báo lại ở đây: khai báo lần 2
// tạo THÊM 1 instance (state in-memory) — `AuthService`/`UsersService` ghi blacklist/phiên
// vào bản này còn `JwtAuthGuard` đọc bản của `RbacModule` ⇒ đăng xuất / đổi mật khẩu /
// khoá user / "1 phiên mỗi tài khoản" thành INERT (token cũ vẫn dùng được tới hết hạn).
@Module({
  imports: [
    JwtModule.register({
      secret: (() => {
        if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var is required');
        return process.env.JWT_SECRET;
      })(),
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController, LoginWifiCheckTargetsController],
  providers: [
    AuthService,
    RateLimiterService,
    AuditLogService,
    LoginWifiCheckTargetsService,
  ],
  exports: [
    AuthService,
    JwtModule,
    AuditLogService,
  ],
})
export class AuthModule {}
