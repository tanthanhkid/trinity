import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { postJson } from '../webhook-http-client';
import { buildSignatureHeader, verifySignatureHeader } from '../signature';

/** Server cục bộ (127.0.0.1) — CHỈ gửi được vì mode test + cờ tường minh (xem ssrf-guard). */
const TEST_ENV = { NODE_ENV: 'test', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' } as NodeJS.ProcessEnv;
const PROD_ENV = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server;
let base: string;
let seen: Seen[] = [];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
beforeEach(() => { seen = []; handler = (_q, s) => { s.statusCode = 200; s.end('ok'); }; });

const req = (path: string, body = '{"a":1}', extra: Record<string, string> = {}) => ({
  url: `${base}${path}`, body, headers: { 'Content-Type': 'application/json', ...extra }, timeoutMs: 1500,
});

describe('postJson (server cục bộ)', () => {
  it('2xx → ok; body + header + chữ ký tới nơi đúng byte', async () => {
    const body = '{"id":"d1","type":"contact.created","created_at":"x","data":{"phone":"***678"}}';
    const sig = buildSignatureHeader('whsec_abc', body);
    const r = await postJson(req('/hook?x=1', body, { 'X-Trinity-Signature': sig, 'X-Trinity-Delivery': 'd1' }), { env: TEST_ENV });
    expect(r).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/hook?x=1');
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers['x-trinity-delivery']).toBe('d1');
    expect(verifySignatureHeader('whsec_abc', seen[0].body, seen[0].headers['x-trinity-signature'] as string)).toBe(true);
    expect(seen[0].headers['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  it('không theo redirect (3xx là thất bại, KHÔNG gọi Location)', async () => {
    let followed = false;
    handler = (q, s) => {
      if (q.url === '/target') { followed = true; s.statusCode = 200; return void s.end(); }
      s.statusCode = 302; s.setHeader('Location', '/target'); s.end();
    };
    const r = await postJson(req('/r'), { env: TEST_ENV });
    expect(r).toMatchObject({ ok: false, statusCode: 302, error: 'redirect_not_followed' });
    await new Promise((x) => setTimeout(x, 50));
    expect(followed).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(['/r']);
  });

  it('4xx/5xx → ok=false kèm mã; không rò nội dung phản hồi', async () => {
    handler = (_q, s) => { s.statusCode = 500; s.end('secret-internal-stacktrace'); };
    const r = await postJson(req('/x'), { env: TEST_ENV });
    expect(r).toMatchObject({ ok: false, statusCode: 500, error: 'http_500' });
    expect(JSON.stringify(r)).not.toContain('stacktrace');
  });

  it('timeout → error=timeout, không treo', async () => {
    handler = () => { /* không phản hồi */ };
    const t0 = Date.now();
    const r = await postJson({ ...req('/slow'), timeoutMs: 300 }, { env: TEST_ENV });
    expect(r).toMatchObject({ ok: false, statusCode: null, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('cổng đóng → connection_refused', async () => {
    const r = await postJson({ ...req('/'), url: 'http://127.0.0.1:1/x' }, { env: TEST_ENV });
    expect(r).toMatchObject({ ok: false, error: 'connection_refused' });
  });

  it('PRODUCTION: cùng URL 127.0.0.1 bị chặn TRƯỚC khi mở kết nối (server không nhận gì)', async () => {
    const r = await postJson(req('/x'), { env: PROD_ENV });
    expect(r).toMatchObject({ ok: false, statusCode: null, error: 'blocked_target' });
    expect(seen).toHaveLength(0);
  });

  it('PRODUCTION + cờ cho phép riêng lẻ vẫn chặn (cờ chỉ có tác dụng khi NODE_ENV=test|development)', async () => {
    const r = await postJson(req('/x'), { env: { NODE_ENV: 'production', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' } as never });
    expect(r.error).toBe('blocked_target');
    expect(seen).toHaveLength(0);
  });

  it('PRODUCTION: hostname phân giải về IP nội bộ (resolver giả) bị chặn, kể cả khi tạo lúc đầu sạch', async () => {
    let n = 0;
    const resolver = async () => (++n === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    // 1) kiểm lúc gửi (assertSafeUrl) dùng lần phân giải 1 → sạch; 2) socket gọi lookup → lần 2 → 127.0.0.1 ⇒ bị chặn.
    const r = await postJson({ url: 'https://rebind.example.com/h', body: '{}', headers: {}, timeoutMs: 1500 }, { env: PROD_ENV, resolver });
    expect(r).toMatchObject({ ok: false, statusCode: null, error: 'blocked_target' });
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('PRODUCTION: resolver DNS treo cũng bị cắt trong hạn timeout (không giữ việc quá lease)', async () => {
    const t0 = Date.now();
    const r = await postJson(
      { url: 'https://slow-dns.example.com/h', body: '{}', headers: {}, timeoutMs: 200 },
      { env: PROD_ENV, resolver: () => new Promise(() => undefined) },
    );
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
