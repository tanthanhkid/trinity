import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common'
import { PrismaModule } from '@trinity/prisma'
import { ElkLoggerModule } from '@trinity/logger'
import { TemplatesModule } from './templates/templates.module'
import { NotificationsModule } from './notifications/notifications.module'
import { SubscribersModule } from './subscribers/subscribers.module'
import { WebsocketModule } from './websocket/websocket.module'
import { HealthController } from './health/health.controller'
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware'
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware'

@Module({
  imports: [
    PrismaModule,
    ElkLoggerModule.forRoot({ service: 'notification' }),
    TemplatesModule,
    NotificationsModule,
    SubscribersModule,
    WebsocketModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, SecurityHeadersMiddleware).forRoutes('*')
  }
}
