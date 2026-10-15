import { Controller, Get, HttpException, Logger, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '@trinity/rbac-nest';
import { isSocialNetwork, socialBaseUrl } from './social.config';
import { SocialAccountsService } from './social-accounts.service';
import { SocialMediaService } from './social-media.service';
import { verifyMediaLink } from './social-media-link';
import { SocialPublishError } from './providers/provider.types';

/**
 * Callback OAuth CÔNG KHAI (trình duyệt được mạng chuyển về). `@Public()` chỉ tắt PermissionGuard —
 * xác thực thật là `state` ký HMAC gắn với người bấm "Liên kết" và đúng mạng.
 */
@ApiTags('Social')
@Controller('social')
export class SocialPublicController {
  private readonly logger = new Logger(SocialPublicController.name);

  constructor(
    private readonly accounts: SocialAccountsService,
    private readonly media: SocialMediaService,
  ) {}

  /** Tệp cho mạng tải về khi đăng (Instagram chỉ nhận URL). Token ký HMAC, hạn 2 giờ — xem `social-media-link.ts`. */
  @Get('media-link/:token/:name')
  @Public()
  @ApiOperation({ summary: 'Link tải tệp có chữ ký cho mạng xã hội lấy ảnh/video khi đăng' })
  async mediaLink(@Param('token') token: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const v = verifyMediaLink(token);
    if (!v) throw new NotFoundException();
    const f = await this.media.openKey(v.key).catch(() => null);
    if (!f) throw new NotFoundException();
    res.set({ 'Content-Type': v.contentType, 'Cache-Control': 'private, max-age=600', ...(f.contentLength ? { 'Content-Length': String(f.contentLength) } : {}) });
    return new StreamableFile(f.body);
  }

  @Get('oauth/callback/:network')
  @Public()
  @ApiOperation({ summary: 'Mạng xã hội chuyển người dùng về đây sau khi đồng ý' })
  async callback(
    @Res() res: Response,
    @Param('network') network: string,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const base = socialBaseUrl() ?? '';
    const back = (q: string) => res.redirect(`${base}/social?tab=channels&${q}`);
    if (!isSocialNetwork(network)) return back('social=error');
    if (error || !code || !state) return back(`social=cancelled&network=${network}`);
    try {
      const r = await this.accounts.handleCallback(network, code, state);
      return back(`social=connected&network=${network}&count=${r.connected}`);
    } catch (err) {
      this.logger.warn(`Callback ${network} lỗi: ${(err as Error).message}`);
      // Chỉ lỗi đã viết cho người dùng (không chứa token) mới đưa về màn hình.
      const reason = err instanceof SocialPublishError || err instanceof HttpException ? (err as Error).message.slice(0, 300) : '';
      return back(`social=error&network=${network}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
    }
  }
}
