import { SocialPostsService } from '../social-posts.service';
import { SocialDraftsService } from '../social-drafts.service';
import { applyUtm, applyUtmToTarget, firstUtmLink, normalizeUtm, utmParamsFor } from '../social-utm';

const P = utmParamsFor('facebook', { campaign: 'thu-2026' });
const Q = 'utm_source=facebook&utm_medium=social&utm_campaign=thu-2026';

describe('applyUtm', () => {
  it('thêm UTM vào liên kết trơn', () => {
    expect(applyUtm('Xem https://shop.vn/sp', P)).toBe(`Xem https://shop.vn/sp?${Q}`);
    expect(applyUtm('http://shop.vn', P)).toBe(`http://shop.vn?${Q}`);
  });
  it('đã có query ⇒ nối bằng &', () => {
    expect(applyUtm('https://shop.vn/sp?id=3', P)).toBe(`https://shop.vn/sp?id=3&${Q}`);
  });
  it('giữ #fragment ở cuối', () => {
    expect(applyUtm('https://shop.vn/sp#gia', P)).toBe(`https://shop.vn/sp?${Q}#gia`);
    expect(applyUtm('https://shop.vn/sp?id=3#gia', P)).toBe(`https://shop.vn/sp?id=3&${Q}#gia`);
  });
  it('không tính dấu câu cuối câu vào liên kết', () => {
    expect(applyUtm('Vào https://shop.vn/sp.', P)).toBe(`Vào https://shop.vn/sp?${Q}.`);
    expect(applyUtm('(xem https://shop.vn/sp), rồi https://a.vn/x!?', P)).toBe(`(xem https://shop.vn/sp?${Q}), rồi https://a.vn/x?${Q}!?`);
    expect(applyUtm('“https://shop.vn/sp”', P)).toBe(`“https://shop.vn/sp?${Q}”`);
  });
  it('ngoặc đóng thuộc liên kết thì giữ (kiểu Wikipedia)', () => {
    expect(applyUtm('https://vi.wikipedia.org/wiki/A_(b) hay', P)).toBe(`https://vi.wikipedia.org/wiki/A_(b)?${Q} hay`);
  });
  it('chữ tiếng Việt xung quanh và xuống dòng', () => {
    expect(applyUtm('Ưu đãi lớn 🎉\nMua ngay: https://shop.vn/uu-dai\nCảm ơn bạn!', P)).toBe(`Ưu đãi lớn 🎉\nMua ngay: https://shop.vn/uu-dai?${Q}\nCảm ơn bạn!`);
  });
  it('nhiều liên kết, mỗi cái một lần', () => {
    expect(applyUtm('https://a.vn và https://b.vn/x', P)).toBe(`https://a.vn?${Q} và https://b.vn/x?${Q}`);
    expect(applyUtm('https://a.vn https://a.vn', P).match(/utm_source/g)).toHaveLength(2);
  });
  it('liên kết đã có utm_ (kể cả một tham số, hoa thường) giữ nguyên', () => {
    expect(applyUtm('https://a.vn/?utm_source=zalo', P)).toBe('https://a.vn/?utm_source=zalo');
    expect(applyUtm('https://a.vn/?x=1&UTM_Campaign=k#f', P)).toBe('https://a.vn/?x=1&UTM_Campaign=k#f');
  });
  it('không đụng link không phải http, email, tên miền trần', () => {
    const t = 'ftp://a.vn/x mailto:a@b.vn a@b.vn shop.vn/sp www.shop.vn tel:0900';
    expect(applyUtm(t, P)).toBe(t);
  });
  it('liên kết hỏng để nguyên', () => {
    expect(applyUtm('https:// và http://', P)).toBe('https:// và http://');
    expect(applyUtm('http://[bad', P)).toBe('http://[bad');
  });
  it('gọi hai lần không đổi thêm (idempotent)', () => {
    const t = 'Xem https://shop.vn/sp?id=3#gia, và https://b.vn.';
    const once = applyUtm(t, P);
    expect(applyUtm(once, P)).toBe(once);
  });
  it('utm_content và giá trị có khoảng trắng được mã hoá', () => {
    const out = applyUtm('https://a.vn', utmParamsFor('youtube', { campaign: 'c', content: 'banner-a' }));
    expect(out).toBe('https://a.vn?utm_source=youtube&utm_medium=social&utm_campaign=c&utm_content=banner-a');
  });
  it('không có tham số hoặc không có chữ ⇒ giữ nguyên', () => {
    expect(applyUtm('https://a.vn', null)).toBe('https://a.vn');
    expect(applyUtm('', P)).toBe('');
  });
});

describe('normalizeUtm', () => {
  it('trim, khoảng trắng → "-"', () => {
    expect(normalizeUtm({ campaign: '  Khuyen mai  thu ', content: ' b 1 ' })).toEqual({ campaign: 'Khuyen-mai-thu', content: 'b-1' });
    expect(normalizeUtm({ campaign: 'a', content: '' })).toEqual({ campaign: 'a' });
  });
  it('null/undefined ⇒ null', () => {
    expect(normalizeUtm(null)).toBeNull();
    expect(normalizeUtm(undefined)).toBeNull();
  });
  it('sai ⇒ lỗi tiếng Việt', () => {
    expect(() => normalizeUtm({ campaign: '   ' })).toThrow(/không được để trống/);
    expect(() => normalizeUtm({ campaign: 'a'.repeat(101) })).toThrow(/tối đa 100/);
    expect(() => normalizeUtm({ campaign: 'a&b=c' })).toThrow(/ký tự/);
    expect(() => normalizeUtm({ content: 'x' })).toThrow(/campaign/);
    expect(() => normalizeUtm({ campaign: 'a', content: 'b'.repeat(101) })).toThrow(/utm_content/);
    expect(() => normalizeUtm('x')).toThrow(/UTM/);
  });
});

describe('firstUtmLink / applyUtmToTarget', () => {
  it('liên kết đầu tiên sau UTM', () => {
    expect(firstUtmLink('a https://x.vn/1. b https://y.vn', P)).toBe(`https://x.vn/1?${Q}`);
    expect(firstUtmLink('không có', P)).toBeNull();
  });
  it('áp lên nội dung, mô tả YouTube và bình luận đầu; không có options.utm ⇒ y nguyên', () => {
    const o = { utm: { campaign: 'c' }, description: 'Mô tả https://a.vn', first_comment: 'Link: https://b.vn.', tags: ['x'] };
    const r = applyUtmToTarget('youtube', 'Xem https://a.vn', o);
    expect(r.text).toBe('Xem https://a.vn?utm_source=youtube&utm_medium=social&utm_campaign=c');
    expect(r.options.description).toBe('Mô tả https://a.vn?utm_source=youtube&utm_medium=social&utm_campaign=c');
    expect(r.options.first_comment).toBe('Link: https://b.vn?utm_source=youtube&utm_medium=social&utm_campaign=c.');
    expect(o.description).toBe('Mô tả https://a.vn');
    const plain = { description: 'https://a.vn' };
    expect(applyUtmToTarget('facebook', 'https://a.vn', plain)).toEqual({ text: 'https://a.vn', options: plain });
  });
});

describe('SocialPostsService.validate — UTM', () => {
  const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
  function setup(network = 'instagram') {
    const prisma = { socialAccount: { findMany: jest.fn(async () => [{ id: 3, network, name: 'Kênh', status: 'active' }]) } };
    const media = { resolve: jest.fn(async () => []) };
    const provider = { supported: true, validateMedia: () => null, validateOptions: jest.fn((..._a: unknown[]) => null as string | null) };
    return { svc: new SocialPostsService(prisma as never, {} as never, media as never, { get: () => provider } as never), provider };
  }
  const base = { content: 'Xem https://shop.vn/sp', targets: [{ account_id: 3 }] };

  it('utm của bài ⇒ lưu vào options từng kênh kèm source/medium; nội dung vẫn sạch', async () => {
    const { svc } = setup();
    const v = await svc.validate(user, { ...base, utm: { campaign: ' thu 2026 ', content: 'a' } } as never);
    expect(v.targets[0].options).toEqual({ utm: { source: 'instagram', medium: 'social', campaign: 'thu-2026', content: 'a' } });
    expect(v.content).toBe('Xem https://shop.vn/sp');
  });
  it('options.utm sẵn có (sửa bài, nháp) được giữ; utm: null thì bỏ', async () => {
    const { svc } = setup();
    const t = [{ account_id: 3, options: { utm: { campaign: 'c' } } }];
    expect((await svc.validate(user, { ...base, targets: t } as never)).targets[0].options.utm).toMatchObject({ campaign: 'c', source: 'instagram' });
    expect((await svc.validate(user, { ...base, targets: t, utm: null } as never)).targets[0].options.utm).toBeUndefined();
  });
  it('campaign sai ⇒ 400 tiếng Việt', async () => {
    const { svc } = setup();
    await expect(svc.validate(user, { ...base, utm: { campaign: '' } } as never)).rejects.toThrow(/không được để trống/);
    await expect(svc.validate(user, { ...base, utm: { campaign: 'a'.repeat(101) } } as never)).rejects.toThrow(/tối đa 100/);
  });
  it('giới hạn ký tự tính SAU khi gắn UTM', async () => {
    const { svc } = setup('google_business');
    const url = 'https://shop.vn/sp';
    const content = `${'x'.repeat(1500 - url.length - 1)} ${url}`;
    expect(content.length).toBeLessThanOrEqual(1500);
    await expect(svc.validate(user, { content, targets: [{ account_id: 3 }] } as never)).resolves.toBeDefined();
    await expect(svc.validate(user, { content, targets: [{ account_id: 3 }], utm: { campaign: 'c' } } as never)).rejects.toThrow(/đã tính tham số UTM/);
  });
  it('validateOptions nhận nội dung đã gắn UTM', async () => {
    const { svc, provider } = setup();
    await svc.validate(user, { ...base, utm: { campaign: 'c' } } as never);
    expect(provider.validateOptions.mock.calls[0][0]).toContain('utm_campaign=c');
  });
});

describe('SocialPostsService.processOne — UTM khi đăng', () => {
  it('gửi cho mạng bản có UTM (nội dung + bình luận đầu), bài lưu vẫn sạch', async () => {
    const target = { id: 11, post_id: 3, account_id: 5, network: 'youtube', caption: null, options: { utm: { campaign: 'c' }, description: 'Mô tả https://a.vn' }, status: 'publishing', attempts: 1 };
    const prisma = {
      socialPostTarget: { findUnique: jest.fn().mockResolvedValue(target), update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([{ status: 'published' }]) },
      socialPost: { findUnique: jest.fn().mockResolvedValue({ id: 3, content: 'Xem https://shop.vn/sp.', media: [] }), update: jest.fn().mockResolvedValue({}) },
      socialAccount: { findUnique: jest.fn().mockResolvedValue({ id: 5, network: 'youtube', status: 'active', external_id: '1', name: 'K' }) },
      integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
    };
    const accounts = { forPublish: jest.fn().mockReturnValue({ id: 5, external_id: '1', name: 'K', access_token: 't', refresh_token: null, token_expires_at: null }), markReauth: jest.fn() };
    const publish = jest.fn().mockResolvedValue({ external_post_id: 'v1', url: 'https://youtu.be/v1' });
    const svc = new SocialPostsService(prisma as never, accounts as never, {} as never, { get: () => ({ network: 'youtube', supported: true, publish }) } as never);
    expect(await svc.processOne(11)).toBe('published');
    const input = publish.mock.calls[0][1];
    expect(input.text).toBe('Xem https://shop.vn/sp?utm_source=youtube&utm_medium=social&utm_campaign=c.');
    expect(input.options.description).toContain('https://a.vn?utm_source=youtube');
    expect(target.options.description).toBe('Mô tả https://a.vn');
  });
});

describe('SocialDraftsService — UTM nằm trong options các kênh', () => {
  const user = { userId: 1 } as never;
  function setup(cur: Record<string, unknown> | null = null) {
    const prisma: any = {
      socialAccount: { findMany: jest.fn(async () => [{ id: 3 }]) },
      socialDraft: {
        create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
        findUnique: jest.fn(async () => cur),
        updateMany: jest.fn(async (..._a: any[]) => ({ count: 1 })),
      },
    };
    return { svc: new SocialDraftsService(prisma as never, { media: {} } as never), prisma };
  }
  it('tạo nháp có kênh + utm ⇒ options.utm ở từng kênh', async () => {
    const { svc, prisma } = setup();
    await svc.create(user, { targets: [{ account_id: 3 }], utm: { campaign: 'Thu 26' } });
    expect(prisma.socialDraft.create.mock.calls[0][0].data.targets).toEqual([{ account_id: 3, options: { utm: { campaign: 'Thu-26' } } }]);
  });
  it('sửa chỉ utm ⇒ áp lên kênh đang có; null ⇒ bỏ', async () => {
    const cur = { id: 1, media: [], targets: [{ account_id: 3, options: { title: 'T' } }] };
    const a = setup(cur);
    await a.svc.update(user, 1, { utm: { campaign: 'c' } });
    expect(a.prisma.socialDraft.updateMany.mock.calls[0][0].data.targets).toEqual([{ account_id: 3, options: { title: 'T', utm: { campaign: 'c' } } }]);
    const b = setup({ ...cur, targets: [{ account_id: 3, options: { utm: { campaign: 'c' } } }] });
    await b.svc.update(user, 1, { utm: null });
    expect(b.prisma.socialDraft.updateMany.mock.calls[0][0].data.targets).toEqual([{ account_id: 3 }]);
  });
  it('campaign sai ⇒ 400', async () => {
    await expect(setup().svc.create(user, { utm: { campaign: '' } })).rejects.toThrow(/UTM/);
  });
  it('đăng nháp giữ UTM (toPostInput chuyển options nguyên vẹn)', () => {
    const { svc } = setup();
    const d = { content: 'x', media: [], targets: [{ account_id: 3, options: { utm: { campaign: 'c' } } }], scheduled_at: null, use_queue: false } as never;
    expect(svc.toPostInput(d).targets[0].options).toEqual({ utm: { campaign: 'c' } });
  });
});

describe('applyUtm — các ca sau rà soát', () => {
  const P = utmParamsFor('facebook', { campaign: 'c' });

  it('dấu markdown / dấu câu toàn góc cuối liên kết không bị nuốt vào URL', () => {
    expect(applyUtm('Mua tại **https://shop.vn**', P)).toBe('Mua tại **https://shop.vn?utm_source=facebook&utm_medium=social&utm_campaign=c**');
    expect(applyUtm('`https://x.vn/a`', P)).toBe('`https://x.vn/a?utm_source=facebook&utm_medium=social&utm_campaign=c`');
    expect(applyUtm('xem https://x.vn/a。', P)).toBe('xem https://x.vn/a?utm_source=facebook&utm_medium=social&utm_campaign=c。');
  });

  it('chuỗi ngoặc đóng rất dài: chạy nhanh (tuyến tính) và giữ nguyên văn bản quanh liên kết', () => {
    const tail = ')'.repeat(60_000);
    const t0 = Date.now();
    const out = applyUtm(`https://a.com${tail}`, P);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.endsWith(tail)).toBe(true);
  });

  it('liên kết quá dài (> 2048) để nguyên', () => {
    const long = `https://a.com/${'x'.repeat(3000)}`;
    expect(applyUtm(long, P)).toBe(long);
  });

  it('YouTube không đặt title: tiêu đề chốt từ chữ sạch, không lộ utm', () => {
    const r = applyUtmToTarget('youtube', 'Xem https://shop.example/khoa-hoc\nMô tả', { utm: { campaign: 'c' } });
    expect(r.options.title).toBe('Xem https://shop.example/khoa-hoc');
    expect(r.text).toContain('utm_source=youtube');
    const withTitle = applyUtmToTarget('youtube', 'https://x.vn', { utm: { campaign: 'c' }, title: 'Tiêu đề' });
    expect(withTitle.options.title).toBe('Tiêu đề');
  });
});
