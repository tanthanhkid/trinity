import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { OAuthError } from './oauth-error';
import { oauthEnabled } from './oauth-config';
import { OauthAuthorizeService } from './oauth-authorize.service';
import { consentLimiter } from './oauth-rate-limits';
import type { AuthorizeInput } from './authorize-request';

const isObj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);

/**
 * Màn đồng ý OAuth (trang Next `/oauth/authorize` gọi 2 route này bằng phiên đăng nhập Trinity — Bearer JWT).
 * 🔴 KHÔNG tin FE: `decision` kiểm LẠI client/redirect_uri/PKCE/resource từ đầu + token consent (HMAC, 10 phút) ràng buộc
 * quyết định với đúng người + đúng tham số vừa hiển thị (CSRF/đổi tham số giữa chừng). Bearer-header (không cookie) nên
 * CSRF cổ điển không áp dụng; token consent là lớp thừa có chủ đích.
 */
@ApiTags('Integrations — OAuth')
@ApiBearerAuth()
@Controller('oauth/authorize')
export class OauthConsentController {
  constructor(private readonly svc: OauthAuthorizeService) {}

  private guard(user: AuthUser, res: Response): boolean {
    if (!oauthEnabled()) {
      res.status(404).json({ statusCode: 404, message: 'Not Found' });
      return true;
    }
    const hit = consentLimiter.hit(`consent:${user.userId}`);
    if (!hit.allowed) {
      res.set('Retry-After', String(hit.retryAfterSec)).status(429).json({ error: 'temporarily_unavailable', error_description: 'Quá nhiều yêu cầu, thử lại sau' });
      return true;
    }
    return false;
  }

  private fail(res: Response, err: unknown): void {
    if (err instanceof OAuthError) {
      res.status(err.status === 401 ? 400 : err.status).json(err.body());
      return;
    }
    res.status(500).json({ error: 'server_error', error_description: 'Lỗi máy chủ' });
  }

  @Post('context')
  @Can('integrations.ai_connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Kiểm yêu cầu uỷ quyền + trả thông tin hiển thị màn đồng ý', description: 'Body: { params: {response_type, client_id, redirect_uri, scope?, state?, code_challenge, code_challenge_method, resource?} }' })
  @ApiResponse({ status: 200, description: '{ ok:true, client, scopes, consent_token } hoặc { ok:false, redirect_to }' })
  @ApiResponse({ status: 400, description: 'client_id/redirect_uri sai — KHÔNG redirect, hiện lỗi trên trang' })
  @ApiResponse({ status: 404, description: 'Kết nối AI chưa bật' })
  async context(@Body() body: unknown, @CurrentUser() user: AuthUser, @Res() res: Response): Promise<void> {
    if (this.guard(user, res)) return;
    try {
      const params = isObj(body) && isObj(body.params) ? (body.params as AuthorizeInput) : {};
      res.status(200).json(await this.svc.context(user, params));
    } catch (err) {
      this.fail(res, err);
    }
  }

  @Post('decision')
  @Can('integrations.ai_connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cho phép / Từ chối — trả `redirect_to` để FE điều hướng về client' })
  @ApiResponse({ status: 200, description: '{ redirect_to }' })
  @ApiResponse({ status: 400, description: 'Tham số/consent_token sai hoặc hết hạn' })
  async decision(@Body() body: unknown, @CurrentUser() user: AuthUser, @Res() res: Response): Promise<void> {
    if (this.guard(user, res)) return;
    try {
      const b = isObj(body) ? body : {};
      const params = isObj(b.params) ? (b.params as AuthorizeInput) : {};
      if (typeof b.approve !== 'boolean' || typeof b.consent_token !== 'string') {
        throw new OAuthError('invalid_request', 'Thiếu approve hoặc consent_token');
      }
      const granted = b.granted_scopes;
      if (granted !== undefined && (!Array.isArray(granted) || granted.length > 8 || granted.some((x) => typeof x !== 'string'))) {
        throw new OAuthError('invalid_request', 'granted_scopes phải là mảng chuỗi');
      }
      res.status(200).json(await this.svc.decide(user, params, b.approve, b.consent_token, granted as string[] | undefined));
    } catch (err) {
      this.fail(res, err);
    }
  }
}
