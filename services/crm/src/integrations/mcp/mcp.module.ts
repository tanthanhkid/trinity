import { ConnectorsModule } from '../../connectors/connectors.module';
import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { ContactsModule } from '../../contacts/contacts.module';
import { DealsModule } from '../../deals/deals.module';
import { KanbanModule } from '../../kanban/kanban.module';
import { ActivitiesModule } from '../../activities/activities.module';
import { CustomObjectsModule } from '../../custom-objects/custom-objects.module';
import { ReportsModule } from '../../reports/reports.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { OauthModule } from '../oauth/oauth.module';
import { BriefingsModule } from '../../briefings/briefings.module';
import { LeadScoringModule } from '../../lead-scoring/lead-scoring.module';
import { SettingsModule } from '../../settings/settings.module';
import { ExtensionsModule } from '../../extensions/extensions.module';
import { SocialModule } from '../../social/social.module';
import { ZaloOaModule } from '../../zalo-oa/zalo-oa.module';
import { FacebookModule } from '../../facebook/facebook.module';
import { McpAuthService } from './mcp-auth.service';
import { McpController } from './mcp.controller';
import { McpRateLimiter } from './mcp-rate-limiter';
import { McpServerService } from './mcp-server.service';
import { AiActionsController } from './actions/ai-actions.controller';
import { AiActionsService } from './actions/ai-actions.service';
import { AiActionExpiryService } from './actions/ai-action-expiry.service';

/** Máy chủ MCP + đề xuất thao tác ghi chờ duyệt. Thêm tool = thêm vào `mcp-tools.registry.ts` / `actions/action-registry.ts`. */
@Module({
  imports: [PrismaModule, NotificationsModule, OauthModule, ContactsModule, DealsModule, KanbanModule, ActivitiesModule, ReportsModule, CustomObjectsModule, BriefingsModule, LeadScoringModule, SettingsModule, ExtensionsModule, SocialModule, FacebookModule, ZaloOaModule, ConnectorsModule],
  controllers: [McpController, AiActionsController],
  providers: [McpAuthService, McpServerService, McpRateLimiter, AiActionsService, AiActionExpiryService],
  exports: [McpServerService],
})
export class McpModule {}
