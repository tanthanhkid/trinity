import { OAuthError } from './oauth-error';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_LEN = 2048;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f\\\s]/;

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname.toLowerCase());

/**
 * Kiểm redirect_uri lúc ĐĂNG KÝ / khai trong CIMD (OAuth 2.1 §2.3.1): https, hoặc http CHỈ cho loopback (RFC 8252).
 * Cấm fragment, userinfo, ký tự điều khiển/khoảng trắng/`\`, scheme lạ (javascript:, data:, app://… — chặn code injection).
 */
export function parseRedirectUri(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LEN || BAD_CHARS.test(raw)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri không hợp lệ');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri không hợp lệ');
  }
  const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  if (!okScheme) throw new OAuthError('invalid_redirect_uri', 'redirect_uri phải là https (http chỉ cho localhost)');
  if (u.hash || raw.includes('#')) throw new OAuthError('invalid_redirect_uri', 'redirect_uri không được có fragment');
  if (u.username || u.password) throw new OAuthError('invalid_redirect_uri', 'redirect_uri không được chứa tài khoản');
  if (!u.hostname) throw new OAuthError('invalid_redirect_uri', 'redirect_uri thiếu tên miền');
  return u;
}

/**
 * Khớp CHÍNH XÁC chuỗi đã đăng ký. Ngoại lệ duy nhất (RFC 8252 §7.3, Claude Code): URI đăng ký là loopback `http`
 * KHÔNG khai cổng ⇒ chấp nhận mọi cổng, còn scheme/host/path/query phải y hệt.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let reg: URL;
  let req: URL;
  try {
    reg = new URL(registered);
    req = new URL(requested);
  } catch {
    return false;
  }
  if (reg.protocol !== 'http:' || !isLoopbackHost(reg.hostname) || reg.port !== '') return false;
  return (
    req.protocol === 'http:' &&
    req.hostname.toLowerCase() === reg.hostname.toLowerCase() &&
    req.pathname === reg.pathname &&
    req.search === reg.search &&
    !req.hash &&
    !req.username &&
    !req.password
  );
}

export const isLoopbackUri = (uri: string): boolean => {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
};

/** Host hiển thị trên màn đồng ý (MCP spec: PHẢI hiển thị rõ hostname của redirect URI). */
export const redirectHost = (uri: string): string => {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
};
