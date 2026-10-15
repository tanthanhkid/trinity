import type { OauthClient } from '@prisma/client';
import { CODE_CHALLENGE_RE, sha256Hex } from './oauth-crypto';
import { OAuthError, RedirectableOAuthError } from './oauth-error';
import {
  ADVERTISED_SCOPES,
  DEFAULT_SCOPES,
  OAUTH_SCOPES,
  isCanonicalResource,
  issuerUrl,
  mcpResourceUrl,
  type OauthScope,
} from './oauth-config';
import { redirectUriMatches } from './redirect-uri';

/** Tham số yêu cầu uỷ quyền như client gửi (chưa tin). */
export interface AuthorizeInput {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  scope?: unknown;
  state?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  resource?: unknown;
}

export interface ValidAuthorize {
  client: OauthClient;
  redirectUri: string;
  scopes: OauthScope[];
  state: string | undefined;
  resource: string;
  codeChallenge: string;
}

const MAX_STATE = 512;
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** URL trả về cho client kèm `iss` (RFC 9207 — chống mix-up) và `state`. */
export function buildClientRedirect(redirectUri: string, base: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuerUrl(base));
  return u.toString();
}

/** Kiểm redirect_uri với client ĐÃ resolve. Sai ⇒ KHÔNG redirect (chống open redirect) — hiện lỗi trên trang. */
export function assertRedirectUri(client: OauthClient, input: AuthorizeInput): string {
  const uri = optStr(input.redirect_uri);
  if (!uri || !client.redirect_uris.some((reg) => redirectUriMatches(reg, uri))) {
    throw new OAuthError('invalid_request', 'redirect_uri không khớp với địa chỉ client đã đăng ký');
  }
  return uri;
}

function parseScopes(raw: unknown): OauthScope[] {
  const asked = typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : [];
  if (asked.some((s) => !ADVERTISED_SCOPES.includes(s))) throw new Error('invalid_scope');
  const real = Array.from(new Set(asked.filter((s): s is OauthScope => (OAUTH_SCOPES as readonly string[]).includes(s))));
  return real.length ? real : [...DEFAULT_SCOPES];
}

/**
 * Kiểm phần CÒN LẠI sau khi client + redirect_uri đã hợp lệ. Mọi lỗi ở đây là `RedirectableOAuthError`
 * (redirect_uri đã tin được ⇒ báo lỗi về cho client kèm `state`).
 * PKCE: chỉ S256 (OAuth 2.1) — `plain`/thiếu ⇒ từ chối (chống downgrade). `resource` phải là URL MCP của CHÍNH ta.
 */
export function validateAuthorizeRest(client: OauthClient, redirectUri: string, input: AuthorizeInput, base: string): ValidAuthorize {
  const fail = (code: string, desc: string): never => {
    throw new RedirectableOAuthError(code, desc);
  };
  const state = optStr(input.state);
  if (state !== undefined && state.length > MAX_STATE) fail('invalid_request', 'state quá dài');
  if (input.response_type !== 'code') fail('unsupported_response_type', 'Chỉ hỗ trợ response_type=code');
  const challenge = optStr(input.code_challenge);
  if (!challenge || !CODE_CHALLENGE_RE.test(challenge)) fail('invalid_request', 'Thiếu hoặc sai code_challenge (PKCE bắt buộc)');
  if (input.code_challenge_method !== 'S256') fail('invalid_request', 'code_challenge_method phải là S256');
  let scopes: OauthScope[] = [];
  try {
    scopes = parseScopes(input.scope);
  } catch {
    fail('invalid_scope', 'scope không được hỗ trợ');
  }
  const resourceIn = optStr(input.resource);
  if (resourceIn !== undefined && !isCanonicalResource(resourceIn, base)) fail('invalid_target', 'resource không phải máy chủ MCP của hệ thống này');
  return {
    client,
    redirectUri,
    scopes,
    state,
    resource: mcpResourceUrl(base),
    codeChallenge: challenge as string,
  };
}

/** Băm tham số đã hiển thị — token consent ràng buộc quyết định với đúng yêu cầu này. */
export function authorizeFingerprint(v: ValidAuthorize): string {
  return sha256Hex(JSON.stringify([v.client.client_id, v.redirectUri, [...v.scopes].sort(), v.state ?? '', v.resource, v.codeChallenge]));
}
