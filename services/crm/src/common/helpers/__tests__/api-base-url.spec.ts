import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encryptSecret, loadSecretKey } from '../../../integrations/webhooks/secret-crypto';
import { GraphClient } from '../../../facebook/graph-client';
import { graphUrl } from '../../../facebook/facebook.config';
import { postFirstComment } from '../../../social/facebook-first-comment';
import { graphCall } from '../../../social/providers/facebook.provider';
import { ZaloOaApiClient } from '../../../zalo-oa/zalo-oa-api.client';
import { zaloUrls } from '../../../zalo-oa/zalo-oa.config';
import { apiBaseUrl } from '../api-base-url';

const ENV = { ...process.env };
const BASE_VARS = ['FACEBOOK_GRAPH_BASE_URL', 'ZALO_OAUTH_BASE_URL', 'ZALO_OPENAPI_BASE_URL', 'ZALO_ZNS_BASE_URL'] as const;
beforeEach(() => {
  for (const k of BASE_VARS) delete process.env[k];
  process.env.FACEBOOK_APP_ID = 'app';
  process.env.FACEBOOK_APP_SECRET = 'secret';
  process.env.INTEGRATIONS_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
});
afterEach(() => {
  process.env = { ...ENV };
});

describe('apiBaseUrl', () => {
  it('không đặt ⇒ địa chỉ mặc định; đặt ⇒ bỏ / cuối', () => {
    expect(apiBaseUrl('X_BASE', 'https://api.example.com', {})).toBe('https://api.example.com');
    expect(apiBaseUrl('X_BASE', 'https://api.example.com', { X_BASE: '  ' })).toBe('https://api.example.com');
    expect(apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'https://fake.test/graph/' })).toBe('https://fake.test/graph');
  });

  it('http:// chỉ nhận ngoài production', () => {
    expect(apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'http://127.0.0.1:9000', NODE_ENV: 'test' })).toBe('http://127.0.0.1:9000');
    expect(() => apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'http://127.0.0.1:9000', NODE_ENV: 'production' })).toThrow(/https:\/\/ ở production/);
    expect(apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'https://graph.example.com', NODE_ENV: 'production' })).toBe('https://graph.example.com');
  });

  it('từ chối URL hỏng, giao thức lạ, có query', () => {
    expect(() => apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'graph.example.com' })).toThrow(/không phải URL/);
    expect(() => apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'ftp://x' })).toThrow(/chỉ nhận https/);
    expect(() => apiBaseUrl('X_BASE', 'https://a', { X_BASE: 'https://x/?a=1' })).toThrow(/query/);
  });
});

describe('không đặt env ⇒ URL như cũ', () => {
  it('Graph API và Graph video', () => {
    expect(graphUrl('v25.0', '/me/accounts', new URLSearchParams({ limit: '1' }))).toBe('https://graph.facebook.com/v25.0/me/accounts?limit=1');
    expect(graphUrl('v25.0', 'P1_9/comments')).toBe('https://graph.facebook.com/v25.0/P1_9/comments');
    expect(graphUrl('v25.0', '555/videos', undefined, { video: true })).toBe('https://graph-video.facebook.com/v25.0/555/videos');
  });

  it('đường dẫn Graph không thoát khỏi /{version}/ hay chèn query', () => {
    for (const bad of ['../me', 'a/../../b', 'P1?access_token=x', 'P1#x', 'a b', 'a\\b']) {
      expect(() => graphUrl('v25.0', bad)).toThrow(/không hợp lệ/);
    }
    expect(graphUrl('v25.0', '123_456/comments')).toBe('https://graph.facebook.com/v25.0/123_456/comments');
  });

  it('Zalo OAuth, OpenAPI, ZNS', () => {
    expect(zaloUrls()).toEqual({
      permission: 'https://oauth.zaloapp.com/v4/oa/permission',
      token: 'https://oauth.zaloapp.com/v4/oa/access_token',
      api: 'https://openapi.zalo.me/v3.0/oa',
      zns: 'https://business.openapi.zalo.me/message/template',
    });
  });
});

describe('đặt env ⇒ mọi lời gọi tới máy chủ giả', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];
  const realFetch = global.fetch;
  const outbound: string[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      hits.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        const u = req.url ?? '';
        const body = u.includes('/zoauth/') ? { access_token: 'AT', refresh_token: 'RT', expires_in: 90000 } : u.includes('/videos') ? { upload_session_id: 's', video_id: 'v', start_offset: '0', end_offset: '0' } : { id: 'x', data: [], error: 0 };
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    hits.length = 0;
    outbound.length = 0;
    // Ghi mọi URL đi ra để chắc không lời gọi nào lọt tới máy chủ thật.
    global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    }) as typeof fetch;
    process.env.FACEBOOK_GRAPH_BASE_URL = `${base}/fb/`;
    process.env.ZALO_OAUTH_BASE_URL = `${base}/zoauth`;
    process.env.ZALO_OPENAPI_BASE_URL = `${base}/zapi`;
    process.env.ZALO_ZNS_BASE_URL = `${base}/zns`;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('Graph: GraphClient, Đăng đa kênh (cả host video), bình luận đầu tiên', async () => {
    await new GraphClient().listPages('user-token');
    await graphCall('POST', '555/feed', { token: 'page-token', body: { message: 'x' } });
    await graphCall('POST', '555/videos', { token: 'page-token', video: true, form: new FormData() });
    const token_enc = encryptSecret('page-token', loadSecretKey());
    const prisma = { facebookPage: { findFirst: jest.fn(async () => ({ token_enc })) } };
    expect(await postFirstComment(prisma as never, 'P1', 'P1_9', 'hi')).toBe('posted');
    expect(hits.map((h) => h.replace(/\?.*$/, ''))).toEqual([
      'GET /fb/v25.0/me/accounts',
      'POST /fb/v25.0/555/feed',
      'POST /fb/v25.0/555/videos',
      'POST /fb/v25.0/P1_9/comments',
    ]);
    expect(outbound.every((u) => u.startsWith(`${base}/`))).toBe(true);
  });

  it('Zalo: đổi token, tin tư vấn, ZNS, hồ sơ, trang cấp quyền', async () => {
    const api = new ZaloOaApiClient();
    await api.exchangeCode('APP', 'SEC', 'CODE', 'VER');
    await api.sendText('AT', 'u1', 'chào');
    await api.sendZns('AT', { phone: '84912345678', templateId: 't', templateData: {}, mode: null });
    await api.getProfile('AT', 'u1');
    expect(hits.map((h) => h.replace(/\?.*$/, ''))).toEqual([
      'POST /zoauth/v4/oa/access_token',
      'POST /zapi/v3.0/oa/message/cs',
      'POST /zns/message/template',
      'GET /zapi/v3.0/oa/user/detail',
    ]);
    expect(outbound.every((u) => u.startsWith(`${base}/`))).toBe(true);
    expect(zaloUrls().permission).toBe(`${base}/zoauth/v4/oa/permission`);
  });

  it('production đặt http:// ⇒ từ chối, không gửi request nào', async () => {
    process.env.NODE_ENV = 'production';
    await expect(new GraphClient().listPages('user-token')).rejects.toThrow(/FACEBOOK_GRAPH_BASE_URL phải dùng https/);
    await expect(graphCall('GET', 'me', { token: 't' })).rejects.toThrow(/FACEBOOK_GRAPH_BASE_URL phải dùng https/);
    await expect(new ZaloOaApiClient().sendText('AT', 'u1', 'x')).rejects.toThrow(/ZALO_\w+_BASE_URL phải dùng https/);
    expect(() => zaloUrls()).toThrow(/ZALO_OAUTH_BASE_URL phải dùng https/);
    expect(outbound).toEqual([]);
    expect(hits).toEqual([]);
  });
});
