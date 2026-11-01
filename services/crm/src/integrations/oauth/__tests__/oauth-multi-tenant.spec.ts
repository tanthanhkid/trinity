import { createHash } from 'node:crypto';
import type { OauthClient } from '@prisma/client';
import { activeCompanyRef, companyRef, currentCompanyId, enterCompany, runInTenantScope } from '@trinity/prisma';
import { OauthTokenService } from '../oauth-token.service';
import { OAuthError } from '../oauth-error';
import { companyIdOfToken, withCompanyPrefix } from '../../../common/helpers/company-token';
import { ApiKeyGuard } from '../../../public-api/api-key.guard';

jest.mock('@trinity/prisma', () => ({ ...jest.requireActual('@trinity/prisma'), activeCompanyRef: jest.fn() }));

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
const ACTIVE = new Set([1, 5, 7]);
const BASE = 'https://crm.example.com';

/** One fake "schema" per company: every lookup records which company the request was bound to. */
function fakeDb(tokens: Record<number, Array<Record<string, unknown>>>, keys: Record<number, Array<Record<string, unknown>>> = {}) {
  const seen: Array<number | null> = [];
  const inCompany = <T>(rows: Record<number, T[]>): T[] => {
    const id = currentCompanyId();
    seen.push(id);
    return id ? rows[id] ?? [] : [];
  };
  const prisma = {
    oauthToken: {
      findUnique: jest.fn(async ({ where }: { where: { access_hash?: string } }) => inCompany(tokens).find((r) => r.access_hash === where.access_hash) ?? null),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: BigInt(9) })),
      update: jest.fn(async () => ({})),
    },
    oauthAuthorizationCode: {
      updateMany: jest.fn(async ({ where }: { where: { code_hash: string } }) => ({ count: inCompany(tokens).some((r) => r.code_hash === where.code_hash) ? 1 : 0 })),
      findUnique: jest.fn(async ({ where }: { where: { code_hash: string } }) => inCompany(tokens).find((r) => r.code_hash === where.code_hash) ?? null),
    },
    user: { findUnique: jest.fn(async () => ({ status: 'active', deleted_at: null, email: 'a@b.c' })) },
    apiKey: {
      findUnique: jest.fn(async ({ where }: { where: { key_hash: string } }) => inCompany(keys).find((r) => r.key_hash === where.key_hash) ?? null),
      update: jest.fn(async () => ({})),
    },
  };
  return { prisma, seen };
}

function tokenRow(raw: string) {
  return { id: BigInt(1), access_hash: sha(raw), revoked_at: null, access_expires_at: new Date(Date.now() + 60_000), resource: `${BASE}/api/v1/mcp`, user_id: 3, client_id: 'trn_c_x', scopes: ['crm.read'], family_id: 'f', last_used_at: new Date() };
}

describe('multi-tenant OAuth / MCP tokens and API keys', () => {
  const env = { ...process.env };
  beforeAll(() => {
    process.env.MULTI_TENANT = 'true';
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = BASE;
    process.env.INTEGRATIONS_MCP_ENABLED = 'true';
  });
  afterAll(() => {
    process.env = env;
  });
  beforeEach(() => {
    (activeCompanyRef as jest.Mock).mockImplementation(async (id: number) => (ACTIVE.has(id) ? companyRef(id) : null));
  });

  it('prefix helpers: company 1 keeps the old format', () => {
    expect(withCompanyPrefix('trn_at_abc', 1)).toBe('trn_at_abc');
    expect(withCompanyPrefix('trn_at_abc', 5)).toBe('c5.trn_at_abc');
    expect(companyIdOfToken('c5.trn_at_abc')).toBe(5);
    expect(companyIdOfToken('trn_at_abc')).toBe(1);
    // base64url never contains '.', so an old unprefixed code that happens to start with "c5" stays company 1.
    expect(companyIdOfToken('c5Zx-abc')).toBe(1);
  });

  const verify = (prisma: unknown, raw: string) =>
    runInTenantScope(async () => {
      const svc = new OauthTokenService(prisma as never, {} as never, {} as never, {} as never);
      const out = await svc.verifyAccessToken(raw);
      return { out, company: currentCompanyId() };
    });

  it('access token of company 5 is looked up in company 5', async () => {
    const raw = 'c5.trn_at_secret';
    const { prisma, seen } = fakeDb({ 5: [tokenRow(raw)] });
    const r = await verify(prisma, raw);
    expect(r.out?.userId).toBe(3);
    expect(r.company).toBe(5);
    expect(seen).toEqual([5]);
  });

  it('unprefixed token (issued before multi-tenancy) → company 1', async () => {
    const raw = 'trn_at_legacy';
    const { prisma, seen } = fakeDb({ 1: [tokenRow(raw)] });
    const r = await verify(prisma, raw);
    expect(r.out?.userId).toBe(3);
    expect(seen[0]).toBe(1);
  });

  it('unknown or suspended company prefix → rejected without any lookup', async () => {
    const { prisma, seen } = fakeDb({});
    expect((await verify(prisma, 'c9.trn_at_secret')).out).toBeNull();
    expect(seen).toEqual([]);
  });

  it("rewriting company 5's token to company 7 finds nothing (looked up in 7's schema)", async () => {
    const raw = 'c5.trn_at_secret';
    const { prisma, seen } = fakeDb({ 5: [tokenRow(raw)], 7: [tokenRow('c7.trn_at_other')] });
    const r = await verify(prisma, 'c7.trn_at_secret');
    expect(r.out).toBeNull();
    expect(seen).toEqual([7]);
  });

  it('a ?cid= hint that disagrees with the token → rejected', async () => {
    const raw = 'c5.trn_at_secret';
    const { prisma } = fakeDb({ 5: [tokenRow(raw)] });
    const out = await runInTenantScope(async () => {
      enterCompany(companyRef(7));
      return new OauthTokenService(prisma as never, {} as never, {} as never, {} as never).verifyAccessToken(raw);
    });
    expect(out).toBeNull();
  });

  describe('/oauth/token', () => {
    const client = { client_id: 'trn_c_x', token_endpoint_auth_method: 'none' } as OauthClient;
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const codeRow = (raw: string) => ({ code_hash: sha(raw), client_id: client.client_id, user_id: 3, redirect_uri: 'https://claude.ai/cb', code_challenge: challenge, scopes: ['crm.read'], resource: `${BASE}/api/v1/mcp`, family_id: 'f', used_at: new Date() });
    const exchange = (prisma: unknown, code: string) =>
      runInTenantScope(async () => {
        const clients = { authenticate: jest.fn(async () => client), touch: jest.fn(async () => undefined) };
        const permissions = { grantsFor: jest.fn(async () => ({ grants: {}, isAdmin: true })) };
        const audit = { log: jest.fn(async () => undefined) };
        const svc = new OauthTokenService(prisma as never, clients as never, permissions as never, audit as never);
        return svc.token({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'https://claude.ai/cb' });
      });

    it('a company 5 code mints company 5 access/refresh tokens', async () => {
      const code = 'c5.codecodecode';
      const { prisma, seen } = fakeDb({ 5: [codeRow(code)] });
      const out = await exchange(prisma, code);
      expect(out.access_token.startsWith('c5.trn_at_')).toBe(true);
      expect(out.refresh_token.startsWith('c5.trn_rt_')).toBe(true);
      expect(seen.every((c) => c === 5)).toBe(true);
    });

    it('a company 1 code keeps the unprefixed format', async () => {
      const code = 'legacycode';
      const { prisma } = fakeDb({ 1: [codeRow(code)] });
      const out = await exchange(prisma, code);
      expect(out.access_token.startsWith('trn_at_')).toBe(true);
    });

    it('unknown company prefix → invalid_grant; rewritten prefix → invalid_grant', async () => {
      const { prisma } = fakeDb({ 5: [codeRow('c5.codecodecode')] });
      await expect(exchange(prisma, 'c9.codecodecode')).rejects.toBeInstanceOf(OAuthError);
      await expect(exchange(prisma, 'c7.codecodecode')).rejects.toMatchObject({ code: 'invalid_grant' });
    });
  });

  describe('public API key guard (crm)', () => {
    const ctx = (key: string) => {
      const req = { headers: { 'x-api-key': key }, ip: '1.2.3.4', socket: {} } as Record<string, unknown>;
      return { req, ctx: { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => req }) } as never };
    };
    const keyRow = (raw: string) => ({ id: 1, name: 'k', scopes: ['contacts:create'], owner_user_id: 3, revoked_at: null, expires_at: null, key_hash: sha(raw) });
    const run = (prisma: unknown, key: string) =>
      runInTenantScope(async () => {
        const guard = new ApiKeyGuard(prisma as never, { getAllAndOverride: () => 'contacts:create' } as never);
        const { req, ctx: c } = ctx(key);
        await guard.canActivate(c);
        return { req, company: currentCompanyId() };
      });

    it('company 5 key → company 5; unprefixed key → company 1', async () => {
      const k5 = 'c5.trinity_live_aaaa';
      const k1 = 'trinity_live_bbbb';
      const { prisma } = fakeDb({}, { 5: [keyRow(k5)], 1: [keyRow(k1)] });
      expect((await run(prisma, k5)).company).toBe(5);
      expect((await run(prisma, k1)).company).toBe(1);
    });

    it('unknown company → 401; rewritten prefix → 401', async () => {
      const k5 = 'c5.trinity_live_aaaa';
      const { prisma } = fakeDb({}, { 5: [keyRow(k5)] });
      await expect(run(prisma, 'c9.trinity_live_aaaa')).rejects.toMatchObject({ status: 401 });
      await expect(run(prisma, 'c7.trinity_live_aaaa')).rejects.toMatchObject({ status: 401 });
    });
  });
});
