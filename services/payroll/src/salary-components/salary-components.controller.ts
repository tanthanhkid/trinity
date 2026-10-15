import { Controller, Get, Post, Patch, Delete, Param, Body, Query, ParseIntPipe } from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger'
import { Can, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { SalaryComponentsService } from './salary-components.service'
import { CreateSalaryComponentDto, UpdateSalaryComponentDto } from './dto/salary-component.dto'

// Cấu hình lương chỉ dành cho người giữ `payroll.manage` — không phân biệt
// đọc/ghi/xoá riêng (khác payslips.view vốn scoped theo nhân viên).
@ApiTags('salary-components')
@ApiBearerAuth()
@Controller('salary-components')
export class SalaryComponentsController {
  constructor(private readonly service: SalaryComponentsService) {}

  @Get()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Danh sách thành phần lương' })
  @ApiQuery({ name: 'component_type', required: false })
  @ApiResponse({ status: 200, description: 'Danh sách thành phần lương' })
  async findAll(@Query('component_type') componentType?: string) {
    return this.service.findAll(componentType)
  }

  @Post()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tạo thành phần lương' })
  @ApiResponse({ status: 201, description: 'Tạo thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 409, description: 'Mã đã tồn tại' })
  async create(@Body() dto: CreateSalaryComponentDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user?.userId)
  }

  @Patch(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Cập nhật thành phần lương' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSalaryComponentDto) {
    return this.service.update(id, dto)
  }

  @Delete(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Xoá thành phần lương' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Xoá thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id)
  }
}
