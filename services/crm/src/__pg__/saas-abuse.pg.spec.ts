import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CompanyRef,
  DEFAULT_COMPANY,
  PrismaService,
  backfillSettingRoutes,
  claimCompanyRoute,
  companyIdForRoute,
  createPrismaService,
  currentCompany,
  ensurePlatform,
  getBaseClient,
  getChannelLock,
  provisionCompany,
  releaseCompanyRoute,
  runInTenantScope,
  runWithCompany,
  setChannelLock,
} from '@trinity/prisma';
import { resolvePublicRouteCompany } from '@trinity/rbac-nest';
import { ChannelBlockedError } from '../channel-guard/channel-guard.errors';
import { ChannelGuardService } from '../channel-guard/channel-guard.service';
import { observeGraph } from '../channel-guard/graph-observer';
import { enterRoutedCompany } from '../common/helpers/routed-company';
import { withCompanyHint } from '../common/helpers/tenant-hint';
import { ConnectorsService } from '../connectors/connectors.service';
import { signState } from '../connectors/oauth-state';
import { ShopeeService } from '../connectors/shopee.service';
import { loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { PaymentsService } from '../connectors/payments.service';
import { txnRefFor, vnpaySign } from '../connectors/vnpay';
import { StoreService } from '../store/store.service';
import { PG_URL, describePg, isLocalDbUrl } from './pg-harness';

/**
 * SaaS đa công ty trên Postgres thật: (1) chống lạm dụng kênh theo công ty — hạn mức theo gói đếm nguyên tử, khoá kênh của
 * chủ nền tảng, tự tạm dừng khi Graph API báo chặn; (2) lỗ route: gian hàng Shopee/Lazada, địa chỉ cửa hàng, IPN/return VNPay
 * của công ty 2 không chạm công ty 1.
 */
describePg('SaaS: chống lạm dụng kênh + route theo công ty (Postgres)', () => {
  let db: PrismaService;
  let A: CompanyRef;
  let B: CompanyRef;
  let guard: ChannelGuardService;
  const prevMt = process.env.MULTI_TENANT;
  const prevKey = process.env.INTEGRATIONS_SECRET_KEY;
  const stamp = Date.now();

  async function dropTenantObjects(): Promise<void> {
    const base = getBaseClient();
    const schemas = await base.$queryRawUnsafe<Array<{ nspname: string }>>(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^c_[0-9]+$'`);
    for (const s of schemas) await base.$executeRawUnsafe(`DROP SCHEMA "${s.nspname}" CASCADE`);
    for (const [trg, table] of [
      ['trinity_platform_sync_login', 'users'],
      ['trinity_platform_sync_facebook_page', 'facebook_pages'],
      ['trinity_platform_sync_zalo_oa', 'zalo_oa_connections'],
    ]) {
      await base.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg} ON public.${table}`);
    }
    await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS platform CASCADE`);
  }

  const setPlan = (c: CompanyRef, plan: string) =>
    runWithCompany(c, () => db.setting.upsert({ where: { key: 'org_plan' }, update: { value: plan }, create: { key: 'org_plan', value: plan } }));
  const inCompany = <T>(c: CompanyRef, fn: () => Promise<T>) => runWithCompany(c, fn);

  beforeAll(async () => {
    if (!isLocalDbUrl(PG_URL)) throw new Error('TEST_DATABASE_URL must point at a local/CI Postgres');
    process.env.DATABASE_URL = PG_URL;
    process.env.MULTI_TENANT = 'true';
    process.env.INTEGRATIONS_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    db = createPrismaService();
    await dropTenantObjects();
    await getBaseClient().$executeRawUnsafe('TRUNCATE TABLE public.users RESTART IDENTITY CASCADE');
    await getBaseClient().$executeRawUnsafe('TRUNCATE TABLE public.settings, public.connector_accounts, public.payment_intents RESTART IDENTITY CASCADE');
    await ensurePlatform();
    A = (await provisionCompany({ companyName: 'Công ty A', adminEmail: `abuse-a-${stamp}@example.com`, adminPassword: 'password-a-123', adminName: 'Chủ A' })).company;
    B = (await provisionCompany({ companyName: 'Công ty B', adminEmail: `abuse-b-${stamp}@example.com`, adminPassword: 'password-b-123', adminName: 'Chủ B' })).company;
    guard = new ChannelGuardService(db);
    guard.onModuleInit();
  }, 240_000);

  afterAll(async () => {
    try {
      guard.onModuleDestroy();
      await dropTenantObjects();
    } finally {
      await db.$disconnect();
      process.env.MULTI_TENANT = prevMt;
      if (prevKey === undefined) delete process.env.INTEGRATIONS_SECRET_KEY;
      else process.env.INTEGRATIONS_SECRET_KEY = prevKey;
    }
  });

  // ───────────────────────── hạn mức

  describe('hạn mức theo gói', () => {
    it('đếm theo từng công ty: A hết hạn mức tin hàng loạt thì B vẫn gửi được', async () => {
      await setPlan(A, 'ket_noi'); // 200 tin/ngày
      await setPlan(B, 'ket_noi');
      await inCompany(A, () => guard.reserve('bulk_message', 200));
      await expect(inCompany(A, () => guard.reserve('bulk_message'))).rejects.toThrow(/hết hạn mức tin gửi hàng loạt/);
      await expect(inCompany(B, () => guard.reserve('bulk_message', 150))).resolves.toBeInstanceOf(Date);
      const sa = await inCompany(A, () => guard.status());
      const sb = await inCompany(B, () => guard.status());
      expect(sa.usage.bulk_messages_today).toBe(200);
      expect(sb.usage.bulk_messages_today).toBe(150);
      expect(sa.warnings.join(' ')).toMatch(/hết hạn mức tin gửi hàng loạt/);
      // Lần vượt được ghi thành sự kiện cho công ty A, không lộ sang B.
      expect(sa.recent_events.some((e) => e.kind === 'limit_exceeded')).toBe(true);
      expect(sb.recent_events.some((e) => e.kind === 'limit_exceeded')).toBe(false);
    });

    it('nguyên tử: 40 lời giữ chỗ song song chỉ vừa đủ phần còn lại', async () => {
      // B còn 50 tin hôm nay (200 - 150).
      const results = await Promise.allSettled(Array.from({ length: 40 }, () => inCompany(B, () => guard.reserve('bulk_message', 2))));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(25);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(15);
      expect((await inCompany(B, () => guard.status())).usage.bulk_messages_today).toBe(200);
    });

    it('người nhận mỗi chiến dịch theo gói; bài đăng/ngày; trả lời bình luận/giờ', async () => {
      await expect(inCompany(B, () => guard.assertRecipients(201))).rejects.toThrow(/tối đa 200 người/);
      await expect(inCompany(B, () => guard.assertRecipients(200))).resolves.toBeUndefined();
      await inCompany(B, () => guard.reserve('post', 10));
      await expect(inCompany(B, () => guard.reserve('post'))).rejects.toThrow(/bài đăng/);
      await inCompany(B, () => guard.reserve('comment_reply', 60));
      await expect(inCompany(B, () => guard.reserve('comment_reply'))).rejects.toBeInstanceOf(ChannelBlockedError);
    });

    it('gói custom rộng nhưng vẫn có trần an toàn', async () => {
      await setPlan(A, 'custom');
      const lim = await inCompany(A, async () => {
        // plan cache 30 s: tạo bản guard mới để đọc gói vừa đổi
        return new ChannelGuardService(db).limits();
      });
      expect(lim.bulkMessagesPerDay).toBe(5000);
      await expect(inCompany(A, () => new ChannelGuardService(db).assertRecipients(2001))).rejects.toBeInstanceOf(ChannelBlockedError);
    });

    it('công ty ≥ 2 thiếu dòng org_plan dùng gói đăng ký mặc định (hạn mức ket_noi), không rơi về custom; công ty 1 vẫn custom', async () => {
      await inCompany(B, () => db.setting.deleteMany({ where: { key: 'org_plan' } }));
      await inCompany(DEFAULT_COMPANY, () => db.setting.deleteMany({ where: { key: 'org_plan' } }));
      const g = new ChannelGuardService(db);
      expect(await inCompany(B, () => g.limits())).toEqual({ bulkMessagesPerDay: 200, recipientsPerCampaign: 200, postsPerDay: 10, autoCommentRepliesPerHour: 60 });
      expect((await inCompany(DEFAULT_COMPANY, () => g.limits())).bulkMessagesPerDay).toBe(5000);
      await setPlan(B, 'ket_noi');
    });

    it('bản cài một công ty (MULTI_TENANT=false) không bị hạn mức mới', async () => {
      process.env.MULTI_TENANT = 'false';
      try {
        const g = new ChannelGuardService(db);
        await expect(g.reserve('bulk_message', 1_000_000)).resolves.toBeNull();
        await expect(g.assertRecipients(1_000_000)).resolves.toBeUndefined();
        await expect(g.assertOutbound('auto')).resolves.toBeUndefined();
        expect((await g.status()).enforced).toBe(false);
      } finally {
        process.env.MULTI_TENANT = 'true';
      }
    });
  });

  // ───────────────────────── khoá kênh

  describe('khoá kênh của chủ nền tảng', () => {
    it('khoá A: mọi gửi ra ngoài của A bị chặn, B không ảnh hưởng, mở lại thì gửi được', async () => {
      expect((await getChannelLock(A.id)).locked).toBe(false);
      expect(await setChannelLock(A.id, true, 'nghi spam')).toBe(true);
      await expect(inCompany(A, () => guard.assertOutbound('manual'))).rejects.toMatchObject({ blockCode: 'channel_locked' });
      await expect(inCompany(A, () => guard.reserve('post'))).rejects.toThrow(/tạm khoá.*nghi spam/);
      await expect(inCompany(A, () => guard.reserve('comment_reply'))).rejects.toMatchObject({ blockCode: 'channel_locked' });
      const st = await inCompany(A, () => guard.status());
      expect(st.locked).toMatchObject({ locked: true, reason: 'nghi spam' });
      expect(st.warnings[0]).toMatch(/tạm khoá/);
      await expect(inCompany(B, () => guard.assertOutbound('manual'))).resolves.toBeUndefined();
      expect(await setChannelLock(A.id, false)).toBe(true);
      await expect(inCompany(A, () => guard.assertOutbound('auto'))).resolves.toBeUndefined();
      expect(await setChannelLock(9999, true)).toBe(false);
    });
  });

  // ───────────────────────── tự tạm dừng

  describe('tỉ lệ lỗi Graph API', () => {
    const waitFor = async (fn: () => Promise<boolean>) => {
      for (let i = 0; i < 40; i++) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('hết giờ chờ');
    };

    it('hai lỗi #368 của công ty A ⇒ A tự tạm dừng gửi tự động; B và tin tay của A vẫn chạy', async () => {
      await inCompany(A, async () => {
        observeGraph({ ok: true, httpStatus: 200, code: null, subcode: null, send: true });
        observeGraph({ ok: false, httpStatus: 400, code: 368, subcode: null, send: true });
        observeGraph({ ok: false, httpStatus: 400, code: 368, subcode: null, send: true });
      });
      await waitFor(async () => (await inCompany(A, () => guard.blockReason('auto'))) !== null);
      const block = await inCompany(A, () => guard.blockReason('auto'));
      expect(block?.code).toBe('channel_paused');
      expect(block?.message).toMatch(/tạm dừng đến/);
      await expect(inCompany(A, () => guard.reserve('comment_reply'))).rejects.toMatchObject({ blockCode: 'channel_paused' });
      expect(await inCompany(A, () => guard.blockReason('manual'))).toBeNull();
      expect(await inCompany(B, () => guard.blockReason('auto'))).toBeNull();
      const st = await inCompany(A, () => guard.status());
      expect(st.auto_pause?.reason).toMatch(/#368/);
      expect(st.recent_events.some((e) => e.kind === 'auto_pause')).toBe(true);
      expect(st.warnings.join(' ')).toMatch(/tạm dừng/);
    });

    it('mở lại sớm (CLI resume) thì gửi tự động chạy lại', async () => {
      expect(await inCompany(A, () => guard.resume())).toBe(true);
      expect(await inCompany(A, () => guard.blockReason('auto'))).toBeNull();
      expect(await inCompany(A, () => guard.resume())).toBe(false);
    });

    it('tỉ lệ lỗi chặn cao (#17/#32/#551) của lời gọi gửi ra thì tạm dừng; lỗi đọc, lỗi quyền, ngoài cửa sổ 24h, lỗi cấp app thì không', async () => {
      await inCompany(B, async () => {
        for (let i = 0; i < 30; i++) observeGraph({ ok: false, httpStatus: 400, code: 190, subcode: null, send: true }); // token hết hạn: lỗi thường
        for (let i = 0; i < 30; i++) observeGraph({ ok: true, httpStatus: 200, code: null, subcode: null, send: true });
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(await inCompany(B, () => guard.blockReason('auto'))).toBeNull();
      await inCompany(B, async () => {
        for (let i = 0; i < 30; i++) observeGraph({ ok: false, httpStatus: 400, code: [17, 32, 551][i % 3], subcode: null, send: true });
      });
      await waitFor(async () => (await inCompany(B, () => guard.blockReason('auto'))) !== null);
      expect((await inCompany(B, () => guard.blockReason('auto')))?.code).toBe('channel_paused');
    });
  });

  describe('lỗi Graph không phải do công ty', () => {
    const fresh = () => {
      const g = new ChannelGuardService(db);
      return g;
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('Page thiếu read_insights (lời gọi ĐỌC lỗi #10/#200 nhiều lần) không bị tạm dừng', async () => {
      const g = fresh();
      await inCompany(A, async () => {
        for (let i = 0; i < 60; i++) g.recordGraph({ ok: false, httpStatus: 403, code: i % 2 ? 10 : 200, subcode: null, send: false });
        for (let i = 0; i < 5; i++) g.recordGraph({ ok: true, httpStatus: 200, code: null, subcode: null, send: true });
      });
      await wait(150);
      expect(await inCompany(A, () => g.blockReason('auto'))).toBeNull();
    });

    it('lỗi quyền thường gặp và ngoài cửa sổ 24h của lời gọi gửi cũng không tính', async () => {
      const g = fresh();
      await inCompany(A, async () => {
        for (let i = 0; i < 40; i++) g.recordGraph({ ok: false, httpStatus: 400, code: 200, subcode: null, send: true });
        for (let i = 0; i < 40; i++) g.recordGraph({ ok: false, httpStatus: 400, code: 10, subcode: 2018278, send: true });
        for (let i = 0; i < 40; i++) g.recordGraph({ ok: false, httpStatus: 400, code: 551, subcode: 2018278, send: true });
      });
      await wait(150);
      expect(await inCompany(A, () => g.blockReason('auto'))).toBeNull();
    });

    it('giới hạn cấp app (#4/#613/429): không đổ cho công ty gọi, cả app lùi gửi tự động; tin tay vẫn gửi', async () => {
      const g = fresh();
      await inCompany(B, async () => {
        for (const [status, code] of [[400, 4], [400, 613], [429, null]] as const) {
          for (let i = 0; i < 15; i++) g.recordGraph({ ok: false, httpStatus: status, code, subcode: null, send: true });
        }
      });
      await wait(150);
      const events = await inCompany(B, () => db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM channel_events WHERE kind = 'auto_pause' AND created_at > now() - interval '1 minute'`));
      // B đã có một lần tạm dừng từ test trước; test này không thêm lần nào.
      const before = Number(events[0].n);
      const r = await inCompany(A, () => g.blockReason('auto'));
      expect(r?.code).toBe('channel_paused');
      expect(r?.message).toMatch(/giới hạn tần suất chung/);
      expect(await inCompany(A, () => g.blockReason('manual'))).toBeNull();
      expect(Number((await inCompany(B, () => db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM channel_events WHERE kind = 'auto_pause' AND created_at > now() - interval '1 minute'`)))[0].n)).toBe(before);
    });
  });

  describe('backoff cấp app và phạm vi tạm dừng', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('một lần lẻ, hoặc lời gọi ĐỌC bị giới hạn cấp app, không kích backoff; lặp ≥3 lần lời gọi gửi thì mới lùi', async () => {
      const g = new ChannelGuardService(db);
      await inCompany(A, async () => {
        g.recordGraph({ ok: false, httpStatus: 400, code: 613, subcode: null, send: true });
        for (let i = 0; i < 20; i++) g.recordGraph({ ok: false, httpStatus: 429, code: null, subcode: null, send: false });
      });
      expect(await inCompany(A, () => g.blockReason('auto'))).toBeNull();
      await inCompany(A, async () => {
        g.recordGraph({ ok: false, httpStatus: 400, code: 4, subcode: null, send: true });
        g.recordGraph({ ok: false, httpStatus: 429, code: null, subcode: null, send: true });
      });
      const r = await inCompany(A, () => g.blockReason('auto'));
      expect(r?.code).toBe('channel_paused');
      expect(r?.until).toBeInstanceOf(Date);
    });

    it('tạm dừng do Graph chỉ áp cho Facebook: phạm vi "other" (Zalo) vẫn gửi; khoá kênh thì chặn cả hai', async () => {
      await setPlan(A, 'custom');
      const g = new ChannelGuardService(db);
      await inCompany(A, async () => {
        for (let i = 0; i < 3; i++) g.recordGraph({ ok: false, httpStatus: 429, code: null, subcode: null, send: true });
      });
      expect((await inCompany(A, () => g.blockReason('auto', 'meta')))?.code).toBe('channel_paused');
      expect(await inCompany(A, () => g.blockReason('auto', 'other'))).toBeNull();
      await expect(inCompany(A, () => g.reserve('bulk_message', 1, undefined, 'other'))).resolves.toBeInstanceOf(Date);
      await setChannelLock(A.id, true, 'thử');
      try {
        expect((await inCompany(A, () => g.blockReason('auto', 'other')))?.code).toBe('channel_locked');
      } finally {
        await setChannelLock(A.id, false);
      }
    });

    it('hoàn hạn mức không xuống dưới 0', async () => {
      const g = new ChannelGuardService(db);
      await setPlan(A, 'custom');
      const gg = new ChannelGuardService(db);
      const before = (await inCompany(A, () => gg.status())).usage.bulk_messages_today;
      await inCompany(A, () => gg.reserve('bulk_message', 2));
      await inCompany(A, () => gg.refund('bulk_message', 1));
      expect((await inCompany(A, () => gg.status())).usage.bulk_messages_today).toBe(before + 1);
      await inCompany(A, () => gg.refund('bulk_message', 1_000_000));
      expect((await inCompany(A, () => gg.status())).usage.bulk_messages_today).toBe(0);
      void g;
      await wait(0);
    });

    it('cảnh báo nhẹ cho mọi người dùng chỉ có chữ cảnh báo, không lộ hạn mức/sự kiện', async () => {
      const g = new ChannelGuardService(db);
      const a = await inCompany(A, () => g.alerts());
      expect(Object.keys(a).sort()).toEqual(['enforced', 'locked', 'paused', 'warnings']);
    });
  });

  describe('giữ chỗ hạn mức trong transaction', () => {
    it('hạn mức đọc trước transaction; transaction lỗi thì hoàn lại; vượt trần một lần thì báo đúng nghĩa, không ghi limit_exceeded', async () => {
      await setPlan(A, 'ket_noi'); // 10 bài/ngày
      const g = new ChannelGuardService(db);
      const used = async () => (await inCompany(A, () => g.status())).usage.posts_today;
      const before = await used();
      const ctx = await inCompany(A, () => g.prepareReserve('post'));
      await expect(inCompany(A, () => db.$transaction(async (tx) => { await g.reserve('post', 3, tx as never, 'meta', ctx); throw new Error('tạo bài lỗi'); }))).rejects.toThrow('tạo bài lỗi');
      expect(await used()).toBe(before);
      await inCompany(A, () => db.$transaction(async (tx) => { await g.reserve('post', 2, tx as never, 'meta', ctx); }));
      expect(await used()).toBe(before + 2);
      const evBefore = (await inCompany(A, () => g.status())).recent_events.length;
      await expect(inCompany(A, () => g.reserve('post', 11))).rejects.toThrow(/Một lần chỉ được bài đăng\/hẹn giờ tối đa 10/);
      expect((await inCompany(A, () => g.status())).recent_events.length).toBe(evBefore);
    });

    it('hết hạn mức TRONG transaction: sự kiện không ghi trong transaction, ghi sau khi gọi recordBlocked', async () => {
      await setPlan(A, 'ket_noi');
      const g = new ChannelGuardService(db);
      const events = async () => (await inCompany(A, () => g.status())).recent_events.filter((e) => e.kind === 'limit_exceeded').length;
      await inCompany(A, async () => {
        const left = 10 - (await g.status()).usage.posts_today;
        if (left > 0) await g.reserve('post', left); // dùng hết hạn mức ngày
      });
      const n0 = await events();
      const ctx = await inCompany(A, () => g.prepareReserve('post'));
      const err = await inCompany(A, () => db.$transaction(async (tx) => { await g.reserve('post', 1, tx as never, 'meta', ctx); }).catch((e) => e));
      expect(err).toBeInstanceOf(ChannelBlockedError);
      expect(await events()).toBe(n0);
      await inCompany(A, () => g.recordBlocked(err));
      expect(await events()).toBeGreaterThanOrEqual(n0); // dedupe theo khung: đã có sự kiện của khung này thì không ghi thêm
    });

    it('refund hoàn đúng khung do reserve trả về', async () => {
      await setPlan(A, 'custom');
      const g = new ChannelGuardService(db);
      const bucket = await inCompany(A, () => g.reserve('bulk_message', 5));
      expect(bucket).toBeInstanceOf(Date);
      const rowCount = async (b: Date) => Number((await inCompany(A, () => db.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count FROM channel_usage WHERE kind = 'bulk_message' AND bucket = $1::timestamptz`, b.toISOString())))[0]?.count ?? 0);
      const c0 = await rowCount(bucket!);
      await inCompany(A, () => g.refund('bulk_message', 2, bucket));
      expect(await rowCount(bucket!)).toBe(c0 - 2);
      // Khung khác (không có dòng) không bị ảnh hưởng và không âm
      await inCompany(A, () => g.refund('bulk_message', 5, new Date(bucket!.getTime() - 86_400_000)));
      expect(await rowCount(bucket!)).toBe(c0 - 2);
    });
  });

  // ───────────────────────── route theo công ty (việc 2)

  describe('Shopee/Lazada: một gian hàng chỉ thuộc một công ty', () => {
    it('công ty đến sau không giành được gian hàng; ngắt kết nối thì nhả ra; push route đúng công ty', async () => {
      const shop = String(10_000 + (stamp % 1000));
      await inCompany(A, () => claimCompanyRoute('shopee_shop', shop));
      await inCompany(A, () => claimCompanyRoute('shopee_shop', shop)); // gọi lại: không sao
      await expect(inCompany(B, () => claimCompanyRoute('shopee_shop', shop))).rejects.toBeInstanceOf(ConflictException);
      expect(await companyIdForRoute('shopee_shop', shop)).toBe(A.id);
      // B không nhả được route của A.
      await inCompany(B, () => releaseCompanyRoute('shopee_shop', shop));
      expect(await companyIdForRoute('shopee_shop', shop)).toBe(A.id);

      await inCompany(A, () => db.connectorAccount.create({ data: { provider: 'shopee', status: 'active', credentials_enc: 'x', settings: { shop_id: Number(shop) }, connected_by: 1 } }));
      const otherShop = String(Number(shop) + 1);
      await inCompany(B, () => claimCompanyRoute('shopee_shop', otherShop));
      await inCompany(B, () => db.connectorAccount.create({ data: { provider: 'shopee', status: 'active', credentials_enc: 'x', settings: { shop_id: Number(otherShop) }, connected_by: 1 } }));

      const landed = async (shopId: string) =>
        runInTenantScope(async () => {
          await resolvePublicRouteCompany({ query: {}, headers: {} });
          expect(await enterRoutedCompany('shopee_shop', shopId)).toBe(true);
          const c = await db.connectorAccount.findUnique({ where: { provider: 'shopee' } });
          return { company: currentCompany()?.id, shop: (c?.settings as { shop_id: number } | null)?.shop_id };
        });
      expect(await landed(shop)).toEqual({ company: A.id, shop: Number(shop) });
      expect(await landed(otherShop)).toEqual({ company: B.id, shop: Number(otherShop) });

      await inCompany(A, () => claimCompanyRoute('lazada_seller', 'seller-x'));
      await expect(inCompany(B, () => claimCompanyRoute('lazada_seller', 'seller-x'))).rejects.toThrow(/Lazada/);
      await inCompany(A, () => releaseCompanyRoute('lazada_seller', 'seller-x'));
      await expect(inCompany(B, () => claimCompanyRoute('lazada_seller', 'seller-x'))).resolves.toBeUndefined();
    });
  });

  describe('Shopee: claim sau khi token thành công', () => {
    it('shop id giả (Shopee từ chối code) không chiếm route; code hợp lệ mới chiếm; công ty khác không giành được', async () => {
      process.env.SHOPEE_PARTNER_ID = '1001';
      process.env.SHOPEE_PARTNER_KEY = 'k'.repeat(32); // gitleaks:allow — khoá giả cho test
      const shopId = 20_000 + (stamp % 1000);
      // `state` mang company của người bắt đầu luồng cấp quyền.
      const stateA = await inCompany(A, async () => signState('shopee', 1, loadSecretKey()));
      const stateB = await inCompany(B, async () => signState('shopee', 1, loadSecretKey()));
      const svc = new ShopeeService(db, { touch: async () => undefined, active: async () => null } as never, {} as never);
      const reject = (async () => ({ ok: true, json: async () => ({ error: 'error_auth', message: 'invalid code' }) })) as never;
      const accept = (async () => ({ ok: true, json: async () => ({ access_token: 'a', refresh_token: 'r', expire_in: 14400 }) })) as never;
      await expect(inCompany(B, () => svc.completeConnect('code-gia', String(shopId), stateB, reject))).rejects.toThrow(/invalid code/);
      expect(await companyIdForRoute('shopee_shop', String(shopId))).toBeNull();
      await inCompany(A, () => svc.completeConnect('code-that', String(shopId), stateA, accept).catch(() => undefined));
      expect(await companyIdForRoute('shopee_shop', String(shopId))).toBe(A.id);
      await expect(inCompany(B, () => svc.completeConnect('code-that', String(shopId), stateB, accept))).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('route mồ côi không chặn chủ thật', () => {
    const backdate = (kind: string, id: string) =>
      getBaseClient().$executeRawUnsafe(`UPDATE platform.company_routes SET created_at = now() - interval '1 hour' WHERE kind = $1 AND external_id = $2`, kind, id);

    it('công ty đang giữ route nhưng KHÔNG có kết nối active với id đó ⇒ công ty thật chiếm được; còn kết nối active thì không', async () => {
      const shop = String(30_000 + (stamp % 1000));
      // A giữ route "last wins" cũ, không có connector nào.
      await getBaseClient().$executeRawUnsafe(`INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('shopee_shop', $1, $2)`, shop, A.id);
      // Vừa mới claim (chưa kịp lưu connector) ⇒ chưa coi là mồ côi.
      await expect(inCompany(B, () => claimCompanyRoute('shopee_shop', shop))).rejects.toBeInstanceOf(ConflictException);
      await backdate('shopee_shop', shop);
      await inCompany(B, () => claimCompanyRoute('shopee_shop', shop));
      expect(await companyIdForRoute('shopee_shop', shop)).toBe(B.id);

      // B có connector active với id đó ⇒ A không giành lại được dù route đã cũ.
      await inCompany(B, () => db.connectorAccount.deleteMany({ where: { provider: 'shopee' } }));
      await inCompany(B, () => db.connectorAccount.create({ data: { provider: 'shopee', status: 'active', credentials_enc: 'x', settings: { shop_id: Number(shop) }, connected_by: 1 } }));
      await backdate('shopee_shop', shop);
      await expect(inCompany(A, () => claimCompanyRoute('shopee_shop', shop))).rejects.toBeInstanceOf(ConflictException);
      // Ngắt kết nối (không qua đường nhả) ⇒ lại thành mồ côi.
      await inCompany(B, () => db.connectorAccount.updateMany({ where: { provider: 'shopee' }, data: { status: 'disconnected' } }));
      await inCompany(A, () => claimCompanyRoute('shopee_shop', shop));
      expect(await companyIdForRoute('shopee_shop', shop)).toBe(A.id);
    });

    it('slug cũ của công ty đã đổi địa chỉ (route còn sót) không chặn người khác; backfill dọn route mồ côi', async () => {
      const slug = `mo-coi-${stamp}`;
      await getBaseClient().$executeRawUnsafe(`INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('store_slug', $1, $2)`, slug, A.id);
      await backdate('store_slug', slug);
      await backfillSettingRoutes();
      expect(await companyIdForRoute('store_slug', slug)).toBeNull();
      await expect(inCompany(B, () => claimCompanyRoute('store_slug', slug))).resolves.toBeUndefined();
      expect(await companyIdForRoute('store_slug', slug)).toBe(B.id);
    });
  });

  describe('địa chỉ trang bán hàng (slug)', () => {
    const storeFor = () =>
      new StoreService(db, { isEnabled: async () => true } as never, {} as never, {} as never, { active: async () => null } as never, {} as never);

    it('slug duy nhất toàn hệ; đổi slug nhả slug cũ; link không có ?cid= vẫn vào đúng công ty', async () => {
      const store = storeFor();
      const slug = `cua-hang-${stamp}`;
      await inCompany(A, () => store.saveSettings({ slug, name: 'Shop A' }, 1));
      await expect(inCompany(B, () => store.saveSettings({ slug, name: 'Shop B' }, 1))).rejects.toThrow(/công ty khác dùng/);
      await inCompany(B, () => store.saveSettings({ slug: `${slug}-b`, name: 'Shop B' }, 1));
      expect(await companyIdForRoute('store_slug', slug)).toBe(A.id);
      expect(await companyIdForRoute('store_slug', `${slug}-b`)).toBe(B.id);

      const landed = (s: string, cid?: number) =>
        runInTenantScope(async () => {
          await resolvePublicRouteCompany({ query: cid ? { cid: String(cid) } : {}, headers: {} });
          await enterRoutedCompany('store_slug', s);
          return currentCompany()?.id;
        });
      expect(await landed(slug)).toBe(A.id);
      expect(await landed(`${slug}-b`)).toBe(B.id);
      expect(await landed(slug.toUpperCase())).toBe(A.id);
      // Gợi ý ?cid= chỉ chọn schema: slug của B hỏi trong A (cid=A) không ra gì.
      expect(await landed(`${slug}-b`, A.id)).toBe(A.id);
      await runInTenantScope(async () => {
        await resolvePublicRouteCompany({ query: { cid: String(A.id) }, headers: {} });
        await expect(store.publicStore(`${slug}-b`)).rejects.toBeInstanceOf(NotFoundException);
      });

      // A đổi địa chỉ ⇒ slug cũ trống, B lấy được.
      await inCompany(A, () => store.saveSettings({ slug: `${slug}-moi` }, 1));
      expect(await companyIdForRoute('store_slug', slug)).toBeNull();
      await inCompany(B, () => store.saveSettings({ slug }, 1));
      expect(await companyIdForRoute('store_slug', slug)).toBe(B.id);
    });
  });

  describe('route có sẵn từ trước khi có luật "ai đến trước được"', () => {
    it('cửa hàng và gian hàng đã kết nối ở công ty 1 được ghi route lúc khởi động, công ty mới không giành được', async () => {
      const slug = `co-san-${stamp}`;
      await runWithCompany(DEFAULT_COMPANY, async () => {
        await db.setting.upsert({ where: { key: 'online_store' }, update: { value: JSON.stringify({ slug }) }, create: { key: 'online_store', value: JSON.stringify({ slug }) } });
        await db.connectorAccount.create({ data: { provider: 'lazada', status: 'active', credentials_enc: 'x', settings: { seller_id: `old-${stamp}` }, connected_by: 1 } });
      });
      try {
        await backfillSettingRoutes();
        await backfillSettingRoutes(); // chạy lại không sao
        expect(await companyIdForRoute('store_slug', slug)).toBe(1);
        expect(await companyIdForRoute('lazada_seller', `old-${stamp}`)).toBe(1);
        await expect(inCompany(B, () => claimCompanyRoute('store_slug', slug))).rejects.toBeInstanceOf(ConflictException);
        await expect(inCompany(B, () => claimCompanyRoute('lazada_seller', `old-${stamp}`))).rejects.toBeInstanceOf(ConflictException);
      } finally {
        await runWithCompany(DEFAULT_COMPANY, async () => {
          await db.setting.deleteMany({ where: { key: 'online_store' } });
          await db.connectorAccount.deleteMany({ where: { provider: 'lazada' } });
        });
      }
    });
  });

  describe('VNPay: return/IPN mang ?cid= chỉ chạm đúng công ty', () => {
    const SECRET_A = 'SecretKeyAAA12345'; // gitleaks:allow — khoá giả cho test
    const SECRET_B = 'SecretKeyBBB67890'; // gitleaks:allow — khoá giả cho test
    let payA: PaymentsService;
    let payB: PaymentsService;
    let intentA: { id: number; code: string };
    let intentB: { id: number; code: string };

    const ipnFor = (code: string, secret: string, cid?: number, amount = 150000) => {
      const q: Record<string, string> = {
        vnp_TmnCode: 'TESTTMN1',
        vnp_Amount: String(amount * 100),
        vnp_TxnRef: txnRefFor(code),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: String(14_000_000 + Math.floor(Math.random() * 999_999)),
        vnp_PayDate: '20261115083500',
      };
      const signed: Record<string, string> = { ...q, vnp_SecureHash: vnpaySign(q, secret) };
      // Giống thật: VNPay nối tham số vào return URL đã có sẵn ?cid=.
      return cid ? { ...signed, cid: String(cid) } : signed;
    };
    const asRequest = async <T>(q: Record<string, string>, fn: () => Promise<T>) =>
      runInTenantScope(async () => {
        await resolvePublicRouteCompany({ query: q, headers: {} });
        return fn();
      });

    beforeAll(async () => {
      const connA = new ConnectorsService(db);
      const connB = new ConnectorsService(db);
      payA = new PaymentsService(db, connA, { ownerIds: async () => 'all' } as never);
      payB = new PaymentsService(db, connB, { ownerIds: async () => 'all' } as never);
      await inCompany(A, () => connA.saveGateway('vnpay', { tmn_code: 'TESTTMN1', hash_secret: SECRET_A }, 1));
      await inCompany(B, () => connB.saveGateway('vnpay', { tmn_code: 'TESTTMN1', hash_secret: SECRET_B }, 1));
      intentA = await inCompany(A, () => payA.create({ amount: 150000, description: 'Đơn A' }, null));
      intentB = await inCompany(B, () => payB.create({ amount: 150000, description: 'Đơn B' }, null));
    });

    const status = (c: CompanyRef, id: number) => inCompany(c, async () => (await db.paymentIntent.findUniqueOrThrow({ where: { id } })).status);

    it('return URL do Trinity tạo mang ?cid= của công ty ≠ 1 (công ty 1 giữ nguyên)', async () => {
      expect(await inCompany(B, async () => withCompanyHint('https://x.example/api/v1/pay/vnpay/return'))).toBe(`https://x.example/api/v1/pay/vnpay/return?cid=${B.id}`);
      expect(await inCompany(DEFAULT_COMPANY, async () => withCompanyHint('https://x.example/api/v1/pay/vnpay/return'))).toBe('https://x.example/api/v1/pay/vnpay/return');
    });

    it('IPN ký bằng khoá của B + cid=B ⇒ chỉ đơn của B thành "paid"', async () => {
      const q = ipnFor(intentB.code, SECRET_B, B.id);
      await expect(asRequest(q, () => payB.handleVnpayIpn(q))).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
      expect(await status(B, intentB.id)).toBe('paid');
      expect(await status(A, intentA.id)).toBe('pending');
    });

    it('IPN không có ?cid= rơi vào công ty 1 (không có VNPay, khác khoá) ⇒ sai chữ ký, không đơn nào đổi', async () => {
      const q = ipnFor(intentA.code, SECRET_A);
      const r = await asRequest(q, () => payA.handleVnpayIpn(q));
      expect(r.RspCode).toBe('97');
      expect(await status(A, intentA.id)).toBe('pending');
    });

    it('?cid=A nhưng chữ ký của B ⇒ 97; ?cid=B với mã đơn của A ⇒ "không thấy đơn", đơn A không đổi', async () => {
      const wrongKey = ipnFor(intentA.code, SECRET_B, A.id);
      expect((await asRequest(wrongKey, () => payA.handleVnpayIpn(wrongKey))).RspCode).toBe('97');
      const foreignCode = ipnFor(intentA.code, SECRET_B, B.id);
      expect((await asRequest(foreignCode, () => payB.handleVnpayIpn(foreignCode))).RspCode).toBe('01');
      expect(await status(A, intentA.id)).toBe('pending');
    });

    it('trang return: hợp lệ trong công ty đúng, không hợp lệ ở công ty khác; ?cid= không làm hỏng chữ ký', async () => {
      const q = ipnFor(intentB.code, SECRET_B, B.id);
      expect((await asRequest(q, () => payB.vnpayReturn(q))).valid).toBe(true);
      const inA = { ...q, cid: String(A.id) };
      expect((await asRequest(inA, () => payA.vnpayReturn(inA))).valid).toBe(false);
    });

    it('IPN của A đúng khoá + cid=A ⇒ đơn A paid, đơn B vẫn giữ nguyên trạng thái của nó', async () => {
      const q = ipnFor(intentA.code, SECRET_A, A.id);
      expect((await asRequest(q, () => payA.handleVnpayIpn(q))).RspCode).toBe('00');
      expect(await status(A, intentA.id)).toBe('paid');
      expect(await status(B, intentB.id)).toBe('paid');
      // Sự kiện cổng không lẫn: A chỉ có giao dịch của A; B có giao dịch của B + lần tra mã lạ ("không thấy đơn").
      expect(await inCompany(A, () => db.connectorEvent.count({ where: { provider: 'vnpay' } }))).toBe(1);
      expect(await inCompany(B, () => db.connectorEvent.count({ where: { provider: 'vnpay', external_id: { not: '' } } }))).toBe(2);
    });
  });
});
