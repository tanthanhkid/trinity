import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '@trinity/prisma';
import { describePg, pgClient, resetTables } from './pg-harness';
import { encryptSecret, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { SocialAccountsService } from '../social/social-accounts.service';
import { SocialPostsService } from '../social/social-posts.service';
import { SocialRecurrenceService } from '../social/social-recurrence.service';
import type { SocialProviderRegistry } from '../social/providers/provider.registry';

/**
 * Migration 0021 (G04 — chỉ còn đăng bài Fanpage) trên Postgres THẬT: dựng dữ liệu cũ của YouTube / TikTok / Google Business /
 * Instagram như ở bản đang chạy, chạy lại SQL của migration (hai lần — phải cho cùng kết quả), rồi chạy job `social.publish`
 * (bài lặp + đăng bài đến hạn) và job lấy số ba lượt: không lỗi, không gọi mạng đã gỡ, bài cũ vẫn còn trong lịch sử.
 */
const TABLES = ['social_post_targets', 'social_posts', 'social_accounts', 'social_recurrences', 'social_drafts', 'integration_events'];
const MIGRATION = join(__dirname, '../../../../packages/prisma/prisma/migrations/0021_social_fanpage_only/migration.sql');
const REMOVED = ['youtube', 'tiktok', 'google_business', 'instagram'];

/** Tách file migration thành từng câu (Prisma `$executeRawUnsafe` chỉ nhận một câu). Chuỗi trong file không chứa `;`. */
function statements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describePg('Migration 0021 — chỉ còn đăng bài Fanpage (Postgres thật)', () => {
  let db: PrismaService;
  const ENV = { ...process.env };

  beforeAll(() => {
    process.env.INTEGRATIONS_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
    db = pgClient();
  });
  afterAll(async () => {
    process.env = { ...ENV };
    await db.$disconnect();
  });
  beforeEach(() => resetTables(db, TABLES));

  async function seed() {
    const tok = encryptSecret('token-cũ', loadSecretKey());
    const acc = (id: number, network: string, status = 'active') =>
      db.socialAccount.create({ data: { id, network, external_id: `x${id}`, name: `Kênh ${network}`, access_token_enc: tok, refresh_token_enc: network === 'facebook' ? null : tok, token_expires_at: network === 'facebook' ? null : new Date(), status, connected_by: 1 } });
    await acc(1, 'facebook');
    await acc(2, 'youtube');
    await acc(3, 'tiktok', 'reauth');
    await acc(4, 'instagram', 'disabled');
    await acc(5, 'google_business');
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 86_400_000);
    const post = (id: number, status: string, scheduled_at: Date | null) => db.socialPost.create({ data: { id, content: `Bài ${id}`, status, scheduled_at, created_by: 1 } });
    const target = (post_id: number, account_id: number, network: string, status: string, extra: Record<string, unknown> = {}) =>
      db.socialPostTarget.create({ data: { post_id, account_id, network, status, next_attempt_at: past, ...extra } });
    // 10: Fanpage + YouTube, đến hạn ⇒ Fanpage đăng được, YouTube phải bị huỷ trước khi job chạy.
    await post(10, 'publishing', past);
    await target(10, 1, 'facebook', 'queued');
    await target(10, 2, 'youtube', 'queued');
    // 11: chỉ TikTok, hẹn ngày mai ⇒ bài thành "đã huỷ".
    await post(11, 'scheduled', future);
    await target(11, 3, 'tiktok', 'queued');
    // 12: YouTube đã đăng (lịch sử, có số liệu) ⇒ giữ nguyên, job lấy số không gọi mạng.
    await post(12, 'published', null);
    await target(12, 2, 'youtube', 'published', { external_post_id: 'vid1', url: 'https://www.youtube.com/watch?v=vid1', published_at: past, metrics: { views: 50, reactions: 5, comments: 3, shares: null } });
    // 13: Google Business đang đăng dở (tiến trình chết) ⇒ lỗi, không biết đã lên chưa.
    await post(13, 'publishing', null);
    await target(13, 5, 'google_business', 'publishing', { claimed_at: past });
    // Bài lặp: một cái có Fanpage + YouTube, một cái chỉ Instagram.
    const rule = { freq: 'daily', interval: 1, time: '09:00' };
    const tpl = (ids: number[]) => ({ content: 'Lặp', media_keys: [], targets: ids.map((account_id) => ({ account_id })) });
    await db.socialRecurrence.create({ data: { id: 1, title: 'Hỗn hợp', template: tpl([1, 2]), rule, starts_on: new Date(), next_run_at: future, created_by: 1 } });
    await db.socialRecurrence.create({ data: { id: 2, title: 'Chỉ IG', template: tpl([4]), rule, starts_on: new Date(), next_run_at: future, created_by: 1 } });
    // Nháp chưa đăng có Fanpage + TikTok.
    await db.socialDraft.create({ data: { id: 1, content: 'Nháp', targets: [{ account_id: 1 }, { account_id: 3, caption: 'tt' }], created_by: 1 } });
  }

  async function migrate() {
    for (const s of statements(readFileSync(MIGRATION, 'utf8'))) await db.$executeRawUnsafe(s);
  }

  it('sau migrate: không còn đích chờ trên 4 mạng, kênh disabled kèm lý do (token giữ), bài lặp/nháp bỏ kênh đã gỡ, lịch sử còn', async () => {
    await seed();
    await migrate();
    const snapshot = async () => ({
      targets: await db.socialPostTarget.findMany({ orderBy: { id: 'asc' }, select: { post_id: true, network: true, status: true, last_error: true, claimed_at: true } }),
      posts: await db.socialPost.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
      accounts: await db.socialAccount.findMany({ orderBy: { id: 'asc' }, select: { id: true, network: true, status: true, last_error: true, access_token_enc: true, refresh_token_enc: true, token_expires_at: true } }),
      recurrences: await db.socialRecurrence.findMany({ orderBy: { id: 'asc' }, select: { id: true, active: true, template: true, last_error: true } }),
      drafts: await db.socialDraft.findMany({ select: { targets: true } }),
    });
    const s = await snapshot();

    const pending = await db.socialPostTarget.count({ where: { network: { in: REMOVED }, status: { in: ['queued', 'publishing'] } } });
    expect(pending).toBe(0);
    expect(s.targets.map((t) => [t.post_id, t.network, t.status])).toEqual([
      [10, 'facebook', 'queued'],
      [10, 'youtube', 'cancelled'],
      [11, 'tiktok', 'cancelled'],
      [12, 'youtube', 'published'],
      [13, 'google_business', 'failed'],
    ]);
    expect(s.targets[1].last_error).toMatch(/ngừng hỗ trợ/);
    expect(s.targets[4].last_error).toMatch(/đăng dở/);
    expect(s.targets[4].claimed_at).toBeNull();
    expect(s.posts.map((p) => [p.id, p.status])).toEqual([[10, 'publishing'], [11, 'cancelled'], [12, 'published'], [13, 'failed']]);

    expect(s.accounts.map((a) => [a.network, a.status])).toEqual([['facebook', 'active'], ['youtube', 'disabled'], ['tiktok', 'disabled'], ['instagram', 'disabled'], ['google_business', 'disabled']]);
    expect(s.accounts[0].last_error).toBeNull();
    expect(s.accounts[1].last_error).toBe('Trinity đã ngừng hỗ trợ YouTube: chỉ còn đăng bài lên Fanpage Facebook. Bài cũ vẫn xem được trong lịch sử.');
    expect(s.accounts[4].last_error).toMatch(/Google Business Profile/);
    // Token của kênh đã gỡ bị xoá trắng (không gọi thu hồi ra ngoài); Fanpage giữ nguyên.
    expect(s.accounts[0].access_token_enc.startsWith('v1.')).toBe(true);
    expect(s.accounts.slice(1).map((a) => [a.access_token_enc, a.refresh_token_enc, a.token_expires_at])).toEqual(Array(4).fill(['', null, null]));

    expect(s.recurrences[0]).toMatchObject({ active: true, last_error: null });
    expect((s.recurrences[0].template as { targets: unknown[] }).targets).toEqual([{ account_id: 1 }]);
    expect(s.recurrences[1].active).toBe(false);
    expect(s.recurrences[1].last_error).toMatch(/ngừng hỗ trợ/);
    expect((s.recurrences[1].template as { targets: unknown[] }).targets).toEqual([{ account_id: 4 }]); // giữ mẫu để xem lại
    expect(s.drafts[0].targets).toEqual([{ account_id: 1 }]);

    // Chạy lại cho cùng kết quả (migration chạy lại ở công ty đang dở dang không làm hỏng gì).
    await migrate();
    const again = await snapshot();
    expect(again).toEqual(s);
  });

  it('job social.publish chạy 3 lượt trên DB có dữ liệu cũ: không lỗi, chỉ Fanpage được đăng, không gọi mạng đã gỡ', async () => {
    await seed();
    await migrate();
    const publish = jest.fn(async () => ({ external_post_id: 'x1_99', url: 'https://www.facebook.com/x1_99' }));
    const fetchMetrics = jest.fn(async () => ({ views: null, reactions: 1, comments: 0, shares: 0 }));
    const facebook = { network: 'facebook', supported: true, configured: () => true, validateMedia: () => null, publish, fetchMetrics };
    const registry = { get: (n: string) => (n === 'facebook' ? facebook : undefined), all: () => [facebook] } as unknown as SocialProviderRegistry;
    const accounts = new SocialAccountsService(db, registry);
    const media = { resolve: async () => [], load: async () => ({}) };
    const posts = new SocialPostsService(db, accounts, media as never, registry);
    const recurrences = new SocialRecurrenceService(db, posts);

    const runs = [];
    for (let i = 0; i < 3; i++) {
      const recurring = await recurrences.materialize();
      runs.push({ ...(await posts.runDue(40_000)), recurring });
      await posts.refreshMetricsDue(25_000);
    }
    expect(runs.map((r) => r.published + r.failed + r.retry)).toEqual([1, 0, 0]);
    expect(runs[0]).toMatchObject({ published: 1, failed: 0, retry: 0 });
    expect(publish).toHaveBeenCalledTimes(1);
    // Lấy số chỉ cho bài Fanpage vừa đăng; bài YouTube cũ không bị gọi (không có provider).
    expect(fetchMetrics).toHaveBeenCalledTimes(1);

    const yt = await db.socialPostTarget.findFirst({ where: { post_id: 12 } });
    expect(yt).toMatchObject({ status: 'published', url: 'https://www.youtube.com/watch?v=vid1', metrics: { views: 50, reactions: 5, comments: 3, shares: null } });
    expect((await db.socialPost.findUnique({ where: { id: 10 } }))?.status).toBe('published'); // Fanpage đã đăng; đích YouTube đã huỷ không tính
    // Lịch sử bài đăng vẫn trả bài cũ của mạng đã gỡ.
    const history = await posts.list({});
    expect(history.data.map((p: { id: number }) => p.id)).toEqual(expect.arrayContaining([10, 11, 12, 13]));
    // Kênh đã gỡ không hiện ở màn Kênh, không bật lại được.
    expect((await accounts.list()).map((a) => a.network)).toEqual(['facebook']);
    await expect(accounts.enable(2)).rejects.toThrow(/ngừng hỗ trợ YouTube/);
  });
});
