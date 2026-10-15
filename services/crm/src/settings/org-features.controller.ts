import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthOnly, Can, CurrentUser as RbacCurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { OrgFeaturesService } from './org-features.service';
import { UpdateOrgFeaturesDto } from './dto/org-features.dto';

/** Công tắc tính năng theo tổ chức — ẩn/hiện UI, KHÔNG thay kiểm quyền. */
@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings/org-features')
export class OrgFeaturesController {
  constructor(private readonly orgFeatures: OrgFeaturesService) {}

  @Get()
  @AuthOnly()
  @ApiOperation({
    summary: 'Tính năng đang bật/tắt của tổ chức (mọi người đăng nhập đọc để dựng menu; dữ liệu không nhạy cảm)',
  })
  @ApiResponse({ status: 200 })
  async get() {
    return this.orgFeatures.get();
  }

  @Put()
  @Can('settings.features')
  @ApiOperation({ summary: 'Bật/tắt tính năng của tổ chức (cập nhật một phần)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'Khoá lạ hoặc giá trị không phải boolean' })
  @ApiResponse({ status: 403 })
  async update(@Body() dto: UpdateOrgFeaturesDto, @RbacCurrentUser() user: AuthUser) {
    return this.orgFeatures.update(dto, user.userId);
  }
}
