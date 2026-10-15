import { Body, Controller, Get, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { IntegrationAuditService } from '@trinity/prisma';
import { Public } from '@trinity/rbac-nest';
import { OAuthError } from './oauth-error';
import { oauthEnabled, publicBaseUrl } from './oauth-config';
import { authorizationServerMetadata, protectedResourceMetadata } from './oauth-metadata';
import { OauthClientsService } from './oauth-clients.service';
import { OauthTokenService } from './oauth-token.service';
import { clientIp, registerLimiter, tokenLimiter } from './oauth-rate-limits';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;
const asBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/**
 * OAuth 2.1 Authorization Server. TẤT CẢ route `@Public()` (chỉ tắt PermissionGuard — xác thực nằm trong từng
 * endpoint: PKCE + client auth + rate limit). Cờ `INTEGRATIONS_MCP_ENABLED` + `INTEGRATIONS_PUBLIC_BASE_URL` thiếu ⇒ 404.
 * Lỗi trả theo RFC 6749 (`{error, error_description}`) nên ghi thẳng vào response — KHÔNG ném HttpException
 * (ElkExceptionFilter sẽ đổi sang format `{statusCode,message}` của Nest).
 */
@ApiExcludeController()
@Controller('oauth')
export class OauthController {
  constructor(
    private readonly clients: OauthClientsService,
    private readonly tokens: OauthTokenService,
    private readonly audit: IntegrationAuditService,
  ) {}

  private notFound(res: Response): boolean {
    if (oauthEnabled()) return false;
    res.status(404).json({ statusCode: 404, message: 'Not Found' });
    return true;
  }

  private fail(res: Response, err: unknown): void {
    if (err instanceof OAuthError) {
      res.set(NO_STORE).status(err.status);
      if (err.status === 401) res.set('WWW-Authenticate', 'Basic realm="oauth"');
      res.json(err.body());
      return;
    }
    res.set(NO_STORE).status(500).json({ error: 'server_error', error_description: 'Lỗi máy chủ' });
  }

  private limited(res: Response, hit: { allowed: boolean; retryAfterSec: number }): boolean {
    if (hit.allowed) return false;
    res.set(NO_STORE).set('Retry-After', String(hit.retryAfterSec)).status(429).json({ error: 'temporarily_unavailable', error_description: 'Quá nhiều yêu cầu, thử lại sau' });
    return true;
  }

  @Get('.well-known/oauth-authorization-server')
  @Public()
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=300')
  authorizationServer(@Res({ passthrough: true }) res: Response) {
    if (this.notFound(res)) return undefined;
    return authorizationServerMetadata(publicBaseUrl() as string);
  }

  @Get('protected-resource')
  @Public()
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=300')
  protectedResource(@Res({ passthrough: true }) res: Response) {
    if (this.notFound(res)) return undefined;
    return protectedResourceMetadata(publicBaseUrl() as string);
  }

  @Post('register')
  @Public()
  @HttpCode(201)
  async register(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (this.notFound(res) || this.limited(res, registerLimiter.hit(`reg:${clientIp(req)}`))) return;
    try {
      const out = await this.clients.register(asBody(body));
      await this.audit.log({ channel: 'mcp', action: 'oauth.register', status: 'ok', clientId: String(out.client_id), metadata: { client_name: out.client_name } });
      res.set(NO_STORE).status(201).json(out);
    } catch (err) {
      this.fail(res, err);
    }
  }

  @Post('token')
  @Public()
  @HttpCode(200)
  async token(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (this.notFound(res) || this.limited(res, tokenLimiter.hit(`tok:${clientIp(req)}`))) return;
    try {
      res.set(NO_STORE).status(200).json(await this.tokens.token(asBody(body)));
    } catch (err) {
      this.fail(res, err);
    }
  }

  @Post('revoke')
  @Public()
  @HttpCode(200)
  async revoke(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (this.notFound(res) || this.limited(res, tokenLimiter.hit(`rev:${clientIp(req)}`))) return;
    try {
      await this.tokens.revoke(asBody(body));
      res.set(NO_STORE).status(200).json({});
    } catch (err) {
      this.fail(res, err);
    }
  }
}
