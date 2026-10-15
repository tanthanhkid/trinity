import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GoogleConnection } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { decryptSecret, encryptSecret, loadSecretKey, IntegrationsKeyError } from '../integrations/webhooks/secret-crypto';
import {
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  loadGoogleConfig,
  type GoogleOAuthConfig,
} from './google-config';
import { GoogleHttp, googleErrorMessage } from './google-http';

const STATE_TTL_MS = 10 * 60_000;
const SKEW_MS = 60_000;

/** `state` OAuth ký HMAC (không lưu DB): gắn người bấm + hạn 10 phút + nonce — chặn CSRF/replay xa. */
export function signState(userId: number, key: Buffer, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ u: userId, e: now + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  const mac = createHmac('sha256', key).update(`google-oauth-state/v1.${body}`).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyState(state: string, key: Buffer, now = Date.now()): { userId: number } | null {
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;
  const expect = createHmac('sha256', key).update(`google-oauth-state/v1.${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expect.length || !timingSafeEqual(given, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown };
    if (typeof p.u !== 'number' || typeof p.e !== 'number' || p.e < now) return null;
    return { userId: p.u };
  } catch {
    return null;
  }
}

/** Lấy email từ id_token (nhận trực tiếp từ Google qua TLS, không cần kiểm chữ ký lại ở đây). */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const p = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
    return typeof p.email === 'string' ? p.email.slice(0, 255) : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}

/** OAuth Google theo tổ chức: đổi code lấy token, lưu mã hoá, tự làm mới access token, thu hồi khi ngắt kết nối. */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(private readonly prisma: PrismaService, private readonly http: GoogleHttp) {}

  private config(): GoogleOAuthConfig {
    const cfg = loadGoogleConfig();
    if (!cfg) throw new ServiceUnavailableException('Google chưa được cấu hình (thiếu GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)');
    return cfg;
  }

  private key(): Buffer {
    try {
      return loadSecretKey();
    } catch (e) {
      if (e instanceof IntegrationsKeyError) throw new ServiceUnavailableException('Thiếu INTEGRATIONS_SECRET_KEY — không lưu được token Google an toàn');
      throw e;
    }
  }

  authUrl(userId: number): string {
    const cfg = this.config();
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: signState(userId, this.key()),
    });
    return `${GOOGLE_AUTH_URL}?${q.toString()}`;
  }

  /** Callback: kiểm state → đổi code → lưu (thay kết nối cũ). Trả id kết nối. */
  async handleCallback(code: string, state: string): Promise<GoogleConnection> {
    const who = verifyState(state, this.key());
    if (!who) throw new BadRequestException('state không hợp lệ hoặc đã hết hạn — hãy bấm Kết nối lại');
    const cfg = this.config();
    const res = await this.http.request({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      form: { code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' },
    });
    const t = (res.json ?? {}) as TokenResponse;
    if (res.status !== 200 || !t.access_token) throw new BadRequestException(googleErrorMessage(res.json, res.status));
    if (!t.refresh_token) throw new BadRequestException('Google không trả refresh token — hãy thu hồi quyền cũ của ứng dụng trong tài khoản Google rồi kết nối lại');
    const key = this.key();
    const data = {
      google_email: emailFromIdToken(t.id_token),
      refresh_token_enc: encryptSecret(t.refresh_token, key),
      access_token_enc: encryptSecret(t.access_token, key),
      token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
      scopes: (t.scope ?? '').split(' ').filter(Boolean),
      status: 'active',
      last_error: null,
      created_by: who.userId,
    };
    // Một tổ chức = một kết nối đang dùng: cấu hình đồng bộ cũ được chuyển sang kết nối mới.
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.googleConnection.create({ data });
      await tx.googleConnection.updateMany({ where: { id: { not: created.id }, status: 'active' }, data: { status: 'revoked', last_error: 'thay bằng kết nối mới' } });
      await tx.googleSheetSync.updateMany({ where: { deleted_at: null }, data: { connection_id: created.id } });
      return created;
    });
  }

  async current(): Promise<GoogleConnection | null> {
    return this.prisma.googleConnection.findFirst({ where: { status: { in: ['active', 'error'] } }, orderBy: { id: 'desc' } });
  }

  async requireCurrent(): Promise<GoogleConnection> {
    const c = await this.current();
    if (!c) throw new NotFoundException('Chưa kết nối Google');
    return c;
  }

  /** Access token còn hạn (tự refresh). `invalid_grant` ⇒ đánh dấu thu hồi để UI báo nối lại. */
  async accessToken(conn: GoogleConnection): Promise<string> {
    const key = this.key();
    if (conn.access_token_enc && conn.token_expires_at && conn.token_expires_at.getTime() - SKEW_MS > Date.now()) {
      return decryptSecret(conn.access_token_enc, key);
    }
    const cfg = this.config();
    const res = await this.http.request({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      form: { refresh_token: decryptSecret(conn.refresh_token_enc, key), client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' },
    });
    const t = (res.json ?? {}) as TokenResponse;
    if (res.status !== 200 || !t.access_token) {
      const revoked = (res.json as { error?: string } | null)?.error === 'invalid_grant';
      const msg = googleErrorMessage(res.json, res.status);
      await this.prisma.googleConnection.update({ where: { id: conn.id }, data: { status: revoked ? 'revoked' : 'error', last_error: msg.slice(0, 500) } });
      this.logger.warn(`Làm mới token Google thất bại (connection=${conn.id}): ${msg}`);
      throw new ServiceUnavailableException(revoked ? 'Quyền Google đã bị thu hồi — hãy kết nối lại' : msg);
    }
    const expires = new Date(Date.now() + (t.expires_in ?? 3600) * 1000);
    await this.prisma.googleConnection.update({
      where: { id: conn.id },
      data: { access_token_enc: encryptSecret(t.access_token, key), token_expires_at: expires, status: 'active', last_error: null },
    });
    return t.access_token;
  }

  /** Ngắt kết nối: thu hồi token bên Google (best-effort) rồi xoá token khỏi DB; cấu hình đồng bộ bị tạm tắt. */
  async disconnect(): Promise<void> {
    const conn = await this.current();
    if (!conn) return;
    try {
      const refresh = decryptSecret(conn.refresh_token_enc, this.key());
      await this.http.request({ method: 'POST', url: GOOGLE_REVOKE_URL, form: { token: refresh } });
    } catch (e) {
      this.logger.warn(`Thu hồi token Google không thành công (bỏ qua): ${(e as Error).message}`);
    }
    await this.prisma.$transaction([
      this.prisma.googleConnection.update({ where: { id: conn.id }, data: { status: 'revoked', refresh_token_enc: 'revoked', access_token_enc: null, token_expires_at: null } }),
      this.prisma.googleSheetSync.updateMany({ where: { deleted_at: null }, data: { is_active: false, last_error: 'đã ngắt kết nối Google' } }),
    ]);
  }
}
