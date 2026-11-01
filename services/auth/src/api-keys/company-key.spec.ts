import { createHash } from 'crypto'
import { UnauthorizedException } from '@nestjs/common'
import { activeCompanyRef, companyRef, currentCompanyId, runInTenantScope, runWithCompany } from '@trinity/prisma'
import { ApiKeysService } from './api-keys.service'

jest.mock('@trinity/prisma', () => ({ ...jest.requireActual('@trinity/prisma'), activeCompanyRef: jest.fn() }))

const sha = (v: string) => createHash('sha256').update(v).digest('hex')
const ACTIVE = new Set([1, 5, 7])

describe('API keys — company prefix (multi-tenant)', () => {
  const env = { ...process.env }
  beforeAll(() => {
    process.env.MULTI_TENANT = 'true'
  })
  afterAll(() => {
    process.env = env
  })
  beforeEach(() => {
    ;(activeCompanyRef as jest.Mock).mockImplementation(async (id: number) => (ACTIVE.has(id) ? companyRef(id) : null))
  })

  function make(keys: Record<number, string[]>) {
    const seen: Array<number | null> = []
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 3, status: 'active' })) },
      apiKey: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data })),
        findUnique: jest.fn(async ({ where }: { where: { key_hash: string } }) => {
          const id = currentCompanyId()
          seen.push(id)
          const hit = (keys[id ?? 0] ?? []).find((k) => sha(k) === where.key_hash)
          return hit ? { id: 1, name: 'k', scopes: ['contacts:create'], owner_user_id: 3, revoked_at: null, expires_at: null } : null
        }),
        update: jest.fn(async () => ({})),
      },
    }
    const permissions = { grantsFor: jest.fn(async () => ({ grants: { 'contacts.create': true }, isAdmin: false })) }
    return { svc: new ApiKeysService(prisma as never, permissions as never), seen, prisma }
  }

  const validate = (svc: ApiKeysService, key: string) =>
    runInTenantScope(async () => {
      await svc.validate(key, 'contacts:create', null)
      return currentCompanyId()
    })

  it('keys created in company 5 carry c5. and a prefix that fits the column', async () => {
    const { svc } = make({})
    const out = await runWithCompany(companyRef(5), () => svc.create({ name: 'k', scopes: ['contacts:create'], owner_user_id: 3 }, 1))
    expect(out.plain_key.startsWith('c5.trinity_live_')).toBe(true)
    expect(String(out.prefix)).toBe(out.plain_key.slice(0, 'c5.trinity_live_'.length + 6))
    expect(String(out.prefix).length).toBeLessThanOrEqual(32)
  })

  it('keys created in company 1 keep the old format', async () => {
    const { svc } = make({})
    const out = await runWithCompany(companyRef(1), () => svc.create({ name: 'k', scopes: ['contacts:create'], owner_user_id: 3 }, 1))
    expect(out.plain_key.startsWith('trinity_live_')).toBe(true)
    expect(String(out.prefix)).toHaveLength('trinity_live_'.length + 6)
  })

  it('company 5 key → company 5; unprefixed → company 1', async () => {
    const { svc, seen } = make({ 5: ['c5.trinity_live_aaaa'], 1: ['trinity_live_bbbb'] })
    expect(await validate(svc, 'c5.trinity_live_aaaa')).toBe(5)
    expect(await validate(svc, 'trinity_live_bbbb')).toBe(1)
    expect(seen).toEqual([5, 1])
  })

  it('unknown/suspended company → 401 without lookup; rewritten prefix → 401', async () => {
    const { svc, seen } = make({ 5: ['c5.trinity_live_aaaa'] })
    await expect(validate(svc, 'c9.trinity_live_aaaa')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(seen).toEqual([])
    await expect(validate(svc, 'c7.trinity_live_aaaa')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(seen).toEqual([7])
  })
})
