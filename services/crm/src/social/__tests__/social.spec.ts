import { FacebookSocialProvider, classifyGraphError } from '../providers/facebook.provider';
import { SocialProviderRegistry } from '../providers/provider.registry';
import { SocialPublishError, type AccountForPublish, type SocialMedia } from '../providers/provider.types';
import { signSocialState, verifySocialState } from '../social-oauth-state';
import { SOCIAL_RETRY_DELAYS_MS, SocialPostsService, aggregateStatus } from '../social-posts.service';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.FACEBOOK_APP_ID = '123';
  process.env.FACEBOOK_APP_SECRET = 'app-secret';
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

describe('state OAuth đăng đa kênh', () => {
  it('ký và kiểm đúng người, đúng mạng; giữ PKCE verifier', () => {
    const s = signSocialState(7, 'facebook', 'v'.repeat(50));
    expect(verifySocialState(s, 'facebook')).toEqual({ userId: 7, verifier: 'v'.repeat(50) });
  });
  it('tráo mạng, sửa chữ ký, hết hạn ⇒ null', () => {
    const s = signSocialState(7, 'facebook');
    expect(verifySocialState(s, 'youtube')).toBeNull();
    expect(verifySocialState(`${s}x`, 'facebook')).toBeNull();
    expect(verifySocialState(signSocialState(7, 'facebook', undefined, Date.now() - 11 * 60_000), 'facebook')).toBeNull();
  });
});

describe('phân loại lỗi Graph', () => {
  it.each([
    [400, 190, 'token'],
    [400, 4, 'rate'],
    [429, null, 'rate'],
    [403, 200, 'permission'],
    [500, null, 'temporary'],
    [400, 100, 'invalid'],
  ])('HTTP %s code %s ⇒ %s', (status, code, kind) => {
    expect(classifyGraphError(status, { error: { code: code ?? undefined, message: 'x' } }).kind).toBe(kind);
  });
  it('chỉ lỗi tạm thời / giới hạn tần suất được thử lại', () => {
    expect(new SocialPublishError('rate', '').retryable).toBe(true);
    expect(new SocialPublishError('temporary', '').retryable).toBe(true);
    expect(new SocialPublishError('invalid', '').retryable).toBe(false);
    expect(new SocialPublishError('token', '').retryable).toBe(false);
  });
});

describe('trạng thái tổng của bài', () => {
  it.each([
    [['queued', 'queued'], true, 'scheduled'],
    [['queued'], false, 'publishing'],
    [['published', 'queued'], true, 'publishing'],
    [['published', 'published'], false, 'published'],
    [['published', 'failed'], false, 'partial'],
    [['failed', 'cancelled'], false, 'failed'],
    [['cancelled'], false, 'cancelled'],
    [['published', 'cancelled'], false, 'published'],
  ])('%j (hẹn giờ=%s) ⇒ %s', (s, scheduled, out) => {
    expect(aggregateStatus((s as string[]).map((status) => ({ status })), scheduled as boolean)).toBe(out);
  });
});

describe('FacebookSocialProvider', () => {
  const fb = new FacebookSocialProvider();
  const acc: AccountForPublish = { id: 1, external_id: '555', name: 'Trang', access_token: 'page-token', refresh_token: null, token_expires_at: null };
  const img = (k: string): SocialMedia => ({ key: k, type: 'image', content_type: 'image/png', size: 3 });
  const load = async (m: SocialMedia) => ({ ...m, body: Buffer.from('abc') });
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  it('kiểm tệp: một video, không ghép video với ảnh, tối đa 10 ảnh', () => {
    const vid: SocialMedia = { key: 'v', type: 'video', content_type: 'video/mp4', size: 1 };
    expect(fb.validateMedia([])).toBeNull();
    expect(fb.validateMedia([vid])).toBeNull();
    expect(fb.validateMedia([vid, vid])).toMatch(/một video/);
    expect(fb.validateMedia([vid, img('a')])).toMatch(/không ghép/);
    expect(fb.validateMedia(Array.from({ length: 11 }, (_, i) => img(String(i))))).toMatch(/10 ảnh/);
  });

  it('URL đăng nhập xin đúng quyền đăng bài, không có publish_video', () => {
    const u = new URL(fb.authorizeUrl('st', 'https://crm.example.com/api/v1/social/oauth/callback/facebook'));
    expect(u.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,pages_manage_posts,business_management');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('chỉ chữ ⇒ POST /{page}/feed, token ở header + appsecret_proof, không nằm trong URL', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValue(ok({ id: '555_1' }));
    const r = await fb.publish(acc, { text: 'Xin chào', media: [], options: {}, load, publicUrl: () => "" });
    expect(r).toEqual({ external_post_id: '555_1', url: 'https://www.facebook.com/555_1' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/555\/feed\?appsecret_proof=[0-9a-f]{64}$/);
    expect(url).not.toContain('page-token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer page-token');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Xin chào' });
  });

  it('nhiều ảnh ⇒ tải từng ảnh published=false rồi feed + attached_media', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(ok({ id: 'p1' })).mockResolvedValueOnce(ok({ id: 'p2' })).mockResolvedValueOnce(ok({ id: '555_9' }));
    const r = await fb.publish(acc, { text: 'Album', media: [img('a'), img('b')], options: {}, load, publicUrl: () => "" });
    expect(r.external_post_id).toBe('555_9');
    expect((f.mock.calls[0][0] as string)).toContain('/555/photos');
    expect(JSON.parse((f.mock.calls[2][1] as RequestInit).body as string)).toEqual({ message: 'Album', attached_media: [{ media_fbid: 'p1' }, { media_fbid: 'p2' }] });
  });

  it('video ⇒ graph-video host', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValue(ok({ id: 'v1' }));
    const r = await fb.publish(acc, { text: 'Clip', media: [{ key: 'v', type: 'video', content_type: 'video/mp4', size: 3 }], options: { title: 'T' }, load, publicUrl: () => "" });
    expect(f.mock.calls[0][0]).toMatch(/^https:\/\/graph-video\.facebook\.com\/v25\.0\/555\/videos/);
    expect(r.url).toBe('https://www.facebook.com/555/videos/v1');
  });

  it('lỗi Graph ⇒ SocialPublishError đã phân loại; lỗi mạng ⇒ temporary', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'expired' } }) } as Response);
    await expect(fb.publish(acc, { text: 'x', media: [], options: {}, load, publicUrl: () => "" })).rejects.toMatchObject({ kind: 'token' });
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(fb.publish(acc, { text: 'x', media: [], options: {}, load, publicUrl: () => "" })).rejects.toMatchObject({ kind: 'temporary' });
  });
});

describe('SocialPostsService.processOne', () => {
  const target = { id: 11, post_id: 3, account_id: 5, network: 'facebook', caption: null, options: {}, status: 'publishing', attempts: 1 };
  const post = { id: 3, content: 'Nội dung', media: [], scheduled_at: null };
  const account = { id: 5, network: 'facebook', status: 'active', external_id: '555', name: 'Trang' };

  function setup(publish: jest.Mock) {
    const prisma = {
      socialPostTarget: { findUnique: jest.fn().mockResolvedValue(target), update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([{ status: 'published' }]) },
      socialPost: { findUnique: jest.fn().mockResolvedValue(post), update: jest.fn().mockResolvedValue({}) },
      socialAccount: { findUnique: jest.fn().mockResolvedValue(account) },
      integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
    };
    const accounts = {
      forPublish: jest.fn().mockReturnValue({ id: 5, external_id: '555', name: 'Trang', access_token: 't', refresh_token: null, token_expires_at: null }),
      markReauth: jest.fn(),
    };
    const fb = { network: 'facebook', supported: true, publish };
    const registry = { get: () => fb } as unknown as SocialProviderRegistry;
    const svc = new SocialPostsService(prisma as never, accounts as never, {} as never, registry);
    return { svc, prisma, accounts };
  }

  it('đăng được ⇒ published + link', async () => {
    const { svc, prisma } = setup(jest.fn().mockResolvedValue({ external_post_id: '555_1', url: 'https://www.facebook.com/555_1' }));
    expect(await svc.processOne(11)).toBe('published');
    expect(prisma.socialPostTarget.update.mock.calls[0][0].data).toMatchObject({ status: 'published', external_post_id: '555_1' });
    expect(prisma.socialPost.update.mock.calls[0][0].data).toEqual({ status: 'published' });
    expect(prisma.integrationEvent.create.mock.calls[0][0].data).toMatchObject({
      event_type: 'social_post.published', resource: 'social_post', resource_id: '11',
      payload: { post_id: 3, target_id: 11, network: 'facebook', account_id: 5, url: 'https://www.facebook.com/555_1', error: null },
    });
  });

  it('lỗi tạm thời ⇒ xếp lại hàng với giãn cách', async () => {
    const { svc, prisma } = setup(jest.fn().mockRejectedValue(new SocialPublishError('temporary', 'down')));
    const t0 = Date.now();
    expect(await svc.processOne(11)).toBe('retry');
    const data = prisma.socialPostTarget.update.mock.calls[0][0].data;
    expect(data.status).toBe('queued');
    expect(data.next_attempt_at.getTime()).toBeGreaterThanOrEqual(t0 + SOCIAL_RETRY_DELAYS_MS[0]);
    expect(data.last_error).toBe('down Sẽ tự thử lại sau 1 phút.');
  });

  it('serverless (không có nhịp chạy nền) ⇒ lỗi tạm thời báo lỗi luôn, người dùng bấm Thử lại', async () => {
    process.env.TRINITY_RUNTIME = 'serverless';
    const { svc, prisma } = setup(jest.fn().mockRejectedValue(new SocialPublishError('rate', 'Facebook giới hạn tần suất.')));
    expect(await svc.processOne(11)).toBe('failed');
    expect(prisma.socialPostTarget.update.mock.calls[0][0].data).toMatchObject({ status: 'failed', last_error: 'Facebook giới hạn tần suất. Bấm Thử lại để đăng lại.' });
  });

  it('lỗi token ⇒ kênh cần liên kết lại, không thử lại', async () => {
    const { svc, prisma, accounts } = setup(jest.fn().mockRejectedValue(new SocialPublishError('token', 'expired')));
    expect(await svc.processOne(11)).toBe('failed');
    expect(accounts.markReauth).toHaveBeenCalledWith(5, 'expired');
    expect(prisma.integrationEvent.create.mock.calls[0][0].data).toMatchObject({ event_type: 'social_post.failed', payload: { error: 'expired', url: null } });
    expect(prisma.socialPostTarget.update.mock.calls[0][0].data.status).toBe('failed');
  });

  it('hết lượt thử ⇒ lỗi hẳn', async () => {
    const { svc, prisma } = setup(jest.fn().mockRejectedValue(new SocialPublishError('rate', 'slow down')));
    prisma.socialPostTarget.findUnique.mockResolvedValue({ ...target, attempts: SOCIAL_RETRY_DELAYS_MS.length + 1 });
    expect(await svc.processOne(11)).toBe('failed');
  });

  it('kênh không còn hoạt động ⇒ lỗi, không gọi mạng', async () => {
    const publish = jest.fn();
    const { svc, prisma } = setup(publish);
    prisma.socialAccount.findUnique.mockResolvedValue({ ...account, status: 'reauth' });
    expect(await svc.processOne(11)).toBe('failed');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('SocialProviderRegistry: mạng đang mở', () => {
  const fb = { network: 'facebook', supported: true } as never;
  const yt = { network: 'youtube', supported: true } as never;
  const off = (network: string) => ({ network, supported: true, configured: () => false }) as never;
  const on = (network: string) => ({ network, supported: true, configured: () => true }) as never;

  it('Instagram/TikTok/Google Business chưa có khoá ⇒ "Sắp có", không liên kết được; không còn X', () => {
    const r = new SocialProviderRegistry(fb, off('instagram'), yt, off('tiktok'), off('google_business'));
    expect(r.all().map((p) => p.network)).toEqual(['facebook', 'instagram', 'youtube', 'tiktok', 'google_business']);
    expect(r.all().filter((p) => p.supported).map((p) => p.network)).toEqual(['facebook', 'youtube']);
    for (const n of ['instagram', 'tiktok', 'google_business'] as const) {
      expect(r.get(n).supported).toBe(false);
      expect(() => r.get(n).authorizeUrl('s', 'u')).toThrow(/chưa hỗ trợ/);
    }
  });

  it('máy chủ có khoá ⇒ Instagram/TikTok đăng được', () => {
    const r = new SocialProviderRegistry(fb, on('instagram'), yt, on('tiktok'), on('google_business'));
    expect(r.all().filter((p) => p.supported).map((p) => p.network)).toEqual(['facebook', 'instagram', 'youtube', 'tiktok', 'google_business']);
  });
});

describe('SocialPostsService.kickIfDue (web nhắc đăng bài tới giờ trên bản serverless)', () => {
  function setup(found: unknown) {
    const prisma = { socialPostTarget: { findFirst: jest.fn().mockResolvedValue(found) } };
    const svc = new SocialPostsService(prisma as never, {} as never, {} as never, {} as never);
    const kick = jest.spyOn(svc, 'kick').mockImplementation(() => undefined);
    return { svc, prisma, kick };
  }

  it('có kênh tới giờ ⇒ chạy hàng đợi', async () => {
    const { svc, prisma, kick } = setup({ id: 7 });
    expect(await svc.kickIfDue(1_000_000)).toEqual({ due: true });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(prisma.socialPostTarget.findFirst.mock.calls[0][0].where.OR[0]).toEqual({ status: 'queued', next_attempt_at: { lte: new Date(1_000_000) } });
  });

  it('chưa tới giờ ⇒ không chạy', async () => {
    const { svc, kick } = setup(null);
    expect(await svc.kickIfDue(1_000_000)).toEqual({ due: false });
    expect(kick).not.toHaveBeenCalled();
  });

  it('nhiều tab gọi dồn trong 20 giây ⇒ chỉ đọc DB một lần', async () => {
    const { svc, prisma } = setup(null);
    await svc.kickIfDue(1_000_000);
    await svc.kickIfDue(1_010_000);
    expect(prisma.socialPostTarget.findFirst).toHaveBeenCalledTimes(1);
    await svc.kickIfDue(1_021_000);
    expect(prisma.socialPostTarget.findFirst).toHaveBeenCalledTimes(2);
  });
});

describe('SocialPostsService.nextDueAt — giờ bài chờ sớm nhất cho lượt tick kế tiếp', () => {
  it('lấy next_attempt_at nhỏ nhất của bài đang chờ / đang đăng; không có ⇒ null', async () => {
    const at = new Date('2026-10-15T03:05:00Z');
    const prisma = { socialPostTarget: { aggregate: jest.fn().mockResolvedValueOnce({ _min: { next_attempt_at: at } }).mockResolvedValueOnce({ _min: { next_attempt_at: null } }) } };
    const svc = new SocialPostsService(prisma as never, {} as never, {} as never, {} as never);
    expect(await svc.nextDueAt()).toEqual(at);
    expect(prisma.socialPostTarget.aggregate.mock.calls[0][0]).toEqual({ where: { status: { in: ['queued', 'publishing'] } }, _min: { next_attempt_at: true } });
    expect(await svc.nextDueAt()).toBeNull();
  });
});

describe('SocialPostsService.validate — ảnh thumbnail YouTube', () => {
  const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
  const video = { key: 'social/v.mp4', type: 'video', content_type: 'video/mp4', size: 10 };
  function setup(thumb: unknown) {
    const prisma = { socialAccount: { findMany: jest.fn(async () => [{ id: 3, network: 'youtube', name: 'Kênh', status: 'active' }]) } };
    const media = { resolve: jest.fn(async (_u: unknown, keys: string[]) => (keys[0] === 'social/v.mp4' ? [video] : thumb ? [thumb] : [])) };
    const provider = { supported: true, validateMedia: () => null, validateOptions: () => null };
    const svc = new SocialPostsService(prisma as never, {} as never, media as never, { get: () => provider } as never);
    return { svc, media };
  }
  const input = (key: string) => ({ content: 'x', media_keys: ['social/v.mp4'], targets: [{ account_id: 3, options: { thumbnail_key: key } }] });

  it('ảnh JPG/PNG trong thư viện ⇒ lưu sẵn thông tin tệp, bỏ thumbnail_key', async () => {
    const { svc } = setup({ key: 'social/t.png', type: 'image', content_type: 'image/png', size: 1000 });
    const v = await svc.validate(user, input('social/t.png') as never);
    expect(v.targets[0].options).toEqual({ thumbnail: { key: 'social/t.png', type: 'image', content_type: 'image/png', size: 1000 } });
  });

  it('options.thumbnail do người gọi tự gửi bị bỏ (chỉ nhận qua thumbnail_key đã kiểm)', async () => {
    const { svc, media } = setup(null);
    const v = await svc.validate(user, { content: 'x', media_keys: ['social/v.mp4'], targets: [{ account_id: 3, options: { thumbnail: { key: 'private/khac.png', type: 'image', content_type: 'image/png', size: 1 } } }] } as never);
    expect(v.targets[0].options).toEqual({});
    expect(media.resolve).toHaveBeenCalledTimes(1); // chỉ resolve media của bài
  });

  it('không có trong thư viện / sai định dạng / quá 2 MB ⇒ 400', async () => {
    await expect(setup(null).svc.validate(user, input('social/khong.png') as never)).rejects.toThrow(/JPG hoặc PNG/);
    await expect(setup({ key: 'k', type: 'image', content_type: 'image/webp', size: 10 }).svc.validate(user, input('k') as never)).rejects.toThrow(/JPG hoặc PNG/);
    await expect(setup({ key: 'k', type: 'image', content_type: 'image/jpeg', size: 3 * 1024 * 1024 }).svc.validate(user, input('k') as never)).rejects.toThrow(/2 MB/);
  });
});

describe('SocialPostsService.update / reschedule — sửa bài đang hẹn giờ', () => {
  const V1 = new Date('2026-10-15T08:00:00Z');
  const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
  const future = (min: number) => new Date(Date.now() + min * 60_000);
  function setup(o: { scheduled?: Date | null; targets?: Array<{ id: number; status: string }>; removed?: number; versionHits?: number } = {}) {
    const targets = o.targets ?? [{ id: 11, status: 'queued' }, { id: 12, status: 'cancelled' }];
    const tx = {
      socialPostTarget: { deleteMany: jest.fn(async (_a: any) => ({ count: o.removed ?? targets.filter((t) => t.status !== 'cancelled').length })), createMany: jest.fn(async (_a: any) => ({})), updateMany: jest.fn(async (_a: any) => ({ count: o.removed ?? 1 })) },
      socialPost: { update: jest.fn(async (_a: any) => ({})), updateMany: jest.fn(async (_a: any) => ({ count: o.versionHits ?? 1 })) },
    };
    const prisma = {
      socialPost: { findUnique: jest.fn(async () => ({ id: 5, media: [{ key: 'social/an.png', type: 'image', content_type: 'image/png', size: 9 }], scheduled_at: o.scheduled === undefined ? future(120) : o.scheduled, updated_at: V1 })) },
      socialPostTarget: { findMany: jest.fn(async () => targets) },
      socialAccount: { findMany: jest.fn(async () => [{ id: 3, network: 'facebook', name: 'Page', status: 'active' }]) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const media = { resolve: jest.fn(async () => []) };
    const provider = { supported: true, validateMedia: () => null, validateOptions: () => null };
    const svc = new SocialPostsService(prisma as never, {} as never, media as never, { get: () => provider } as never);
    jest.spyOn(svc, 'refreshStatus').mockResolvedValue(undefined);
    jest.spyOn(svc, 'get').mockResolvedValue({ id: 5 } as never);
    return { svc, tx };
  }
  const body = (at: Date) => ({ content: 'Nội dung mới', media_keys: [], scheduled_at: at.toISOString(), targets: [{ account_id: 3 }] });

  it('sửa: thay các kênh còn chờ, cập nhật nội dung + giờ trong một transaction', async () => {
    const { svc, tx } = setup();
    const at = future(300);
    await svc.update(user, 5, body(at) as never);
    expect(tx.socialPostTarget.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [11] }, status: 'queued' } });
    // kênh từng huỷ được chọn lại ⇒ xoá dòng huỷ trước khi tạo (tránh trùng khoá bài + kênh)
    expect(tx.socialPostTarget.deleteMany).toHaveBeenCalledWith({ where: { post_id: 5, status: 'cancelled', account_id: { in: [3] } } });
    expect(tx.socialPost.update.mock.calls[0][0].data).toMatchObject({ content: 'Nội dung mới', scheduled_at: at, status: 'scheduled' });
    expect(tx.socialPostTarget.createMany.mock.calls[0][0].data[0]).toMatchObject({ post_id: 5, account_id: 3, next_attempt_at: at });
  });

  it('expectUpdatedAt: ghi có điều kiện theo bản; bản khác / ai sửa chen ngang ⇒ 409, không ghi đè', async () => {
    const ok = setup();
    await ok.svc.update(user, 5, body(future(300)) as never, { expectUpdatedAt: V1 });
    expect(ok.tx.socialPost.updateMany.mock.calls[0][0].where).toEqual({ id: 5, updated_at: V1 });
    expect(ok.tx.socialPost.update).not.toHaveBeenCalled();
    await expect(setup().svc.update(user, 5, body(future(300)) as never, { expectUpdatedAt: new Date('2026-10-15T07:00:00Z') })).rejects.toThrow(/sửa ở nơi khác/);
    await expect(setup({ versionHits: 0 }).svc.update(user, 5, body(future(300)) as never, { expectUpdatedAt: V1 })).rejects.toThrow(/sửa ở nơi khác/);
  });

  it('chặn: bài đăng ngay / kênh đã bắt đầu đăng / sắp tới giờ / giờ mới đã qua', async () => {
    await expect(setup({ scheduled: null }).svc.update(user, 5, body(future(60)) as never)).rejects.toThrow(/Chỉ sửa được bài đang hẹn giờ/);
    await expect(setup({ targets: [{ id: 11, status: 'publishing' }] }).svc.update(user, 5, body(future(60)) as never)).rejects.toThrow(/Chỉ sửa được/);
    await expect(setup({ scheduled: future(0.5) }).svc.update(user, 5, body(future(60)) as never)).rejects.toThrow(/sắp tới giờ/);
    await expect(setup().svc.update(user, 5, body(future(-5)) as never)).rejects.toThrow(/ít nhất 1 phút/);
  });

  it('job vừa nhận đăng giữa chừng ⇒ 409, không ghi gì thêm', async () => {
    const { svc, tx } = setup({ removed: 0 });
    await expect(svc.update(user, 5, body(future(60)) as never)).rejects.toThrow(/vừa bắt đầu đăng/);
    expect(tx.socialPost.update).not.toHaveBeenCalled();
  });

  it('giữ nguyên tệp đính kèm (kể cả tệp đã ẩn khỏi thư viện) — không resolve lại', async () => {
    const { svc, tx } = setup();
    const resolve = (svc as unknown as { media: { resolve: jest.Mock } }).media.resolve;
    await svc.update(user, 5, { ...body(future(300)), media_keys: ['social/an.png'] } as never);
    expect(resolve).not.toHaveBeenCalled();
    expect(tx.socialPost.update.mock.calls[0][0].data.media).toEqual([{ key: 'social/an.png', type: 'image', content_type: 'image/png', size: 9 }]);
  });

  it('dời giờ: chỉ đổi giờ của bài và các kênh còn chờ', async () => {
    const { svc, tx } = setup();
    const at = future(1440);
    await svc.reschedule(5, at.toISOString());
    expect(tx.socialPostTarget.updateMany).toHaveBeenCalledWith({ where: { id: { in: [11] }, status: 'queued' }, data: { next_attempt_at: at } });
    expect(tx.socialPost.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { scheduled_at: at } });
    await expect(setup().svc.reschedule(5, 'không phải ngày')).rejects.toThrow(/ISO 8601/);
  });
});
