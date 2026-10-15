import { Injectable } from '@nestjs/common';
import { IntegrationAuditService, PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { randomUUID } from 'node:crypto';
import {
  assertRedirectUri,
  authorizeFingerprint,
  buildClientRedirect,
  validateAuthorizeRest,
  type AuthorizeInput,
  type ValidAuthorize,
} from './authorize-request';
import { CODE_TTL_MS, CONSENT_TTL_SEC, SCOPE_LABELS, publicBaseUrl } from './oauth-config';
import { randomToken, sha256Hex, signConsent, verifyConsent } from './oauth-crypto';
import { OAuthError, RedirectableOAuthError } from './oauth-error';
import { OauthClientsService } from './oauth-clients.service';
import { isLoopbackUri, redirectHost } from './redirect-uri';

/** Nhãn nhận diện CHỈ khi redirect đi tới đúng host đã biết — tên client do client tự khai nên không đáng tin một mình. */
const KNOWN_REDIRECT_HOSTS: Record<string, string> = {
  'chatgpt.com': 'ChatGPT (OpenAI)',
  'claude.ai': 'Claude (Anthropic)',
};

export type ContextResult =
  | {
      ok: true;
      client: {
        name: string;
        logo_uri: string | null;
        client_uri: string | null;
        kind: string;
        redirect_uri: string;
        redirect_host: string;
        loopback: boolean;
        known_as: string | null;
      };
      scopes: { scope: string; label: string; description: string; available: boolean; optional: boolean }[];
      consent_token: string;
      expires_in: number;
    }
  | { ok: false; redirect_to: string };

@Injectable()
export class OauthAuthorizeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: OauthClientsService,
    private readonly audit: IntegrationAuditService,
  ) {}

  private base(): string {
    const b = publicBaseUrl();
    if (!b) throw new OAuthError('server_error', 'Chưa cấu hình INTEGRATIONS_PUBLIC_BASE_URL', 503);
    return b;
  }

  /** Kiểm đầy đủ. Ném `OAuthError` (hiện trên trang) hoặc `RedirectableOAuthError` (redirect về client). */
  private async validate(input: AuthorizeInput): Promise<ValidAuthorize> {
    const base = this.base();
    const clientId = typeof input.client_id === 'string' ? input.client_id : '';
    const client = await this.clients.resolve(clientId, true);
    const redirectUri = assertRedirectUri(client, input);
    return validateAuthorizeRest(client, redirectUri, input, base);
  }

  private errorRedirect(err: RedirectableOAuthError, input: AuthorizeInput): { ok: false; redirect_to: string } {
    const state = typeof input.state === 'string' ? input.state.slice(0, 512) : undefined;
    const uri = String(input.redirect_uri);
    return { ok: false, redirect_to: buildClientRedirect(uri, this.base(), { error: err.code, error_description: err.description, state }) };
  }

  async context(user: AuthUser, input: AuthorizeInput): Promise<ContextResult> {
    let v: ValidAuthorize;
    try {
      v = await this.validate(input);
    } catch (err) {
      if (err instanceof RedirectableOAuthError) return this.errorRedirect(err, input);
      throw err;
    }
    const host = redirectHost(v.redirectUri);
    return {
      ok: true,
      client: {
        name: v.client.name,
        logo_uri: v.client.logo_uri,
        client_uri: v.client.client_uri,
        kind: v.client.kind,
        redirect_uri: v.redirectUri,
        redirect_host: host,
        loopback: isLoopbackUri(v.redirectUri),
        known_as: KNOWN_REDIRECT_HOSTS[host.toLowerCase()] ?? null,
      },
      scopes: v.scopes.map((s) => ({ scope: s, ...SCOPE_LABELS[s] })),
      consent_token: signConsent({ u: user.userId, h: authorizeFingerprint(v), e: Math.floor(Date.now() / 1000) + CONSENT_TTL_SEC }),
      expires_in: CONSENT_TTL_SEC,
    };
  }

  /** Trả `redirect_to` — FE điều hướng trình duyệt tới đó. Mọi tham số được kiểm LẠI từ đầu (không tin FE). */
  async decide(user: AuthUser, input: AuthorizeInput, approve: boolean, consentToken: string, grantedScopes?: string[]): Promise<{ redirect_to: string }> {
    let v: ValidAuthorize;
    try {
      v = await this.validate(input);
    } catch (err) {
      if (err instanceof RedirectableOAuthError) return { redirect_to: this.errorRedirect(err, input).redirect_to };
      throw err;
    }
    const claims = verifyConsent(consentToken);
    if (!claims || claims.u !== user.userId || claims.h !== authorizeFingerprint(v)) {
      throw new OAuthError('invalid_request', 'Phiên đồng ý không hợp lệ hoặc đã hết hạn — hãy tải lại trang');
    }
    // Người dùng có thể BỎ scope tuỳ chọn (crm.write) ở màn đồng ý: chỉ nhận tập con của scope đã hiển thị, không bao giờ rộng hơn.
    const scopes = grantedScopes === undefined ? v.scopes : grantedScopes.filter((x, i, a) => a.indexOf(x) === i);
    if (approve && (scopes.length === 0 || scopes.some((x) => !(v.scopes as string[]).includes(x)) || v.scopes.some((x) => !SCOPE_LABELS[x].optional && !scopes.includes(x)))) {
      throw new OAuthError('invalid_request', 'Phạm vi được cấp không hợp lệ — hãy tải lại trang');
    }
    const meta = { scopes, requested_scopes: v.scopes, client_name: v.client.name, redirect_host: redirectHost(v.redirectUri) };
    if (!approve) {
      await this.audit.log({ channel: 'mcp', action: 'oauth.authorize', status: 'denied', clientId: v.client.client_id, userId: user.userId, metadata: { ...meta, reason: 'user_denied' } });
      return { redirect_to: buildClientRedirect(v.redirectUri, this.base(), { error: 'access_denied', error_description: 'Người dùng từ chối', state: v.state }) };
    }
    const code = randomToken(32);
    await this.prisma.oauthAuthorizationCode.create({
      data: {
        code_hash: sha256Hex(code),
        client_id: v.client.client_id,
        user_id: user.userId,
        redirect_uri: v.redirectUri,
        code_challenge: v.codeChallenge,
        scopes,
        resource: v.resource,
        family_id: randomUUID(),
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      },
      select: { id: true },
    });
    await this.clients.touch(v.client);
    await this.audit.log({ channel: 'mcp', action: 'oauth.authorize', status: 'ok', clientId: v.client.client_id, userId: user.userId, metadata: meta });
    return { redirect_to: buildClientRedirect(v.redirectUri, this.base(), { code, state: v.state }) };
  }
}
