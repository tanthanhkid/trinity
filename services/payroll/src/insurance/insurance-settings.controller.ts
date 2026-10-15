import { Controller, Get, Post, Patch, Delete, Param, Body, ParseIntPipe } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger'
import { Can, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { InsuranceSettingsService } from './insurance-settings.service'
import { CreateInsuranceSettingDto, UpdateInsuranceSettingDto } from './dto/insurance-setting.dto'

@ApiTags('insurance-settings')
@ApiBearerAuth()
@Controller('insurance-settings')
export class InsuranceSettingsController {
  constructor(private readonly service: InsuranceSettingsService) {}

  @Get()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Danh sách cấu hình bảo hiểm' })
  @ApiResponse({ status: 200, description: 'Danh sách BHXH/BHYT/BHTN' })
  findAll() {
    return this.service.findAll()
  }

  @Post()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tạo cấu hình bảo hiểm' })
  @ApiResponse({ status: 201, description: 'Tạo thành công' })
  create(@Body() dto: CreateInsuranceSettingDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user?.userId)
  }

  @Patch(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Cập nhật cấu hình bảo hiểm' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInsuranceSettingDto) {
    return this.service.update(id, dto)
  }

  @Delete(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Xoá cấu hình bảo hiểm' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Xoá thành công' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id)
  }
}
