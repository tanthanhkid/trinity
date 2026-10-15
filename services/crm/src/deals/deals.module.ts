import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [DealsController],
  providers: [DealsService],
  exports: [DealsService],
})
export class DealsModule {}
