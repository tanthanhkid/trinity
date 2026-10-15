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

const LOOPBACK = '127.0.0.1'; // proxy nội bộ nên được tin header

describe('extractClientIp', () => {
  const makeReq = (headers: Record<string, string | undefined>, ip?: string, remoteAddress?: string): Request => ({
    headers,
    ip,
    socket: { remoteAddress },
  } as unknown as Request);

  const ORIGINAL_TRUST_CF = process.env.ATTENDANCE_TRUST_CF_IP;
  afterEach(() => {
    if (ORIGINAL_TRUST_CF === undefined) delete process.env.ATTENDANCE_TRUST_CF_IP;
    else process.env.ATTENDANCE_TRUST_CF_IP = ORIGINAL_TRUST_CF;
  });

  it('SECURITY: should prefer x-real-ip (nginx-set) over client-spoofable cf-connecting-ip by default', () => {
    delete process.env.ATTENDANCE_TRUST_CF_IP;
    const req = makeReq({ 'cf-connecting-ip': '203.0.113.108', 'x-real-ip': '10.0.0.1' }, undefined, LOOPBACK);
    // KHÔNG được tin cf-connecting-ip (client tự gửi khi không có proxy) → dùng x-real-ip
    expect(extractClientIp(req)).toBe('10.0.0.1');
  });

  it('SECURITY: should IGNORE cf-connecting-ip when no x-real-ip + env off (chống giả mạo)', () => {
    delete process.env.ATTENDANCE_TRUST_CF_IP;
    const req = makeReq({ 'cf-connecting-ip': '203.0.113.108' });
    expect(extractClientIp(req)).toBeNull();
  });

  it('should trust cf-connecting-ip ONLY when ATTENDANCE_TRUST_CF_IP=true (sau Cloudflare)', () => {
    process.env.ATTENDANCE_TRUST_CF_IP = 'true';
    const req = makeReq({ 'cf-connecting-ip': '203.0.113.108', 'x-real-ip': '10.0.0.1' });
    expect(extractClientIp(req)).toBe('203.0.113.108');
  });

  it('should use x-real-ip when present', () => {
    const req = makeReq({ 'x-real-ip': '198.51.100.73' }, undefined, LOOPBACK);
    expect(extractClientIp(req)).toBe('198.51.100.73');
  });

  it('should fall back to first x-forwarded-for entry', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.189, 10.0.0.1' }, undefined, LOOPBACK);
    expect(extractClientIp(req)).toBe('203.0.113.189');
  });

  it('SECURITY: x-forwarded-for do client chèn đầu danh sách → lấy IP proxy nối cuối, không lấy phần client tự gửi', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.108, 198.51.100.73' }, undefined, LOOPBACK);
    expect(extractClientIp(req)).toBe('198.51.100.73');
  });

  it('should fall back to req.ip', () => {
    const req = makeReq({}, '203.0.113.123');
    expect(extractClientIp(req)).toBe('203.0.113.123');
  });

  it('should fall back to socket.remoteAddress', () => {
    const req = makeReq({}, undefined, '::ffff:203.0.113.108');
    expect(extractClientIp(req)).toBe('203.0.113.108');
  });

  it('should return null when no IP available', () => {
    const req = makeReq({});
    expect(extractClientIp(req)).toBeNull();
  });

  it('SECURITY: gọi thẳng từ IP công cộng với x-real-ip/x-forwarded-for giả → bỏ qua header, dùng IP socket', () => {
    const req = makeReq({ 'x-real-ip': '203.0.113.108', 'x-forwarded-for': '203.0.113.108' }, undefined, '198.51.100.9');
    expect(extractClientIp(req)).toBe('198.51.100.9');
  });

  it('ATTENDANCE_TRUST_PROXY_HEADERS=true → tin header dù socket là IP công cộng', () => {
    process.env.ATTENDANCE_TRUST_PROXY_HEADERS = 'true';
    try {
      const req = makeReq({ 'x-real-ip': '203.0.113.5' }, undefined, '198.51.100.9');
      expect(extractClientIp(req)).toBe('203.0.113.5');
    } finally {
      delete process.env.ATTENDANCE_TRUST_PROXY_HEADERS;
    }
  });

  it('proxy mạng riêng (10.x, 192.168.x) được tin; 172.32.x thì không', () => {
    expect(extractClientIp(makeReq({ 'x-real-ip': '203.0.113.5' }, undefined, '10.2.3.4'))).toBe('203.0.113.5');
    expect(extractClientIp(makeReq({ 'x-real-ip': '203.0.113.5' }, undefined, '192.168.1.9'))).toBe('203.0.113.5');
    expect(extractClientIp(makeReq({ 'x-real-ip': '203.0.113.5' }, undefined, '172.32.0.1'))).toBe('172.32.0.1');
  });

  it('should normalize IPv4-mapped IPv6 from x-real-ip', () => {
    const req = makeReq({ 'x-real-ip': '::ffff:198.51.100.73' }, undefined, LOOPBACK);
    expect(extractClientIp(req)).toBe('198.51.100.73');
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
