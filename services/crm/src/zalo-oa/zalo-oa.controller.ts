import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Headers, Param, ParseIntPipe, Post, Query, Req, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Can, CurrentUser, Public, type AuthUser } from '@trinity/rbac-nest';
import { LinkThreadDto, SendTextDto, SendZnsDto } from './zalo-oa.dto';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { ZaloOaMessagingService } from './zalo-oa-messaging.service';
import { ZaloOaThreadsService } from './zalo-oa-threads.service';
import { ZaloOaTokenService } from './zalo-oa-token.service';
import { ZaloOaWebhookService } from './zalo-oa-webhook.service';
import { zaloOaConfig } from './zalo-oa.config';

const clampLimit = (v: string | undefined, def: number, max: number): number => Math.min(Math.max(Number(v) || def, 1), max);

/**
 * Zalo OA chính thức. Quyền: kết nối/ngắt/ZNS = `integrations.webhooks` (cùng nhóm "Kết nối & AI");
 * hộp thư (xem/trả lời/ghép khách) = `contacts.update`. Cờ/gói `zalo_oa` tắt ⇒ 403 (`@RequireOrgFeature`; riêng webhook luôn 200 sau khi kiểm chữ ký để Zalo không gửi lại).
 */
@ApiTags('Zalo OA')
@ApiBearerAuth()
@Controller('zalo-oa')
export class ZaloOaController {
  constructor(
    private readonly tokens: ZaloOaTokenService,
    private readonly threads: ZaloOaThreadsService,
    private readonly messaging: ZaloOaMessagingService,
    private readonly webhook: ZaloOaWebhookService,
  ) {}

  @Get('status')
  @Can('contacts.update')
  @RequireOrgFeature('zalo_oa')
  @ApiOperation({ summary: 'Trạng thái kết nối Zalo OA (không trả token)' })
  @ApiResponse({ status: 200, description: 'ZaloOaStatus + webhook_url/redirect_uri cần khai trên Zalo' })
  async status() {
    const cfg = zaloOaConfig();
    return { ...(await this.tokens.status()), redirect_uri: cfg.redirectUri, webhook_path: '/api/v1/zalo-oa/webhook' };
  }

  @Post('connect')
  @Can('integrations.webhooks')
  @RequireOrgFeature('zalo_oa')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bắt đầu cấp quyền OA — trả URL để chuyển trình duyệt sang Zalo' })
  @ApiResponse({ status: 503, description: 'Thiếu cấu hình env' })
  async connect(@CurrentUser() user: AuthUser) {
    return this.tokens.startConnect(user.userId);
  }

  @Get('oauth/callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth của Zalo (đổi code lấy token, rồi chuyển về Cài đặt)' })
  @ApiResponse({ status: 302, description: 'Chuyển về trang Cài đặt kèm ?zalo_oa=connected|error' })
  async callback(@Query('code') code: string, @Query('oa_id') oaId: string, @Query('state') state: string, @Res() res: Response) {
    const back = zaloOaConfig().postConnectUrl;
    const sep = back.includes('?') ? '&' : '?';
    try {
      await this.tokens.completeConnect(code, oaId, state);
      return res.redirect(`${back}${sep}zalo_oa=connected`);
    } catch {
      return res.redirect(`${back}${sep}zalo_oa=error`);
    }
  }

  @Delete('connection')
  @Can('integrations.webhooks')
  @RequireOrgFeature('zalo_oa')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ngắt kết nối (xoá token đã lưu; hội thoại giữ nguyên)' })
  async disconnect(): Promise<void> {
    await this.tokens.disconnect();
  }

  @Get('threads')
  @Can('contacts.update')
  @RequireOrgFeature('zalo_oa')
  @ApiOperation({ summary: 'Danh sách hội thoại (mới nhất trước, phân trang cursor)' })
  async list(@Query('limit') limit?: string, @Query('cursor') cursor?: string, @Query('q') q?: string) {
    return this.threads.list({ limit: clampLimit(limit, 30, 100), cursor: cursor ? Number(cursor) || undefined : undefined, q: typeof q === 'string' ? q.slice(0, 100) : undefined });
  }

  @Get('threads/:id/messages')
  @Can('contacts.update')
  @RequireOrgFeature('zalo_oa')
  @ApiOperation({ summary: 'Tin nhắn của một hội thoại (mới nhất trước; `before` = id tin để lấy trang cũ hơn)' })
  async messages(@Param('id', ParseIntPipe) id: number, @Query('limit') limit?: string, @Query('before') before?: string) {
    if (before !== undefined && !/^\d{1,18}$/.test(before)) throw new BadRequestException('before không hợp lệ');
    return { data: await this.threads.messages(id, { limit: clampLimit(limit, 50, 200), before: before ? BigInt(before) : undefined }) };
  }

  @Post('threads/:id/messages')
  @Can('contacts.update')
  @RequireOrgFeature('zalo_oa')
  @ApiOperation({ summary: 'Trả lời khách bằng tin tư vấn (chỉ trong 48 giờ kể từ tin gần nhất của khách)' })
  @ApiResponse({ status: 400, description: 'Quá 48h / chưa kết nối / Zalo từ chối' })
  async reply(@Param('id', ParseIntPipe) id: number, @Body() dto: SendTextDto, @CurrentUser() user: AuthUser) {
    return this.messaging.sendText(id, dto.text, user.userId);
  }

  @Post('threads/:id/read')
  @Can('contacts.update')
  @RequireOrgFeature('zalo_oa')
  @HttpCode(204)
  @ApiOperation({ summary: 'Đánh dấu đã đọc' })
  async read(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.threads.markRead(id);
  }

  @Post('threads/:id/link')
  @Can('contacts.update')
  @RequireOrgFeature('zalo_oa')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ghép hội thoại với khách CRM (theo contact_id, hoặc SĐT: tìm/tạo)' })
  async link(@Param('id', ParseIntPipe) id: number, @Body() dto: LinkThreadDto, @CurrentUser() user: AuthUser) {
    if (!dto.contact_id && !dto.phone) throw new BadRequestException('Cần contact_id hoặc phone');
    return this.threads.link(id, { contactId: dto.contact_id, phone: dto.phone }, user.userId);
  }

  @Post('zns')
  @Can('integrations.webhooks')
  @RequireOrgFeature('zalo_oa')
  @HttpCode(200)
  @ApiOperation({ summary: 'Gửi ZNS theo mẫu đã duyệt tới một số điện thoại' })
  @ApiResponse({ status: 400, description: 'SĐT/mẫu/dữ liệu sai, hết quota, chưa kết nối' })
  async zns(@Body() dto: SendZnsDto, @CurrentUser() user: AuthUser) {
    const data = Object.fromEntries(Object.entries(dto.template_data).map(([k, v]) => [k, String(v)]));
    return this.messaging.sendZns({ phone: dto.phone, templateId: dto.template_id, templateData: data, trackingId: dto.tracking_id, sentBy: user.userId });
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook Zalo OA (xác thực X-ZEvent-Signature = sha256(app_id + body + timestamp + OA secret))' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 401, description: 'Sai/thiếu chữ ký hoặc chưa cấu hình ZALO_WEBHOOK_SECRET' })
  async hook(@Req() req: Request, @Headers('x-zevent-signature') sig: string | undefined) {
    const out = await this.webhook.receive((req as Request & { rawBody?: Buffer }).rawBody, sig);
    return { ok: out.ok };
  }
}
