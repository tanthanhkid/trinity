import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { ZaloOaConnection } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { ZaloOaApiClient, type ZaloTokenSet } from './zalo-oa-api.client';
import { OAUTH_STATE_TTL_MS, REFRESH_SKEW_MS, ZALO_URLS, isZaloOaConfigured, zaloOaConfig } from './zalo-oa.config';
import { ZaloApiError } from './zalo-oa.errors';

const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // Zalo: refresh token sống ~3 tháng

export interface ZaloOaStatus {
  configured: boolean;
  webhook_secret_configured: boolean;
  secret_key_configured: boolean;
  connected: boolean;
  oa_id: string | null;
  status: 'active' | 'needs_reauth' | 'disconnected';
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  last_error: string | null;
}

/**
 * OAuth v4 của OA: tạo URL cấp quyền (PKCE S256 + state chống CSRF), đổi code lấy token, lưu MÃ HOÁ, tự làm mới.
 * Refresh token dùng một lần ⇒ làm mới đi qua một Promise chung (single-flight) trong process; nếu process khác đã
 * làm mới trước (lỗi refresh nhưng DB đã có token mới) thì đọc lại và dùng token mới thay vì đánh dấu hỏng.
 */
@Injectable()
export class ZaloOaTokenService {
  private readonly logger = new Logger(ZaloOaTokenService.name);
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: ZaloOaApiClient,
  ) {}

  async startConnect(userId: number): Promise<{ authorize_url: string }> {
    const cfg = zaloOaConfig();
    if (!isZaloOaConfigured(cfg)) throw new ServiceUnavailableException('Chưa cấu hình ZALO_OA_APP_ID / ZALO_OA_APP_SECRET / ZALO_OA_REDIRECT_URI');
    const key = this.key();
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.prisma.zaloOaOauthState.deleteMany({ where: { expires_at: { lt: new Date() } } });
    await this.prisma.zaloOaOauthState.create({
      data: { state, code_verifier_enc: encryptSecret(verifier, key), user_id: userId, expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS) },
    });
    const q = new URLSearchParams({
      app_id: cfg.appId as string,
      redirect_uri: cfg.redirectUri as string,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
    });
    return { authorize_url: `${ZALO_URLS.permission}?${q.toString()}` };
  }

  /** Callback: kiểm state (dùng một lần, còn hạn) → đổi code → lưu. Trả oa_id đã kết nối. */
  async completeConnect(code: string, oaId: string, state: string): Promise<string> {
    const cfg = zaloOaConfig();
    if (!isZaloOaConfigured(cfg)) throw new ServiceUnavailableException('Chưa cấu hình Zalo OA');
    if (!code || !oaId || !state || !/^[\w-]{1,64}$/.test(oaId)) throw new BadRequestException('Thiếu tham số callback');
    const st = await this.prisma.zaloOaOauthState.findUnique({ where: { state } });
    await this.prisma.zaloOaOauthState.deleteMany({ where: { state } });
    if (!st || st.expires_at.getTime() < Date.now()) throw new BadRequestException('Phiên cấp quyền không hợp lệ hoặc đã hết hạn — hãy thử kết nối lại');
    const key = this.key();
    const tokens = await this.api.exchangeCode(cfg.appId as string, cfg.appSecret as string, code, decryptSecret(st.code_verifier_enc, key));
    await this.save(oaId, tokens, st.user_id);
    return oaId;
  }

  private key(): Buffer {
    try {
      return loadSecretKey();
    } catch {
      throw new ServiceUnavailableException('INTEGRATIONS_SECRET_KEY chưa cấu hình hợp lệ — không lưu được token an toàn');
    }
  }

  private async save(oaId: string, t: ZaloTokenSet, userId: number): Promise<void> {
    const key = this.key();
    const data = {
      access_token_enc: encryptSecret(t.access_token, key),
      refresh_token_enc: encryptSecret(t.refresh_token, key),
      access_expires_at: new Date(Date.now() + t.expires_in * 1000),
      refresh_expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      status: 'active',
      last_error: null,
      last_refreshed_at: new Date(),
    };
    await this.prisma.zaloOaConnection.upsert({ where: { oa_id: oaId }, create: { oa_id: oaId, connected_by: userId, ...data }, update: data });
  }

  getConnection(): Promise<ZaloOaConnection | null> {
    return this.prisma.zaloOaConnection.findFirst({ orderBy: { id: 'desc' } });
  }

  /** Access token còn hạn (tự làm mới nếu sắp hết). Chưa kết nối / cần cấp quyền lại ⇒ 400. */
  async getAccessToken(): Promise<{ token: string; oaId: string; connectedBy: number }> {
    const conn = await this.getConnection();
    if (!conn || conn.status !== 'active') throw new BadRequestException('Zalo OA chưa kết nối hoặc cần kết nối lại');
    const fresh = conn.access_expires_at.getTime() - Date.now() > REFRESH_SKEW_MS;
    const token = fresh ? decryptSecret(conn.access_token_enc, this.key()) : await this.refreshShared(conn);
    return { token, oaId: conn.oa_id, connectedBy: conn.connected_by };
  }

  private refreshShared(conn: ZaloOaConnection): Promise<string> {
    this.inflight ??= this.refresh(conn).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(conn: ZaloOaConnection): Promise<string> {
    const cfg = zaloOaConfig();
    const key = this.key();
    try {
      const t = await this.api.refresh(cfg.appId as string, cfg.appSecret as string, decryptSecret(conn.refresh_token_enc, key));
      await this.save(conn.oa_id, t, conn.connected_by);
      return t.access_token;
    } catch (err) {
      const again = await this.prisma.zaloOaConnection.findUnique({ where: { oa_id: conn.oa_id } });
      if (again && again.access_expires_at.getTime() - Date.now() > REFRESH_SKEW_MS) return decryptSecret(again.access_token_enc, key);
      const msg = err instanceof ZaloApiError ? `Làm mới token thất bại (mã ${err.code})` : 'Làm mới token thất bại';
      this.logger.error(`${msg} oa=${conn.oa_id}`);
      // Lỗi tạm thời (mạng, Zalo 5xx, phản hồi không đọc được, lỗi DB) KHÔNG nghĩa là refresh token hỏng:
      // giữ nguyên trạng thái để lần sau thử lại, đừng buộc quản trị viên kết nối lại.
      const transient = !(err instanceof ZaloApiError) || err.code === -1 || err.code === -2 || (err.httpStatus ?? 0) >= 500;
      if (transient) throw new BadRequestException('Chưa làm mới được token Zalo OA (lỗi tạm thời) — thử lại sau');
      await this.markNeedsReauth(conn.oa_id, msg);
      throw new BadRequestException('Không làm mới được token Zalo OA — cần kết nối lại');
    }
  }

  async markNeedsReauth(oaId: string, reason: string): Promise<void> {
    await this.prisma.zaloOaConnection.updateMany({ where: { oa_id: oaId }, data: { status: 'needs_reauth', last_error: reason.slice(0, 300) } });
  }

  async disconnect(): Promise<void> {
    await this.prisma.zaloOaConnection.deleteMany({});
  }

  async status(): Promise<ZaloOaStatus> {
    const cfg = zaloOaConfig();
    const conn = await this.getConnection();
    let keyOk = true;
    try {
      loadSecretKey();
    } catch {
      keyOk = false;
    }
    return {
      configured: isZaloOaConfigured(cfg),
      webhook_secret_configured: Boolean(cfg.webhookSecret),
      secret_key_configured: keyOk,
      connected: conn?.status === 'active',
      oa_id: conn?.oa_id ?? null,
      status: conn ? (conn.status as 'active' | 'needs_reauth') : 'disconnected',
      access_expires_at: conn?.access_expires_at.toISOString() ?? null,
      refresh_expires_at: conn?.refresh_expires_at?.toISOString() ?? null,
      last_error: conn?.last_error ?? null,
    };
  }
}
