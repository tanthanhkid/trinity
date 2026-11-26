import { PrismaService, SyncBus, createPrismaService, getBaseClient, syncBus, runWithCompany, DEFAULT_COMPANY, ensurePlatform, provisionCompany, type CompanyRef, type SyncEnvelope } from '@trinity/prisma';
import { ActiveSessionService, RbacCache, TokenBlacklistService } from '@trinity/rbac-nest';
import { ChannelGuardService } from '../channel-guard/channel-guard.service';
import { ReadCache } from '../common/read-cache';
import { PG_URL, describePg, isLocalDbUrl } from './pg-harness';

/**
 * G12b — đồng bộ giữa hai tiến trình qua Postgres NOTIFY, cho TỪNG kênh mà crm/rbac-nest giữ.
 * "Tiến trình A" = bus của chính tiến trình test (`syncBus`, cùng các service thật nghe trên đó); "tiến trình B" = một
 * `SyncBus` thứ hai có mã nguồn gốc khác, kết nối riêng — đúng như một tiến trình Node/Rust khác. Mỗi ca dưới 2 giây.
 * Kênh `bell` và `payslip` (nằm ở service notification) có test riêng ở `services/notification`.
 */
describePg('G12b: đồng bộ giữa tiến trình qua Postgres NOTIFY', () => {
  let db: PrismaService;
  let B: SyncBus;
  let C2: CompanyRef;
  const prevMt = process.env.MULTI_TENANT;

  /** Chờ tới khi `cond()` đúng (tối đa 2 giây — tiêu chí của issue). */
  async function within2s(cond: () => boolean | Promise<boolean>): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      if (await cond()) return Date.now() - t0;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('quá 2 giây mà chưa đồng bộ');
  }
  function listen(bus: SyncBus, kind: Parameters<SyncBus['on']>[0]): SyncEnvelope[] {
    const got: SyncEnvelope[] = [];
    bus.on(kind, (m) => got.push(m));
    return got;
  }

  beforeAll(async () => {
    if (!isLocalDbUrl(PG_URL)) throw new Error('TEST_DATABASE_URL must point at a local/CI Postgres');
    process.env.DATABASE_URL = PG_URL;
    process.env.MULTI_TENANT = 'false';
    db = createPrismaService();
    await syncBus.start(PG_URL);
    B = new SyncBus('rust-test-b');
    await B.start(PG_URL);
  }, 60_000);

  afterAll(async () => {
    await B.stop();
    await syncBus.stop();
    await db.$disconnect();
    process.env.MULTI_TENANT = prevMt;
  });

  it('kết nối nghe hoạt động và tin của chính mình không dội lại', async () => {
    expect(syncBus.connected).toBe(true);
    const own = listen(syncBus, 'cache');
    await syncBus.publish('cache', { p: 'x:' }, 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(own).toHaveLength(0);
  });

  it('sửa vai trò: A xoá cache quyền thì B nghe được; B báo thì cache quyền của A rụng', async () => {
    const cache = new RbacCache();
    const seenByB = listen(B, 'rbac');
    await runWithCompany(DEFAULT_COMPANY, async () => {
      cache.set('g:5', ['x']);
      cache.set('g:6', ['y']);
      expect(cache.get('g:5')).toBeDefined();
      // B (tiến trình khác) sửa vai trò của user 5
      await B.publish('rbac', { ids: [5] }, 1);
      await within2s(() => cache.get('g:5') === undefined);
      expect(cache.get('g:6')).toBeDefined(); // user khác không bị xoá oan
      // A sửa vai trò của user 6 ⇒ B nhận tin đúng khuôn
      await cache.invalidateUsers([6]);
    });
    await within2s(() => seenByB.length === 1);
    expect(seenByB[0]).toMatchObject({ v: 1, k: 'rbac', c: 1, ids: [6] });
    cache.onModuleDestroy();
  });

  it('đăng xuất: blacklist token và phiên đồng bộ hai chiều', async () => {
    const bl = new TokenBlacklistService();
    const sessions = new ActiveSessionService();
    const tokenAtB = listen(B, 'token');
    const sessionAtB = listen(B, 'session');
    await runWithCompany(DEFAULT_COMPANY, async () => {
      // B đăng xuất user 9 ⇒ A từ chối token của user 9; B mở lại ⇒ A cho qua
      await B.publish('token', { op: 'block', u: 9 }, 1);
      await within2s(() => bl.isBlacklisted(9));
      await B.publish('token', { op: 'unblock', u: 9 }, 1);
      await within2s(() => !bl.isBlacklisted(9));
      // A đăng xuất user 3 ⇒ B nhận
      bl.blacklistUser(3);
      // Phiên: B bắt đầu phiên "s-1" cho user 4 ⇒ A thấy phiên khác là hết hiệu lực
      await B.publish('session', { op: 'start', u: 4, s: 's-1' }, 1);
      await within2s(() => !sessions.isCurrentSession(4, 'khac'));
      expect(sessions.isCurrentSession(4, 's-1')).toBe(true);
      await B.publish('session', { op: 'clear', u: 4 }, 1);
      await within2s(() => sessions.isCurrentSession(4, 'khac'));
      const sid = sessions.startSession(8);
      await within2s(() => sessionAtB.some((m) => m['u'] === 8 && m['s'] === sid));
    });
    await within2s(() => tokenAtB.some((m) => m['op'] === 'block' && m['u'] === 3));
  });

  it('tạo khách (số đếm): vô hiệu theo (công ty, tiền tố) ở hai chiều', async () => {
    const rc = new ReadCache();
    const cacheAtB = listen(B, 'cache');
    rc.set('crm:contacts:count:abc', '41', 60);
    rc.set('dashboard:v1:today:1', '{}', 60);
    rc.set('khac:giu-lai', '1', 60);
    await B.publish('cache', { p: 'crm:contacts:count:' }, 1);
    await within2s(() => rc.get('crm:contacts:count:abc') === undefined);
    expect(rc.get('dashboard:v1:today:1')).toBe('{}');
    await runWithCompany(DEFAULT_COMPANY, async () => {
      rc.invalidatePrefix('dashboard:');
    });
    expect(rc.get('dashboard:v1:today:1')).toBeUndefined();
    await within2s(() => cacheAtB.some((m) => m['p'] === 'dashboard:' && m.c === 1));
    expect(rc.get('khac:giu-lai')).toBe('1');
    rc.onModuleDestroy();
  });

  describe('đa công ty', () => {
    beforeAll(async () => {
      process.env.MULTI_TENANT = 'true';
      await ensurePlatform();
      C2 = (await provisionCompany({ companyName: 'Sync C', adminEmail: `sync-c-${Date.now()}@example.com`, adminPassword: 'password-c-123', adminName: 'Chủ C' })).company;
    }, 120_000);
    afterAll(async () => {
      const base = getBaseClient();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${C2.schema}" CASCADE`);
      process.env.MULTI_TENANT = 'false';
    });

    it('tin của công ty khác không xoá cache của công ty này', async () => {
      const rc = new ReadCache();
      const c1 = DEFAULT_COMPANY;
      rc.set('crm:contacts:count:k', '1', 60); // khoá công ty 1 (không tiền tố)
      rc.set(`c${C2.id}:crm:contacts:count:k`, '2', 60);
      await B.publish('cache', { p: 'crm:contacts:count:' }, C2.id);
      await within2s(() => rc.get(`c${C2.id}:crm:contacts:count:k`) === undefined);
      expect(rc.get('crm:contacts:count:k')).toBe('1');
      expect(c1.id).toBe(1);
      rc.onModuleDestroy();
    });

    it('2 lỗi #368 do B báo ⇒ A tạm dừng gửi tự động; kết quả A ghi cũng tới B', async () => {
      const guard = new ChannelGuardService(db);
      guard.onModuleInit();
      const graphAtB = listen(B, 'graph');
      await expect(runWithCompany(C2, () => guard.autoPause())).resolves.toBeNull();
      const out = { ok: false, h: 400, code: 368, sub: null, send: true };
      await B.publish('graph', out, C2.id);
      await B.publish('graph', out, C2.id);
      await within2s(async () => (await runWithCompany(C2, () => guard.blockReason('auto'))) !== null);
      const r = await runWithCompany(C2, () => guard.blockReason('auto'));
      expect(r?.code).toBe('channel_paused');
      // tin tay vẫn gửi được
      await expect(runWithCompany(C2, () => guard.blockReason('manual'))).resolves.toBeNull();
      // A ghi một kết quả gửi ra ⇒ B nhận đúng khuôn; lời gọi đọc thì không phát
      runWithCompany(C2, () => guard.recordGraph({ ok: false, httpStatus: 400, code: 551, subcode: null, send: true }));
      runWithCompany(C2, () => guard.recordGraph({ ok: true, httpStatus: 200, code: null, subcode: null, send: false }));
      await within2s(() => graphAtB.length >= 1);
      await new Promise((r2) => setTimeout(r2, 100));
      expect(graphAtB).toHaveLength(1);
      expect(graphAtB[0]).toMatchObject({ k: 'graph', c: C2.id, ok: false, h: 400, code: 551, send: true });
      guard.onModuleDestroy();
    });
  });
});
