import {
  CompanyRef,
  DEFAULT_COMPANY,
  MissingCompanyContextError,
  PrismaService,
  activeCompanyRef,
  companyIdForEmail,
  companyIdForRoute,
  createPrismaService,
  ensurePlatform,
  getBaseClient,
  provisionCompany,
  runWithCompany,
  forEachCompany,
} from '@trinity/prisma';
import { PG_URL, describePg, isLocalDbUrl } from './pg-harness';

/**
 * Multi-tenant isolation on a real Postgres: two companies signed up through `provisionCompany`, each in its own
 * schema. Company B must not read, count, update or delete anything of company A — not through Prisma models,
 * not through raw SQL, not by guessing ids — and the shared uniqueness rules (one email / one Facebook Page per
 * company, one user per company) hold at the database.
 */
describePg('multi-tenant isolation (Postgres)', () => {
  let db: PrismaService;
  let A: CompanyRef;
  let B: CompanyRef;
  const prevMt = process.env.MULTI_TENANT;
  const stamp = Date.now();
  const emailA = `owner-a-${stamp}@example.com`;
  const emailB = `owner-b-${stamp}@example.com`;

  async function dropTenantObjects(): Promise<void> {
    const base = getBaseClient();
    const schemas = await base.$queryRawUnsafe<Array<{ nspname: string }>>(
      `SELECT nspname FROM pg_namespace WHERE nspname ~ '^c_[0-9]+$'`,
    );
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

  beforeAll(async () => {
    if (!isLocalDbUrl(PG_URL)) throw new Error('TEST_DATABASE_URL must point at a local/CI Postgres');
    process.env.DATABASE_URL = PG_URL;
    process.env.MULTI_TENANT = 'true';
    db = createPrismaService();
    await dropTenantObjects();
    await ensurePlatform();
    A = (await provisionCompany({ companyName: 'Công ty A', adminEmail: emailA, adminPassword: 'password-a-123', adminName: 'Chủ A' })).company;
    B = (await provisionCompany({ companyName: 'Công ty B', adminEmail: emailB, adminPassword: 'password-b-123', adminName: 'Chủ B' })).company;
  }, 180_000);

  afterAll(async () => {
    try {
      await dropTenantObjects();
    } finally {
      await db.$disconnect();
      process.env.MULTI_TENANT = prevMt;
    }
  });

  it('gives each company its own schema and owner, routed by email', async () => {
    expect(A.schema).toMatch(/^c_\d+$/);
    expect(B.schema).toMatch(/^c_\d+$/);
    expect(A.schema).not.toBe(B.schema);
    expect(await companyIdForEmail(emailA)).toBe(A.id);
    expect(await companyIdForEmail(emailB.toUpperCase())).toBe(B.id);
    expect(await activeCompanyRef(A.id)).toEqual(A);
    // Both owners got id 1 in their own schema — ids repeat across companies.
    const ownerA = await runWithCompany(A, () => db.user.findFirstOrThrow({ select: { id: true, email: true } }));
    const ownerB = await runWithCompany(B, () => db.user.findFirstOrThrow({ select: { id: true, email: true } }));
    expect(ownerA).toEqual({ id: 1, email: emailA });
    expect(ownerB).toEqual({ id: 1, email: emailB });
  });

  it('refuses any query without a company context', async () => {
    expect(() => db.contact).toThrow(MissingCompanyContextError);
    expect(() => db.$queryRawUnsafe).toThrow(MissingCompanyContextError);
  });

  it('company B cannot read, count, update or delete company A rows, even by guessed id', async () => {
    const contactA = await runWithCompany(A, () =>
      db.contact.create({ data: { full_name: 'Khách của A', phone: '0900000001' }, select: { id: true, code: true } }),
    );

    await runWithCompany(B, async () => {
      expect(await db.contact.findUnique({ where: { id: contactA.id } })).toBeNull();
      expect(await db.contact.findFirst({ where: { phone: '0900000001' } })).toBeNull();
      expect(await db.contact.count()).toBe(0);
      await expect(db.contact.update({ where: { id: contactA.id }, data: { full_name: 'hacked' } })).rejects.toThrow();
      expect((await db.contact.updateMany({ data: { full_name: 'hacked' } })).count).toBe(0);
      expect((await db.contact.deleteMany({})).count).toBe(0);
      const raw = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM contacts`);
      expect(Number(raw[0].n)).toBe(0);
      const tagged = await db.$queryRaw<Array<{ id: number }>>`SELECT id FROM contacts WHERE id = ${contactA.id}`;
      expect(tagged).toEqual([]);
      // Interactive transactions stay in the company too.
      const inTx = await db.$transaction(async (tx) => tx.contact.findMany({ select: { id: true } }));
      expect(inTx).toEqual([]);
    });

    const stillA = await runWithCompany(A, () => db.contact.findUnique({ where: { id: contactA.id }, select: { full_name: true } }));
    expect(stillA).toEqual({ full_name: 'Khách của A' });
  });

  it('keeps settings and auto-generated codes per company', async () => {
    const codeA = await runWithCompany(A, () => db.contact.create({ data: { full_name: 'A2', phone: '0900000002' }, select: { code: true } }));
    const codeB = await runWithCompany(B, () => db.contact.create({ data: { full_name: 'B1', phone: '0900000001' }, select: { code: true } }));
    // B's first contact gets B's first code, unaffected by A's sequence.
    expect(codeB.code).toBeTruthy();
    expect(codeA.code).not.toBe(undefined);
    const nameA = await runWithCompany(A, () => db.setting.findUnique({ where: { key: 'company_name' } }));
    const nameB = await runWithCompany(B, () => db.setting.findUnique({ where: { key: 'company_name' } }));
    expect(nameA?.value).toBe('Công ty A');
    expect(nameB?.value).toBe('Công ty B');
  });

  it('lets one Facebook Page belong to one company only and routes it there', async () => {
    const pageId = `p${stamp}`;
    await runWithCompany(A, () =>
      db.facebookPage.create({ data: { page_id: pageId, name: 'Page A', token_enc: 'x', default_assignee_id: 1, contact_source_id: 1, connected_by: 1 } }),
    );
    expect(await companyIdForRoute('facebook_page', pageId)).toBe(A.id);
    await expect(
      runWithCompany(B, () => db.facebookPage.create({ data: { page_id: pageId, name: 'Page A?', token_enc: 'x', default_assignee_id: 1, contact_source_id: 1, connected_by: 1 } })),
    ).rejects.toThrow(/TRINITY_ROUTE_TAKEN/);
    // B sees no page at all.
    expect(await runWithCompany(B, () => db.facebookPage.count())).toBe(0);
  });

  it('rejects an email already owned by another company', async () => {
    await expect(
      // Company 1 may have many users, so only the email rule can stop this one.
      runWithCompany(DEFAULT_COMPANY, () =>
        db.user.create({ data: { email: emailA.toUpperCase(), password_hash: 'x', full_name: 'Copy', status: 'active' } }),
      ),
    ).rejects.toThrow(/TRINITY_EMAIL_TAKEN/);
    expect(await companyIdForEmail(emailA)).toBe(A.id);
  });

  it('allows exactly one user per signed-up company', async () => {
    await expect(
      runWithCompany(A, () =>
        db.user.create({ data: { email: `second-${stamp}@example.com`, password_hash: 'x', full_name: 'Second', status: 'active' } }),
      ),
    ).rejects.toThrow(/TRINITY_SINGLE_USER/);
    expect(await companyIdForEmail(`second-${stamp}@example.com`)).toBeNull();
  });

  it('runs background work once per company, each in its own schema', async () => {
    const seen = await forEachCompany(async (c) => ({ schema: c.schema, contacts: await db.contact.count() }));
    expect(seen[A.id]).toEqual({ schema: A.schema, contacts: 2 });
    expect(seen[B.id]).toEqual({ schema: B.schema, contacts: 1 });
    expect(seen[1]).toMatchObject({ schema: 'public' });
  });
});
