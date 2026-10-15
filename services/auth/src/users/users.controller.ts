import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger'
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import { UsersService } from './users.service'
import { UserListExportService } from './user-list-export.service'
import { CreateUserDto } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { AssignTeamDto } from './dto/assign-team.dto'
import { LockUserDto } from './dto/lock-user.dto'
import { ResetPasswordDto } from './dto/reset-password.dto'

@ApiTags('Users')
@Controller('users')
@ApiBearerAuth()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly userListExportService: UserListExportService,
  ) {}

  @Get()
  @Can('users.view')
  @ApiOperation({ summary: 'Danh sách người dùng (phân trang, filter) — Mẫu A theo scope users.view' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'team_id', required: false, type: Number })
  @ApiQuery({ name: 'role', required: false, type: String })
  @ApiQuery({ name: 'roles', required: false, type: String, description: 'CSV role list' })
  @ApiQuery({ name: 'manager_id', required: false, type: String, description: 'Lọc theo người quản lý. Dùng "none" để lọc user chưa có quản lý.' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'sort_by', required: false, type: String, description: 'Sắp xếp theo: email | full_name | status | created_at' })
  @ApiQuery({ name: 'sort_order', required: false, type: String, description: 'asc | desc' })
  @ApiResponse({ status: 200, description: 'Danh sách người dùng phân trang' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('team_id') teamId?: string,
    @Query('role') role?: string,
    @Query('roles') roles?: string,
    @Query('manager_id') managerId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('sort_by') sortBy?: string,
    @Query('sort_order') sortOrder?: string,
  ) {
    const roleList = roles
      ? roles
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : undefined
    const managerIdParam: number | null | undefined =
      managerId === 'none' ? null : managerId ? +managerId : undefined
    return this.usersService.findAll(
      {
        page: +page,
        // Bảng users nhỏ. Settings > Người dùng fetch 1 lần (limit lớn) để dựng
        // sơ đồ tổ chức client-side KHÔNG phân trang; cap thấp sẽ âm thầm cắt cụt
        // danh sách. Trần 1000 vẫn chặn abuse.
        limit: Math.min(+limit, 1000),
        teamId: teamId ? +teamId : undefined,
        role,
        roles: roleList,
        managerId: managerIdParam,
        search,
        status,
        sortBy: (['email', 'full_name', 'status', 'created_at'] as const).includes(sortBy as never)
          ? (sortBy as 'email' | 'full_name' | 'status' | 'created_at')
          : undefined,
        sortOrder: sortOrder === 'desc' ? 'desc' : sortOrder === 'asc' ? 'asc' : undefined,
      },
      user,
    )
  }

  // PHẢI khai báo TRƯỚC @Get(':id') — nếu không 'export' bị bắt là :id.
  @Get('export')
  @Can('users.export')
  @ApiOperation({
    summary:
      'Xuất Excel danh sách người dùng (theo filter + RBAC scope hiện hành)',
  })
  @ApiQuery({ name: 'team_id', required: false, type: Number })
  @ApiQuery({ name: 'role', required: false, type: String })
  @ApiQuery({ name: 'roles', required: false, type: String, description: 'CSV role list' })
  @ApiQuery({ name: 'manager_id', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'sort_by', required: false, type: String })
  @ApiQuery({ name: 'sort_order', required: false, type: String })
  @ApiResponse({ status: 200, description: 'File Excel danh sách người dùng' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Không có quyền xuất dữ liệu' })
  async exportUsers(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('team_id') teamId?: string,
    @Query('role') role?: string,
    @Query('roles') roles?: string,
    @Query('manager_id') managerId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('sort_by') sortBy?: string,
    @Query('sort_order') sortOrder?: string,
  ): Promise<void> {
    const roleList = roles
      ? roles
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : undefined
    const managerIdParam: number | null | undefined =
      managerId === 'none' ? null : managerId ? +managerId : undefined
    const buffer = await this.userListExportService.exportToExcel(
      {
        page: 1,
        limit: 100_000,
        teamId: teamId ? +teamId : undefined,
        role,
        roles: roleList,
        managerId: managerIdParam,
        search,
        status,
        sortBy: (['email', 'full_name', 'status', 'created_at'] as const).includes(sortBy as never)
          ? (sortBy as 'email' | 'full_name' | 'status' | 'created_at')
          : undefined,
        sortOrder: sortOrder === 'desc' ? 'desc' : sortOrder === 'asc' ? 'asc' : undefined,
      },
      user,
    )
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="danh-sach-nguoi-dung.xlsx"',
    })
    res.end(buffer)
  }

  @Get(':id')
  @Can('users.view')
  @ApiOperation({ summary: 'Chi tiết người dùng — Mẫu B, ngoài scope → 404' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Thông tin chi tiết user + roles[] + team' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng' })
  async findById(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.usersService.findById(id, user)
  }

  @Post()
  @Can('users.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tạo người dùng mới (chưa gán vai trò — gán qua PUT /users/:id/roles)' })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: 'Tạo thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  @ApiResponse({ status: 409, description: 'Email đã tồn tại' })
  async create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.usersService.create(dto, actor)
  }

  @Patch(':id')
  @Can('users.manage')
  @ApiOperation({ summary: 'Cập nhật thông tin người dùng' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({ type: UpdateUserDto })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Tự sửa chính mình, hoặc target có quyền cao hơn actor' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng, hoặc ngoài scope users.manage' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.usersService.update(id, dto, actor)
  }

  @Delete(':id')
  @Can('users.manage')
  @ApiOperation({
    summary:
      'Khoá tài khoản người dùng (soft delete) + cascade reassign managed_users',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({ type: LockUserDto, required: false })
  @ApiResponse({ status: 200, description: 'Đã khoá tài khoản' })
  @ApiResponse({
    status: 400,
    description: 'reassign_to không hợp lệ (self / không active / không tồn tại)',
  })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Tự khoá chính mình, hoặc target có quyền cao hơn actor' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng, hoặc ngoài scope users.manage' })
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LockUserDto = {},
    @CurrentUser() actor: AuthUser,
  ) {
    return this.usersService.delete(id, dto.reassign_to, actor)
  }

  @Delete(':id/permanent')
  @Can('users.manage')
  @ApiOperation({
    summary:
      'Xoá vĩnh viễn người dùng (soft delete sâu) — ẩn khỏi mọi UI quản trị.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({ type: LockUserDto, required: false })
  @ApiResponse({ status: 200, description: 'Đã xoá vĩnh viễn (deleted_at set)' })
  @ApiResponse({
    status: 400,
    description: 'reassign_to không hợp lệ (self / không active / không tồn tại), hoặc xoá Quản trị cuối cùng',
  })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Tự xoá chính mình, hoặc target có quyền cao hơn actor' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng, hoặc ngoài scope users.manage' })
  async permanentDelete(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LockUserDto = {},
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.usersService.softDeletePermanent(id, dto.reassign_to, currentUser)
  }

  @Patch(':id/reset-password')
  @Can('users.manage')
  @ApiOperation({ summary: 'Reset mật khẩu người dùng' })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({ type: ResetPasswordDto, required: true })
  @ApiResponse({ status: 200, description: 'Đã reset mật khẩu thành công (response KHÔNG trả password/hash)' })
  @ApiResponse({ status: 400, description: 'Thiếu mật khẩu hoặc mật khẩu không hợp lệ (< 8 ký tự)' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Tự reset chính mình qua endpoint này, hoặc target có quyền cao hơn actor' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng, hoặc ngoài scope users.manage' })
  async resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetPasswordDto = {},
    @CurrentUser() actor: AuthUser,
  ) {
    return this.usersService.resetPassword(id, dto.password, actor)
  }

  @Get(':id/password-history')
  @Can('users.manage')
  @ApiOperation({ summary: 'Lịch sử đổi/reset mật khẩu của 1 người dùng' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Danh sách log đổi mật khẩu, mới nhất trước — KHÔNG chứa giá trị mật khẩu' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  @ApiResponse({ status: 404, description: 'Ngoài scope users.manage' })
  async getPasswordHistory(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthUser) {
    return this.usersService.getPasswordHistory(id, actor)
  }

  @Patch(':id/team')
  @Can('users.manage')
  @ApiOperation({ summary: 'Gán user vào team (1 user = 1 team) — deprecated, giữ backward-compat' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiBody({ type: AssignTeamDto })
  @ApiResponse({ status: 200, description: 'Gán team thành công, token cũ bị vô hiệu' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Không có quyền' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy user hoặc team' })
  async assignTeam(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignTeamDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.usersService.assignTeam(id, dto.team_id, actor)
  }
}
