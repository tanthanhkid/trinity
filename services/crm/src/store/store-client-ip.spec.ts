import type { Request } from 'express';
import { __resetClientIpStateForTest, __setRouteTableForTest } from '@trinity/rbac-nest';
import { StoreController } from './store.controller';
import type { StoreService } from './store.service';
import { FixedWindowLimiter } from '../common/helpers/fixed-window-limiter';
import { hitByClient, untrustedPeerLimiter } from '../integrations/oauth/oauth-rate-limits';

jest.mock('../common/helpers/routed-company', () => ({ enterRoutedCompany: jest.fn().mockResolvedValue(true) }));

/** Giới hạn tốc độ theo IP khách (OAuth/MCP, đặt đơn). Luật xác định IP đầy đủ: packages/rbac-nest client-ip.spec.ts. */
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

describe('OAuth/MCP: giới hạn theo IP khách', () => {
  it('sau Caddy (cidr:127.0.0.1/32): hai client khác IP có bộ đếm riêng; IP giả trong header không đổi được xô', () => {
    process.env.TRUSTED_PROXY = 'cidr:127.0.0.1/32';
    const lim = new FixedWindowLimiter(10, 60_000);
    const a = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.1' });
    const b = req('127.0.0.1', { 'x-forwarded-for': '203.0.113.2' });
    for (let i = 0; i < 10; i++) expect(hitByClient(lim, 'reg', a, `x${i}`).allowed).toBe(true);
    expect(hitByClient(lim, 'reg', a, 'khác').allowed).toBe(false); // đổi khoá riêng không lách được khi IP tin được
    expect(hitByClient(lim, 'reg', b).allowed).toBe(true);
  });

  it('IP không tin được: khoá riêng theo client (một client không chặn client khác)', () => {
    delete process.env.TRUSTED_PROXY;
    const lim = new FixedWindowLimiter(3, 60_000);
    const r = req('127.0.0.1');
    for (let i = 0; i < 3; i++) expect(hitByClient(lim, 'tok', r, 'client-a').allowed).toBe(true);
    expect(hitByClient(lim, 'tok', r, 'client-a').allowed).toBe(false);
    expect(hitByClient(lim, 'tok', r, 'client-b').allowed).toBe(true);
  });

  it('IP không tin được: đổi khoá riêng mỗi lần KHÔNG lách được trần theo IP peer', () => {
    delete process.env.TRUSTED_PROXY;
    const lim = new FixedWindowLimiter(3, 60_000);
    const r = req('127.0.0.1');
    let blocked = false;
    for (let i = 0; i < 700 && !blocked; i++) blocked = !hitByClient(lim, 'peercap', r, `client-${i}`).allowed;
    expect(blocked).toBe(true);
    expect(untrustedPeerLimiter.hit('peercap:127.0.0.1').allowed).toBe(false);
  });
});

describe('trang bán hàng: giới hạn đặt đơn', () => {
  it('không còn lấy phần tử ĐẦU của x-forwarded-for (client tự khai); hai client khác IP khác khoá', async () => {
    process.env.TRUSTED_PROXY = 'cidr:127.0.0.1/32';
    const placeOrder = jest.fn().mockResolvedValue({ ok: true });
    const ctrl = new StoreController({ placeOrder } as unknown as StoreService);
    await ctrl.placeOrder('shop', req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.1' }), {});
    await ctrl.placeOrder('shop', req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.2' }), {});
    expect(placeOrder.mock.calls.map((c) => c[1])).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('IP không tin được: khoá theo SĐT, và trần theo IP peer (100/10 phút) không lách được bằng đổi SĐT', async () => {
    delete process.env.TRUSTED_PROXY;
    const placeOrder = jest.fn().mockResolvedValue({ ok: true });
    const ctrl = new StoreController({ placeOrder } as unknown as StoreService);
    await ctrl.placeOrder('shop', req('127.0.0.2'), { phone: '0901 234 567' });
    expect(placeOrder.mock.calls[0][1]).toBe('u:phone:0901234567');
    let status = 0;
    for (let i = 0; i < 120 && !status; i++) {
      await ctrl.placeOrder('shop', req('127.0.0.2'), { phone: `09${String(i).padStart(8, '0')}` }).catch((e: { getStatus(): number }) => (status = e.getStatus()));
    }
    expect(status).toBe(429);
  });
});
