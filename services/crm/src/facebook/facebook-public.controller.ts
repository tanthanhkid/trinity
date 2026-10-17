import { Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req, Res, Body } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '@trinity/rbac-nest';
import { FORWARDED_HEADER, loadFacebookConfig } from './facebook.config';
import { FacebookChatLinksService } from './facebook-chat-links.service';
import { FacebookPagesService } from './facebook-pages.service';
import { FacebookWebhookService } from './facebook-webhook.service';

/**
 * Các đường CÔNG KHAI cho Meta/trình duyệt (webhook, callback OAuth, link mở chat `go/:code`). `@Public()` chỉ tắt PermissionGuard — xác thực thật:
 * webhook = verify token (GET) + chữ ký X-Hub-Signature-256 (POST); callback OAuth = `state` ký HMAC gắn với người bấm.
 */
@ApiTags('Facebook')
@Controller('facebook')
export class FacebookPublicController {
  constructor(
    private readonly webhook: FacebookWebhookService,
    private readonly pages: FacebookPagesService,
    private readonly chatLinks: FacebookChatLinksService,
  ) {}

  @Get('go/:code')
  @Public()
  @ApiOperation({ summary: 'Link/QR mở chat: đếm lượt mở rồi chuyển sang Messenger của Page kèm mã nguồn' })
  async go(@Res() res: Response, @Param('code') code: string) {
    const to = await this.chatLinks.open(code);
    if (!to) throw new NotFoundException('Link không tồn tại hoặc đã bị xoá');
    res.setHeader('cache-control', 'no-store');
    return res.redirect(302, to);
  }

  @Get('webhook')
  @Public()
  @ApiOperation({ summary: 'Meta xác minh webhook (hub.mode/hub.verify_token/hub.challenge)' })
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.webhook.verify(mode, token, challenge);
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Meta đẩy sự kiện Messenger + leadgen' })
  async receive(@Req() req: Request, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    const forwarded = Boolean(req.headers[FORWARDED_HEADER]);
    await this.webhook.receive((req as Request & { rawBody?: Buffer }).rawBody, signature, body, { forwarded });
    return { status: 'ok' };
  }

  @Get('oauth/callback')
  @Public()
  @ApiOperation({ summary: 'Facebook chuyển người dùng về đây sau khi chọn Fanpage' })
  async callback(@Res() res: Response, @Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string) {
    const base = loadFacebookConfig().baseUrl ?? '';
    const back = (q: string) => res.redirect(`${base}/connections?muc=facebook&${q}`);
    if (error || !code || !state) return back('facebook=cancelled');
    try {
      const r = await this.pages.handleCallback(code, state);
      return back(`facebook=connected&pages=${r.connected}&failed=${r.failed}&posting=${r.posting}`);
    } catch {
      return back('facebook=error');
    }
  }
}
