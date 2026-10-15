import { Controller, Get, Post, Patch, Param, Body, Query, ParseIntPipe } from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger'
import { Can } from '@trinity/rbac-nest'
import { SalaryRulesService } from './salary-rules.service'
import { CreateSalaryRuleDto } from './dto/create-rule.dto'
import { UpdateSalaryRuleDto } from './dto/update-rule.dto'

@ApiTags('salary-rules')
@ApiBearerAuth()
@Controller('salary-rules')
export class SalaryRulesController {
  constructor(private readonly salaryRulesService: SalaryRulesService) {}

  @Get()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Danh sách bảng lương' })
  @ApiQuery({ name: 'position', required: false })
  @ApiResponse({ status: 200, description: 'Danh sách salary rules' })
  async findAll(@Query('position') position?: string) {
    if (position) {
      return this.salaryRulesService.findByPosition(position)
    }
    return this.salaryRulesService.findAll()
  }

  @Get(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Chi tiết bảng lương' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Salary rule detail' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  async findById(@Param('id', ParseIntPipe) id: number) {
    return this.salaryRulesService.findById(id)
  }

  @Post()
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tạo bảng lương mới' })
  @ApiResponse({ status: 201, description: 'Tạo thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  async create(@Body() dto: CreateSalaryRuleDto) {
    return this.salaryRulesService.create(dto)
  }

  @Patch(':id')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Cập nhật bảng lương' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSalaryRuleDto) {
    return this.salaryRulesService.update(id, dto)
  }
}
