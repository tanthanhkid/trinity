import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { BroadcastDto, BroadcastPreviewDto, BroadcastSendDto, ChatLinkDto, CommentDryRunDto, CommentReplyDto, CommentRuleDto, FacebookReplyDto, FlowDto, UpdateFacebookPageDto } from './dto-facebook';
import { FacebookChatLinksService } from './facebook-chat-links.service';
import { FacebookCommentsService, normalizePostId, trackCommentRuleSaved } from './facebook-comments.service';
import { FacebookFlowsService } from './facebook-flows.service';
import { FacebookBroadcastsService } from './facebook-broadcasts.service';
import { FacebookMessengerService } from './facebook-messenger.service';
import { FacebookPagesService } from './facebook-pages.service';

/**
 * Quản trị Fanpage + hộp thư. Quyền `integrations.webhooks` (nhóm Kết nối & AI); cờ gói `facebook_page` kiểm ở BE.
 * Token không bao giờ trả ra API.
 */
@ApiTags('Facebook')
@ApiBearerAuth()
@RequireOrgFeature('facebook_page')
@Controller('facebook')
export class FacebookController {
  constructor(
    private readonly pages: FacebookPagesService,
    private readonly messenger: FacebookMessengerService,
    private readonly comments: FacebookCommentsService,
    private readonly chatLinks: FacebookChatLinksService,
    private readonly flows: FacebookFlowsService,
    private readonly broadcasts: FacebookBroadcastsService,
  ) {}

  @Get('status')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Cấu hình máy chủ cho Facebook: đủ env chưa, URL webhook/redirect để dán vào Meta App' })
  status() {
    return this.pages.status();
  }

  @Post('connect-url')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'URL hộp thoại đăng nhập Facebook để chọn Fanpage' })
  @ApiResponse({ status: 503, description: 'Chưa cấu hình Facebook App / khoá mã hoá' })
  connectUrl(@CurrentUser() user: AuthUser) {
    return this.pages.connectUrl(user);
  }

  @Get('pages')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Danh sách Fanpage đã kết nối (không có token)' })
  async list() {
    return { data: await this.pages.list() };
  }

  @Patch('pages/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Đổi sale nhận lead / nguồn khách / bật tắt' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFacebookPageDto, @CurrentUser() user: AuthUser) {
    return this.pages.update(id, dto, user);
  }

  @Post('pages/:id/check')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Kiểm hạn/hiệu lực token ngay' })
  async check(@Param('id', ParseIntPipe) id: number) {
    const page = await this.pages.checkToken(id);
    if (page.token_status === 'active') await this.messenger.refreshMissingNames(page.page_id).catch(() => 0);
    return page;
  }

  @Delete('pages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Ngắt kết nối Fanpage (huỷ đăng ký webhook, xoá token)' })
  disconnect(@Param('id', ParseIntPipe) id: number) {
    return this.pages.disconnect(id);
  }

  @Get('conversations')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Hộp thư: hội thoại Messenger gần nhất' })
  async conversations(@Query('limit') limit?: string, @Query('unanswered') unanswered?: string) {
    return { data: await this.messenger.listConversations(limit ? Number(limit) || 50 : 50, { unanswered: unanswered === '1' || unanswered === 'true' }) };
  }

  @Get('conversations/:id/messages')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tin của một hội thoại (đánh dấu đã đọc)' })
  messages(@Param('id', ParseIntPipe) id: number) {
    return this.messenger.messages(id);
  }

  @Post('conversations/:id/messages')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Trả lời khách — chỉ trong 24 giờ kể từ tin khách gần nhất' })
  @ApiResponse({ status: 400, description: 'Quá 24 giờ / nội dung rỗng' })
  reply(@Param('id', ParseIntPipe) id: number, @Body() dto: FacebookReplyDto, @CurrentUser() user: AuthUser) {
    return this.messenger.reply(id, dto.text, user);
  }

  /* ---- Bình luận tự động (kiểu ManyChat) ---- */

  @Get('comments')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Bình luận gần nhất trên bài của các Page và việc Trinity đã làm' })
  async listComments(@Query('limit') limit?: string, @Query('status') status?: string, @Query('unanswered') unanswered?: string) {
    return { data: await this.comments.listComments({ limit: limit ? Number(limit) || 50 : 50, status: status || undefined, unanswered: unanswered === '1' || unanswered === 'true' }) };
  }

  @Post('comments/:id/reply')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Nhân viên trả lời tay một bình luận: công khai dưới bình luận hoặc nhắn riêng qua Messenger (1 lần, trong 7 ngày)' })
  @ApiResponse({ status: 400, description: 'Nội dung trống / đã nhắn riêng / quá 7 ngày / Facebook từ chối' })
  replyComment(@Param('id') id: string, @Body() dto: CommentReplyDto, @CurrentUser() user: AuthUser) {
    return this.comments.replyManually(id, dto, user.userId);
  }

  @Get('comment-rules')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Luật tự xử lý bình luận' })
  async listRules() {
    return { data: await this.comments.listRules() };
  }

  @Post('comment-rules')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tạo luật (mặc định chế độ thử: chỉ ghi lại, không gửi lên Facebook)' })
  createRule(@Body() dto: CommentRuleDto, @CurrentUser() user: AuthUser) {
    return this.comments.createRule({ ...dto, name: dto.name ?? '' }, user.userId);
  }

  @Patch('comment-rules/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Sửa luật' })
  async updateRule(@Param('id', ParseIntPipe) id: number, @Body() dto: CommentRuleDto, @CurrentUser() user: AuthUser) {
    const rule = await this.comments.updateRule(id, dto);
    trackCommentRuleSaved(rule, false, user.userId);
    return rule;
  }

  @Delete('comment-rules/:id')
  @Can('integrations.webhooks')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Xoá luật (bình luận đã xử lý giữ nguyên)' })
  async deleteRule(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.comments.deleteRule(id);
  }

  @Post('comment-rules/dry-run')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Thử luật với một bình luận mẫu — không ghi, không gửi gì' })
  dryRun(@Body() dto: CommentDryRunDto) {
    return this.comments.dryRun({ ...dto, post_id: dto.post_id ? normalizePostId(dto.post_id, dto.page_id ?? null) : null });
  }

  /* ---- Link/QR mở chat kèm nguồn khách ---- */

  @Get('chat-links')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Link/QR mở chat Messenger: link, nguồn khách, lượt mở, số hội thoại' })
  async listChatLinks() {
    return { data: await this.chatLinks.list() };
  }

  @Post('chat-links')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tạo link/QR mở chat (khách mới vào qua link mang nguồn của link)' })
  createChatLink(@Body() dto: ChatLinkDto, @CurrentUser() user: AuthUser) {
    return this.chatLinks.create(dto, user.userId);
  }

  @Patch('chat-links/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Đổi tên / nguồn khách / bật tắt link (không đổi Page)' })
  updateChatLink(@Param('id', ParseIntPipe) id: number, @Body() dto: ChatLinkDto) {
    const { page_id: _p, ...rest } = dto;
    return this.chatLinks.update(id, rest);
  }

  @Delete('chat-links/:id')
  @Can('integrations.webhooks')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Xoá link (khách đã vào giữ nguyên nguồn; QR đã in sẽ không mở được nữa)' })
  async deleteChatLink(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.chatLinks.remove(id);
  }

  /* ---- Kịch bản nhắn tin nhiều bước ---- */

  @Get('flows')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Kịch bản nhắn tin Messenger: cách bắt đầu, các bước, số lượt chạy / đi hết / đang dở' })
  async listFlows() {
    return { data: await this.flows.list() };
  }

  @Get('flows/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Một kịch bản' })
  getFlow(@Param('id', ParseIntPipe) id: number) {
    return this.flows.get(id);
  }

  @Get('flows/:id/runs')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Lượt chạy gần nhất: khách nào, đang ở bước nào, kết thúc ra sao' })
  async flowRuns(@Param('id', ParseIntPipe) id: number, @Query('limit') limit?: string) {
    return { data: await this.flows.runs(id, limit ? Number(limit) || 50 : 50) };
  }

  @Post('flows')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tạo kịch bản (mặc định TẮT — bật khi đã xem lại)' })
  createFlow(@Body() dto: FlowDto, @CurrentUser() user: AuthUser) {
    return this.flows.create(dto, user.userId);
  }

  @Patch('flows/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Sửa / bật / tắt kịch bản (sửa bước hoặc tắt ⇒ lượt đang dở dừng lại)' })
  updateFlow(@Param('id', ParseIntPipe) id: number, @Body() dto: FlowDto) {
    const { page_id: _p, ...rest } = dto;
    return this.flows.update(id, rest);
  }

  @Delete('flows/:id')
  @Can('integrations.webhooks')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Xoá kịch bản và lịch sử lượt chạy (tin đã gửi giữ nguyên trong hộp thư)' })
  async deleteFlow(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.flows.remove(id);
  }

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Chạy việc Messenger đã tới giờ (bước kịch bản "chờ N phút", lượt gửi hàng loạt) — web gọi định kỳ khi không có job nền' })
  async tick() {
    const [flows, broadcasts, nextFlow, nextBroadcast] = await Promise.all([
      this.flows.kickIfDue(),
      this.broadcasts.kickIfDue(),
      this.flows.nextDueAt(),
      this.broadcasts.nextDueAt(),
    ]);
    const next = [nextFlow, nextBroadcast].filter((d): d is Date => d != null).sort((a, b) => a.getTime() - b.getTime())[0];
    return { due: flows.due || broadcasts.due, next_at: next ? next.toISOString() : null };
  }

  /* ---- Gửi tin hàng loạt (chỉ khách còn trong cửa sổ 24h) ---- */

  @Get('broadcasts')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Các lượt gửi tin hàng loạt: trạng thái, số đã gửi / lỗi / bỏ qua' })
  async listBroadcasts() {
    return { data: await this.broadcasts.list() };
  }

  @Post('broadcasts/preview')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Đếm người nhận: khách còn trong 24h khớp bộ lọc, và số khách đã quá 24h (không gửi được)' })
  previewBroadcast(@Body() dto: BroadcastPreviewDto) {
    return this.broadcasts.preview(dto.page_id, dto.audience ?? {});
  }

  @Get('broadcasts/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Một lượt gửi' })
  getBroadcast(@Param('id', ParseIntPipe) id: number) {
    return this.broadcasts.get(id);
  }

  @Get('broadcasts/:id/recipients')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Người nhận của lượt gửi: đã gửi / lỗi / bỏ qua (quá 24h)' })
  async broadcastRecipients(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.broadcasts.recipients(id) };
  }

  @Post('broadcasts')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tạo lượt gửi (nháp — chưa gửi cho tới khi bấm Gửi)' })
  createBroadcast(@Body() dto: BroadcastDto, @CurrentUser() user: AuthUser) {
    return this.broadcasts.create(dto, user.userId);
  }

  @Patch('broadcasts/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Sửa lượt gửi chưa chạy' })
  updateBroadcast(@Param('id', ParseIntPipe) id: number, @Body() dto: BroadcastDto) {
    return this.broadcasts.update(id, dto);
  }

  @Post('broadcasts/:id/send')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Gửi ngay hoặc hẹn giờ (người nhận chốt lúc tới giờ gửi)' })
  async sendBroadcast(@Param('id', ParseIntPipe) id: number, @Body() dto: BroadcastSendDto) {
    const b = await this.broadcasts.send(id, dto.scheduled_at ?? null);
    if (!dto.scheduled_at) this.broadcasts.kick();
    return b;
  }

  @Post('broadcasts/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Huỷ lượt đang chờ / đang gửi (người chưa nhận sẽ không nhận)' })
  cancelBroadcast(@Param('id', ParseIntPipe) id: number) {
    return this.broadcasts.cancel(id);
  }

  @Delete('broadcasts/:id')
  @Can('integrations.webhooks')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Xoá lượt nháp / đã kết thúc (tin đã gửi giữ nguyên trong hộp thư)' })
  async deleteBroadcast(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.broadcasts.remove(id);
  }
}
