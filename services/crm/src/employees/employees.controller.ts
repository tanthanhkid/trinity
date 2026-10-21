import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { EmployeesService } from './employees.service';
import { EmployeeBirthdayExportService } from './employee-birthday-export.service';
import { EmployeeListExportService } from './employee-list-export.service';
import { QueryEmployeesDto } from './dto/query-employees.dto';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import {
  HrStatsQueryDto,
  BirthdayListQueryDto,
} from './dto/employees-stats.dto';

// RBAC: xem = quyền `employees.view` (phạm vi own|team|subtree|all theo user_id);
// thêm/sửa/khoá/xoá = quyền `employees.manage` (không scoped — danh mục quyền
// không tách delete-only); xuất Excel = quyền `employees.export`.
@ApiTags('Employees')
@ApiBearerAuth()
@Controller('management/employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly birthdayExportService: EmployeeBirthdayExportService,
    private readonly listExportService: EmployeeListExportService,
  ) {}

  @Get()
  @Can('employees.view')
  @ApiOperation({ summary: 'Danh sách nhân viên (phân trang, tìm kiếm, lọc)' })
  @ApiResponse({ status: 200, description: 'Danh sách nhân viên' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  findAll(@CurrentUser() user: AuthUser, @Query() dto: QueryEmployeesDto) {
    return this.employeesService.findAll(dto, user);
  }

  @Get('stats')
  @Can('employees.view')
  @ApiOperation({ summary: 'Thống kê nhân viên theo phòng ban, giới tính, học vấn, chức danh, trạng thái' })
  @ApiResponse({ status: 200, description: 'Số liệu thống kê nhân viên' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  getStats(@CurrentUser() user: AuthUser) {
    return this.employeesService.getStats(user);
  }

  // ── Dashboard "Thống kê nhân viên" (Team + Sinh nhật) ──
  // Khai báo TRƯỚC GET /:id để tránh NestJS resolve "hr-stats"/"birthdays" thành :id.

  @Get('hr-stats')
  @Can('employees.view')
  @ApiOperation({
    summary: 'Thống kê nhân sự theo Team + trạng thái + phân bố sinh nhật theo tháng',
  })
  @ApiResponse({ status: 200, description: 'Số liệu thống kê Team + sinh nhật' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  getHrStats(@CurrentUser() user: AuthUser, @Query() dto: HrStatsQueryDto) {
    return this.employeesService.getHrStats(dto, user);
  }

  @Get('birthdays')
  @Can('employees.view')
  @ApiOperation({ summary: 'Danh sách nhân viên có sinh nhật trong tháng (theo bộ lọc)' })
  @ApiResponse({ status: 200, description: 'Danh sách sinh nhật theo tháng' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  getBirthdays(@CurrentUser() user: AuthUser, @Query() dto: BirthdayListQueryDto) {
    return this.employeesService.getBirthdayList(dto, user);
  }

  @Get('birthdays/export')
  @Can('employees.export')
  @ApiOperation({ summary: 'Xuất Excel danh sách sinh nhật theo tháng (quyền employees.export)' })
  @ApiResponse({ status: 200, description: 'File Excel danh sách sinh nhật' })
  @ApiResponse({ status: 403, description: 'Không có quyền xuất dữ liệu' })
  async exportBirthdays(
    @CurrentUser() user: AuthUser,
    @Query() dto: BirthdayListQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.birthdayExportService.exportToExcel(dto, user);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="danh-sach-sinh-nhat${
        dto.month ? '-thang-' + dto.month : ''
      }.xlsx"`,
    });
    res.end(buffer);
  }

  @Get('export')
  @Can('employees.export')
  @ApiOperation({
    summary:
      'Xuất Excel danh sách nhân viên theo bộ lọc + sắp xếp hiện hành (quyền employees.export)',
  })
  @ApiResponse({ status: 200, description: 'File Excel danh sách nhân viên' })
  @ApiResponse({ status: 403, description: 'Không có quyền xuất dữ liệu' })
  async exportEmployees(
    @CurrentUser() user: AuthUser,
    @Query() dto: QueryEmployeesDto,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.listExportService.exportToExcel(dto, user);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="danh-sach-nhan-vien.xlsx"',
    });
    res.end(buffer);
  }

  @Get(':id')
  @Can('employees.view')
  @ApiOperation({ summary: 'Chi tiết nhân viên' })
  @ApiResponse({ status: 200, description: 'Thông tin chi tiết nhân viên' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy nhân viên' })
  findById(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.employeesService.findById(id, user);
  }

  @Post()
  @Can('employees.manage')
  @ApiOperation({ summary: 'Thêm nhân viên mới (tạo user + employee record)' })
  @ApiResponse({ status: 201, description: 'Nhân viên đã được tạo' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 409, description: 'Email đã tồn tại' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto, user);
  }

  @Patch(':id')
  @Can('employees.manage')
  @ApiOperation({ summary: 'Cập nhật thông tin nhân viên' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy nhân viên' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto, user);
  }

  @Patch(':id/lock')
  @Can('employees.manage')
  @ApiOperation({ summary: 'Khoá tài khoản nhân viên (User.status=locked + Employee.status=resigned)' })
  @ApiResponse({ status: 200, description: 'Đã khoá tài khoản' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy nhân viên' })
  lock(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.employeesService.lock(id, user);
  }

  /** Nút "Mở khoá" trên web. CHỈ Quản trị (kiểm trong service). Không có tool MCP tương ứng. */
  @Patch(':id/unlock')
  @Can('employees.manage')
  @ApiOperation({ summary: 'Mở khoá tài khoản nhân viên (đảo lock: User.status=active + Employee.status=active) — chỉ Quản trị' })
  @ApiResponse({ status: 200, description: 'Đã mở khoá' })
  @ApiResponse({ status: 403, description: 'Không phải Quản trị / tài khoản của chính mình' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy nhân viên' })
  @ApiResponse({ status: 409, description: 'Tài khoản đang không bị khoá' })
  unlock(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.employeesService.unlock(id, user);
  }

  @Delete(':id')
  @Can('employees.manage')
  @ApiOperation({ summary: 'Xoá nhân viên (soft delete)' })
  @ApiResponse({ status: 200, description: 'Đã xoá nhân viên' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy nhân viên' })
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.employeesService.remove(id, user);
  }
}
