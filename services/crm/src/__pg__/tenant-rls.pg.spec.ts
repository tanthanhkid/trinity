import { PrismaClient } from '@prisma/client';
import { runWithTenant, withTenantRls, type PrismaService } from '@trinity/prisma';
import { describePg, PG_URL, pgClient } from './pg-harness';
import { scanStale } from '../stale-work/stale-work.scan';
import { DEFAULT_STALE_CONFIG } from '../stale-work/stale-work.config';
import { DashboardTrendService } from '../reports/dashboard-trend.service';
import { LeadScoringService } from '../lead-scoring/lead-scoring.service';
import { RecordRefsService } from '../custom-objects/refs/record-refs.service';

/**
 * SPIKE RLS (migration 0016): hai khách thuê A, B trên CÙNG một DB.
 * App chạy bằng role thường (không superuser, không BYPASSRLS) + extension `withTenantRls`; DB tự chặn bằng policy.
 * Kiểm: A không đọc/sửa/xoá/gắn được dữ liệu B qua Prisma lẫn mọi câu SQL viết tay chạm contacts/activities/deals/
 * facebook_*; thiếu tenant ⇒ 0 dòng + ghi bị chặn; webhook tra tenant theo page_id.
 * Test âm (có răng): tắt RLS ⇒ bộ dò rò rỉ phải bắt được rò. `RLS_NEGATIVE=1` tắt RLS cho CẢ file ⇒ các test cách ly phải đỏ.
 */
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const APP_ROLE = 'trinity_rls_app';
const APP_PW = 'rls-test-only';
const RLS_TABLES = ['contacts', 'activities', 'deals', 'facebook_pages', 'facebook_conversations', 'facebook_messages'];
const NEGATIVE = process.env.RLS_NEGATIVE === '1';

function appUrl(): string {
  const u = new URL(PG_URL);
  u.username = APP_ROLE;
  u.password = APP_PW;
  u.searchParams.set('connection_limit', '5');
  return u.toString();
}

describePg('RLS nhiều khách thuê trên Postgres thật', () => {
  let admin: PrismaService;
  let appBase: PrismaClient;
  let app: PrismaService;
  const ids = { userA: 0, userB: 0, contactA: 0, contactB: 0, dealA: 0, dealB: 0, convA: 0, convB: 0 };
  const asA = <T>(fn: () => Promise<T>) => runWithTenant(A, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenant(B, fn);

  async function setRls(on: boolean): Promise<void> {
    for (const t of RLS_TABLES) await admin.$executeRawUnsafe(`ALTER TABLE "${t}" ${on ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`);
  }

  beforeAll(async () => {
    admin = pgClient();
    const [me] = await admin.$queryRaw<{ ok: boolean }[]>`SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`;
    if (!me?.ok) throw new Error('TEST_DATABASE_URL phải là role admin (superuser/BYPASSRLS) — role của migration');
    // Role app: KHÔNG superuser, KHÔNG BYPASSRLS. Cấp quyền như role app thật (xem docs/multi-tenant-rls.md).
    await admin.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await admin.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await admin.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION trinity_tenant_for_facebook_page(text) TO ${APP_ROLE}`);

    await admin.$executeRawUnsafe(
      `TRUNCATE facebook_messages, facebook_conversations, facebook_pages, deals, activities, contacts, users RESTART IDENTITY CASCADE`,
    );
    await admin.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ('${A}', '${B}')`);
    await admin.$executeRawUnsafe(`INSERT INTO tenants (id, slug, name) VALUES ('${A}', 'rls-a', 'Khách A'), ('${B}', 'rls-b', 'Khách B')`);

    appBase = new PrismaClient({ datasources: { db: { url: appUrl() } } });
    app = withTenantRls(appBase) as unknown as PrismaService;

    // users chưa có tenant_id (ngoài phạm vi spike) — tạo bằng admin.
    ids.userA = (await admin.user.create({ data: { email: 'a@rls.test', password_hash: 'x', full_name: 'Sale A' } })).id;
    ids.userB = (await admin.user.create({ data: { email: 'b@rls.test', password_hash: 'x', full_name: 'Sale B' } })).id;

    // Dữ liệu tạo QUA APP trong ngữ cảnh tenant — không truyền tenant_id, DB tự điền.
    const old = new Date(Date.now() - 40 * 86_400_000);
    const remind = new Date(Date.now() - 5 * 3_600_000);
    for (const [t, user, key] of [[A, ids.userA, 'A'], [B, ids.userB, 'B']] as const) {
      await runWithTenant(t, async () => {
        const c = await app.contact.create({ data: { phone: `09000000${key === 'A' ? 1 : 2}`, full_name: `Trùng Tên ${key}`, assigned_to: user, created_by_id: user, created_at: old, reminder_at: remind } });
        const d = await app.deal.create({ data: { title: `Trùng deal ${key}`, assigned_to: user, created_by: user, contact_id: c.id, updated_at: old } });
        await app.activity.create({ data: { contact_id: c.id, action: 'note', created_at: old } });
        await app.facebookPage.create({ data: { page_id: `page-${key}`, name: `Page ${key}`, token_enc: 'x', default_assignee_id: user, contact_source_id: 1, connected_by: user } });
        const conv = await app.facebookConversation.create({ data: { page_id: `page-${key}`, psid: 'psid-1', contact_id: c.id } });
        await app.facebookMessage.create({ data: { conversation_id: conv.id, mid: `mid-${key}`, direction: 'in', text: `xin chào từ ${key}` } });
        if (key === 'A') Object.assign(ids, { contactA: c.id, dealA: d.id, convA: conv.id });
        else Object.assign(ids, { contactB: c.id, dealB: d.id, convB: conv.id });
      });
    }
    if (NEGATIVE) await setRls(false);
  });

  afterAll(async () => {
    if (NEGATIVE) await setRls(true);
    await appBase?.$disconnect();
    await admin?.$disconnect();
  });

  it('dữ liệu tạo qua app mang đúng tenant (DEFAULT trinity_current_tenant())', async () => {
    const rows = await admin.$queryRaw<{ id: number; tenant_id: string }[]>`SELECT id, tenant_id::text FROM contacts ORDER BY id`;
    expect(rows).toEqual([{ id: ids.contactA, tenant_id: A }, { id: ids.contactB, tenant_id: B }]);
  });

  /** Mọi đường đọc của A — trả danh sách chỗ thấy dữ liệu B (rỗng = cách ly đúng). Dùng chung cho test âm. */
  async function leaksForA(): Promise<string[]> {
    const out: string[] = [];
    const flag = (name: string, bad: boolean) => bad && out.push(name);
    await asA(async () => {
      flag('contact.findMany', (await app.contact.findMany()).some((c) => c.id === ids.contactB));
      flag('contact.findUnique(B)', !!(await app.contact.findUnique({ where: { id: ids.contactB } })));
      flag('deal.count', (await app.deal.count()) !== 1);
      flag('activity.findMany', (await app.activity.findMany()).some((a) => a.contact_id === ids.contactB));
      flag('facebookConversation(B)', !!(await app.facebookConversation.findUnique({ where: { page_id_psid: { page_id: 'page-B', psid: 'psid-1' } } })));
      flag('facebookMessage.findMany', (await app.facebookMessage.findMany()).some((m) => m.mid === 'mid-B'));
      flag('facebookPage.findMany', (await app.facebookPage.findMany()).length !== 1);
      flag('$queryRaw contacts', (await app.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contacts`)[0].n !== 1);
      flag('$transaction(fn)', (await app.$transaction(async (tx) => tx.contact.count())) !== 1);
      flag('$transaction([...])', (await app.$transaction([app.contact.count(), app.deal.count()])).some((n) => n !== 1));
      // SQL viết tay trong code thật chạm các bảng này:
      const stale = await scanStale(app, DEFAULT_STALE_CONFIG, new Date());
      flag('scanStale (raw contacts+activities)', stale.has(ids.userB));
      const trend = new DashboardTrendService(app, {} as never, {} as never) as unknown as {
        fetchInterestDays(o: 'all', s: Date, e: Date): Promise<{ cnt: bigint }[]>;
      };
      const days = await trend.fetchInterestDays('all', new Date(Date.now() - 60 * 86_400_000), new Date());
      flag('dashboard fetchInterestDays (raw contacts)', days.reduce((s, r) => s + Number(r.cnt), 0) !== 1);
      const refs = new RecordRefsService(app, {} as never) as unknown as {
        searchName(acc: unknown, q: string, n: number): Promise<{ type: string; id: number }[]>;
      };
      const acc = { user: {}, objects: new Map(), recordOwners: null, contactOwners: 'all', dealOwners: 'all', kanban: null };
      const found = await refs.searchName(acc, 'Trùng', 20);
      flag('record-refs searchName (raw contacts/deals)', found.some((r) => (r.type === 'contact' && r.id === ids.contactB) || (r.type === 'deal' && r.id === ids.dealB)));
    });
    return out;
  }

  it('A không đọc được dữ liệu B — Prisma, $queryRaw, transaction, và các câu SQL viết tay trong code', async () => {
    expect(await leaksForA()).toEqual([]);
    expect(await asB(async () => (await app.contact.findMany()).map((c) => c.id))).toEqual([ids.contactB]);
  });

  it('A không sửa/xoá được dữ liệu B (Prisma + SQL viết tay của lead-scoring)', async () => {
    await asA(async () => {
      await expect(app.contact.update({ where: { id: ids.contactB }, data: { full_name: 'hack' } })).rejects.toMatchObject({ code: 'P2025' });
      expect((await app.contact.updateMany({ where: { id: ids.contactB }, data: { full_name: 'hack' } })).count).toBe(0);
      expect((await app.deal.deleteMany({ where: { id: ids.dealB } })).count).toBe(0);
      expect((await app.facebookMessage.deleteMany({})).count).toBe(1); // chỉ xoá được tin của chính A
      expect(await app.$executeRaw`UPDATE contacts SET full_name = 'hack' WHERE id = ${ids.contactB}`).toBe(0);
      const scoring = new LeadScoringService(app, {} as never) as unknown as { write(id: number, s: number, l: string, r: unknown, now: Date): Promise<void> };
      await scoring.write(ids.contactB, 99, 'hot', [], new Date());
    });
    const b = await admin.contact.findUniqueOrThrow({ where: { id: ids.contactB } });
    expect(b.full_name).toBe('Trùng Tên B');
    expect(b.lead_score).toBeNull();
    expect(await admin.deal.count({ where: { id: ids.dealB } })).toBe(1);
    expect(await admin.facebookMessage.count({ where: { mid: 'mid-B' } })).toBe(1);
  });

  it('A không ghi dữ liệu mang tenant B, không gắn activity/deal vào khách của B (FK cùng tenant)', async () => {
    await asA(async () => {
      await expect(app.contact.create({ data: { phone: '0999', tenant_id: B } })).rejects.toThrow(/row-level security/);
      await expect(app.contact.update({ where: { id: ids.contactA }, data: { tenant_id: B } })).rejects.toThrow(/row-level security/);
      await expect(app.activity.create({ data: { contact_id: ids.contactB, action: 'note' } })).rejects.toThrow();
      await expect(app.deal.create({ data: { title: 'x', assigned_to: ids.userA, created_by: ids.userA, contact_id: ids.contactB } })).rejects.toThrow();
    });
    expect(await admin.activity.count({ where: { contact_id: ids.contactB } })).toBe(1);
  });

  it('thiếu tenant ⇒ 0 dòng và ghi bị chặn (fail closed), kể cả kết nối pool từng mang tenant', async () => {
    // Pool 1 kết nối: kết nối vừa chạy transaction có SET LOCAL, sau đó biến còn lại là '' chứ không phải NULL.
    const u = new URL(appUrl());
    u.searchParams.set('connection_limit', '1');
    const oneBase = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    const one = withTenantRls(oneBase) as unknown as PrismaService;
    try {
      expect(await runWithTenant(A, () => one.contact.count())).toBe(1); // callback KHÔNG async: PrismaPromise lười vẫn chạy trong tenant
      expect(await one.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS v`).toEqual([{ v: '' }]);
      expect(await one.contact.count()).toBe(0);
      expect(await one.facebookMessage.findMany()).toEqual([]);
      expect(await one.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM deals`).toEqual([{ n: 0 }]);
      await expect(one.contact.create({ data: { phone: '0988' } })).rejects.toThrow();
      expect(await one.$queryRaw<{ t: string | null }[]>`SELECT trinity_current_tenant()::text AS t`).toEqual([{ t: null }]);
      expect(await runWithTenant(null, () => one.deal.count())).toBe(0);
    } finally {
      await oneBase.$disconnect();
    }
  });

  it('webhook: tra tenant theo page_id (hàm SECURITY DEFINER) rồi ghi tin vào đúng tenant', async () => {
    const [{ t }] = await app.$queryRaw<{ t: string | null }[]>`SELECT trinity_tenant_for_facebook_page(${'page-B'})::text AS t`;
    expect(t).toBe(B);
    await runWithTenant(t, () => app.facebookMessage.create({ data: { conversation_id: ids.convB, mid: 'mid-B-2', direction: 'in', text: 'webhook' } }));
    expect(await asA(() => app.facebookMessage.count({ where: { mid: 'mid-B-2' } }))).toBe(0);
    expect(await asB(() => app.facebookMessage.count({ where: { mid: 'mid-B-2' } }))).toBe(1);
    const [{ t: none }] = await app.$queryRaw<{ t: string | null }[]>`SELECT trinity_tenant_for_facebook_page(${'khong-co'})::text AS t`;
    expect(none).toBeNull();
  });

  (NEGATIVE ? it.skip : it)('test âm: tắt RLS ⇒ bộ dò rò rỉ bắt được rò (chứng minh test có răng)', async () => {
    await setRls(false);
    try {
      const leaks = await leaksForA();
      expect(leaks).toEqual(expect.arrayContaining(['contact.findMany', 'scanStale (raw contacts+activities)', 'dashboard fetchInterestDays (raw contacts)', 'record-refs searchName (raw contacts/deals)']));
    } finally {
      await setRls(true);
    }
  });

  (NEGATIVE ? it.skip : it)('đo chi phí: lệnh lẻ qua extension (BEGIN + set_config + lệnh + COMMIT) so với client thường', async () => {
    const N = Number(process.env.RLS_BENCH_N ?? 300);
    const plain = new PrismaClient({ datasources: { db: { url: PG_URL } } }); // role admin: không RLS, không bọc
    try {
      const run = async (label: string, fn: () => Promise<unknown>) => {
        for (let i = 0; i < 30; i++) await fn(); // làm nóng
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < N; i++) await fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
        return { label, ms: Math.round(ms * 1000) / 1000 };
      };
      // Mốc: role admin bỏ qua RLS, client không extension.
      const base = await run('client thường (1 lệnh)', () => plain.contact.findFirst({ where: { id: ids.contactA } }));
      const rls = await run('extension RLS (1 lệnh)', () => asA(() => app.contact.findFirst({ where: { id: ids.contactA } })));
      const req5 = async (db: PrismaService | PrismaClient, wrap: boolean) => {
        const go = async () => { await db.contact.findFirst({ where: { id: ids.contactA } }); await db.deal.count(); await db.activity.findMany({ take: 5 }); await db.facebookConversation.findMany({ take: 5 }); await db.facebookMessage.count(); };
        return wrap ? asA(go) : go();
      };
      const base5 = await run('client thường (request 5 lệnh)', () => req5(plain, false));
      const rls5 = await run('extension RLS (request 5 lệnh)', () => req5(app, true));
      const rlsTx = await run('extension RLS (request 5 lệnh, 1 transaction)', () => asA(() => app.$transaction(async (tx) => { await tx.contact.findFirst({ where: { id: ids.contactA } }); await tx.deal.count(); await tx.activity.findMany({ take: 5 }); await tx.facebookConversation.findMany({ take: 5 }); await tx.facebookMessage.count(); })));
      // eslint-disable-next-line no-console
      console.log('RLS bench (ms/lần, N=%d):\n%s', N, [base, rls, base5, rls5, rlsTx].map((r) => `  ${r.label}: ${r.ms}`).join('\n'));
      expect(rls.ms).toBeGreaterThan(0);
    } finally {
      await plain.$disconnect();
    }
  }, 120_000);
});
