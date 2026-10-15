import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeeBirthdayExportService } from './employee-birthday-export.service';
import { EmployeeListExportService } from './employee-list-export.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    EmployeeBirthdayExportService,
    EmployeeListExportService,
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
