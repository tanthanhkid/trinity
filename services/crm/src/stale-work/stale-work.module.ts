import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { NotificationsModule } from '../notifications/notifications.module';
import { StaleWorkController } from './stale-work.controller';
import { StaleWorkJob } from './stale-work.job';
import { StaleWorkService } from './stale-work.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [StaleWorkController],
  providers: [StaleWorkService, StaleWorkJob],
  exports: [StaleWorkService],
})
export class StaleWorkModule {}
