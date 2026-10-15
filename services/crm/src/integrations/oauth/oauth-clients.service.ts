import { Injectable, Logger } from '@nestjs/common';
import type { OauthClient, Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { randomToken, safeEqual, sha256Hex } from './oauth-crypto';
import { OAuthError } from './oauth-error';
import { ADVERTISED_SCOPES } from './oauth-config';
import { parseRedirectUri } from './redirect-uri';
import { safeGetJson, SafeGetError } from '../common/safe-http-get';
import { allowPrivateTargets } from '../webhooks/ssrf-guard';

const MAX_REDIRECTS = 10;
const MAX_DCR_CLIENTS = 5000;
const CIMD_MIN_TTL_SEC = 5 * 60;
const CIMD_MAX_TTL_SEC = 24 * 60 * 60;
const CIMD_DEFAULT_TTL_SEC = 60 * 60;
const MAX_CLIENT_ID_LEN = 512;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

// Ký tự điều khiển + điều khiển chiều chữ (bidi) — bỏ để tên client không đánh lừa mắt người đọc ở màn đồng ý.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string' || v.length > max) return undefined;
  const clean = v.replace(HIDDEN_CHARS, '').trim();
  return clean || undefined;
};

/** URL ảnh/trang chỉ để HIỂN THỊ — bắt buộc https, cắt độ dài. */
function httpsUrl(v: unknown): string | null {
  const s = str(v, 1024);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `http://` chỉ được nhận khi môi trường dev/test + cờ tường minh (cùng điều kiện nới SSRF) — production luôn chỉ https. */
export const isCimdClientId = (id: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  id.startsWith('https://') || (allowPrivateTargets(env) && id.startsWith('http://'));

/** `client_id` kiểu URL hợp lệ cho CIMD: https, có path (≠ "/"), không fragment/userinfo/dot-segment. */
export function parseCimdClientId(id: string, env: NodeJS.ProcessEnv = process.env): URL {
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    throw new OAuthError('invalid_client', 'client_id không hợp lệ', 401);
  }
  const segments = u.pathname.split('/');
  const bad =
    id.length > MAX_CLIENT_ID_LEN || (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowPrivateTargets(env))) || u.hash || id.includes('#') || u.username || u.password ||
    u.pathname === '/' || segments.some((s) => s === '.' || s === '..') || u.toString() !== id;
  if (bad) throw new OAuthError('invalid_client', 'client_id (URL metadata) không hợp lệ', 401);
  return u;
}

function cimdHostAllowed(host: string, env: NodeJS.ProcessEnv): boolean {
  const list = (env.INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(host.toLowerCase());
}

function validateRedirectList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDIRECTS) {
    throw new OAuthError('invalid_redirect_uri', `redirect_uris phải có từ 1 đến ${MAX_REDIRECTS} địa chỉ`);
  }
  const uris = raw.map((r: unknown) => {
    parseRedirectUri(r);
    return r as string;
  });
  return Array.from(new Set(uris));
}

@Injectable()
export class OauthClientsService {
  private readonly logger = new Logger(OauthClientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** RFC 7591 — đăng ký động. Giới hạn theo IP làm ở controller; ở đây chặn trần tổng số client DCR. */
  async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const redirectUris = validateRedirectList(body.redirect_uris);
    const method = body.token_endpoint_auth_method === undefined ? 'none' : body.token_endpoint_auth_method;
    if (method !== 'none' && method !== 'client_secret_post') {
      throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method chỉ hỗ trợ none hoặc client_secret_post');
    }
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
    if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      throw new OAuthError('invalid_client_metadata', 'grant_types chỉ hỗ trợ authorization_code và refresh_token');
    }
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some((r) => r !== 'code'))) {
      throw new OAuthError('invalid_client_metadata', 'response_types chỉ hỗ trợ code');
    }
    if ((await this.prisma.oauthClient.count({ where: { kind: 'dcr' } })) >= MAX_DCR_CLIENTS) {
      throw new OAuthError('temporarily_unavailable', 'Máy chủ đang tạm dừng đăng ký client mới', 503);
    }
    const name = str(body.client_name, 200) ?? 'Ứng dụng chưa đặt tên';
    const scope = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter((s) => ADVERTISED_SCOPES.includes(s)).join(' ') : undefined;
    const clientId = `trn_c_${randomToken(18)}`;
    const secret = method === 'client_secret_post' ? `trn_s_${randomToken(32)}` : null;
    const row = await this.prisma.oauthClient.create({
      data: {
        client_id: clientId,
        kind: 'dcr',
        name,
        redirect_uris: redirectUris,
        logo_uri: httpsUrl(body.logo_uri),
        client_uri: httpsUrl(body.client_uri),
        token_endpoint_auth_method: method,
        client_secret_hash: secret ? sha256Hex(secret) : null,
        metadata: { grant_types: grants, scope: scope ?? '' } as Prisma.InputJsonObject,
      },
    });
    return {
      client_id: row.client_id,
      client_id_issued_at: Math.floor(row.created_at.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      redirect_uris: row.redirect_uris,
      client_name: row.name,
      grant_types: grants,
      response_types: ['code'],
      token_endpoint_auth_method: method,
      ...(scope ? { scope } : {}),
    };
  }

  /**
   * Tra client cho màn đồng ý (`allowFetch=true`: CIMD được tải/làm mới) hoặc cho endpoint token/revoke
   * (`allowFetch=false`: CHỈ đọc bản đã lưu — endpoint công khai không bao giờ kích hoạt tải URL ngoài).
   */
  async resolve(clientId: string, allowFetch: boolean, env: NodeJS.ProcessEnv = process.env): Promise<OauthClient> {
    if (!clientId || clientId.length > MAX_CLIENT_ID_LEN) throw new OAuthError('invalid_client', 'client_id không hợp lệ', 401);
    const row = await this.prisma.oauthClient.findUnique({ where: { client_id: clientId } });
    if (!isCimdClientId(clientId, env)) {
      if (!row || row.kind !== 'dcr') throw new OAuthError('invalid_client', 'client_id không tồn tại', 401);
      return row;
    }
    if (!allowFetch) {
      if (!row || row.kind !== 'cimd') throw new OAuthError('invalid_client', 'client_id không tồn tại', 401);
      return row;
    }
    const url = parseCimdClientId(clientId, env);
    if (!cimdHostAllowed(url.hostname, env)) throw new OAuthError('invalid_client', 'Tên miền client không nằm trong danh sách cho phép', 401);
    if (row && row.metadata_expires_at && row.metadata_expires_at.getTime() > Date.now()) return row;
    return this.fetchCimd(clientId, env);
  }

  private async fetchCimd(clientId: string, env: NodeJS.ProcessEnv): Promise<OauthClient> {
    let res;
    try {
      res = await safeGetJson(clientId, { env });
    } catch (err) {
      this.logger.warn(`CIMD fetch lỗi (${(err as SafeGetError).message}) cho client_id có độ dài ${clientId.length}`);
      throw new OAuthError('invalid_client', 'Không tải được metadata của client', 401);
    }
    const doc = (res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json : null) as Record<string, unknown> | null;
    if (!doc || doc.client_id !== clientId) throw new OAuthError('invalid_client', 'Metadata client không hợp lệ: client_id không khớp URL', 401);
    const method = doc.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none' && method !== 'private_key_jwt') {
      throw new OAuthError('invalid_client', 'CIMD không được dùng client secret', 401);
    }
    let redirectUris: string[];
    try {
      redirectUris = validateRedirectList(doc.redirect_uris);
    } catch {
      throw new OAuthError('invalid_client', 'Metadata client có redirect_uris không hợp lệ', 401);
    }
    const ttl = Math.min(Math.max(res.maxAgeSec ?? CIMD_DEFAULT_TTL_SEC, CIMD_MIN_TTL_SEC), CIMD_MAX_TTL_SEC);
    const now = new Date();
    const data = {
      kind: 'cimd',
      name: str(doc.client_name, 200) ?? new URL(clientId).hostname,
      redirect_uris: redirectUris,
      logo_uri: httpsUrl(doc.logo_uri),
      client_uri: httpsUrl(doc.client_uri),
      token_endpoint_auth_method: 'none',
      metadata: {
        client_id: clientId,
        grant_types: Array.isArray(doc.grant_types) ? doc.grant_types.filter((g): g is string => typeof g === 'string').slice(0, 5) : null,
        token_endpoint_auth_method: method ?? 'none',
      } as Prisma.InputJsonObject,
      metadata_fetched_at: now,
      metadata_expires_at: new Date(now.getTime() + ttl * 1000),
    };
    return this.prisma.oauthClient.upsert({ where: { client_id: clientId }, create: { client_id: clientId, ...data }, update: data });
  }

  /** Xác thực client ở endpoint token/revoke: public ⇒ chỉ cần tồn tại; `client_secret_post` ⇒ phải đúng secret. */
  async authenticate(clientId: string, clientSecret: string | undefined): Promise<OauthClient> {
    const client = await this.resolve(clientId, false);
    if (client.token_endpoint_auth_method === 'client_secret_post') {
      const ok = !!clientSecret && !!client.client_secret_hash && safeEqual(sha256Hex(clientSecret), client.client_secret_hash);
      if (!ok) throw new OAuthError('invalid_client', 'Sai client_secret', 401);
    }
    return client;
  }

  async touch(client: OauthClient): Promise<void> {
    const last = client.last_used_at?.getTime() ?? 0;
    if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
    await this.prisma.oauthClient.update({ where: { id: client.id }, data: { last_used_at: new Date() }, select: { id: true } }).catch(() => undefined);
  }
}
