import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Can, CanAny, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import { RolesService } from './roles.service'
import { CreateRoleDto } from './dto/create-role.dto'
import { UpdateRoleDto } from './dto/update-role.dto'
import { SetGrantsDto } from './dto/set-grants.dto'

/**
 * API quản trị vai trò. Mọi thay đổi ghi `rbac_audit_log` + vô hiệu
 * cache quyền của người giữ vai trò → `/auth/me` phản ánh NGAY, không cần đăng
 * nhập lại. Chống leo thang: `role-guardrails.ts`.
 */
@ApiTags('Roles')
@Controller('roles')
@ApiBearerAuth()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  // `kanban.boards`: form Bảng Kanban chọn vai trò được thấy bảng.
  @Get()
  @CanAny('roles.manage', 'users.manage', 'kanban.boards')
  @ApiOperation({ summary: 'Danh sách vai trò: {id,name,description,is_system,member_count}' })
  @ApiResponse({ status: 200 })
  list() {
    return this.roles.list()
  }

  @Get(':id')
  @Can('roles.manage')
  @ApiOperation({ summary: 'Chi tiết vai trò + quyền (grants)' })
  @ApiParam({ name: 'id', type: Number })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.roles.get(id)
  }

  @Post()
  @Can('roles.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tạo vai trò (quyền mới phải ⊆ quyền của bạn)' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateRoleDto) {
    return this.roles.create(actor, dto)
  }

  @Post(':id/clone')
  @Can('roles.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Nhân bản vai trò' })
  clone(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.roles.clone(actor, id)
  }

  @Patch(':id')
  @Can('roles.manage')
  @ApiOperation({ summary: 'Đổi tên / mô tả vai trò (không sửa được vai trò hệ thống)' })
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRoleDto) {
    return this.roles.update(actor, id, dto)
  }

  @Put(':id/grants')
  @Can('roles.manage')
  @ApiOperation({ summary: 'Thay toàn bộ quyền của vai trò' })
  setGrants(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetGrantsDto) {
    return this.roles.setGrants(actor, id, dto.grants)
  }

  @Delete(':id')
  @Can('roles.manage')
  @ApiOperation({ summary: 'Xoá vai trò (409 nếu hệ thống hoặc còn người giữ)' })
  remove(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.roles.remove(actor, id)
  }

  @Get(':id/members')
  @Can('roles.manage')
  @ApiOperation({ summary: 'Người đang giữ vai trò (email chỉ hiện với người trong phạm vi users.view của bạn)' })
  members(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.roles.members(actor, id)
  }
}
