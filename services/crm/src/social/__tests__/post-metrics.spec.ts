import { FacebookSocialProvider } from '../providers/facebook.provider';
import { SocialPostGoneError, SocialPublishError, type AccountForPublish } from '../providers/provider.types';
import { YoutubeSocialProvider } from '../providers/youtube.provider';
import type { SocialProviderRegistry } from '../providers/provider.registry';
import { SocialPostsService, engagementOf, metricsDue, sumMetrics } from '../social-posts.service';

const ENV = { ...process.env };
beforeEach(() => {
  process.env.FACEBOOK_APP_ID = '123';
  process.env.FACEBOOK_APP_SECRET = 'app-secret';
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
const H = 3_600_000;

describe('lịch lấy số và cộng số', () => {
  it('chưa lấy lần nào ⇒ đến hạn; bài < 2 ngày lấy lại sau 1 giờ, bài cũ sau 6 giờ', () => {
    const now = 100 * 24 * H;
    expect(metricsDue(new Date(now - H), null, now)).toBe(true);
    expect(metricsDue(new Date(now - H), new Date(now - 59 * 60_000), now)).toBe(false);
    expect(metricsDue(new Date(now - H), new Date(now - H), now)).toBe(true);
    expect(metricsDue(new Date(now - 3 * 24 * H), new Date(now - 2 * H), now)).toBe(false);
    expect(metricsDue(new Date(now - 3 * 24 * H), new Date(now - 6 * H), now)).toBe(true);
  });

  it('cộng số: lượt xem null khi không kênh nào có; tương tác không tính lượt xem', () => {
    expect(sumMetrics([{ views: null, reactions: 3, comments: 1, shares: 2 }, null])).toEqual({ views: null, reactions: 3, comments: 1, shares: 2 });
    expect(sumMetrics([{ views: 10, reactions: 1, comments: 0, shares: null }, { views: null, reactions: 2, comments: 5, shares: 0 }])).toEqual({ views: 10, reactions: 3, comments: 5, shares: 0 });
    expect(engagementOf({ views: 999, reactions: 1, comments: 2, shares: 3 })).toBe(6);
    expect(engagementOf(null)).toBe(0);
  });
});

describe('Facebook: lấy số bài', () => {
  const fb = new FacebookSocialProvider();
  const acc: AccountForPublish = { id: 1, external_id: '555', name: 'Trang', access_token: 'page-token', refresh_token: null, token_expires_at: null };

  it('bài ({page}_{post}) ⇒ cảm xúc, bình luận, chia sẻ; chưa ai chia sẻ ⇒ 0; không có lượt xem', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { reactions: { summary: { total_count: 4 } }, comments: { summary: { total_count: 2 } }, id: '555_1' }));
    expect(await fb.fetchMetrics(acc, '555_1')).toEqual({ views: null, reactions: 4, comments: 2, shares: 0 });
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('/555_1?fields=');
    expect(decodeURIComponent(url)).toContain('reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares');
    expect(url).not.toContain('page-token');
  });

  it('video (id số) ⇒ lượt xem của video + số của bài chứa video', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(res(200, { views: 710, post_id: '967', id: '1255' }))
      .mockResolvedValueOnce(res(200, { reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 0 } }, shares: { count: 1 } }));
    expect(await fb.fetchMetrics(acc, '1255')).toEqual({ views: 710, reactions: 3, comments: 0, shares: 1 });
    expect(String(f.mock.calls[0][0])).toContain('/1255?fields=views%2Cpost_id');
    expect(String(f.mock.calls[1][0])).toContain('/555_967?fields=');
  });

  it('video chưa có bài kèm ⇒ chỉ lượt xem', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { views: 5, id: '1255' }));
    expect(await fb.fetchMetrics(acc, '1255')).toEqual({ views: 5, reactions: null, comments: null, shares: null });
  });
});

describe('YouTube: lấy số video', () => {
  const yt = new YoutubeSocialProvider();
  const acc: AccountForPublish = { id: 2, external_id: 'UC1', name: 'Kênh', access_token: 'yt-token', refresh_token: 'r', token_expires_at: null };

  it('statistics ⇒ lượt xem, thích, bình luận; không có chia sẻ', async () => {
    const f = jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { items: [{ statistics: { viewCount: '120', likeCount: '7', commentCount: '2' } }] }));
    expect(await yt.fetchMetrics(acc, 'vid1')).toEqual({ views: 120, reactions: 7, comments: 2, shares: null });
    expect(String(f.mock.calls[0][0])).toBe('https://www.googleapis.com/youtube/v3/videos?part=statistics&id=vid1');
  });

  it('video ẩn số thích ⇒ null; video đã xoá ⇒ lỗi invalid', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { items: [{ statistics: { viewCount: '3', commentCount: '0' } }] }));
    expect(await yt.fetchMetrics(acc, 'v')).toEqual({ views: 3, reactions: null, comments: 0, shares: null });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(res(200, { items: [] }));
    await expect(yt.fetchMetrics(acc, 'gone')).rejects.toBeInstanceOf(SocialPostGoneError);
  });
});

describe('SocialPostsService: lấy số và thống kê', () => {
  const now = Date.now();
  const account = { id: 5, network: 'facebook', status: 'active', external_id: '555', name: 'Trang' };
  function setup(fetchMetrics: jest.Mock | undefined, rows: unknown[]) {
    const prisma = {
      socialPostTarget: { findMany: jest.fn().mockResolvedValue(rows), update: jest.fn().mockResolvedValue({}) },
      socialAccount: { findUnique: jest.fn().mockResolvedValue(account), findMany: jest.fn().mockResolvedValue([{ id: 5, name: 'Trang' }, { id: 6, name: 'Kênh YT' }]) },
      socialPost: { findMany: jest.fn().mockResolvedValue([{ id: 1, content: 'Bài một' }, { id: 2, content: 'Bài hai' }]) },
    };
    const accounts = { forPublish: jest.fn().mockReturnValue({ id: 5, external_id: '555', name: 'Trang', access_token: 't', refresh_token: null, token_expires_at: null }), markReauth: jest.fn() };
    const provider = { network: 'facebook', supported: true, fetchMetrics };
    const svc = new SocialPostsService(prisma as never, accounts as never, {} as never, { get: () => provider } as unknown as SocialProviderRegistry);
    return { svc, prisma, accounts };
  }
  const t = (o: Record<string, unknown>) => ({ id: 1, post_id: 1, account_id: 5, network: 'facebook', status: 'published', external_post_id: '555_1', url: 'u', published_at: new Date(now - H), metrics: null, metrics_at: null, ...o });

  it('job: lưu số; bài chưa đến hạn bỏ qua; lỗi một bài vẫn ghi giờ lấy, không đánh dấu kênh cần liên kết lại', async () => {
    const fm = jest.fn().mockResolvedValueOnce({ views: null, reactions: 2, comments: 1, shares: 0 }).mockRejectedValueOnce(new SocialPublishError('token', 'hết hạn'));
    const { svc, prisma, accounts } = setup(fm, [t({ id: 1 }), t({ id: 2, metrics_at: new Date(now - 10 * 60_000) }), t({ id: 3 })]);
    expect(await svc.refreshMetricsDue(10_000, now)).toEqual({ updated: 1, failed: 1 });
    expect(fm).toHaveBeenCalledTimes(2);
    const calls = prisma.socialPostTarget.update.mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({ where: { id: 1 }, data: { metrics: { reactions: 2, comments: 1 } } });
    expect(calls[1].where).toEqual({ id: 3 });
    expect(calls[1].data.metrics).toBeUndefined();
    expect(calls[1].data.metrics_at).toBeInstanceOf(Date);
    expect(accounts.markReauth).not.toHaveBeenCalled();
    const where = prisma.socialPostTarget.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('published');
    expect(where.published_at.gte.getTime()).toBe(now - 90 * 24 * H);
  });

  it('bài đã bị xoá trên kênh ⇒ giữ số cũ + cờ removed, lần sau thôi lấy; thống kê đếm riêng', async () => {
    const fm = jest.fn().mockRejectedValue(new SocialPostGoneError('đã xoá'));
    const old = { views: 40, reactions: 2, comments: 0, shares: null };
    const { svc, prisma } = setup(fm, [t({ id: 1, metrics: old, metrics_at: new Date(now - 2 * H) }), t({ id: 2 })]);
    expect(await svc.refreshMetricsDue(10_000, now)).toEqual({ updated: 0, failed: 2 });
    const data = prisma.socialPostTarget.update.mock.calls.map((c) => c[0].data.metrics);
    expect(data).toEqual([{ ...old, removed: true }, { views: null, reactions: null, comments: null, shares: null, removed: true }]);
    fm.mockClear();
    const removedRows = [t({ id: 1, metrics: { ...old, removed: true } }), t({ id: 2, metrics: { views: null, reactions: null, comments: null, shares: null, removed: true } })];
    prisma.socialPostTarget.findMany.mockResolvedValue(removedRows);
    await svc.refreshMetricsDue(10_000, now);
    expect(fm).not.toHaveBeenCalled();
    const r = await svc.stats({ from: new Date(now - 30 * 24 * H), to: new Date(now) });
    expect(r).toMatchObject({ removed: 2, without_metrics: 0 });
    expect(r.top.map((x) => [x.target_id, x.removed])).toEqual([[1, true]]);
  });

  it('mạng chưa có hàm lấy số ⇒ chỉ ghi giờ lấy', async () => {
    const { svc, prisma } = setup(undefined, [t({ id: 9 })]);
    expect(await svc.refreshMetricsDue(10_000, now)).toEqual({ updated: 0, failed: 1 });
    expect(prisma.socialPostTarget.update.mock.calls[0][0].data).toEqual({ metrics_at: expect.any(Date) });
  });

  it('thống kê: tổng, theo kênh, bài tương tác cao nhất, bài chưa có số', async () => {
    const rows = [
      t({ id: 1, post_id: 1, account_id: 5, metrics: { views: null, reactions: 2, comments: 1, shares: 0 }, metrics_at: new Date(now - H) }),
      t({ id: 2, post_id: 1, account_id: 6, network: 'youtube', metrics: { views: 50, reactions: 5, comments: 3, shares: null }, metrics_at: new Date(now - 2 * H) }),
      t({ id: 3, post_id: 2, account_id: 5, metrics: null }),
    ];
    const { svc } = setup(undefined, rows);
    const r = await svc.stats({ from: new Date(now - 30 * 24 * H), to: new Date(now) });
    expect(r.totals).toEqual({ posts: 2, published: 3, views: 50, reactions: 7, comments: 4, shares: 0 });
    expect(r.by_account).toEqual([
      { account_id: 5, account_name: 'Trang', network: 'facebook', published: 2, with_metrics: 1, views: null, reactions: 2, comments: 1, shares: 0 },
      { account_id: 6, account_name: 'Kênh YT', network: 'youtube', published: 1, with_metrics: 1, views: 50, reactions: 5, comments: 3, shares: 0 },
    ]);
    expect(r.top.map((x) => [x.target_id, x.engagement])).toEqual([[2, 8], [1, 3]]);
    expect(r.top[0].content).toBe('Bài một');
    expect(r.without_metrics).toBe(1);
    expect(r.updated_at?.getTime()).toBe(now - H);
  });
});
