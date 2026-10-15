import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeGetJson, SafeGetError } from '../../common/safe-http-get';

const dev: NodeJS.ProcessEnv = { NODE_ENV: 'test', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' };

describe('safeGetJson (tải CIMD)', () => {
  let srv: http.Server;
  let origin: string;
  const routes: Record<string, (res: http.ServerResponse) => void> = {};

  beforeAll(async () => {
    srv = http.createServer((req, res) => (routes[req.url ?? ''] ?? ((r) => void r.writeHead(404).end()))(res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => srv.close(r));
  });

  it('SSRF: mọi địa chỉ nội bộ bị chặn khi KHÔNG bật cờ dev (mặc định = production)', async () => {
    for (const u of ['https://127.0.0.1/a', 'https://10.1.2.3/a', 'https://169.254.169.254/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://0.0.0.0/a', 'http://example.com/a', 'https://example.com:22/a']) {
      await expect(safeGetJson(u, { env: { NODE_ENV: 'production' } })).rejects.toThrow(SafeGetError);
    }
  });

  it('DNS rebinding/trộn IP nội bộ vào đáp án ⇒ chặn (resolver giả)', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await expect(safeGetJson('https://rebind.example.com/c.json', { env: { NODE_ENV: 'production' }, resolver })).rejects.toThrow('blocked_target');
  });

  it('JSON hợp lệ + Cache-Control max-age', async () => {
    routes['/ok'] = (res) => void res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' }).end('{"a":1}');
    const r = await safeGetJson(`${origin}/ok`, { env: dev });
    expect(r).toMatchObject({ statusCode: 200, maxAgeSec: 120, json: { a: 1 } });
  });

  it('KHÔNG theo redirect; non-200; sai content-type; JSON hỏng; quá lớn ⇒ lỗi', async () => {
    routes['/redir'] = (res) => void res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    routes['/ctype'] = (res) => void res.writeHead(200, { 'Content-Type': 'text/html' }).end('{"a":1}');
    routes['/bad'] = (res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{nope');
    routes['/big'] = (res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ x: 'a'.repeat(70_000) }));
    await expect(safeGetJson(`${origin}/redir`, { env: dev })).rejects.toThrow('redirect_not_followed');
    await expect(safeGetJson(`${origin}/missing`, { env: dev })).rejects.toThrow('http_404');
    await expect(safeGetJson(`${origin}/ctype`, { env: dev })).rejects.toThrow('not_json');
    await expect(safeGetJson(`${origin}/bad`, { env: dev })).rejects.toThrow('invalid_json');
    await expect(safeGetJson(`${origin}/big`, { env: dev })).rejects.toThrow('too_large');
  });

  it('timeout', async () => {
    routes['/slow'] = () => undefined;
    await expect(safeGetJson(`${origin}/slow`, { env: dev, timeoutMs: 150 })).rejects.toThrow('timeout');
  });
});
