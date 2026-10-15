import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@trinity/prisma';
import { ElkLoggerModule } from '@trinity/logger';
import { ProjectsModule } from './projects/projects.module';
import { ProductsModule } from './products/products.module';
import { PosModule } from './pos/pos.module';
import { HealthController } from './health/health.controller';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';

/**
 * Commerce service: projects, products (multi-industry catalog) and POS.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ElkLoggerModule.forRoot({ service: 'commerce' }),
    ProjectsModule,
    ProductsModule,
    PosModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, SecurityHeadersMiddleware).forRoutes('*');
  }
}
