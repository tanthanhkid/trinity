import { __resetClientIpStateForTest, __setRouteTableForTest } from '@trinity/rbac-nest';
import { normalizeIp, extractClientIp, ipMatchesOffice } from '../attendance-ip.helper';
import type { Request } from 'express';

describe('normalizeIp', () => {
  it('should strip ::ffff: prefix (IPv4-mapped IPv6)', () => {
    expect(normalizeIp('::ffff:203.0.113.108')).toBe('203.0.113.108');
    expect(normalizeIp('::FFFF:198.51.100.73')).toBe('198.51.100.73');
  });

  it('should return plain IPv4 unchanged', () => {
    expect(normalizeIp('203.0.113.108')).toBe('203.0.113.108');
    expect(normalizeIp('192.168.1.1')).toBe('192.168.1.1');
  });

  it('should trim whitespace', () => {
    expect(normalizeIp('  192.168.1.1  ')).toBe('192.168.1.1');
  });

  it('should return plain IPv6 unchanged', () => {
    expect(normalizeIp('::1')).toBe('::1');
  });
});

// Luật đầy đủ (5 giá trị TRUSTED_PROXY, chữ ký) test ở packages/rbac-nest/src/client-ip.spec.ts.
describe('extractClientIp — qua hàm dùng chung resolveClientIp', () => {
  const makeReq = (headers: Record<string, string | undefined>, remoteAddress?: string): Request =>
    ({ headers, socket: { remoteAddress } }) as unknown as Request;
  const ORIGINAL_TP = process.env.TRUSTED_PROXY;
  beforeEach(() => {
    __resetClientIpStateForTest();
    __setRouteTableForTest(null);
  });
  afterEach(() => {
    if (ORIGINAL_TP === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = ORIGINAL_TP;
    __setRouteTableForTest(undefined);
  });

  it('SECURITY: mặc định (none) gọi thẳng kèm cf-connecting-ip / x-real-ip / x-forwarded-for giả → IP peer', () => {
    delete process.env.TRUSTED_PROXY;
    process.env.ATTENDANCE_TRUST_CF_IP = 'true'; // cờ cũ không còn tác dụng
    try {
      const req = makeReq({ 'cf-connecting-ip': '203.0.113.108', 'x-real-ip': '203.0.113.108', 'x-forwarded-for': '203.0.113.108' }, '198.51.100.9');
      expect(extractClientIp(req)).toBe('198.51.100.9');
    } finally {
      delete process.env.ATTENDANCE_TRUST_CF_IP;
    }
  });

  it('peer loopback chưa khai báo proxy → null (không tin được: cho qua, không so IP văn phòng)', () => {
    delete process.env.TRUSTED_PROXY;
    expect(extractClientIp(makeReq({ 'x-real-ip': '203.0.113.5' }, '127.0.0.1'))).toBeNull();
  });

  it('peer là cổng mặc định của container → null', () => {
    delete process.env.TRUSTED_PROXY;
    __setRouteTableForTest('Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010012AC\t0003\n'); // 172.18.0.1
    expect(extractClientIp(makeReq({}, '172.18.0.1'))).toBeNull();
  });

  it('cloudflare-behind:127.0.0.1/32 → cf-connecting-ip khi hop do proxy ghi thuộc dải Cloudflare', () => {
    process.env.TRUSTED_PROXY = 'cloudflare-behind:127.0.0.1/32';
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 172.70.1.1', 'cf-connecting-ip': '203.0.113.108' }, '127.0.0.1');
    expect(extractClientIp(req)).toBe('203.0.113.108');
  });
});

describe('ipMatchesOffice', () => {
  const officeIps = ['203.0.113.108', '203.0.113.123'];

  it('should return true when IP matches an office IP', () => {
    expect(ipMatchesOffice('203.0.113.108', officeIps)).toBe(true);
    expect(ipMatchesOffice('203.0.113.123', officeIps)).toBe(true);
  });

  it('should return false when IP does not match', () => {
    expect(ipMatchesOffice('203.0.113.109', officeIps)).toBe(false);
    expect(ipMatchesOffice('198.51.100.73', officeIps)).toBe(false);
  });

  it('should normalize IPv4-mapped IPv6 before comparing', () => {
    expect(ipMatchesOffice('::ffff:203.0.113.108', officeIps)).toBe(true);
    expect(ipMatchesOffice('203.0.113.108', ['::ffff:203.0.113.108'])).toBe(true);
  });

  it('should return false for empty office IP list', () => {
    expect(ipMatchesOffice('203.0.113.108', [])).toBe(false);
  });
});
