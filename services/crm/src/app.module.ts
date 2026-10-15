import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@trinity/prisma';
import { ElkLoggerModule } from '@trinity/logger';
import { ContactsModule } from './contacts/contacts.module';
import { ActivitiesModule } from './activities/activities.module';
import { ReportsModule } from './reports/reports.module';
import { StorageModule } from './storage/storage.module';
import { SettingsModule } from './settings/settings.module';
import { SettingsOptionsModule } from './settings-options/settings-options.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NewsfeedModule } from './newsfeed/newsfeed.module';
import { PublicApiModule } from './public-api/public-api.module';
import { DealsModule } from './deals/deals.module';
import { EmployeesModule } from './employees/employees.module';
import { ContractsModule } from './contracts/contracts.module';
import { JobTitlesModule } from './job-titles/job-titles.module';
import { AttendanceModule } from './attendance/attendance.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { ManagementTeamsModule } from './teams/teams.module';
import { KanbanModule } from './kanban/kanban.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { GoogleModule } from './google/google.module';
import { CustomObjectsModule } from './custom-objects/custom-objects.module';
import { UsageModule } from './usage/usage.module';
import { ZaloOaModule } from './zalo-oa/zalo-oa.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { StoreModule } from './store/store.module';
import { LeadScoringModule } from './lead-scoring/lead-scoring.module';
import { StaleWorkModule } from './stale-work/stale-work.module';
import { FacebookModule } from './facebook/facebook.module';
import { SocialModule } from './social/social.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { BriefingsModule } from './briefings/briefings.module';
import { RedisModule } from './common/redis.module';
import { HealthController } from './health/health.controller';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';

// Không bật ThrottlerGuard toàn cục: giới hạn 100 req/min làm kẹt thao tác nhanh của người dùng.
// Rate limit cho bên thứ 3 vẫn được giữ tại `PublicApiRateLimiterGuard`
// (controller-scoped trên /public/*) và `RateLimiterService` (public-login key).
//
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule, // Global — PrismaService available everywhere
    StorageModule, // Global — MinIO S3 storage
    RedisModule, // Global — REDIS_CLIENT token
    ElkLoggerModule.forRoot({ service: 'crm' }),
    ContactsModule,
    ActivitiesModule,
    ReportsModule,
    SettingsModule,
    SettingsOptionsModule,
    NotificationsModule,
    NewsfeedModule,
    PublicApiModule,
    DealsModule,
    EmployeesModule,
    ContractsModule,
    JobTitlesModule,
    AttendanceModule,
    RecruitmentModule,
    ManagementTeamsModule,
    KanbanModule,
    IntegrationsModule,
    GoogleModule,
    CustomObjectsModule,
    FacebookModule,
    SocialModule,
    OnboardingModule,
    UsageModule,
    ZaloOaModule,
    ConnectorsModule,
    StoreModule,
    LeadScoringModule,
    StaleWorkModule,
    BriefingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(CorrelationIdMiddleware, SecurityHeadersMiddleware)
      .forRoutes('*');
  }
}
