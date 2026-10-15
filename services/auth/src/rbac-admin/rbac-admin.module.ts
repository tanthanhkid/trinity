import { Module } from '@nestjs/common'
import { RolesController } from './roles.controller'
import { UserRolesController } from './user-roles.controller'
import { RbacAuditController } from './rbac-audit.controller'
import { RolesService } from './roles.service'
import { RbacAuditService } from './rbac-audit.service'

/** Quản trị vai trò/quyền. */
@Module({
  controllers: [RolesController, UserRolesController, RbacAuditController],
  providers: [RolesService, RbacAuditService],
  exports: [RolesService, RbacAuditService],
})
export class RbacAdminModule {}
