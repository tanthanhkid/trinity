import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  imports: [PrismaModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class ManagementTeamsModule {}
