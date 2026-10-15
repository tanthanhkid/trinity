import { Body, Controller, Get, Put } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuthOnly, CurrentUser, type AuthUser } from '@trinity/rbac-nest'
import { PinnedMenuService, PinnedMenuResponse } from './pinned-menu.service'
import { UpdatePinnedMenuDto } from './dto/update-pinned-menu.dto'

/**
 * Ghim menu sidebar theo user — preference cá nhân, `@AuthOnly()`:
 * MỌI user đã đăng nhập tự quản lý mục ghim của chính mình, không phân biệt
 * vai trò/quyền (mẫu chính thức "route dành cho mọi người đăng nhập
 * nhưng lọc theo chính mình").
 *
 * ⚠️ FE BẮT BUỘC lọc lại kết quả qua `isItemVisible`/`isChildVisible` trước
 * khi hiển thị — key hợp lệ còn trong DB nhưng quyền hiện tại (có thể vừa bị
 * đổi) không còn thấy thì KHÔNG được render ("ghim cũ sau khi đổi
 * quyền phải tự biến mất, không lộ link"). BE chỉ đảm bảo key nằm trong
 * `KNOWN_MENU_KEYS`, không đảm bảo quyền hiện tại được xem key đó.
 */
@ApiTags('Users — Pinned Menu')
@Controller('users/me/pinned-menu')
@AuthOnly()
@ApiBearerAuth()
export class PinnedMenuController {
  constructor(private readonly pinnedMenuService: PinnedMenuService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách key menu user hiện tại đã ghim' })
  @ApiResponse({ status: 200, description: '{ keys: string[] } — [] = chưa tuỳ chỉnh' })
  async get(@CurrentUser() user: AuthUser): Promise<PinnedMenuResponse> {
    return this.pinnedMenuService.get(user.userId)
  }

  @Put()
  @ApiOperation({ summary: 'Ghi đè toàn bộ danh sách key menu đã ghim' })
  @ApiResponse({ status: 200, description: 'Danh sách sau khi lưu (đã dedupe)' })
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePinnedMenuDto,
  ): Promise<PinnedMenuResponse> {
    return this.pinnedMenuService.update(user.userId, dto.keys)
  }
}
