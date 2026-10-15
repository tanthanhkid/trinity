import type { Request } from 'express'
import {
  extractLoginClientIp,
  isLoginWifiCheckBypassed,
  isLoginWifiCheckEnabled,
  isUnusableLoginIp,
  loginIpMatchesOffice,
  normalizeLoginIp,
} from './login-wifi-check.helper'

const PROXY = { remoteAddress: '127.0.0.1' }

function buildReq(headers: Record<string, string | undefined>, opts?: { ip?: string; remoteAddress?: string }): Request {
  return {
    headers,
    ip: opts?.ip,
    socket: { remoteAddress: opts?.remoteAddress } as unknown as Request['socket'],
  } as unknown as Request
}

describe('login-wifi-check.helper', () => {
  // PIN env ambient: máy dev/CI có thể đã export LOGIN_WIFI_TRUST_CF_IP → test
  // xanh/đỏ tuỳ máy nếu không ghim. Xoá trước MỖI test, khôi phục sau cả file.
  const ORIGINAL_TRUST_CF = process.env.LOGIN_WIFI_TRUST_CF_IP
  beforeEach(() => {
    delete process.env.LOGIN_WIFI_TRUST_CF_IP
  })
  afterAll(() => {
    if (ORIGINAL_TRUST_CF === undefined) delete process.env.LOGIN_WIFI_TRUST_CF_IP
    else process.env.LOGIN_WIFI_TRUST_CF_IP = ORIGINAL_TRUST_CF
  })

  describe('isLoginWifiCheckEnabled — kill-switch mặc định TẮT', () => {
    const ORIGINAL = process.env.LOGIN_WIFI_CHECK_ENABLED
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.LOGIN_WIFI_CHECK_ENABLED
      else process.env.LOGIN_WIFI_CHECK_ENABLED = ORIGINAL
    })

    it('trả false khi env chưa set', () => {
      delete process.env.LOGIN_WIFI_CHECK_ENABLED
      expect(isLoginWifiCheckEnabled()).toBe(false)
    })

    it('trả false với mọi giá trị khác chuỗi "true"', () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'TRUE'
      expect(isLoginWifiCheckEnabled()).toBe(false)
      process.env.LOGIN_WIFI_CHECK_ENABLED = '1'
      expect(isLoginWifiCheckEnabled()).toBe(false)
    })

    it('trả true khi env = "true"', () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      expect(isLoginWifiCheckEnabled()).toBe(true)
    })
  })

  describe('isLoginWifiCheckBypassed', () => {
    const ORIGINAL = process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS
      else process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = ORIGINAL
    })

    // Bypass theo quyền `settings.integrations`
    // (chính quyền dùng để bật/tắt công tắc này) — Quản trị tự thoả điều kiện
    // vì mọi quyền của Quản trị = `true`/`'all'`.

    it('có quyền settings.integrations LUÔN bypass, kể cả khi danh sách env rỗng', () => {
      delete process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS
      expect(
        isLoginWifiCheckBypassed({
          id: 1,
          email: 'x@example.vn',
          grants: { 'settings.integrations': true },
        }),
      ).toBe(true)
    })

    it('không có settings.integrations, danh sách rỗng → KHÔNG bypass', () => {
      delete process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS
      expect(
        isLoginWifiCheckBypassed({ id: 1, email: 'x@example.vn', grants: { 'contacts.create': true } }),
      ).toBe(false)
    })

    it('email khớp danh sách CSV (không phân biệt hoa/thường) → bypass', () => {
      process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = 'User1@Example.com, other@x.vn'
      expect(
        isLoginWifiCheckBypassed({ id: 123, email: 'user1@example.com', grants: {} }),
      ).toBe(true)
    })

    it('id khớp danh sách CSV → bypass', () => {
      process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = '298'
      expect(isLoginWifiCheckBypassed({ id: 298, email: 'other@x.vn', grants: {} })).toBe(true)
    })

    it('KHÔNG khớp danh sách → không bypass', () => {
      process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = 'someone-else@example.vn'
      expect(isLoginWifiCheckBypassed({ id: 1, email: 'x@example.vn', grants: {} })).toBe(false)
    })
  })

  describe('isUnusableLoginIp — loopback/không xác định PHẢI fail-open', () => {
    it.each(['127.0.0.1', '::1', '0.0.0.0', 'unknown', '', null, undefined])(
      'coi %p là KHÔNG xác định được IP',
      (ip) => {
        expect(isUnusableLoginIp(ip as string | null | undefined)).toBe(true)
      },
    )

    it('IP văn phòng thật (không phải loopback) → false', () => {
      expect(isUnusableLoginIp('203.0.113.10')).toBe(false)
    })

    it('IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) vẫn nhận diện là loopback', () => {
      expect(isUnusableLoginIp('::ffff:127.0.0.1')).toBe(true)
    })
  })

  describe('extractLoginClientIp — thứ tự ưu tiên', () => {
    it('ưu tiên x-real-ip (reverse proxy đặt = $remote_addr)', () => {
      const req = buildReq({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '9.9.9.9' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('203.0.113.5')
    })

    it('fallback x-forwarded-for (entry đầu tiên) khi thiếu x-real-ip', () => {
      const req = buildReq({ 'x-forwarded-for': '203.0.113.6, 10.0.0.1' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('203.0.113.6')
    })

    it('x-forwarded-for do client tự thêm entry đầu → lấy IP công cộng ngoài cùng (proxy append), không tin entry đầu', () => {
      const req = buildReq({ 'x-forwarded-for': '203.0.113.99, 198.51.100.4, 10.0.0.1' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('198.51.100.4')
    })

    it('x-forwarded-for toàn IP riêng (client trong LAN) → entry đầu', () => {
      const req = buildReq({ 'x-forwarded-for': '192.168.1.50, 10.0.0.1' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('192.168.1.50')
    })

    it('fallback req.ip khi thiếu cả 2 header', () => {
      const req = buildReq({}, { ip: '203.0.113.7' })
      expect(extractLoginClientIp(req)).toBe('203.0.113.7')
    })

    it('fallback socket.remoteAddress khi không có gì khác', () => {
      const req = buildReq({}, { remoteAddress: '203.0.113.8' })
      expect(extractLoginClientIp(req)).toBe('203.0.113.8')
    })

    it('trả null khi không xác định được IP nào (fail-open ở tầng gọi)', () => {
      const req = buildReq({})
      expect(extractLoginClientIp(req)).toBeNull()
    })

    it('chuẩn hoá bỏ prefix ::ffff: (IPv4-mapped IPv6)', () => {
      const req = buildReq({ 'x-real-ip': '::ffff:203.0.113.9' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('203.0.113.9')
    })
  })

  describe('x-real-ip chỉ được tin khi kết nối tới từ proxy nội bộ', () => {
    afterEach(() => {
      delete process.env.LOGIN_WIFI_TRUST_PROXY_HEADERS
    })

    it('gọi thẳng từ IP công cộng + x-real-ip giả → bỏ qua header, dùng IP socket', () => {
      const req = buildReq({ 'x-real-ip': '203.0.113.108', 'x-forwarded-for': '203.0.113.108' }, { remoteAddress: '198.51.100.9' })
      expect(extractLoginClientIp(req)).toBe('198.51.100.9')
    })

    it('qua proxy mạng riêng (10.x / 172.16-31.x / 192.168.x / ::1) → tin header', () => {
      for (const remote of ['10.1.2.3', '172.20.0.5', '192.168.1.1', '::1', '::ffff:127.0.0.1']) {
        expect(extractLoginClientIp(buildReq({ 'x-real-ip': '203.0.113.5' }, { remoteAddress: remote }))).toBe('203.0.113.5')
      }
    })

    it('172.32.x không phải mạng riêng → không tin header', () => {
      expect(extractLoginClientIp(buildReq({ 'x-real-ip': '203.0.113.5' }, { remoteAddress: '172.32.0.1' }))).toBe('172.32.0.1')
    })

    it('LOGIN_WIFI_TRUST_PROXY_HEADERS=true → tin header dù socket là IP công cộng', () => {
      process.env.LOGIN_WIFI_TRUST_PROXY_HEADERS = 'true'
      expect(extractLoginClientIp(buildReq({ 'x-real-ip': '203.0.113.5' }, { remoteAddress: '198.51.100.9' }))).toBe('203.0.113.5')
    })
  })

  describe('LOGIN_WIFI_TRUST_CF_IP — chỉ tin cf-connecting-ip khi ở sau Cloudflare', () => {
    it('cờ TẮT: BỎ QUA cf-connecting-ip dù client có gửi (chống giả mạo khi không qua Cloudflare)', () => {
      const req = buildReq({
        'cf-connecting-ip': '203.0.113.108', // client tự bịa IP văn phòng
        'x-real-ip': '1.2.3.4',
      }, PROXY)
      expect(extractLoginClientIp(req)).toBe('1.2.3.4')
    })

    it('cờ TẮT + CHỈ có cf-connecting-ip → vẫn không dùng, trả null (fail-open ở tầng gọi)', () => {
      const req = buildReq({ 'cf-connecting-ip': '203.0.113.108' })
      expect(extractLoginClientIp(req)).toBeNull()
    })

    it('cờ BẬT: ưu tiên cf-connecting-ip hơn x-real-ip (sau Cloudflare)', () => {
      process.env.LOGIN_WIFI_TRUST_CF_IP = 'true'
      const req = buildReq({
        'cf-connecting-ip': '203.0.113.108', // IP THẬT của nhân viên
        'x-real-ip': '198.51.100.7', // IP edge Cloudflare do reverse proxy đặt
      })
      expect(extractLoginClientIp(req)).toBe('203.0.113.108')
    })

    it('cờ BẬT nhưng thiếu cf-connecting-ip → rơi về x-real-ip như cũ', () => {
      process.env.LOGIN_WIFI_TRUST_CF_IP = 'true'
      const req = buildReq({ 'x-real-ip': '203.0.113.5' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('203.0.113.5')
    })

    it('cờ đặt giá trị khác chuỗi "true" → coi như TẮT', () => {
      process.env.LOGIN_WIFI_TRUST_CF_IP = '1'
      const req = buildReq({ 'cf-connecting-ip': '203.0.113.108', 'x-real-ip': '1.2.3.4' }, PROXY)
      expect(extractLoginClientIp(req)).toBe('1.2.3.4')
    })

    it('cờ BẬT: chuẩn hoá cf-connecting-ip (trim + bỏ ::ffff:)', () => {
      process.env.LOGIN_WIFI_TRUST_CF_IP = 'true'
      const req = buildReq({ 'cf-connecting-ip': ' ::ffff:203.0.113.108 ' })
      expect(extractLoginClientIp(req)).toBe('203.0.113.108')
    })
  })

  describe('normalizeLoginIp + loginIpMatchesOffice', () => {
    it('normalizeLoginIp trim + bỏ prefix IPv4-mapped', () => {
      expect(normalizeLoginIp('  ::ffff:1.2.3.4  ')).toBe('1.2.3.4')
    })

    it('loginIpMatchesOffice khớp đúng IP trong danh sách', () => {
      expect(loginIpMatchesOffice('1.2.3.4', ['9.9.9.9', '1.2.3.4'])).toBe(true)
    })

    it('loginIpMatchesOffice không khớp → false', () => {
      expect(loginIpMatchesOffice('1.2.3.4', ['9.9.9.9'])).toBe(false)
    })
  })
})
