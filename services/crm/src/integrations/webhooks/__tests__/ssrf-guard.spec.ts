import {
  allowPrivateTargets,
  assertSafeUrl,
  createSafeLookup,
  isBlockedIp,
  parseWebhookUrl,
  SsrfBlockedError,
} from '../ssrf-guard';

const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const TEST_OPEN = { NODE_ENV: 'test', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' } as NodeJS.ProcessEnv;

describe('isBlockedIp — IPv4', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255',
    '192.0.0.5', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '240.0.0.1',
  ];
  it.each(blocked)('chặn %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  const open = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '193.168.0.1', '203.0.114.1', '126.255.255.255'];
  it.each(open)('cho %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('isBlockedIp — IPv6', () => {
  const blocked = [
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '::ffff:c0a8:101',
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:db8::1', '2001::1', '2001:1::1',
    '100::1', '::127.0.0.1', '0:0:0:0:0:0:0:1', 'fe80::1%eth0', 'garbage', '', '1.2.3', '2130706433',
  ];
  it.each(blocked)('chặn %j', (ip) => expect(isBlockedIp(ip)).toBe(true));

  const open = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '64:ff9b::808:808', '::ffff:8.8.8.8'];
  it.each(open)('cho %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('parseWebhookUrl', () => {
  it('chỉ https; http bị chặn ở production', () => {
    expect(() => parseWebhookUrl('http://example.com/x', PROD)).toThrow(SsrfBlockedError);
    expect(() => parseWebhookUrl('ftp://example.com/x', PROD)).toThrow(SsrfBlockedError);
    expect(() => parseWebhookUrl('file:///etc/passwd', PROD)).toThrow(SsrfBlockedError);
    expect(() => parseWebhookUrl('gopher://example.com', PROD)).toThrow(SsrfBlockedError);
    expect(parseWebhookUrl('https://example.com/hook?x=1', PROD).hostname).toBe('example.com');
  });

  it('chặn tài khoản trong URL và cổng lạ', () => {
    expect(() => parseWebhookUrl('https://user:pw@example.com/', PROD)).toThrow(/tài khoản/);
    expect(() => parseWebhookUrl('https://example.com:5432/', PROD)).toThrow(/cổng/);
    expect(() => parseWebhookUrl('https://example.com:4000/', PROD)).toThrow(/cổng/);
    expect(() => parseWebhookUrl('https://example.com:8443/', PROD)).not.toThrow();
    expect(() => parseWebhookUrl('https://example.com:443/', PROD)).not.toThrow();
  });

  it.each([
    'https://127.0.0.1/', 'https://localhost/x'.replace('localhost', '0.0.0.0'), 'https://[::1]/', 'https://10.1.2.3/', 'https://169.254.169.254/latest/meta-data',
    // dạng IP lách: WHATWG URL chuẩn hoá về a.b.c.d trước khi mình kiểm.
    'https://2130706433/', 'https://0x7f000001/', 'https://0x7f.1/', 'https://017700000001/', 'https://127.1/', 'https://0/', 'https://0177.0.0.1/',
    'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[0:0:0:0:0:ffff:7f00:1]/', 'https://[fd00::1]/', 'https://[fe80::1]/',
    'https://100.64.0.1/', 'https://192.168.0.1/', 'https://[64:ff9b::7f00:1]/', 'https://3232235521/',
  ])('chặn IP literal/dạng lách %s', (u) => {
    expect(() => parseWebhookUrl(u, PROD)).toThrow(SsrfBlockedError);
  });

  it('IP công cộng literal được qua bước cú pháp', () => {
    expect(parseWebhookUrl('https://8.8.8.8/h', PROD).hostname).toBe('8.8.8.8');
    expect(parseWebhookUrl('https://[2606:4700:4700::1111]/h', PROD).hostname).toBe('2606:4700:4700::1111');
  });

  it('không có cờ test: cờ riêng lẻ KHÔNG mở lỗ (production + cờ → vẫn chặn)', () => {
    expect(allowPrivateTargets({ NODE_ENV: 'production', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' } as never)).toBe(false);
    expect(allowPrivateTargets({ INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' } as never)).toBe(false); // NODE_ENV thiếu = production
    expect(allowPrivateTargets({ NODE_ENV: 'staging', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: '1' } as never)).toBe(false);
    expect(allowPrivateTargets({ NODE_ENV: 'test' } as never)).toBe(false); // thiếu cờ tường minh
    expect(allowPrivateTargets(TEST_OPEN)).toBe(true);
    expect(allowPrivateTargets({ NODE_ENV: 'development', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: '1' } as never)).toBe(true);
    expect(() => parseWebhookUrl('http://127.0.0.1:8080/x', { NODE_ENV: 'production', INTEGRATIONS_ALLOW_PRIVATE_TARGETS: 'true' } as never)).toThrow(SsrfBlockedError);
  });

  it('mode test + cờ: http://127.0.0.1 được phép', () => {
    expect(parseWebhookUrl('http://127.0.0.1:8080/x', TEST_OPEN).hostname).toBe('127.0.0.1');
  });
});

describe('assertSafeUrl — DNS', () => {
  const res = (...addrs: Array<[string, 4 | 6]>) => async () => addrs.map(([address, family]) => ({ address, family }));

  it('hostname phân giải về IP nội bộ bị chặn', async () => {
    await expect(assertSafeUrl('https://evil.example.com/', { env: PROD, resolver: res(['127.0.0.1', 4]) })).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl('https://evil.example.com/', { env: PROD, resolver: res(['169.254.169.254', 4]) })).rejects.toThrow(/không phải IP công cộng/);
    await expect(assertSafeUrl('https://evil.example.com/', { env: PROD, resolver: res(['::1', 6]) })).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl('https://evil.example.com/', { env: PROD, resolver: res(['::ffff:10.0.0.5', 6]) })).rejects.toThrow(SsrfBlockedError);
  });

  it('BẤT KỲ địa chỉ nào nội bộ trong danh sách là đủ để chặn', async () => {
    await expect(assertSafeUrl('https://mix.example.com/', { env: PROD, resolver: res(['8.8.8.8', 4], ['10.0.0.1', 4]) })).rejects.toThrow(SsrfBlockedError);
  });

  it('DNS lỗi / rỗng → từ chối', async () => {
    await expect(assertSafeUrl('https://nx.example.com/', { env: PROD, resolver: async () => { throw new Error('ENOTFOUND'); } })).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl('https://nx.example.com/', { env: PROD, resolver: async () => [] })).rejects.toThrow(SsrfBlockedError);
  });

  it('IP công cộng → cho qua', async () => {
    const t = await assertSafeUrl('https://ok.example.com/h', { env: PROD, resolver: res(['93.184.216.34', 4]) });
    expect(t.hostname).toBe('ok.example.com');
  });

  it('localhost phân giải 127.0.0.1 → chặn', async () => {
    await expect(assertSafeUrl('https://localhost/', { env: PROD, resolver: res(['127.0.0.1', 4]) })).rejects.toThrow(SsrfBlockedError);
  });
});

describe('createSafeLookup — chống DNS rebinding', () => {
  const run = (lookup: ReturnType<typeof createSafeLookup>, opts: object) =>
    new Promise<{ err: Error | null; addr?: unknown; family?: number }>((resolve) =>
      lookup('rebind.example.com', opts, (err, addr, family) => resolve({ err, addr, family })),
    );

  it('đáp án đổi sang IP nội bộ ở lần phân giải lúc KẾT NỐI vẫn bị chặn (kiểm nằm trong chính lookup của socket)', async () => {
    let call = 0;
    const resolver = async () => (++call === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    // Lần 1 (lúc tạo endpoint) sạch…
    await expect(assertSafeUrl('https://rebind.example.com/', { env: PROD, resolver })).resolves.toBeTruthy();
    // …lần 2 (lúc nối socket) là 127.0.0.1 → lookup của socket từ chối.
    const out = await run(createSafeLookup(PROD, resolver), {});
    expect(out.err).toBeInstanceOf(SsrfBlockedError);
  });

  it('trả đúng địa chỉ đã kiểm (dạng 1 địa chỉ và dạng all)', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }];
    const lk = createSafeLookup(PROD, resolver);
    const one = await run(lk, {});
    expect(one.addr).toBe('93.184.216.34');
    const all = await run(lk, { all: true });
    expect(all.addr).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    const v6 = await run(lk, { family: 6 });
    expect(v6.addr).toBe('2606:2800:220:1::1');
  });

  it('danh sách lẫn 1 IP nội bộ → chặn cả danh sách', async () => {
    const lk = createSafeLookup(PROD, async () => [{ address: '8.8.8.8', family: 4 }, { address: '192.168.0.9', family: 4 }]);
    expect((await run(lk, { all: true })).err).toBeInstanceOf(SsrfBlockedError);
  });
});
