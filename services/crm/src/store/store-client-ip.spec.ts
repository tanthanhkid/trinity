import type { Request } from 'express';
import { __resetClientIpStateForTest, __setRouteTableForTest } from '@trinity/rbac-nest';
import { StoreController } from './store.controller';
import type { StoreService } from './store.service';
import { clientIp, registerLimiter } from '../integrations/oauth/oauth-rate-limits';

jest.mock('../common/helpers/routed-company', () => ({ enterRoutedCompany: jest.fn().mockResolvedValue(true) }));

/** Hai client khác IP có bộ đếm riêng (OAuth, đặt đơn); IP giả trong header không đổi được xô. Luật đầy đủ: packages/rbac-nest client-ip.spec.ts. */
const req = (peer: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: peer } }) as unknown as Request;
const ORIGINAL_TP = process.env.TRUSTED_PROXY;

beforeEach(() => {
  __resetClientIpStateForTest();
  __setRouteTableForTest(null);
});
afterAll(() => {
  if (ORIGINAL_TP === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = ORIGINAL_TP;
  __setRouteTableForTest(undefined);
});

describe('giới hạn OAuth theo IP khách', () => {
  it('sau Caddy (cidr:127.0.0.1/32): hai client khác IP có bộ đếm riêng', () => {
    process.env.TRUSTED_PROXY = 'cidr:127.0.0.1/32';
    const a = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.1' });
    const b = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.2' });
    expect(clientIp(a)).toBe('203.0.113.1');
    expect(clientIp(b)).toBe('203.0.113.2');
    const now = 1_000;
    for (let i = 0; i < 10; i++) expect(registerLimiter.hit(`reg:${clientIp(a)}`, now).allowed).toBe(true);
    expect(registerLimiter.hit(`reg:${clientIp(a)}`, now).allowed).toBe(false);
    expect(registerLimiter.hit(`reg:${clientIp(b)}`, now).allowed).toBe(true);
  });

  it('mặc định (none): x-real-ip giả không đổi được xô — khoá theo IP peer', () => {
    delete process.env.TRUSTED_PROXY;
    expect(clientIp(req('198.51.100.9', { 'x-real-ip': '203.0.113.7' }))).toBe('198.51.100.9');
  });
});

describe('IP không tin được: khoá theo thứ riêng của từng client, không một xô chung', () => {
  it('OAuth token: theo client_id; MCP: theo Authorization; thiếu thì mới rơi về IP peer', () => {
    delete process.env.TRUSTED_PROXY;
    const r = req('127.0.0.1');
    expect(clientIp(r, 'client-a')).not.toBe(clientIp(r, 'client-b'));
    expect(clientIp(r, 'client-a')).toMatch(/^u:/);
    expect(clientIp(r)).toBe('127.0.0.1');
  });

  it('đặt đơn: theo số điện thoại người đặt', async () => {
    delete process.env.TRUSTED_PROXY;
    const placeOrder = jest.fn().mockResolvedValue({ ok: true });
    const ctrl = new StoreController({ placeOrder } as unknown as StoreService);
    await ctrl.placeOrder('shop', req('127.0.0.1'), { phone: '0901 234 567' });
    await ctrl.placeOrder('shop', req('127.0.0.1'), { phone: '0912345678' });
    expect(placeOrder.mock.calls.map((c) => c[1])).toEqual(['u:phone:0901234567', 'u:phone:0912345678']);
  });
});

describe('trang bán hàng: giới hạn đặt đơn theo IP khách', () => {
  it('không còn lấy phần tử ĐẦU của x-forwarded-for (client tự khai); hai client khác IP khác khoá', async () => {
    process.env.TRUSTED_PROXY = 'cidr:127.0.0.1/32';
    const placeOrder = jest.fn().mockResolvedValue({ ok: true });
    const ctrl = new StoreController({ placeOrder } as unknown as StoreService);
    await ctrl.placeOrder('shop', req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.1' }), {});
    await ctrl.placeOrder('shop', req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.2' }), {});
    expect(placeOrder.mock.calls.map((c) => c[1])).toEqual(['203.0.113.1', '203.0.113.2']);
  });
});
