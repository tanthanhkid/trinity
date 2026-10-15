import { Controller, Get, Post, Body, HttpCode, HttpStatus } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger'
import { AuthOnly, Can } from '@trinity/rbac-nest'
import { TeamsService } from './teams.service'

/**
 * @deprecated Nguồn sự thật về quan hệ
 * team là `User.manager_id` (Sơ đồ tổ chức). Endpoint này được giữ lại tạm thời
 * cho backward-compat và sẽ bị xoá ở release sau.
 * Không thêm consumer mới. Chỉnh sửa cơ cấu tổ chức tại Settings → Sơ đồ tổ chức.
 */
@ApiTags('Teams (Deprecated)')
@Controller('auth/teams')
@ApiBearerAuth()
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  /** @deprecated Dùng Sơ đồ tổ chức (User.manager_id) thay cho teams. Đọc danh mục — mọi user đăng nhập. */
  @Get()
  @AuthOnly()
  @ApiOperation({ summary: '[Deprecated] Danh sách teams' })
  @ApiResponse({ status: 200, description: 'Danh sách teams với member count' })
  async findAll() {
    return this.teamsService.findAll()
  }

  /** @deprecated Dùng Sơ đồ tổ chức (User.manager_id) thay cho teams. */
  @Post()
  @Can('org.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[Deprecated] Tạo team mới' })
  @ApiResponse({ status: 201, description: 'Tạo team thành công' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  async create(@Body() body: { name: string; leadUserId: number }) {
    return this.teamsService.create(body.name, body.leadUserId)
  }
}
