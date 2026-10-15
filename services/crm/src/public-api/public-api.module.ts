import { Module } from '@nestjs/common';
import { PublicContactsController } from './public-contacts.controller';
import { PublicDealsController, PublicTasksController } from './public-work.controller';
import { PublicWorkService } from './public-work.service';
import { DealsModule } from '../deals/deals.module';
import { KanbanModule } from '../kanban/kanban.module';
import { PublicApiService } from './public-api.service';
import { ApiKeyGuard } from './api-key.guard';
import { PublicApiRateLimiterGuard } from './public-api-rate-limiter.service';

/**
 * Module exposing /public/contacts cho bên thứ 3.
 * PrismaModule đã là Global (app.module) — không cần import lại.
 */
@Module({
  imports: [DealsModule, KanbanModule],
  controllers: [PublicContactsController, PublicDealsController, PublicTasksController],
  providers: [PublicApiService, PublicWorkService, ApiKeyGuard, PublicApiRateLimiterGuard],
  // webhook vào dùng lại đúng lõi tạo khách này.
  exports: [PublicApiService],
})
export class PublicApiModule {}
