import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApproveAiActionDto, UpdateAiActionSettingsDto } from './approve-ai-action.dto';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { oauthEnabled } from '../../oauth/oauth-config';
import { AiActionsService } from './ai-actions.service';

const STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired', 'failed'];

/**
 * Hoạt động AI (lịch sử thao tác AI đã ghi) + duyệt đề xuất khi bật "Yêu cầu duyệt thay đổi do AI". 🔴 Route CHỈ nhận JWT phiên web (guard toàn cục): token OAuth của AI là chuỗi opaque `trn_at_…`,
 * không phải JWT ⇒ 401 — AI KHÔNG có đường nào tự duyệt. `@AuthOnly` hợp lệ vì MỌI truy vấn lọc theo CHÍNH `user.userId`
 * (người khác ⇒ 404); quyền nghiệp vụ được kiểm LẠI trong `AiActionsService.approve` + service nghiệp vụ lúc thực thi.
 */
@ApiTags('Integrations — Hoạt động AI')
@ApiBearerAuth()
@Controller('integrations/ai-actions')
export class AiActionsController {
  constructor(private readonly svc: AiActionsService) {}

  /** Cờ tắt ⇒ 404; id ngoài INT32 (Prisma sẽ ném 500) ⇒ 404 như id không tồn tại. */
  private on(id?: number): void {
    if (!oauthEnabled() || (id !== undefined && (id < 1 || id > 2_147_483_647))) throw new NotFoundException();
  }

  @Get()
  @AuthOnly()
  @ApiOperation({ summary: 'Đề xuất AI của CHÍNH mình (mới nhất trước, `?status=`, `?cursor=`, `?limit=`)' })
  @ApiResponse({ status: 200, description: '{ data: DraftView[], next_cursor }' })
  async list(@Query('status') status: string | undefined, @Query('cursor') cursor: string | undefined, @Query('limit') limit: string | undefined, @CurrentUser() user: AuthUser) {
    this.on();
    if (status !== undefined && !STATUSES.includes(status)) throw new BadRequestException('status không hợp lệ');
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const cur = cursor ? Number(cursor) : undefined;
    if (cur !== undefined && (!Number.isInteger(cur) || cur < 1)) throw new BadRequestException('cursor không hợp lệ');
    return this.svc.list(user.userId, { status, cursor: cur, limit: lim });
  }

  @Get('settings')
  @AuthOnly()
  @ApiOperation({ summary: 'Cài đặt duyệt thay đổi do AI (mọi người đăng nhập đọc được — để FE biết có hiện mục chờ duyệt không)' })
  async settings() {
    this.on();
    return { require_approval: await this.svc.requiresApproval() };
  }

  @Patch('settings')
  @Can('integrations.ai_admin')
  @ApiOperation({ summary: 'Bật/tắt "Yêu cầu duyệt thay đổi do AI" (quản trị; mặc định TẮT = AI ghi thẳng theo quyền người dùng)' })
  async updateSettings(@Body() dto: UpdateAiActionSettingsDto, @CurrentUser() user: AuthUser) {
    this.on();
    return this.svc.setRequireApproval(dto.require_approval, user.userId);
  }

  @Get('pending-count')
  @AuthOnly()
  @ApiOperation({ summary: 'Số đề xuất AI đang chờ mình duyệt (cho badge)' })
  async pendingCount(@CurrentUser() user: AuthUser) {
    this.on();
    return { pending: await this.svc.pendingCount(user.userId) };
  }

  @Get(':id')
  @AuthOnly()
  @ApiOperation({ summary: 'Chi tiết 1 đề xuất của mình' })
  @ApiResponse({ status: 404, description: 'Không có / của người khác' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    this.on(id);
    return this.svc.get(user.userId, id);
  }

  @Post(':id/approve')
  @AuthOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Duyệt: thực hiện đề xuất qua service nghiệp vụ với quyền của CHÍNH mình' })
  @ApiResponse({ status: 403, description: 'Mất quyền nghiệp vụ lúc duyệt — đề xuất chuyển `failed` kèm lý do' })
  @ApiResponse({ status: 404, description: 'Không có / của người khác' })
  @ApiResponse({ status: 409, description: 'Đã duyệt/từ chối/hết hạn' })
  @ApiResponse({ status: 400, description: 'Đổi cấu trúc ảnh hưởng dữ liệu mà chưa gõ đúng tên bảng' })
  async approve(@Param('id', ParseIntPipe) id: number, @Body() dto: ApproveAiActionDto, @CurrentUser() user: AuthUser) {
    this.on(id);
    return this.svc.approve(user, id, dto?.confirm_text);
  }

  @Post(':id/reject')
  @AuthOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Từ chối đề xuất của mình' })
  @ApiResponse({ status: 409, description: 'Đã được xử lý hoặc hết hạn' })
  async reject(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    this.on(id);
    return this.svc.reject(user, id);
  }
}
