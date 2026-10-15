import { Module } from '@nestjs/common'
import { PrismaModule } from '@trinity/prisma'
import { JobTitlesController } from './job-titles.controller'
import { JobTitlesService } from './job-titles.service'

@Module({
  imports: [PrismaModule],
  controllers: [JobTitlesController],
  providers: [JobTitlesService],
  exports: [JobTitlesService],
})
export class JobTitlesModule {}
