import * as os from 'node:os';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { CreateSocialPostDto, SocialDraftDto, SocialDraftPublishDto, SocialQueueSlotsDto, SocialSnippetDto, GoogleReviewReplyDto, SocialRescheduleDto, SocialConnectDto, SocialMediaRegisterDto, SocialUploadTokenDto, SocialImportDto, SocialImportPlanDto, SocialRecurrenceDto } from './dto-social';
import { MAX_VIDEO_BYTES } from './social.config';
import { SocialAccountsService } from './social-accounts.service';
import { SocialDraftsService } from './social-drafts.service';
import { SocialImportService } from './social-import.service';
import { SocialMediaService } from './social-media.service';
import { SocialPostsService } from './social-posts.service';
import { SocialRecurrenceService } from './social-recurrence.service';
import { SocialQueueService } from './social-queue.service';
import { SocialSnippetsService } from './social-snippets.service';

/**
 * Đăng đa kênh. `social.manage` = liên kết/gỡ kênh, gỡ bài khỏi mạng; `social.post` = soạn, hẹn giờ, xem lịch, huỷ, thử lại.
 * Token không bao giờ trả ra API.
 */
@ApiTags('Social')
@ApiBearerAuth()
@RequireOrgFeature('social_posting')
@Controller('social')
export class SocialController {
  constructor(
    private readonly accounts: SocialAccountsService,
    private readonly posts: SocialPostsService,
    private readonly media: SocialMediaService,
    private readonly drafts: SocialDraftsService,
    private readonly queue: SocialQueueService,
    private readonly snippets: SocialSnippetsService,
    private readonly importer: SocialImportService,
    private readonly recurrences: SocialRecurrenceService,
  ) {}

  @Get('networks')
  @Can('social.post')
  @ApiOperation({ summary: 'Các mạng: đã hỗ trợ chưa, máy chủ đủ cấu hình chưa, URL callback để đăng ký trong app của mạng' })
  async networks() {
    return { data: this.accounts.networks() };
  }

  @Get('accounts')
  @Can('social.post')
  @ApiOperation({ summary: 'Kênh đã liên kết (không có token)' })
  async listAccounts() {
    return { data: await this.accounts.list() };
  }

  @Post('accounts/connect-url')
  @HttpCode(HttpStatus.OK)
  @Can('social.manage')
  @ApiOperation({ summary: 'URL đăng nhập của mạng để liên kết kênh' })
  connectUrl(@Body() dto: SocialConnectDto, @CurrentUser() user: AuthUser) {
    return this.accounts.connectUrl(dto.network, user);
  }

  @Post('accounts/:id/enable')
  @HttpCode(HttpStatus.OK)
  @Can('social.manage')
  @ApiOperation({ summary: 'Bật lại kênh đã gỡ (chỉ khi còn token; không thì liên kết lại)' })
  async enableAccount(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.accounts.enable(id) };
  }

  @Delete('accounts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can('social.manage')
  @ApiOperation({ summary: 'Gỡ kênh (xoá token; bài hẹn giờ còn chờ trên kênh này bị huỷ)' })
  disconnect(@Param('id', ParseIntPipe) id: number) {
    return this.accounts.disconnect(id);
  }

  @Get('accounts/:id/tiktok-creator')
  @Can('social.post')
  @ApiOperation({ summary: 'TikTok creator_info: tên/ảnh tài khoản, quyền xem được chọn, bình luận/Duet/Stitch bị tắt, thời lượng tối đa' })
  async tiktokCreator(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.posts.tiktokCreatorInfo(id) };
  }

  @Get('accounts/:id/youtube-playlists')
  @Can('social.post')
  @ApiOperation({ summary: 'Playlist của kênh YouTube (chọn khi đăng video)' })
  async youtubePlaylists(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.posts.youtubePlaylists(id) };
  }

  @Get('accounts/:id/google-reviews')
  @Can('social.post')
  @ApiOperation({ summary: 'Đánh giá Google của một địa điểm Google Business (mới cập nhật trước, 50/trang)' })
  async googleReviews(@Param('id', ParseIntPipe) id: number, @Query('page_token') pageToken?: string) {
    return { data: await this.posts.gbpReviews(id, pageToken || undefined) };
  }

  @Post('accounts/:id/google-reviews/:reviewId/reply')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Trả lời công khai một đánh giá Google (gửi lại = sửa câu trả lời)' })
  async replyGoogleReview(@Param('id', ParseIntPipe) id: number, @Param('reviewId') reviewId: string, @Body() dto: GoogleReviewReplyDto, @CurrentUser() user: AuthUser) {
    return { data: await this.posts.gbpReply(id, reviewId, dto.comment, user) };
  }

  @Post('media/upload-token')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Token tải tệp thẳng lên Blob (Vercel); 400 nếu môi trường không hỗ trợ → dùng POST social/media' })
  uploadToken(@Body() dto: SocialUploadTokenDto, @CurrentUser() user: AuthUser) {
    return this.media.uploadToken(user, dto.file_name, dto.size);
  }

  @Post('media')
  @Can('social.post')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Tải một ảnh/video (multipart, trường `file`) → khoá dùng trong media_keys' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: os.tmpdir(),
        filename: (_req, _file, cb) => cb(null, `social_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      }),
      limits: { fileSize: MAX_VIDEO_BYTES },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthUser) {
    return this.media.uploadFile(user, file);
  }

  @Post('media/register')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Đưa tệp vừa tải thẳng lên Blob vào thư viện media' })
  register(@Body() dto: SocialMediaRegisterDto, @CurrentUser() user: AuthUser) {
    return this.media.register(user, dto.key, dto.name);
  }

  @Get('media')
  @Can('social.post')
  @ApiOperation({ summary: 'Thư viện ảnh/video dùng chung (mới nhất trước), lọc type=image|video, q=tên' })
  library(@Query('type') type?: string, @Query('q') q?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    return this.media.list({ type, q, limit: n(limit), cursor: n(cursor) });
  }

  @Get('media/:id/file')
  @Can('social.post')
  @ApiOperation({ summary: 'Xem trước một tệp trong thư viện (stream qua BE)' })
  async file(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const f = await this.media.open(id);
    res.set({ 'Content-Type': f.contentType, 'Content-Disposition': 'inline', 'Content-Length': String(f.contentLength), 'Cache-Control': 'private, max-age=3600' });
    return new StreamableFile(f.body);
  }

  @Post('media/:id/hide')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Ẩn tệp khỏi thư viện (không xoá tệp — bài cũ vẫn dùng)' })
  hide(@Param('id', ParseIntPipe) id: number) {
    return this.media.hide(id);
  }

  @Post('posts')
  @Can('social.post')
  @ApiOperation({ summary: 'Tạo bài: đăng ngay (bỏ trống scheduled_at) hoặc hẹn giờ ra nhiều kênh' })
  create(@Body() dto: CreateSocialPostDto, @CurrentUser() user: AuthUser) {
    return this.posts.create(user, { ...dto, source: 'web' });
  }

  @Post('posts/preview')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Xem trước từng kênh sẽ đăng gì (sau UTM, điểm "Xem thêm", cảnh báo); không lưu gì, không giữ khung hàng đợi' })
  async preview(@Body() dto: CreateSocialPostDto, @CurrentUser() user: AuthUser) {
    return { data: await this.posts.preview(user, dto) };
  }

  @Post('posts/import/plan')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Nhập nhiều bài từ CSV — kiểm từng dòng (kênh, giờ, tệp, giới hạn), trả plan_hash; không tạo gì, không giữ khung hàng đợi' })
  async importPlan(@Body() dto: SocialImportPlanDto, @CurrentUser() user: AuthUser) {
    return { data: await this.importer.plan(user, dto.csv, dto.mode) };
  }

  @Post('posts/import')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Nhập nhiều bài từ CSV: kiểm lại, 409 nếu khác plan_hash đã xem; chỉ tạo các dòng hợp lệ (nháp hoặc bài hẹn giờ), từng dòng độc lập' })
  @ApiResponse({ status: 409, description: 'Dữ liệu đã đổi so với bản đã kiểm tra' })
  importPosts(@Body() dto: SocialImportDto, @CurrentUser() user: AuthUser) {
    return this.importer.importCsv(user, dto.csv, dto.mode, dto.plan_hash);
  }

  @Get('drafts')
  @Can('social.post')
  @ApiOperation({ summary: 'Bài nháp chưa đăng (mới sửa trước)' })
  listDrafts() {
    return this.drafts.list();
  }

  @Get('drafts/:id')
  @Can('social.post')
  @ApiOperation({ summary: 'Chi tiết một bài nháp' })
  async getDraft(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.drafts.get(id) };
  }

  @Post('drafts')
  @Can('social.post')
  @ApiOperation({ summary: 'Lưu bài nháp — được thiếu kênh/nội dung/giờ; chưa đăng gì' })
  async createDraft(@Body() dto: SocialDraftDto, @CurrentUser() user: AuthUser) {
    return { data: await this.drafts.create(user, dto, 'web') };
  }

  @Patch('drafts/:id')
  @Can('social.post')
  @ApiOperation({ summary: 'Sửa bài nháp (chỉ trường có gửi); 409 nếu nháp đã đăng' })
  async updateDraft(@Param('id', ParseIntPipe) id: number, @Body() dto: SocialDraftDto, @CurrentUser() user: AuthUser) {
    return { data: await this.drafts.update(user, id, dto) };
  }

  @Delete('drafts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can('social.post')
  @ApiOperation({ summary: 'Xoá bài nháp' })
  removeDraft(@Param('id', ParseIntPipe) id: number) {
    return this.drafts.remove(id);
  }

  @Post('drafts/:id/publish')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Đăng nháp thành bài thật (kiểm đầy đủ như POST social/posts); lỗi thì nháp giữ nguyên' })
  publishDraft(@Param('id', ParseIntPipe) id: number, @Body() dto: SocialDraftPublishDto, @CurrentUser() user: AuthUser) {
    const overrides = { ...(dto.scheduled_at !== undefined ? { scheduled_at: dto.scheduled_at } : {}), ...(dto.use_queue ? { use_queue: true } : {}) };
    return this.drafts.publish(user, id, overrides, 'web', dto.expected_updated_at ? new Date(dto.expected_updated_at) : undefined);
  }

  @Get('snippets')
  @Can('social.post')
  @ApiOperation({ summary: 'Bộ hashtag và chữ ký; ?kind=hashtags|signature để lọc' })
  async listSnippets(@Query('kind') kind?: string) {
    return { data: await this.snippets.list(kind) };
  }

  @Post('snippets')
  @Can('social.post')
  @ApiOperation({ summary: 'Tạo bộ hashtag / chữ ký (tối đa 100 mẫu; chữ ký mặc định chỉ một)' })
  async createSnippet(@Body() dto: SocialSnippetDto, @CurrentUser() user: AuthUser) {
    return { data: await this.snippets.create(user, dto) };
  }

  @Patch('snippets/:id')
  @Can('social.post')
  @ApiOperation({ summary: 'Sửa mẫu (chỉ trường có gửi)' })
  async updateSnippet(@Param('id', ParseIntPipe) id: number, @Body() dto: SocialSnippetDto) {
    return { data: await this.snippets.update(id, dto) };
  }

  @Delete('snippets/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can('social.post')
  @ApiOperation({ summary: 'Xoá mẫu' })
  removeSnippet(@Param('id', ParseIntPipe) id: number) {
    return this.snippets.remove(id);
  }

  @Get('recurrences')
  @Can('social.post')
  @ApiOperation({ summary: 'Bài lặp lại kèm 3 lần đăng tới (tính ra) và các bài đã tạo' })
  async listRecurrences() {
    return { data: await this.recurrences.list() };
  }

  @Post('recurrences')
  @Can('social.post')
  @ApiOperation({ summary: 'Tạo bài lặp lại (hằng ngày/tuần/tháng, giờ Việt Nam); máy chủ luôn giữ đúng một bài hẹn sắp tới' })
  async createRecurrence(@Body() dto: SocialRecurrenceDto, @CurrentUser() user: AuthUser) {
    return { data: await this.recurrences.create(user, dto) };
  }

  @Patch('recurrences/:id')
  @Can('social.post')
  @ApiOperation({ summary: 'Sửa bài lặp lại (chỉ trường có gửi); chỉ áp cho bài sau — bài hẹn đang chờ bị huỷ và tạo lại' })
  async updateRecurrence(@Param('id', ParseIntPipe) id: number, @Body() dto: SocialRecurrenceDto, @CurrentUser() user: AuthUser) {
    return { data: await this.recurrences.update(user, id, dto) };
  }

  @Post('recurrences/:id/pause')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Tạm dừng: huỷ bài hẹn đang chờ (không xoá)' })
  async pauseRecurrence(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.recurrences.pause(id) };
  }

  @Post('recurrences/:id/resume')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Tiếp tục: tính lại lần đăng kế tiếp từ bây giờ' })
  async resumeRecurrence(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.recurrences.resume(id) };
  }

  @Delete('recurrences/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can('social.post')
  @ApiOperation({ summary: 'Xoá lịch lặp (huỷ bài chờ; bài đã đăng giữ nguyên)' })
  removeRecurrence(@Param('id', ParseIntPipe) id: number) {
    return this.recurrences.remove(id);
  }

  @Get('queue/slots')
  @Can('social.post')
  @ApiOperation({ summary: 'Khung giờ đăng hàng đợi hằng tuần (giờ Việt Nam)' })
  async queueSlots() {
    return { data: await this.queue.slots() };
  }

  @Put('queue/slots')
  @Can('social.post')
  @ApiOperation({ summary: 'Thay toàn bộ khung giờ hàng đợi (weekday 0 = Chủ nhật … 6, minute 0–1439)' })
  async setQueueSlots(@Body() dto: SocialQueueSlotsDto) {
    return { data: await this.queue.setSlots(dto.slots) };
  }

  @Get('queue/next')
  @Can('social.post')
  @ApiOperation({ summary: 'Các khung trống gần nhất (mặc định 1, tối đa 20)' })
  async queueNext(@Query('count') count?: string) {
    const n = count && /^\d+$/.test(count) ? Math.min(Math.max(Number(count), 1), 20) : 1;
    return { data: (await this.queue.nextFree(n)).map((d) => d.toISOString()) };
  }

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Đăng các bài đã đến giờ hẹn / đến lượt thử lại (web gọi định kỳ khi không có job nền)' })
  async tick() {
    // Tạo bài tiếp theo của các lịch lặp trước, để bài vừa tạo cũng được tính vào "đến hạn".
    await this.recurrences.materialize().catch(() => undefined);
    const [r, next] = await Promise.all([this.posts.kickIfDue(), this.posts.nextDueAt()]);
    return { due: r.due, next_at: next ? next.toISOString() : null };
  }

  @Get('posts')
  @Can('social.post')
  @ApiOperation({ summary: 'Danh sách / lịch bài (lọc theo khoảng ngày, trạng thái)' })
  list(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    return this.posts.list({ status, from, to, limit: n(limit), cursor: n(cursor) });
  }

  @Get('stats')
  @Can('social.post')
  @ApiOperation({ summary: 'Thống kê bài đã đăng trong khoảng ngày: tổng, theo kênh, bài tương tác cao nhất (mặc định 30 ngày)' })
  stats(@Query('from') from?: string, @Query('to') to?: string, @Query('top') top?: string) {
    const to_ = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : new Date();
    const from_ = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : new Date(to_.getTime() - 30 * 86_400_000);
    if (from_ > to_) throw new BadRequestException('Ngày bắt đầu phải trước ngày kết thúc.');
    if (to_.getTime() - from_.getTime() > 366 * 86_400_000) throw new BadRequestException('Khoảng thống kê tối đa 1 năm.');
    return this.posts.stats({ from: from_, to: to_, top: top && /^\d+$/.test(top) ? Number(top) : undefined });
  }

  @Post('posts/:id/metrics')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Lấy ngay số liệu (lượt xem, cảm xúc, bình luận, chia sẻ) các kênh đã đăng của bài' })
  refreshMetrics(@Param('id', ParseIntPipe) id: number) {
    return this.posts.refreshPostMetrics(id);
  }

  @Get('posts/:id')
  @Can('social.post')
  @ApiOperation({ summary: 'Chi tiết bài + trạng thái từng kênh' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.posts.get(id);
  }

  @Patch('posts/:id')
  @Can('social.post')
  @ApiOperation({ summary: 'Sửa bài đang hẹn giờ (nội dung, tệp, giờ, kênh) trước khi tới giờ đăng' })
  @ApiResponse({ status: 409, description: 'Bài vừa bắt đầu đăng' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateSocialPostDto, @CurrentUser() user: AuthUser) {
    return this.posts.update(user, id, dto);
  }

  @Post('posts/:id/reschedule')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Đổi giờ bài đang hẹn giờ (kéo-thả trên lịch)' })
  reschedule(@Param('id', ParseIntPipe) id: number, @Body() dto: SocialRescheduleDto) {
    return this.posts.reschedule(id, dto.scheduled_at);
  }

  @Post('posts/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Huỷ các kênh chưa đăng của bài' })
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.posts.cancel(id);
  }

  @Post('targets/:id/retry')
  @HttpCode(HttpStatus.OK)
  @Can('social.post')
  @ApiOperation({ summary: 'Thử lại một kênh bị lỗi' })
  retry(@Param('id', ParseIntPipe) id: number) {
    return this.posts.retry(id);
  }

  @Delete('targets/:id/remote')
  @Can('social.manage')
  @ApiOperation({ summary: 'Gỡ bài đã đăng khỏi mạng (nếu mạng cho phép)' })
  deleteRemote(@Param('id', ParseIntPipe) id: number) {
    if (id <= 0) throw new BadRequestException('id không hợp lệ');
    return this.posts.deleteRemote(id);
  }
}
