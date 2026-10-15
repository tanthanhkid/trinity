import { Module } from '@nestjs/common'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'
import { UserListExportService } from './user-list-export.service'
import { PinnedMenuController } from './pinned-menu.controller'
import { PinnedMenuService } from './pinned-menu.service'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [UsersController, PinnedMenuController],
  providers: [UsersService, UserListExportService, PinnedMenuService],
  exports: [UsersService],
})
export class UsersModule {}
