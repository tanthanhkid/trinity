import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { OauthController } from './oauth.controller';
import { OauthConsentController } from './oauth-consent.controller';
import { AiConnectionsController } from './ai-connections.controller';
import { OauthClientsService } from './oauth-clients.service';
import { OauthAuthorizeService } from './oauth-authorize.service';
import { OauthTokenService } from './oauth-token.service';
import { AiConnectionsService } from './ai-connections.service';
import { OauthPurgeService } from './oauth-purge.service';

/** OAuth 2.1 Authorization Server. Xuất OauthTokenService để máy chủ MCP xác minh access token. */
@Module({
  imports: [PrismaModule],
  controllers: [OauthController, OauthConsentController, AiConnectionsController],
  providers: [OauthClientsService, OauthAuthorizeService, OauthTokenService, AiConnectionsService, OauthPurgeService],
  exports: [OauthTokenService, OauthClientsService],
})
export class OauthModule {}
