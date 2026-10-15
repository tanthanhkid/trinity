import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  ParseIntPipe,
} from '@nestjs/common'
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger'
import { AuthOnly, Can, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { NotificationsService } from './notifications.service'
import { SendNotificationDto } from './dto/send-notification.dto'
import { QueryNotificationDto } from './dto/query-notification.dto'
import { QueryUnreadCountDto } from './dto/query-unread-count.dto'

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // Thông báo của CHÍNH MÌNH — mọi người đăng nhập gọi được, lọc theo user.id
  @Get()
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Danh sach thong bao cua user hien tai' })
  @ApiResponse({ status: 200, description: 'Tra ve danh sach thong bao' })
  findByUser(@Query() query: QueryNotificationDto, @CurrentUser() user: AuthUser) {
    return this.notificationsService.findByUser(
      user.userId,
      query.cursor,
      query.limit ?? 20,
      query.read,
    )
  }

  @Get('unread-count')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'So thong bao chua doc (badge) — dung chung cho badge va tab "Chua doc" trong popup',
  })
  @ApiResponse({ status: 200, description: 'Tra ve so luong chua doc' })
  getUnreadCount(@Query() query: QueryUnreadCountDto, @CurrentUser() user: AuthUser) {
    // Serverless: poll badge của FE cũng kích xử lý thông báo hẹn giờ đến hạn (không chặn response; no-op ngoài serverless).
    this.notificationsService.maybeProcessScheduledInBackground()
    return this.notificationsService.getUnreadCount(user.userId, query.category)
  }

  @Patch(':id/read')
  @AuthOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Danh dau da doc' })
  @ApiResponse({ status: 200, description: 'Danh dau thanh cong' })
  @ApiResponse({ status: 404, description: 'Khong tim thay (khong phai thong bao cua minh)' })
  markAsRead(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notificationsService.markAsRead(id, user.userId)
  }

  // Không có quyền "notifications.send" riêng trong danh mục @trinity/rbac
  // gửi thông báo thủ công dùng `settings.integrations` (nhóm Hệ thống, nhạy cảm).
  @Post('send')
  @Can('settings.integrations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Gui thong bao thu cong' })
  @ApiResponse({ status: 201, description: 'Gui thanh cong' })
  send(@Body() dto: SendNotificationDto) {
    return this.notificationsService.send(dto)
  }
}
