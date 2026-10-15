import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../integrations/webhooks/secret-crypto';
import { GoogleOAuthService, emailFromIdToken, signState, verifyState } from '../google-oauth.service';
import { loadGoogleConfig } from '../google-config';
import { FakeGoogleHttp } from './fake-google';

const KEY = randomBytes(32);
const envBackup = { ...process.env };
beforeEach(() => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY.toString('base64');
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csecret';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://crm.test/api/v1/integrations/google/oauth/callback';
});
afterEach(() => { process.env = { ...envBackup }; });

describe('state OAuth', () => {
  it('ký/kiểm đúng, từ chối sửa đổi, hết hạn, sai khoá', () => {
    const s = signState(7, KEY);
    expect(verifyState(s, KEY)).toEqual({ userId: 7 });
    expect(verifyState(`${s}x`, KEY)).toBeNull();
    expect(verifyState(s, randomBytes(32))).toBeNull();
    expect(verifyState(s, KEY, Date.now() + 11 * 60_000)).toBeNull();
    expect(verifyState('rac', KEY)).toBeNull();
  });
});

describe('loadGoogleConfig', () => {
  it('thiếu client id/secret ⇒ null (không hoạt động)', () => {
    expect(loadGoogleConfig({})).toBeNull();
    expect(loadGoogleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'a' })).toBeNull();
  });
  it('redirect suy từ INTEGRATIONS_PUBLIC_BASE_URL khi không khai', () => {
    const c = loadGoogleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b', INTEGRATIONS_PUBLIC_BASE_URL: 'https://crm.test' });
    expect(c?.redirectUri).toBe('https://crm.test/api/v1/integrations/google/oauth/callback');
  });
});

describe('emailFromIdToken', () => {
  it('đọc email, rác ⇒ null', () => {
    expect(emailFromIdToken(`x.${Buffer.from('{"email":"a@b.vn"}').toString('base64url')}.y`)).toBe('a@b.vn');
    expect(emailFromIdToken('rac')).toBeNull();
  });
});

function makePrisma() {
  const conns: Record<string, unknown>[] = [];
  const tx = {
    googleConnection: {
      create: jest.fn(async ({ data }) => { const r = { id: conns.length + 1, ...data }; conns.push(r); return r; }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    googleSheetSync: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: unknown) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn as Promise<unknown>[]))),
    googleConnection: { update: jest.fn(async () => ({})), findFirst: jest.fn() },
    googleSheetSync: { updateMany: jest.fn(async () => ({ count: 2 })) },
  };
  return { prisma, tx, conns };
}

describe('GoogleOAuthService', () => {
  it('callback: đổi code, lưu token MÃ HOÁ (không plaintext), nhận email', async () => {
    const http = new FakeGoogleHttp();
    const { prisma, tx, conns } = makePrisma();
    const svc = new GoogleOAuthService(prisma as never, http);
    const conn = (await svc.handleCallback('CODE', signState(5, KEY))) as unknown as Record<string, string>;
    expect(conn.google_email).toBe('ceo@congty.vn');
    expect(conn.created_by).toBe(5);
    expect(JSON.stringify(conns)).not.toContain('RT-1');
    expect(JSON.stringify(conns)).not.toContain('AT-1');
    expect(decryptSecret(conn.refresh_token_enc, KEY)).toBe('RT-1');
    expect(tx.googleSheetSync.updateMany).toHaveBeenCalled(); // cấu hình cũ chuyển sang kết nối mới
    expect(http.calls[0].form).toMatchObject({ grant_type: 'authorization_code', code: 'CODE' });
  });

  it('callback: state sai ⇒ 400, không gọi Google', async () => {
    const http = new FakeGoogleHttp();
    const svc = new GoogleOAuthService(makePrisma().prisma as never, http);
    await expect(svc.handleCallback('CODE', 'bậy')).rejects.toThrow(/state/);
    expect(http.calls).toHaveLength(0);
  });

  it('callback: Google không trả refresh token ⇒ báo cách xử lý', async () => {
    const http = new FakeGoogleHttp();
    http.tokenBody = { access_token: 'AT', expires_in: 3600 };
    const svc = new GoogleOAuthService(makePrisma().prisma as never, http);
    await expect(svc.handleCallback('C', signState(1, KEY))).rejects.toThrow(/refresh token/);
  });

  it('accessToken: còn hạn ⇒ dùng lại, không gọi Google; hết hạn ⇒ refresh + lưu mã hoá', async () => {
    const http = new FakeGoogleHttp();
    const { prisma } = makePrisma();
    const svc = new GoogleOAuthService(prisma as never, http);
    const fresh = { id: 1, refresh_token_enc: encryptSecret('RT', KEY), access_token_enc: encryptSecret('CACHED', KEY), token_expires_at: new Date(Date.now() + 600_000) };
    expect(await svc.accessToken(fresh as never)).toBe('CACHED');
    expect(http.calls).toHaveLength(0);
    http.tokenBody = { access_token: 'NEW-AT', expires_in: 3600 };
    const stale = { ...fresh, token_expires_at: new Date(Date.now() - 1000) };
    expect(await svc.accessToken(stale as never)).toBe('NEW-AT');
    expect(http.calls[0].form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT' });
    const saved = (prisma.googleConnection.update.mock.calls as unknown as [{ data: Record<string, string> }][])[0][0].data;
    expect(saved.access_token_enc).not.toContain('NEW-AT');
  });

  it('accessToken: invalid_grant ⇒ đánh dấu revoked', async () => {
    const http = new FakeGoogleHttp();
    http.tokenStatus = 400;
    http.tokenBody = { error: 'invalid_grant' };
    const { prisma } = makePrisma();
    const svc = new GoogleOAuthService(prisma as never, http);
    const stale = { id: 1, refresh_token_enc: encryptSecret('RT', KEY), access_token_enc: null, token_expires_at: null };
    await expect(svc.accessToken(stale as never)).rejects.toThrow(/thu hồi/);
    expect((prisma.googleConnection.update.mock.calls as unknown as [{ data: { status: string } }][])[0][0].data.status).toBe('revoked');
  });

  it('thiếu cấu hình Google ⇒ 503 rõ ràng', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const svc = new GoogleOAuthService(makePrisma().prisma as never, new FakeGoogleHttp());
    expect(() => svc.authUrl(1)).toThrow(/chưa được cấu hình/);
  });

  it('authUrl: scope tối thiểu, offline, có state', () => {
    const svc = new GoogleOAuthService(makePrisma().prisma as never, new FakeGoogleHttp());
    const u = new URL(svc.authUrl(3));
    expect(u.searchParams.get('scope')).toContain('auth/spreadsheets');
    expect(u.searchParams.get('scope')).toContain('auth/drive.file');
    expect(u.searchParams.get('scope')).not.toMatch(/auth\/drive(\s|$)/);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(verifyState(u.searchParams.get('state') as string, KEY)).toEqual({ userId: 3 });
  });
});
