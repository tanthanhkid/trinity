import { signState, verifyState } from '../oauth-state';
import { mapShopeeOrder, shopeeAuthUrl, shopeeConfig, shopeeSign, verifyShopeePush, ShopeeClient } from '../shopee';
import { LazadaClient, lazadaConfig, lazadaPaidTotal, lazadaSign, mapLazadaOrder, verifyLazadaPush } from '../lazada';
import { ShopeeService } from '../shopee.service';

/** Khoá giả cho test; chữ ký tham chiếu tính độc lập bằng Python theo công thức trong tài liệu từng sàn. */
const SHOPEE = { partnerId: 2001887, partnerKey: 'shopee-partner-key-test-0001', sandbox: true }; // gitleaks:allow
const LZ = { appKey: '123456', appSecret: 'lazada-app-secret-test-0001' }; // gitleaks:allow

describe('state OAuth ký HMAC', () => {
  const key = Buffer.alloc(32, 9);
  it('đúng sàn + còn hạn ⇒ trả người bắt đầu; sai sàn/hết hạn/sửa ⇒ null', () => {
    const st = signState('shopee', 42, key, 1_000_000);
    expect(verifyState(st, 'shopee', key, 1_000_000 + 60_000)).toEqual({ userId: 42 });
    expect(verifyState(st, 'lazada', key, 1_000_000)).toBeNull();
    expect(verifyState(st, 'shopee', key, 1_000_000 + 16 * 60_000)).toBeNull();
    expect(verifyState(st.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'shopee', key, 1_000_000)).toBeNull();
  });
});

describe('Shopee', () => {
  it('đọc cấu hình máy chủ', () => {
    expect(shopeeConfig({ SHOPEE_PARTNER_ID: '2001887', SHOPEE_PARTNER_KEY: 'shopee-partner-key-test-0001', SHOPEE_SANDBOX: '1' } as never)).toEqual(SHOPEE);
    expect(shopeeConfig({} as never)).toBeNull();
  });

  it('chữ ký API công khai và API của shop khớp bản tính độc lập', () => {
    expect(shopeeSign(SHOPEE, '/api/v2/shop/auth_partner', 1760500000)).toBe('9f8d77d633aaf45fd41041dee332ffe3992c36e28351d055d5c57f655e49be18');
    expect(shopeeSign(SHOPEE, '/api/v2/order/get_order_list', 1760500000, { accessToken: 'tok-abc', shopId: 123456 })).toBe('987d224b3dffa20c8d7b609168d043a53f9d4c74d9cb382ffdedef0906659401');
  });

  it('URL cấp quyền: host sandbox, đủ partner_id/timestamp/sign/redirect', () => {
    const u = new URL(shopeeAuthUrl(SHOPEE, 'https://crm.example.com/api/v1/connectors/shopee/callback?state=x', 1760500000));
    expect(u.origin + u.pathname).toBe('https://partner.test-stable.shopeemobile.com/api/v2/shop/auth_partner');
    expect(u.searchParams.get('sign')).toBe('9f8d77d633aaf45fd41041dee332ffe3992c36e28351d055d5c57f655e49be18');
    expect(u.searchParams.get('redirect')).toBe('https://crm.example.com/api/v1/connectors/shopee/callback?state=x');
  });

  it('push: Authorization = HMAC(partner_key, url|body)', () => {
    const body = Buffer.from('{"shop_id":123456,"code":3,"data":{"ordersn":"2510150ABC"}}');
    expect(verifyShopeePush(SHOPEE, 'https://crm.example.com/api/v1/connectors/shopee/push', body, 'fdb93b55f1149f3aa0449a1289ce3a11196546db08340edbcabb004a5c85caaf')).toBe(true);
    expect(verifyShopeePush(SHOPEE, 'https://crm.example.com/khac', body, 'fdb93b55f1149f3aa0449a1289ce3a11196546db08340edbcabb004a5c85caaf')).toBe(false);
  });

  it('đơn: SĐT bị Shopee che (có *) ⇒ không dùng để ghép khách', () => {
    const o = mapShopeeOrder({ order_sn: '2510150ABC', order_status: 'READY_TO_SHIP', total_amount: 259000, buyer_user_id: 77, buyer_username: 'an.nguyen', update_time: 1760500000, recipient_address: { name: 'An', phone: '84******78' }, item_list: [{ item_name: 'Áo', model_quantity_purchased: 2, model_discounted_price: 129500 }] });
    expect(o).toMatchObject({ external_id: '2510150ABC', total: 259000, status: 'READY_TO_SHIP', customer: { external_id: '77', name: 'an.nguyen', phone: null }, items: [{ name: 'Áo', quantity: 2, price: 129500 }] });
  });

  it('client: gửi access_token + shop_id + sign của shop', async () => {
    const urls: string[] = [];
    const fetchFn = jest.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify({ error: '', response: { order_list: [], more: false } }), { status: 200 }); });
    await new ShopeeClient(SHOPEE, fetchFn as never, () => 1760500000).orderList({ accessToken: 'tok-abc', shopId: 123456 }, 1, 2);
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/api/v2/order/get_order_list');
    expect(u.searchParams.get('sign')).toBe('987d224b3dffa20c8d7b609168d043a53f9d4c74d9cb382ffdedef0906659401');
    expect(u.searchParams.get('shop_id')).toBe('123456');
    expect(u.searchParams.get('time_range_field')).toBe('update_time');
  });

  it('máy chủ chưa cấu hình ⇒ báo rõ', () => {
    const prev = process.env.SHOPEE_PARTNER_ID;
    delete process.env.SHOPEE_PARTNER_ID;
    expect(() => new ShopeeService({} as never, {} as never, {} as never).startConnect(1)).toThrow('SHOPEE_PARTNER_ID');
    if (prev !== undefined) process.env.SHOPEE_PARTNER_ID = prev;
  });
});

describe('Lazada', () => {
  it('đọc cấu hình máy chủ', () => {
    expect(lazadaConfig({ LAZADA_APP_KEY: '123456', LAZADA_APP_SECRET: 'lazada-app-secret-test-0001' } as never)).toEqual(LZ);
    expect(lazadaConfig({ LAZADA_APP_KEY: 'abc' } as never)).toBeNull();
  });

  it('chữ ký: sắp xếp tham số, path + k+v, HMAC-SHA256 in hoa — khớp bản tính độc lập', () => {
    const p = { access_token: 'tok-lz', app_key: '123456', limit: '100', offset: '0', sign_method: 'sha256', timestamp: '1760500000000', update_after: '2026-10-01T00:00:00+00:00' };
    expect(lazadaSign(LZ.appSecret, '/orders/get', p)).toBe('0F4259C18D26E3D5F8741D65CAADB12BD1390D02B03C053FBD9E492ECF1D05F6');
  });

  it('client gửi đúng tham số + sign', async () => {
    const urls: string[] = [];
    const fetchFn = jest.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify({ code: '0', data: { orders: [], count: 0 } }), { status: 200 }); });
    await new LazadaClient(LZ, fetchFn as never, () => 1760500000000).orders('tok-lz', new Date('2026-10-01T00:00:00Z'), 0);
    const u = new URL(urls[0]);
    expect(u.origin + u.pathname).toBe('https://api.lazada.vn/rest/orders/get');
    const sent = Object.fromEntries([...u.searchParams.entries()].filter(([k]) => k !== 'sign'));
    expect(sent).toMatchObject({ app_key: '123456', sign_method: 'sha256', timestamp: '1760500000000', access_token: 'tok-lz', update_after: '2026-10-01T00:00:00+00:00' });
    expect(u.searchParams.get('sign')).toBe(lazadaSign(LZ.appSecret, '/orders/get', sent));
  });

  it('push: Authorization = HMAC(app_secret, app_key + body)', () => {
    const body = Buffer.from('{"seller_id":"999","message_type":0,"data":{"trade_order_id":"555"}}');
    expect(verifyLazadaPush(LZ, body, '2ca796599943b31b547d24773e54c8b48cc0cafbc5914972a5032f60970faa71')).toBe(true);
    expect(verifyLazadaPush(LZ, Buffer.from('{}'), '2ca796599943b31b547d24773e54c8b48cc0cafbc5914972a5032f60970faa71')).toBe(false);
  });

  it('đơn: tổng = tiền khách thực trả (trừ voucher, cộng ship, trừ giảm ship); mặt hàng theo paid_price', () => {
    const o = { order_id: 555, order_number: 555, price: '1,250,000.00', voucher: '100,000.00', shipping_fee: '30000', shipping_fee_discount_platform: '10000', statuses: ['pending'], customer_first_name: 'An', address_billing: { phone: '0912345678' }, updated_at: '2026-10-15T10:00:00+07:00' };
    expect(lazadaPaidTotal(o)).toBe(1170000);
    expect(lazadaPaidTotal({ price: '500000', voucher_platform: '20000', voucher_seller: '30000' })).toBe(450000);
    expect(mapLazadaOrder(o, [{ name: 'Tai nghe', item_price: 1250000, paid_price: 1150000 }])).toMatchObject({ external_id: '555', total: 1170000, status: 'pending', items: [{ name: 'Tai nghe', price: 1150000 }] });
  });

  it('mặt hàng: 100 đơn ⇒ 2 lô 50 mã, gộp kết quả', async () => {
    const batches: number[][] = [];
    const fetchFn = jest.fn(async (url: string) => {
      const ids = JSON.parse(new URL(url).searchParams.get('order_ids') ?? '[]') as number[];
      batches.push(ids);
      return new Response(JSON.stringify({ code: '0', data: ids.map((id) => ({ order_id: id, order_items: [{ name: `SP ${id}` }] })) }), { status: 200 });
    });
    const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
    const m = await new LazadaClient(LZ, fetchFn as never).items('tok', ids);
    expect(batches.map((b) => b.length)).toEqual([50, 50]);
    expect(m.size).toBe(100);
    expect(m.get('100')).toEqual([{ name: 'SP 100' }]);
  });
});
