import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { NotificationsModule } from '../notifications/notifications.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationOutboxPurgeService } from './integration-outbox-purge.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhookEndpointsService } from './webhooks/webhook-endpoints.service';
import { WebhookDeliveriesService } from './webhooks/webhook-deliveries.service';
import { WebhookSenderService } from './webhooks/webhook-sender.service';
import { WebhookActorService } from './webhooks/webhook-actor.service';
import { WebhookDeliveryWorker } from './webhooks/webhook-delivery-worker.service';
import { WebhookDispatcherService } from './webhooks/webhook-dispatcher.service';
import { WebhookInboundController } from './webhooks/inbound/webhook-inbound.controller';
import { WebhookInboundSourcesController } from './webhooks/inbound/webhook-inbound-sources.controller';
import { WebhookInboundService } from './webhooks/inbound/webhook-inbound.service';
import { WebhookInboundSourcesService } from './webhooks/inbound/webhook-inbound-sources.service';
import { PublicApiModule } from '../public-api/public-api.module';
import { OauthModule } from './oauth/oauth.module';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [PrismaModule, NotificationsModule, PublicApiModule, OauthModule, McpModule],
  controllers: [IntegrationsController, WebhooksController, WebhookInboundSourcesController, WebhookInboundController],
  providers: [
    IntegrationOutboxPurgeService,
    WebhookEndpointsService,
    WebhookDeliveriesService,
    WebhookSenderService,
    WebhookActorService,
    WebhookDeliveryWorker,
    WebhookDispatcherService,
    WebhookInboundService,
    WebhookInboundSourcesService,
  ],
})
export class IntegrationsModule {}
