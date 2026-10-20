import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { CustomReportsService } from './custom-reports.service';

export class SaveCustomReportsDto {
  /** Toàn bộ danh sách định nghĩa (thay thế) — hình dạng kiểm ở `normalizeReportDefs`. */
  @IsArray()
  reports!: unknown[];
}

export class RunCustomReportQueryDto {
  /** `this_month` (mặc định) · `month:YYYY-MM` · `year:YYYY` · `all`. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  period?: string;
}

/**
 * Báo cáo dùng chung cho mọi bảng (#25). Xem: ai đăng nhập cũng gọi được, nhưng chỉ thấy báo cáo của bảng mình có
 * quyền xem và số liệu theo phạm vi quyền đó. Cấu hình: chỉ quản trị viên (`custom_objects.manage`).
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports/custom')
export class CustomReportsController {
  constructor(private readonly reports: CustomReportsService) {}

  @Get()
  @AuthOnly()
  @ApiOperation({ summary: 'Danh sách báo cáo người xem mở được + có quyền cấu hình không' })
  list(@CurrentUser() user: AuthUser) {
    return this.reports.list(user);
  }

  @Get('sources')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Bảng nguồn + trường dùng được (ngày / số / nhóm) cho màn cấu hình' })
  sources(@CurrentUser() user: AuthUser) {
    return this.reports.sources(user);
  }

  @Get('definitions')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Toàn bộ định nghĩa đã lưu (kể cả báo cáo của bảng người cấu hình không xem được) — màn cấu hình sửa trên danh sách này' })
  async definitions() {
    return { reports: await this.reports.readDefs() };
  }

  @Get('presets')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Bộ báo cáo mẫu cài sẵn (theo ngành) + báo cáo nào cài được trên dữ liệu hiện có' })
  presets(@CurrentUser() user: AuthUser) {
    return this.reports.presets(user);
  }

  @Post('presets/:key/install')
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Cài một bộ mẫu: thêm báo cáo có bảng nguồn và chưa trùng mã; không ghi đè báo cáo đã có' })
  installPreset(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.reports.installPreset(user, key);
  }

  @Put()
  @Can('custom_objects.manage')
  @ApiOperation({ summary: 'Lưu toàn bộ danh sách báo cáo (thay thế)' })
  async save(@Body() body: SaveCustomReportsDto, @CurrentUser() user: AuthUser) {
    return { reports: await this.reports.save(user, body.reports) };
  }

  @Get(':id')
  @AuthOnly()
  @ApiOperation({ summary: 'Chạy một báo cáo theo kỳ: số bản ghi, tổng các cột số, theo nhóm, theo tháng' })
  run(@Param('id') id: string, @Query() q: RunCustomReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.reports.run(user, id, q.period);
  }
}
