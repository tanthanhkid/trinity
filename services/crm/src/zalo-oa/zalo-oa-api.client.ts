import { Injectable } from '@nestjs/common';
import { ZALO_URLS } from './zalo-oa.config';
import { ZaloApiError } from './zalo-oa.errors';

export interface ZaloTokenSet {
  access_token: string;
  refresh_token: string;
  /** giây */
  expires_in: number;
}
export interface ZaloUserProfile {
  display_name: string | null;
  avatar: string | null;
  phone: string | null;
}
export interface ZnsResult {
  msg_id: string | null;
  quota: unknown;
}

type Json = Record<string, unknown>;
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Lớp HTTP mỏng gọi Zalo. Mọi lời gọi dùng `fetch` toàn cục (test mock `global.fetch`). Phản hồi Zalo có 2 dạng lỗi:
 * `{ error: <≠0>, message }` (API) và `{ error: <≠0>, error_name, error_reason }` (OAuth) — gộp thành `ZaloApiError`.
 */
@Injectable()
export class ZaloOaApiClient {
  private async call(url: string, init: RequestInit): Promise<Json> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (err) {
      throw new ZaloApiError(-1, `Không gọi được Zalo: ${(err as Error).message}`);
    }
    let body: Json;
    try {
      body = (await res.json()) as Json;
    } catch {
      throw new ZaloApiError(-2, 'Zalo trả phản hồi không phải JSON', res.status);
    }
    const code = Number(body.error ?? 0);
    if (code !== 0 || !res.ok) {
      const msg = String(body.message ?? body.error_reason ?? body.error_name ?? `HTTP ${res.status}`);
      throw new ZaloApiError(code || -res.status, msg, res.status);
    }
    return body;
  }

  private tokenRequest(appId: string, appSecret: string, form: Record<string, string>): Promise<ZaloTokenSet> {
    return this.call(ZALO_URLS.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: appSecret },
      body: new URLSearchParams({ app_id: appId, ...form }).toString(),
    }).then(toTokenSet);
  }

  exchangeCode(appId: string, appSecret: string, code: string, codeVerifier: string): Promise<ZaloTokenSet> {
    return this.tokenRequest(appId, appSecret, { code, grant_type: 'authorization_code', code_verifier: codeVerifier });
  }

  /** Refresh token dùng MỘT LẦN: mỗi lần làm mới Zalo cấp cặp mới, cặp cũ chết. */
  refresh(appId: string, appSecret: string, refreshToken: string): Promise<ZaloTokenSet> {
    return this.tokenRequest(appId, appSecret, { refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async sendText(accessToken: string, userId: string, text: string): Promise<{ msg_id: string | null }> {
    const b = await this.call(`${ZALO_URLS.api}/message/cs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: accessToken },
      body: JSON.stringify({ recipient: { user_id: userId }, message: { text } }),
    });
    return { msg_id: (b.data as Json | undefined)?.message_id ? String((b.data as Json).message_id) : null };
  }

  async sendZns(
    accessToken: string,
    p: { phone: string; templateId: string; templateData: Record<string, string>; trackingId?: string; mode: 'development' | null },
  ): Promise<ZnsResult> {
    const body: Json = { phone: p.phone, template_id: p.templateId, template_data: p.templateData };
    if (p.trackingId) body.tracking_id = p.trackingId;
    if (p.mode) body.mode = p.mode;
    const b = await this.call(ZALO_URLS.zns, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: accessToken },
      body: JSON.stringify(body),
    });
    const d = (b.data ?? {}) as Json;
    return { msg_id: d.msg_id ? String(d.msg_id) : null, quota: d.quota ?? null };
  }

  async getProfile(accessToken: string, userId: string): Promise<ZaloUserProfile> {
    const q = encodeURIComponent(JSON.stringify({ user_id: userId }));
    const b = await this.call(`${ZALO_URLS.api}/user/detail?data=${q}`, { method: 'GET', headers: { access_token: accessToken } });
    const d = (b.data ?? {}) as Json;
    const shared = (d.shared_info ?? {}) as Json;
    return {
      display_name: typeof d.display_name === 'string' ? d.display_name : null,
      avatar: typeof d.avatar === 'string' ? d.avatar : null,
      phone: shared.phone ? String(shared.phone) : null,
    };
  }
}

function toTokenSet(b: Json): ZaloTokenSet {
  const access = b.access_token;
  const refresh = b.refresh_token;
  const exp = Number(b.expires_in);
  if (typeof access !== 'string' || typeof refresh !== 'string' || !Number.isFinite(exp)) {
    throw new ZaloApiError(-3, 'Phản hồi token của Zalo thiếu trường');
  }
  return { access_token: access, refresh_token: refresh, expires_in: exp };
}
