import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
} from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger'
import { Can, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { EmployeesService } from './employees.service'
import { CreateEmployeeDto } from './dto/create-employee.dto'
import { UpdateEmployeeDto } from './dto/update-employee.dto'
import { QueryEmployeeDto } from './dto/query-employee.dto'

@ApiTags('employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @Can('employees.view')
  @ApiOperation({ summary: 'Danh sách nhân viên' })
  @ApiResponse({ status: 200, description: 'Danh sách employees' })
  async findAll(@Query() query: QueryEmployeeDto, @CurrentUser() user: AuthUser) {
    return this.employeesService.findAll(query, user)
  }

  @Get(':id')
  @Can('employees.view')
  @ApiOperation({ summary: 'Chi tiết nhân viên + salary history + KPI' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Employee detail' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  async findById(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.employeesService.findById(id, user)
  }

  @Post()
  @Can('employees.manage')
  @ApiOperation({ summary: 'Tạo hồ sơ nhân viên' })
  @ApiResponse({ status: 201, description: 'Tạo thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 409, description: 'User đã có hồ sơ nhân viên' })
  async create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto)
  }

  @Patch(':id')
  @Can('employees.manage')
  @ApiOperation({ summary: 'Cập nhật hồ sơ nhân viên' })
  @ApiParam({ name: 'id', type: 'number' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto)
  }
}
