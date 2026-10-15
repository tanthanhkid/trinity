import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../integrations/webhooks/secret-crypto';
import { ZaloOaTokenService } from '../zalo-oa-token.service';
import { ZaloApiError } from '../zalo-oa.errors';

const KEY = randomBytes(32);
process.env.INTEGRATIONS_SECRET_KEY = KEY.toString('base64');
process.env.ZALO_OA_APP_ID = 'APP';
process.env.ZALO_OA_APP_SECRET = 'SEC';
process.env.ZALO_OA_REDIRECT_URI = 'https://crm.example/api/v1/zalo-oa/oauth/callback';

function setup() {
  const states = new Map<string, { code_verifier_enc: string; user_id: number; expires_at: Date }>();
  let conn: Record<string, any> | null = null;
  const prisma = {
    zaloOaOauthState: {
      deleteMany: jest.fn(async ({ where }: any) => { if (where.state) states.delete(where.state); }),
      create: jest.fn(async ({ data }: any) => { states.set(data.state, data); }),
      findUnique: jest.fn(async ({ where }: any) => states.get(where.state) ?? null),
    },
    zaloOaConnection: {
      upsert: jest.fn(async ({ where, create, update }: any) => { conn = conn ? { ...conn, ...update } : { id: 1, ...create }; return conn; }),
      findFirst: jest.fn(async () => conn),
      findUnique: jest.fn(async () => conn),
      updateMany: jest.fn(async ({ data }: any) => { if (conn) conn = { ...conn, ...data }; }),
      deleteMany: jest.fn(async () => { conn = null; }),
    },
  };
  const api = { exchangeCode: jest.fn(), refresh: jest.fn() };
  const svc = new ZaloOaTokenService(prisma as never, api as never);
  return { svc, prisma, api, states, getConn: () => conn };
}

describe('ZaloOaTokenService', () => {
  it('startConnect: URL permission có PKCE S256 + state, verifier lưu MÃ HOÁ', async () => {
    const { svc, states } = setup();
    const { authorize_url } = await svc.startConnect(7);
    const u = new URL(authorize_url);
    expect(u.origin + u.pathname).toBe('https://oauth.zaloapp.com/v4/oa/permission');
    expect(u.searchParams.get('app_id')).toBe('APP');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const state = u.searchParams.get('state') as string;
    const stored = states.get(state)!;
    expect(stored.code_verifier_enc.startsWith('v1.')).toBe(true);
    const verifier = decryptSecret(stored.code_verifier_enc, KEY);
    const { createHash } = await import('node:crypto');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('completeConnect: đổi code bằng verifier đúng, lưu token mã hoá, state dùng một lần', async () => {
    const { svc, api, states, getConn } = setup();
    const url = new URL((await svc.startConnect(7)).authorize_url);
    const state = url.searchParams.get('state') as string;
    const verifier = decryptSecret(states.get(state)!.code_verifier_enc, KEY);
    api.exchangeCode.mockResolvedValue({ access_token: 'AT', refresh_token: 'RT', expires_in: 90000 });
    await svc.completeConnect('CODE', 'OA1', state);
    expect(api.exchangeCode).toHaveBeenCalledWith('APP', 'SEC', 'CODE', verifier);
    const c = getConn()!;
    // Không kiểm "không chứa 'AT'": bản mã base64 ngẫu nhiên đôi khi chứa đúng 2 ký tự đó (test từng hỏng ngẫu nhiên ~1%).
    expect(c.access_token_enc).toMatch(/^v1\./);
    expect(c.access_token_enc).not.toBe('AT');
    expect(decryptSecret(c.access_token_enc, KEY)).toBe('AT');
    expect(c.connected_by).toBe(7);
    await expect(svc.completeConnect('CODE', 'OA1', state)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('state sai hoặc hết hạn bị từ chối, không gọi Zalo', async () => {
    const { svc, api, states } = setup();
    await expect(svc.completeConnect('C', 'OA1', 'khong-co')).rejects.toBeInstanceOf(BadRequestException);
    const state = new URL((await svc.startConnect(1)).authorize_url).searchParams.get('state') as string;
    states.get(state)!.expires_at = new Date(Date.now() - 1000);
    await expect(svc.completeConnect('C', 'OA1', state)).rejects.toBeInstanceOf(BadRequestException);
    expect(api.exchangeCode).not.toHaveBeenCalled();
  });

  async function connected(expiresInMs: number) {
    const s = setup();
    s.api.exchangeCode.mockResolvedValue({ access_token: 'OLD', refresh_token: 'RT0', expires_in: expiresInMs / 1000 });
    const state = new URL((await s.svc.startConnect(7)).authorize_url).searchParams.get('state') as string;
    await s.svc.completeConnect('C', 'OA1', state);
    return s;
  }

  it('token còn hạn: dùng ngay, không refresh', async () => {
    const { svc, api } = await connected(3600_000);
    expect((await svc.getAccessToken()).token).toBe('OLD');
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('token sắp hết: tự refresh bằng refresh token cũ, lưu cặp mới; nhiều lời gọi đồng thời chỉ refresh một lần', async () => {
    const { svc, api, getConn } = await connected(60_000);
    api.refresh.mockResolvedValue({ access_token: 'NEW', refresh_token: 'RT1', expires_in: 90000 });
    const out = await Promise.all([svc.getAccessToken(), svc.getAccessToken(), svc.getAccessToken()]);
    expect(out.every((o) => o.token === 'NEW')).toBe(true);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith('APP', 'SEC', 'RT0');
    expect(decryptSecret(getConn()!.refresh_token_enc, KEY)).toBe('RT1');
  });

  it('refresh hỏng: đánh dấu needs_reauth và báo cần kết nối lại', async () => {
    const { svc, api, getConn } = await connected(60_000);
    api.refresh.mockRejectedValue(new ZaloApiError(-118, 'refresh token invalid'));
    await expect(svc.getAccessToken()).rejects.toBeInstanceOf(BadRequestException);
    expect(getConn()!.status).toBe('needs_reauth');
    await expect(svc.getAccessToken()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refresh lỗi tạm thời (mạng/5xx): KHÔNG đánh dấu needs_reauth, lần sau thử lại được', async () => {
    const { svc, api, getConn } = await connected(60_000);
    api.refresh.mockRejectedValueOnce(new ZaloApiError(-1, 'network down'));
    await expect(svc.getAccessToken()).rejects.toBeInstanceOf(BadRequestException);
    expect(getConn()!.status).toBe('active');
    api.refresh.mockRejectedValueOnce(new ZaloApiError(-503, 'bad gateway', 503));
    await expect(svc.getAccessToken()).rejects.toBeInstanceOf(BadRequestException);
    expect(getConn()!.status).toBe('active');
    api.refresh.mockResolvedValue({ access_token: 'NEW', refresh_token: 'RT1', expires_in: 90000 });
    await expect(svc.getAccessToken()).resolves.toMatchObject({ token: 'NEW' });
  });

  it('status không lộ token', async () => {
    const { svc } = await connected(3600_000);
    const st = await svc.status();
    expect(st).toMatchObject({ configured: true, connected: true, oa_id: 'OA1', status: 'active' });
    expect(JSON.stringify(st)).not.toMatch(/OLD|RT0|v1\./);
  });
});

void encryptSecret;
