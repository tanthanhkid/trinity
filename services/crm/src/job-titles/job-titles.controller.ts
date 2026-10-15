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
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { can } from '@trinity/rbac'
import { type AuthUser, AuthOnly, Can, CurrentUser } from '@trinity/rbac-nest'
import { JobTitlesService } from './job-titles.service'
import { CreateJobTitleDto } from './dto/create-job-title.dto'
import { UpdateJobTitleDto } from './dto/update-job-title.dto'
import { QueryJobTitlesDto } from './dto/query-job-titles.dto'

/** Danh mục (id/tên/nhóm) mở cho mọi người đăng nhập; các mức lương chỉ cho người quản lý tổ chức/lương. */
function canSeeSalary(user: AuthUser): boolean {
  return user.isAdmin || can(user.grants, 'org.manage') || can(user.grants, 'payroll.view') || can(user.grants, 'payroll.manage')
}

function redactSalary<T extends { base_salary: string; standard_target: string; default_insurance_salary: string | null }>(row: T) {
  return { ...row, base_salary: null, standard_target: null, default_insurance_salary: null }
}

// RBAC: đọc danh mục chức danh mở cho mọi người đã đăng nhập (mirror contacts.catalog);
// ghi cần `org.manage` (sơ đồ tổ chức, phòng ban, team, chức danh).
@ApiTags('JobTitles')
@ApiBearerAuth()
@Controller('management/job-titles')
export class JobTitlesController {
  constructor(private readonly jobTitlesService: JobTitlesService) {}

  @Get()
  @AuthOnly()
  @ApiOperation({ summary: 'Danh sách chức danh (lọc theo nhóm / trạng thái)' })
  @ApiResponse({ status: 200, description: 'Danh sách chức danh' })
  async findAll(@Query() dto: QueryJobTitlesDto, @CurrentUser() user: AuthUser) {
    const rows = await this.jobTitlesService.findAll(dto)
    return canSeeSalary(user) ? rows : rows.map(redactSalary)
  }

  @Get(':id')
  @AuthOnly()
  @ApiOperation({ summary: 'Chi tiết chức danh' })
  @ApiResponse({ status: 200, description: 'Thông tin chi tiết chức danh' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy chức danh' })
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const row = await this.jobTitlesService.findOne(id)
    return canSeeSalary(user) ? row : redactSalary(row)
  }

  @Post()
  @Can('org.manage')
  @ApiOperation({ summary: 'Tạo chức danh mới' })
  @ApiResponse({ status: 201, description: 'Chức danh đã được tạo' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 409, description: 'Mã cấp bậc đã tồn tại' })
  create(@Body() dto: CreateJobTitleDto) {
    return this.jobTitlesService.create(dto)
  }

  @Patch(':id')
  @Can('org.manage')
  @ApiOperation({ summary: 'Cập nhật thông tin chức danh' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy chức danh' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateJobTitleDto) {
    return this.jobTitlesService.update(id, dto)
  }

  @Delete(':id')
  @Can('org.manage')
  @ApiOperation({ summary: 'Xoá chức danh (quyền org.manage)' })
  @ApiResponse({ status: 200, description: 'Đã xoá chức danh' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy chức danh' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.jobTitlesService.remove(id)
  }
}
