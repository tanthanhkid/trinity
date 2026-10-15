import {
  Body,
  Controller,
  Get,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthOnly, Can, CurrentUser as RbacCurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { SettingsService } from './settings.service';
import { UpdateNotificationSoundDto } from './dto/notification-sound.dto';
import { UpdateDepartmentsDto } from './dto/departments.dto';

/**
 * RBAC: mọi route đã chuyển sang `@Can`/`@AuthOnly` (đọc bởi
 * `PermissionGuard` toàn cục); `departments` GET/PATCH = `@AuthOnly`/`@Can('org.manage')`.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('notification-sound')
  @AuthOnly()
  @ApiOperation({
    summary: 'Lấy âm báo thông báo chung toàn hệ thống (mọi người đăng nhập đọc được)',
  })
  @ApiResponse({ status: 200 })
  async getNotificationSound() {
    return this.settingsService.getNotificationSound();
  }

  @Patch('notification-sound')
  @Can('settings.integrations')
  @ApiOperation({
    summary: 'Đổi âm báo thông báo chung — áp dụng cho mọi nhân viên',
  })
  @ApiResponse({ status: 200 })
  async updateNotificationSound(
    @Body() dto: UpdateNotificationSoundDto,
    @RbacCurrentUser() user: AuthUser,
  ) {
    return this.settingsService.updateNotificationSound(dto.sound_id, user.userId);
  }

  // RBAC: đọc mở cho mọi người đã đăng nhập (dropdown
  // dùng ở nhiều màn); ghi cần quyền `org.manage` (sơ đồ tổ chức, phòng ban,
  // team, chức danh).
  @Get('departments')
  @AuthOnly()
  @ApiOperation({
    summary: 'Lấy danh sách phòng ban cấu hình chung (mọi người đã đăng nhập — cho dropdown)',
  })
  @ApiResponse({ status: 200 })
  async getDepartments() {
    return this.settingsService.getDepartments();
  }

  @Patch('departments')
  @Can('org.manage')
  @ApiOperation({
    summary: 'Cập nhật danh sách phòng ban (quyền org.manage)',
  })
  @ApiResponse({ status: 200 })
  async updateDepartments(
    @Body() dto: UpdateDepartmentsDto,
    @RbacCurrentUser() user: AuthUser,
  ) {
    return this.settingsService.updateDepartments(dto.departments, user.userId);
  }
}
