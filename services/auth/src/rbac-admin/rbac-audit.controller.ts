import { Controller, Get, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Can } from '@trinity/rbac-nest'
import { RbacAuditService } from './rbac-audit.service'
import { AuditQueryDto } from './dto/audit-query.dto'

@ApiTags('RBAC')
@Controller('rbac')
@ApiBearerAuth()
export class RbacAuditController {
  constructor(private readonly audit: RbacAuditService) {}

  @Get('audit')
  @Can('roles.manage')
  @ApiOperation({ summary: 'Nhật ký thay đổi vai trò/quyền (mới nhất trước)' })
  list(@Query() q: AuditQueryDto) {
    return this.audit.list({
      targetType: q.targetType,
      targetId: q.targetId,
      page: q.page,
      limit: q.limit,
    })
  }
}
