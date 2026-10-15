import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { ManagementTeamsModule } from '../teams/teams.module';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

@Module({
  imports: [PrismaModule, ManagementTeamsModule],
  controllers: [ContractsController],
  providers: [ContractsService],
  exports: [ContractsService],
})
export class ContractsModule {}
