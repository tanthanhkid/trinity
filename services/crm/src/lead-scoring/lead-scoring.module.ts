import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { LeadIntentService } from './lead-intent.service';
import { LeadScoringController } from './lead-scoring.controller';
import { LeadScoringJob } from './lead-scoring.job';
import { LeadScoringService } from './lead-scoring.service';

/** Chấm điểm lead: quy tắc chạy trên máy chủ (không AI) + điểm "ý định" do agent AI của khách ghi qua MCP. */
@Module({
  imports: [PrismaModule],
  controllers: [LeadScoringController],
  providers: [LeadScoringService, LeadScoringJob, LeadIntentService],
  exports: [LeadScoringService, LeadIntentService],
})
export class LeadScoringModule {}
