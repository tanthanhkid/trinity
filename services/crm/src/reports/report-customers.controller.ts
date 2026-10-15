import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { QueryReportRangeDto } from './dto/query-report-range.dto';
import { QueryReportUncontactedDto } from './dto/query-report-uncontacted.dto';
import { parseReportPeriod } from './helpers/report-date-range.helper';
import { ReportCustomersService } from './report-customers.service';
import { ReportCustomersUncontactedService } from './report-customers-uncontacted.service';

/**
 * Nhóm "Khách hàng". Scope theo phạm vi quyền `reports.customers`
 * (owner = `assigned_to` HOẶC `created_by_id`).
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Can('reports.customers')
@Controller('reports/customers')
export class ReportCustomersController {
  constructor(
    private readonly customersService: ReportCustomersService,
    private readonly uncontactedService: ReportCustomersUncontactedService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Khách hàng mới theo thời gian + phân bổ theo Nguồn/Trạng thái/Người phụ trách',
    description:
      'Trend tự chọn granularity ngày/tuần/tháng theo độ dài kỳ. Không có breakdown theo Tag.',
  })
  @ApiResponse({ status: 200 })
  async getOverview(@Query() query: QueryReportRangeDto, @CurrentUser() user: AuthUser) {
    const period = parseReportPeriod(query.date_from, query.date_to);
    return this.customersService.getOverview(user, period);
  }

  @Get('uncontacted')
  @ApiOperation({
    summary: 'Khách chưa được chăm sóc quá N ngày (7/14/30)',
    description:
      'Contact KHÔNG có Activity nào trong N ngày gần nhất, trong phạm vi quyền `reports.customers`. ' +
      'Cursor pagination (id desc). SĐT che theo quyền `contacts.phone_full`.',
  })
  @ApiResponse({ status: 200 })
  async getUncontacted(
    @Query() query: QueryReportUncontactedDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.uncontactedService.getUncontacted(user, query);
  }
}
