import { Body, Controller, Get, Put } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import {
  LoginWifiCheckRosterUser,
  LoginWifiCheckTargetsService,
  LoginWifiCheckTargetView,
} from './login-wifi-check-targets.service'
import { ReplaceLoginWifiCheckTargetsDto } from './dto/login-wifi-check-targets.dto'

/**
 * quản lý danh sách ÁP DỤNG (opt-in enforcement) cho "Đăng nhập
 * theo wifi văn phòng". `settings.integrations` cho CẢ GET lẫn ghi (roster +
 * danh sách đã cấu hình là dữ liệu nhân sự toàn công ty, cùng mức nhạy cảm
 * với các mục Hệ thống khác). Đọc/ghi công tắc bật/tắt tổng vẫn ở
 * `AuthController` (`/auth/settings/login-wifi-check`, KHÔNG đổi) — controller
 * này CHỈ quản lý danh sách con bên trong.
 */
@ApiTags('Auth / Login Wifi Check Targets')
@ApiBearerAuth()
@Controller('auth/settings/login-wifi-check-targets')
@Can('settings.integrations')
export class LoginWifiCheckTargetsController {
  constructor(private readonly service: LoginWifiCheckTargetsService) {}

  @Get('roster')
  @ApiOperation({ summary: 'Roster nhân viên active để chọn Phòng/Team/Nhân viên' })
  async getRoster(): Promise<LoginWifiCheckRosterUser[]> {
    return this.service.getRoster()
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách đang cấu hình áp dụng kiểm tra wifi' })
  @ApiResponse({ status: 200, description: '[] = chưa chọn ai, KHÔNG ai bị áp dụng dù công tắc đang bật' })
  async list(): Promise<LoginWifiCheckTargetView[]> {
    return this.service.list()
  }

  @Put()
  @ApiOperation({
    summary: 'Thay TOÀN BỘ danh sách áp dụng',
    description: 'items rỗng = xoá sạch, quay về "chưa chọn ai" (không ai bị áp dụng dù công tắc đang bật)',
  })
  @ApiResponse({ status: 200 })
  async replaceAll(
    @Body() dto: ReplaceLoginWifiCheckTargetsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LoginWifiCheckTargetView[]> {
    return this.service.replaceAll(dto.items, user.userId)
  }
}
