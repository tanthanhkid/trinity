import type { Request } from 'express'
import { __resetClientIpStateForTest, __setRouteTableForTest } from '@trinity/rbac-nest'
import {
  extractLoginClientIp,
  loginClientIpTrusted,
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

  // Luật đầy đủ (5 giá trị TRUSTED_PROXY, chữ ký) test ở packages/rbac-nest/src/client-ip.spec.ts; ở đây chỉ kiểm
  // helper đăng nhập đọc đúng hàm dùng chung và không còn tin header theo kiểu cũ.
  describe('extractLoginClientIp / loginClientIpTrusted — qua hàm dùng chung', () => {
    const ORIGINAL_TP = process.env.TRUSTED_PROXY
    beforeEach(() => {
      __resetClientIpStateForTest()
      __setRouteTableForTest(null)
    })
    afterEach(() => {
      if (ORIGINAL_TP === undefined) delete process.env.TRUSTED_PROXY
      else process.env.TRUSTED_PROXY = ORIGINAL_TP
      __setRouteTableForTest(undefined)
    })

    it('TRUSTED_PROXY mặc định (none): x-real-ip / x-forwarded-for / cf-connecting-ip giả bị bỏ qua, dùng IP peer', () => {
      delete process.env.TRUSTED_PROXY
      const req = buildReq(
        { 'x-real-ip': '203.0.113.108', 'x-forwarded-for': '203.0.113.108', 'cf-connecting-ip': '203.0.113.108' },
        { remoteAddress: '198.51.100.9' },
      )
      expect(extractLoginClientIp(req)).toBe('198.51.100.9')
      expect(loginClientIpTrusted(req)).toBe(true)
    })

    it('peer loopback (proxy cùng máy, chưa đặt TRUSTED_PROXY) → không tin được, khoá tốc độ là IP peer', () => {
      delete process.env.TRUSTED_PROXY
      const req = buildReq({ 'x-real-ip': '203.0.113.5' }, PROXY)
      expect(loginClientIpTrusted(req)).toBe(false)
      expect(extractLoginClientIp(req)).toBe('127.0.0.1')
    })

    it('cidr:127.0.0.1/32 → phần tử phải cùng của X-Forwarded-For; X-Real-IP giả bị bỏ qua', () => {
      process.env.TRUSTED_PROXY = 'cidr:127.0.0.1/32'
      const req = buildReq({ 'x-real-ip': '203.0.113.108', 'x-forwarded-for': '203.0.113.108, 198.51.100.4' }, { remoteAddress: '::ffff:127.0.0.1' })
      expect(extractLoginClientIp(req)).toBe('198.51.100.4')
      expect(loginClientIpTrusted(req)).toBe(true)
    })

    it('cờ cũ LOGIN_WIFI_TRUST_CF_IP không còn tác dụng: cf-connecting-ip giả không được tin', () => {
      delete process.env.TRUSTED_PROXY
      process.env.LOGIN_WIFI_TRUST_CF_IP = 'true'
      const req = buildReq({ 'cf-connecting-ip': '203.0.113.108' }, { remoteAddress: '198.51.100.9' })
      expect(extractLoginClientIp(req)).toBe('198.51.100.9')
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
