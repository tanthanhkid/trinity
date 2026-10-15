import { Global, Module } from '@nestjs/common'
import { APP_GUARD, DiscoveryModule } from '@nestjs/core'
import { JwtModule } from '@nestjs/jwt'
import { RbacCache } from './rbac-cache'
import { PermissionService } from './permission.service'
import { ScopeService } from './scope.service'
import { JwtAuthGuard } from './jwt-auth.guard'
import { PermissionGuard } from './permission.guard'
import { TokenBlacklistService } from './session/token-blacklist.service'
import { ActiveSessionService } from './session/active-session.service'

function requiredEnv(k: string): string {
  const v = process.env[k]
  if (!v) throw new Error(`${k} environment variable is required`)
  return v
}

/**
 * Module RBAC duy nhất — đăng ký 1 lần ở `MonolithModule` (và bất kỳ app Nest
 * nào chạy độc lập cần `PermissionService`/`ScopeService`, vd `AuthModule` khi
 * chạy standalone ngoài monolith). `@Global()` nên mọi module trong CÙNG cây
 * ứng dụng dùng lại đúng 1 instance các provider dưới đây, không cần import
 * lại.
 *
 * ⚠️ `JwtModule.registerAsync` (KHÔNG `register` trần) — `requiredEnv` PHẢI
 * chạy lúc Nest thực sự khởi tạo module (app bootstrap), KHÔNG chạy ngay lúc
 * FILE này được `import`. `@Module({...})` là decorator: object truyền vào nó
 * được evaluate NGAY khi class được khai báo — tức là ngay khi bất kỳ ai
 * `import` một thứ gì từ `@trinity/rbac-nest` (kể cả chỉ cần
 * `TokenBlacklistService`), vì barrel `index.ts` re-export luôn module này.
 * `register()` trần sẽ ném lỗi thiếu `JWT_SECRET` ngay lúc `import`, phá mọi
 * unit test không set biến này — dù test đó không đụng gì tới RBAC.
 */
@Global()
@Module({
  imports: [
    DiscoveryModule,
    JwtModule.registerAsync({ useFactory: () => ({ secret: requiredEnv('JWT_SECRET') }) }),
  ],
  providers: [
    RbacCache,
    PermissionService,
    ScopeService,
    JwtAuthGuard,
    TokenBlacklistService,
    ActiveSessionService,
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [RbacCache, PermissionService, ScopeService, JwtAuthGuard, TokenBlacklistService, ActiveSessionService],
})
export class RbacModule {}
