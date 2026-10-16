import { DashboardChannelsService } from './dashboard-channels.service';

const ALL_ON = new Proxy({}, { get: (_t, k) => (k === 'locked' ? {} : true) });

function make(opts: { features?: Record<string, boolean>; pages?: any[]; msgs?: any[]; convs?: any[]; social?: any[]; published?: any[]; connectors?: any[]; paid?: any[]; store?: string | null; orders?: number } = {}) {
  const prisma: any = {
    facebookPage: { findMany: jest.fn(async () => opts.pages ?? []) },
    facebookMessage: { groupBy: jest.fn(async () => opts.msgs ?? []) },
    facebookConversation: { findMany: jest.fn(async () => opts.convs ?? []) },
    zaloOaConnection: { findMany: jest.fn(async () => []) },
    zaloOaMessage: { count: jest.fn(async () => 0) },
    socialAccount: { findMany: jest.fn(async () => opts.social ?? []) },
    socialPostTarget: { groupBy: jest.fn(async () => opts.published ?? []) },
    connectorAccount: { findMany: jest.fn(async () => opts.connectors ?? []) },
    paymentIntent: { groupBy: jest.fn(async () => opts.paid ?? []) },
    setting: { findUnique: jest.fn(async () => (opts.store ? { value: opts.store } : null)) },
    storeOrder: { count: jest.fn(async () => opts.orders ?? 0) },
  };
  const features: any = { get: jest.fn(async () => (opts.features ? { ...opts.features, locked: {} } : ALL_ON)) };
  return { svc: new DashboardChannelsService(prisma, features), prisma };
}

const ADMIN = { 'integrations.webhooks': true, 'contacts.update': 'all', 'social.post': true, 'deals.view': 'all', 'pos.manage': true } as any;
const PAGE = { id: 1, page_id: 'p1', name: 'AiiLab', is_active: true, token_status: 'active', subscribed: true };

describe('DashboardChannelsService', () => {
  it('Fanpage: đếm tin khách gửi hôm nay theo Page; Page tắt ⇒ off', async () => {
    const { svc } = make({
      pages: [PAGE, { ...PAGE, id: 2, page_id: 'p2', name: 'Trinity', is_active: false }],
      msgs: [{ conversation_id: 10, _count: { _all: 3 } }, { conversation_id: 11, _count: { _all: 2 } }],
      convs: [{ id: 10, page_id: 'p1' }, { id: 11, page_id: 'p1' }],
    });
    const r = await svc.get(ADMIN);
    const fb = r.channels.filter((c) => c.kind === 'facebook_page');
    expect(fb.map((c) => [c.name, c.state, c.today?.value])).toEqual([['AiiLab', 'ok', 5], ['Trinity', 'off', 0]]);
  });

  it('token hỏng ⇒ attention; chưa nối Page nào ⇒ gợi ý nối thêm', async () => {
    expect((await make({ pages: [{ ...PAGE, token_status: 'expired' }] }).svc.get(ADMIN)).channels[0].state).toBe('attention');
    expect((await make().svc.get(ADMIN)).available.map((a) => a.kind)).toContain('facebook_page');
  });

  it('tính năng tắt hoặc thiếu quyền ⇒ không có nhóm kênh đó, không truy vấn', async () => {
    const off = make({ features: { facebook_page: false }, pages: [PAGE] });
    expect((await off.svc.get(ADMIN)).channels.some((c) => c.kind === 'facebook_page')).toBe(false);
    expect(off.prisma.facebookPage.findMany).not.toHaveBeenCalled();
    const none = make({ pages: [PAGE] });
    expect(await none.svc.get({} as any)).toEqual({ channels: [], available: [] });
    expect(none.prisma.facebookPage.findMany).not.toHaveBeenCalled();
  });

  it('chỉ quyền cập nhật khách ⇒ không thấy Fanpage; xem thương vụ phạm vi hẹp ⇒ không thấy số tiền/đơn cả công ty', async () => {
    const { svc, prisma } = make({ pages: [PAGE], connectors: [{ id: 4, provider: 'sepay', status: 'active', last_event_at: null }], store: JSON.stringify({ slug: 'a', published: true }) });
    const r = await svc.get({ 'contacts.update': 'own', 'deals.view': 'own' } as any);
    expect(r.channels).toEqual([]);
    expect(prisma.facebookPage.findMany).not.toHaveBeenCalled();
    expect(prisma.paymentIntent.groupBy).not.toHaveBeenCalled();
    expect(prisma.storeOrder.count).not.toHaveBeenCalled();
    const all = await svc.get({ 'deals.view': 'all' } as any);
    expect(all.channels.map((c) => c.kind).sort()).toEqual(['payment', 'store']);
  });

  it('bật kết nối bán hàng mà chưa nối ⇒ gợi ý nối', async () => {
    const r = await make({ connectors: [{ id: 4, provider: 'sepay', status: 'active', last_event_at: null }] }).svc.get(ADMIN);
    expect(r.available.map((a) => a.kind)).toContain('commerce');
  });

  it('kênh đăng bài, thanh toán, trang bán hàng', async () => {
    const { svc } = make({
      social: [{ id: 3, network: 'youtube', name: 'Kênh YT', status: 'needs_reauth' }],
      published: [{ account_id: 3, _count: { _all: 1 } }],
      connectors: [{ id: 4, provider: 'sepay', status: 'active', last_event_at: null }, { id: 5, provider: 'kiotviet', status: 'error', last_event_at: null }],
      paid: [{ paid_via: 'sepay', _count: { _all: 2 } }],
      store: JSON.stringify({ slug: 'cua-hang', name: 'Cửa hàng A', published: true }),
      orders: 4,
    });
    const r = await svc.get(ADMIN);
    const by = (k: string) => r.channels.find((c) => c.key.startsWith(k))!;
    expect([by('social').state, by('social').today?.value]).toEqual(['attention', 1]);
    expect([by('payment').name, by('payment').today?.value]).toEqual(['SePay', 2]);
    expect([by('commerce').state, by('commerce').today]).toEqual(['attention', null]);
    expect([by('store').state, by('store').today?.value]).toEqual(['ok', 4]);
  });
});
