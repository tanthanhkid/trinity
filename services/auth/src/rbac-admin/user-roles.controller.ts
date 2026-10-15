import { Body, Controller, Param, ParseIntPipe, Put } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import { RolesService } from './roles.service'
import { SetUserRolesDto } from './dto/set-user-roles.dto'

@ApiTags('Users')
@Controller('users')
@ApiBearerAuth()
export class UserRolesController {
  constructor(private readonly roles: RolesService) {}

  @Put(':id/roles')
  @Can('users.manage')
  @ApiOperation({
    summary: 'Gán (thay toàn bộ) vai trò cho người dùng — chống leo thang',
  })
  setRoles(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetUserRolesDto) {
    return this.roles.setUserRoles(actor, id, dto.roleIds)
  }
}
