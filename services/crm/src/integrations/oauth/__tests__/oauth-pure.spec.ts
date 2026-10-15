import type { OauthClient } from '@prisma/client';
import { CODE_CHALLENGE_RE, CODE_VERIFIER_RE, pkceS256, signConsent, verifyConsent } from '../oauth-crypto';
import { isCanonicalResource, mcpResourceUrl, oauthEnabled, publicBaseUrl } from '../oauth-config';
import { parseRedirectUri, redirectUriMatches, isLoopbackUri } from '../redirect-uri';
import { assertRedirectUri, authorizeFingerprint, buildClientRedirect, validateAuthorizeRest } from '../authorize-request';
import { OAuthError, RedirectableOAuthError } from '../oauth-error';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth-metadata';
import { isCimdClientId, parseCimdClientId } from '../oauth-clients.service';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'unit-test-secret';
const BASE = 'https://crm.example.com';
const client = (over: Partial<OauthClient> = {}): OauthClient => ({
  id: 1, client_id: 'trn_c_x', kind: 'dcr', name: 'X', redirect_uris: ['https://app.example.com/cb'], logo_uri: null, client_uri: null,
  token_endpoint_auth_method: 'none', client_secret_hash: null, metadata: {}, metadata_fetched_at: null, metadata_expires_at: null,
  created_at: new Date(), last_used_at: null, ...over,
});
const CH = pkceS256('a'.repeat(50));

describe('PKCE (RFC 7636)', () => {
  it('khớp test vector Appendix B', () => {
    expect(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('regex verifier 43–128 ký tự, challenge S256 = 43 ký tự base64url', () => {
    expect(CODE_VERIFIER_RE.test('a'.repeat(42))).toBe(false);
    expect(CODE_VERIFIER_RE.test('a'.repeat(43))).toBe(true);
    expect(CODE_VERIFIER_RE.test('a'.repeat(129))).toBe(false);
    expect(CODE_VERIFIER_RE.test(`${'a'.repeat(43)}!`)).toBe(false);
    expect(CODE_CHALLENGE_RE.test(CH)).toBe(true);
    expect(CODE_CHALLENGE_RE.test('plain-verifier-not-hashed')).toBe(false);
  });
});

describe('consent token', () => {
  const claims = { u: 7, h: 'abc', e: Math.floor(Date.now() / 1000) + 60 };
  it('ký/kiểm đúng; sửa 1 ký tự / hết hạn / khác secret ⇒ null', () => {
    const t = signConsent(claims);
    expect(verifyConsent(t)).toEqual(claims);
    expect(verifyConsent(`${t}x`)).toBeNull();
    expect(verifyConsent(`${t.split('.')[0]}.AAAA`)).toBeNull();
    expect(verifyConsent(t, (claims.e + 1) * 1000)).toBeNull();
    expect(verifyConsent('a.b.c')).toBeNull();
    expect(verifyConsent('')).toBeNull();
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'other-secret';
    expect(verifyConsent(t)).toBeNull();
    process.env.JWT_SECRET = prev;
  });
});

describe('cấu hình URL gốc', () => {
  const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'production', ...o });
  it('chỉ https, không path/query/userinfo; localhost http chỉ trong dev/test', () => {
    expect(publicBaseUrl(env({ INTEGRATIONS_PUBLIC_BASE_URL: 'https://crm.example.com/' }))).toBe('https://crm.example.com');
    expect(publicBaseUrl(env({ INTEGRATIONS_PUBLIC_BASE_URL: 'http://crm.example.com' }))).toBeNull();
    expect(publicBaseUrl(env({ INTEGRATIONS_PUBLIC_BASE_URL: 'http://localhost:4000' }))).toBeNull();
    expect(publicBaseUrl({ NODE_ENV: 'test', INTEGRATIONS_PUBLIC_BASE_URL: 'http://localhost:4000' })).toBe('http://localhost:4000');
    for (const bad of ['https://crm.example.com/app', 'https://u:p@crm.example.com', 'https://crm.example.com?x=1', 'https://crm.example.com#x', 'not a url', '']) {
      expect(publicBaseUrl(env({ INTEGRATIONS_PUBLIC_BASE_URL: bad }))).toBeNull();
    }
  });
  it('oauthEnabled cần CẢ cờ lẫn base URL (mặc định tắt)', () => {
    expect(oauthEnabled({})).toBe(false);
    expect(oauthEnabled({ INTEGRATIONS_MCP_ENABLED: 'true' })).toBe(false);
    expect(oauthEnabled({ NODE_ENV: 'production', INTEGRATIONS_PUBLIC_BASE_URL: BASE })).toBe(false);
    expect(oauthEnabled({ NODE_ENV: 'production', INTEGRATIONS_MCP_ENABLED: '1', INTEGRATIONS_PUBLIC_BASE_URL: BASE })).toBe(true);
  });
  it('resource (RFC 8707): khớp URL MCP chuẩn tắc, bỏ qua / cuối + hoa/thường host; khác ⇒ sai', () => {
    expect(isCanonicalResource(mcpResourceUrl(BASE), BASE)).toBe(true);
    expect(isCanonicalResource(`${mcpResourceUrl(BASE)}/`, BASE)).toBe(true);
    expect(isCanonicalResource('HTTPS://CRM.EXAMPLE.COM/api/v1/mcp', BASE)).toBe(true);
    for (const bad of [BASE, 'https://evil.example.com/api/v1/mcp', `${mcpResourceUrl(BASE)}/x`, `${mcpResourceUrl(BASE)}?a=1`, `${mcpResourceUrl(BASE)}#f`, 'nope', '']) {
      expect(isCanonicalResource(bad, BASE)).toBe(false);
    }
  });
});

describe('redirect_uri', () => {
  it('chấp nhận https + http loopback; từ chối còn lại', () => {
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/abc123', 'http://localhost/callback', 'http://127.0.0.1:8080/cb', 'http://[::1]/cb']) {
      expect(() => parseRedirectUri(ok)).not.toThrow();
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'http://example.com/cb', 'ftp://x.example.com', 'myapp://cb', 'https://x.example.com/cb#f', 'https://u:p@x.example.com/cb', 'https://x.example.com/\\evil', 'https://x.example.com/a b', '', 'https://', 123, null, `https://x.example.com/${'a'.repeat(2100)}`]) {
      expect(() => parseRedirectUri(bad)).toThrow(OAuthError);
    }
  });
  it('khớp chính xác; loopback không cổng ⇒ mọi cổng; không nới host/path/scheme', () => {
    expect(redirectUriMatches('https://a.example.com/cb', 'https://a.example.com/cb')).toBe(true);
    expect(redirectUriMatches('https://a.example.com/cb', 'https://a.example.com/cb/')).toBe(false);
    expect(redirectUriMatches('https://a.example.com/cb', 'https://a.example.com/cb?x=1')).toBe(false);
    expect(redirectUriMatches('https://a.example.com/cb', 'https://a.example.com.evil.com/cb')).toBe(false);
    expect(redirectUriMatches('http://localhost/callback', 'http://localhost:3118/callback')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:9/callback')).toBe(true);
    expect(redirectUriMatches('http://localhost/callback', 'http://127.0.0.1:3118/callback')).toBe(false);
    expect(redirectUriMatches('http://localhost/callback', 'http://localhost:3118/other')).toBe(false);
    expect(redirectUriMatches('http://localhost/callback', 'https://localhost:3118/callback')).toBe(false);
    expect(redirectUriMatches('http://localhost:3000/callback', 'http://localhost:3001/callback')).toBe(false);
    expect(redirectUriMatches('https://a.example.com/cb', 'http://localhost:3118/cb')).toBe(false);
    expect(isLoopbackUri('http://localhost:1/x')).toBe(true);
    expect(isLoopbackUri('https://localhost/x')).toBe(false);
  });
});

describe('yêu cầu uỷ quyền', () => {
  const base = { response_type: 'code', client_id: 'trn_c_x', redirect_uri: 'https://app.example.com/cb', code_challenge: CH, code_challenge_method: 'S256', state: 's1' };
  it('redirect_uri sai ⇒ OAuthError THƯỜNG (không redirect)', () => {
    try {
      assertRedirectUri(client(), { ...base, redirect_uri: 'https://evil.example.com/cb' });
      fail('phải ném');
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthError);
      expect(e).not.toBeInstanceOf(RedirectableOAuthError);
    }
    expect(() => assertRedirectUri(client(), { ...base, redirect_uri: undefined })).toThrow(OAuthError);
  });
  it('PKCE downgrade (plain/thiếu/sai độ dài) ⇒ RedirectableOAuthError', () => {
    const c = client();
    const v = (over: Record<string, unknown>) => () => validateAuthorizeRest(c, 'https://app.example.com/cb', { ...base, ...over }, BASE);
    expect(v({ code_challenge_method: 'plain' })).toThrow(RedirectableOAuthError);
    expect(v({ code_challenge_method: undefined })).toThrow(RedirectableOAuthError);
    expect(v({ code_challenge: undefined })).toThrow(RedirectableOAuthError);
    expect(v({ code_challenge: 'abc' })).toThrow(RedirectableOAuthError);
    expect(v({ response_type: 'token' })).toThrow(RedirectableOAuthError);
    expect(v({ scope: 'crm.read evil' })).toThrow(RedirectableOAuthError);
    expect(v({ state: 'x'.repeat(513) })).toThrow(RedirectableOAuthError);
    expect(v({ resource: 'https://evil.example.com/api/v1/mcp' })).toThrow(RedirectableOAuthError);
  });
  it('mặc định scope crm.read; bỏ offline_access; resource luôn là URL MCP của ta', () => {
    const c = client();
    const ok = validateAuthorizeRest(c, 'https://app.example.com/cb', base, BASE);
    expect(ok.scopes).toEqual(['crm.read']);
    expect(ok.resource).toBe(mcpResourceUrl(BASE));
    expect(validateAuthorizeRest(c, 'https://app.example.com/cb', { ...base, scope: 'crm.read offline_access crm.write' }, BASE).scopes).toEqual(['crm.read', 'crm.write']);
  });
  it('fingerprint đổi khi đổi bất kỳ tham số; redirect kèm iss + state, giữ query sẵn có', () => {
    const c = client();
    const a = validateAuthorizeRest(c, 'https://app.example.com/cb', base, BASE);
    const b = validateAuthorizeRest(c, 'https://app.example.com/cb', { ...base, state: 's2' }, BASE);
    const d = validateAuthorizeRest(c, 'https://app.example.com/cb', { ...base, scope: 'crm.write' }, BASE);
    expect(authorizeFingerprint(a)).not.toBe(authorizeFingerprint(b));
    expect(authorizeFingerprint(a)).not.toBe(authorizeFingerprint(d));
    const u = new URL(buildClientRedirect('https://app.example.com/cb?keep=1', BASE, { code: 'c', state: 's', gone: undefined }));
    expect([u.searchParams.get('keep'), u.searchParams.get('code'), u.searchParams.get('state'), u.searchParams.get('iss'), u.searchParams.has('gone')]).toEqual(['1', 'c', 's', `${BASE}/api/v1/oauth`, false]);
  });
});

describe('metadata', () => {
  it('AS: issuer + S256 + CIMD + iss; không implicit/password', () => {
    const m = authorizationServerMetadata(BASE) as Record<string, unknown>;
    expect(m.issuer).toBe(`${BASE}/api/v1/oauth`);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.response_types_supported).toEqual(['code']);
  });
  it('PRM: resource khớp URL MCP; scopes_supported = crm.read + crm.write (crm.write ghi trực tiếp; chế độ duyệt là tuỳ chọn của admin)', () => {
    const m = protectedResourceMetadata(BASE) as Record<string, unknown>;
    expect(m.resource).toBe(`${BASE}/api/v1/mcp`);
    expect(m.authorization_servers).toEqual([`${BASE}/api/v1/oauth`]);
    expect(m.scopes_supported).toEqual(['crm.read', 'crm.write']);
  });
});

describe('CIMD client_id', () => {
  it('nhận https có path; từ chối còn lại', () => {
    expect(isCimdClientId('https://claude.ai/oauth/claude-code-client-metadata', {})).toBe(true);
    expect(isCimdClientId('http://example.com/x.json', {})).toBe(false);
    expect(isCimdClientId('http://127.0.0.1/x.json', { NODE_ENV: 'test', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' })).toBe(true);
    expect(isCimdClientId('http://127.0.0.1/x.json', { NODE_ENV: 'production', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' })).toBe(false);
    expect(() => parseCimdClientId('https://claude.ai/oauth/claude-code-client-metadata', {})).not.toThrow();
    for (const bad of ['https://example.com', 'https://example.com/', 'https://example.com/a/../b', 'https://example.com/./b', 'https://u:p@example.com/b', 'https://example.com/b#f', `https://example.com/${'a'.repeat(600)}`, 'https://EXAMPLE.com/b']) {
      expect(() => parseCimdClientId(bad, {})).toThrow(OAuthError);
    }
  });
});
