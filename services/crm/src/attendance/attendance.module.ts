import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { NotificationsModule } from '../notifications/notifications.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceExportService } from './attendance-export.service';
import { AttendanceMatrixExportService } from './attendance-matrix-export.service';
import { AttendanceAbsentExportService } from './attendance-absent-export.service';
import { AttendanceStatsExportService } from './attendance-stats-export.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceService,
    AttendanceExportService,
    AttendanceMatrixExportService,
    AttendanceAbsentExportService,
    AttendanceStatsExportService,
  ],
  exports: [AttendanceService],
})
export class AttendanceModule {}
