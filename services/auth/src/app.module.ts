import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common'
import { PrismaModule } from '@trinity/prisma'
import { ElkLoggerModule } from '@trinity/logger'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { RbacAdminModule } from './rbac-admin/rbac-admin.module'
import { TeamsModule } from './teams/teams.module'
import { ApiKeysModule } from './api-keys/api-keys.module'
import { PublicApiModule } from './public-api/public-api.module'
import { HealthController } from './health/health.controller'
import { RbacCatalogController } from './rbac-admin/rbac-catalog.controller'
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware'
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware'

@Module({
  imports: [
    PrismaModule,
    ElkLoggerModule.forRoot({ service: 'auth' }),
    AuthModule,
    UsersModule,
    RbacAdminModule,
    TeamsModule,
    ApiKeysModule,
    PublicApiModule,
  ],
  // RbacCatalogController dùng PermissionService/ScopeService — provider TOÀN CỤC
  // từ RbacModule (packages/rbac-nest, đăng ký ở apps/monolith/src/app.module.ts),
  // KHÔNG cần import lại ở đây.
  controllers: [HealthController, RbacCatalogController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, SecurityHeadersMiddleware).forRoutes('*')
  }
}
