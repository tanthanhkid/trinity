import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { IntegrationAuditService } from '@trinity/prisma';
import { Public } from '@trinity/rbac-nest';
import { OAUTH_SCOPES, oauthEnabled, protectedResourceMetadataUrl, publicBaseUrl } from '../oauth/oauth-config';
import { clientIp } from '../oauth/oauth-rate-limits';
import { FixedWindowLimiter } from '../../common/helpers/fixed-window-limiter';
import { McpAuthError, McpAuthService } from './mcp-auth.service';
import { MCP_AUTH_FAIL_PER_MINUTE, MCP_REQUESTS_PER_MINUTE, McpRateLimiter } from './mcp-rate-limiter';
import { McpServerService } from './mcp-server.service';

/** Chỉ chặn brute-force token rác theo IP (token thật 256 bit — không dò được, nhưng mỗi lần sai tốn 1 truy vấn DB). */
const authFailLimiter = new FixedWindowLimiter(MCP_AUTH_FAIL_PER_MINUTE, 60_000);

/** Giá trị header HTTP chỉ nhận Latin-1 — mô tả tiếng Việt phải bỏ dấu, nếu không Node ném ERR_INVALID_CHAR (500). */
export const asciiHeader = (v: string): string =>
  v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'");

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/** Origin trình duyệt được phép (chống DNS rebinding — MCP spec Streamable HTTP). Client máy chủ (ChatGPT/Claude) không gửi Origin. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const base = publicBaseUrl(env);
  const extra = (env.INTEGRATIONS_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return new Set([...(base ? [base] : []), 'https://chatgpt.com', 'https://chat.openai.com', 'https://claude.ai', ...extra]);
}

@ApiExcludeController()
@Controller('mcp')
export class McpController {
  constructor(
    private readonly auth: McpAuthService,
    private readonly server: McpServerService,
    private readonly limiter: McpRateLimiter,
    private readonly audit: IntegrationAuditService,
  ) {}

  /** 401/403 theo RFC 6750 + RFC 9728: `resource_metadata` để client tự khám phá AS. */
  private challenge(res: Response, err: McpAuthError): void {
    const base = publicBaseUrl() as string;
    const parts: string[] = [];
    if (err.kind !== 'missing') parts.push(`error="${err.kind}"`, `error_description="${asciiHeader(err.description)}"`);
    // Xin CẢ crm.write: Claude chỉ xin đúng scope ghi ở đây ⇒ thiếu crm.write là mọi tool đề xuất bị chặn
    // insufficient_scope. Người dùng vẫn bỏ được crm.write ở màn đồng ý ("Cho phép AI thay đổi dữ liệu").
    parts.push(`resource_metadata="${protectedResourceMetadataUrl(base)}"`, `scope="${OAUTH_SCOPES.join(' ')}"`);
    res.set('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
    res.set('Cache-Control', 'no-store');
    res.status(err.kind === 'insufficient_scope' ? 403 : 401).json({ error: err.kind === 'missing' ? 'unauthorized' : err.kind, error_description: err.description });
  }

  @Post()
  @Public()
  @HttpCode(200)
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!oauthEnabled()) {
      res.status(404).json({ statusCode: 404, message: 'Not Found' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin.replace(/\/+$/, ''))) {
      res.status(403).json(jsonRpcError(-32000, 'Origin không được phép'));
      return;
    }
    let principal;
    try {
      principal = await this.auth.authenticate(req);
    } catch (err) {
      if (!(err instanceof McpAuthError)) throw err;
      if (!authFailLimiter.hit(clientIp(req)).allowed) {
        res.set('Retry-After', '60').status(429).json({ error: 'rate_limited', error_description: 'Quá nhiều yêu cầu xác thực sai' });
        return;
      }
      if (err.who) await this.audit.log({ channel: 'mcp', action: 'auth', status: 'denied', clientId: err.who.clientId, userId: err.who.userId, error: err.kind });
      this.challenge(res, err);
      return;
    }
    const hit = await this.limiter.hit('req', principal.userId, MCP_REQUESTS_PER_MINUTE);
    if (!hit.allowed) {
      res.set('Retry-After', String(hit.retryAfterSec)).status(429).json(jsonRpcError(-32000, 'Quá giới hạn yêu cầu'));
      return;
    }
    if (Array.isArray(req.body) || req.body === undefined || req.body === null || typeof req.body !== 'object') {
      res.status(400).json(jsonRpcError(-32600, 'Body phải là 1 thông điệp JSON-RPC (không hỗ trợ batch)'));
      return;
    }
    await this.server.handle(req, res, principal);
  }

  /** Stateless: không có luồng GET (SSE) và không có session để DELETE — 405 theo spec. */
  @Get()
  @Public()
  getNotAllowed(@Res() res: Response): void {
    res.set('Allow', 'POST').status(oauthEnabled() ? 405 : 404).json(jsonRpcError(-32000, 'Method not allowed'));
  }

  @Delete()
  @Public()
  deleteNotAllowed(@Res() res: Response): void {
    res.set('Allow', 'POST').status(oauthEnabled() ? 405 : 404).json(jsonRpcError(-32000, 'Method not allowed'));
  }
}
