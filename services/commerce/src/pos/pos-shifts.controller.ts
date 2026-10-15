import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, Can, CurrentUser } from '@trinity/rbac-nest';
import { ParseInt4Pipe } from '../common/validation/int4';
import { CloseShiftDto, DailyReportQueryDto, ListShiftsQueryDto, OpenShiftDto } from './dto/shift-catalog.dto';
import { PosReportsService } from './pos-reports.service';
import { PosShiftsService } from './pos-shifts.service';

/** POS — ca làm việc + báo cáo ngày. Danh tính từ JWT; xem/đóng ca của người khác theo phạm vi `pos.sell`. */
@ApiTags('POS')
@ApiBearerAuth()
@Can('pos.sell')
@Controller('pos')
export class PosShiftsController {
  constructor(private readonly shifts: PosShiftsService, private readonly reports: PosReportsService) {}

  @Post('shifts/open')
  @ApiOperation({ summary: 'Mở ca (nhập tiền đầu ca)' })
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: AuthUser) { return this.shifts.open(dto, user); }

  @Get('shifts/current')
  @ApiOperation({ summary: 'Ca đang mở của tôi + tổng kết tạm' })
  current(@CurrentUser() user: AuthUser) { return this.shifts.current(user); }

  @Get('shifts')
  list(@Query() q: ListShiftsQueryDto, @CurrentUser() user: AuthUser) { return this.shifts.list(q, user); }

  @Get('shifts/:id/summary')
  summary(@Param('id', ParseInt4Pipe) id: number, @CurrentUser() user: AuthUser) { return this.shifts.summary(id, user); }

  @Post('shifts/:id/close')
  @ApiOperation({ summary: 'Đóng ca: nhập tiền đếm thực tế → chênh lệch so với dự kiến' })
  close(@Param('id', ParseInt4Pipe) id: number, @Body() dto: CloseShiftDto, @CurrentUser() user: AuthUser) {
    return this.shifts.close(id, dto, user);
  }

  @Get('reports/daily')
  @Can('pos.report')
  @ApiOperation({ summary: 'Báo cáo doanh thu ngày (giờ VN) — quyền pos.report' })
  daily(@Query() q: DailyReportQueryDto) { return this.reports.daily(q.date); }
}
