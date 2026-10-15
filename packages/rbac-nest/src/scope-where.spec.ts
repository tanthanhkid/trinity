import { NotFoundException } from '@nestjs/common'
import { scopeWhere, assertInScope, maskPhone, maskPhoneFor, makePhoneMasker } from './scope-where'
import type { ScopeService } from './scope.service'
import type { AuthUser } from './auth-user'

function mkUser(userId: number): AuthUser {
  return { userId, email: `u${userId}@t`, isAdmin: false, grants: {} }
}

describe('scopeWhere', () => {
  it("owner 'all' → {}", () => {
    expect(scopeWhere('all', ['assigned_to'])).toEqual({})
  })
  it('1 field → { field: { in } }', () => {
    expect(scopeWhere([1, 2], ['assigned_to'])).toEqual({ assigned_to: { in: [1, 2] } })
  })
  it('nhiều field → OR', () => {
    expect(scopeWhere([1, 2], ['assigned_to', 'created_by_id'])).toEqual({
      OR: [{ assigned_to: { in: [1, 2] } }, { created_by_id: { in: [1, 2] } }],
    })
  })
})

describe('assertInScope', () => {
  const user = mkUser(1)

  it("allowed='all' → không throw", async () => {
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') } as unknown as ScopeService
    await expect(assertInScope(scope, user, 'contacts.view', [999])).resolves.toBeUndefined()
  })

  it('owner trong tập cho phép → không throw', async () => {
    const scope = { ownerIds: jest.fn().mockResolvedValue([1, 2]) } as unknown as ScopeService
    await expect(assertInScope(scope, user, 'contacts.view', [null, 2])).resolves.toBeUndefined()
  })

  it('owner ngoài tập cho phép → NotFoundException', async () => {
    const scope = { ownerIds: jest.fn().mockResolvedValue([1, 2]) } as unknown as ScopeService
    await expect(assertInScope(scope, user, 'contacts.view', [999])).rejects.toThrow(
      NotFoundException,
    )
    await expect(assertInScope(scope, user, 'contacts.view', [999])).rejects.toThrow(
      'Không tìm thấy',
    )
  })
})

describe('maskPhone', () => {
  it('giữ 3 số cuối', () => expect(maskPhone('0900000168')).toBe('***168'))
  it('null → null', () => expect(maskPhone(null)).toBeNull())
  it('chuỗi quá ngắn → ***', () => expect(maskPhone('12')).toBe('***'))
})

describe('maskPhoneFor / makePhoneMasker', () => {
  const user = mkUser(1)

  it("allowed='all' → số thật", async () => {
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') } as unknown as ScopeService
    await expect(
      maskPhoneFor(scope, user, 'contacts.phone_full', [2], '0900000168'),
    ).resolves.toBe('0900000168')
  })

  it('owner trong scope → số thật', async () => {
    const scope = { ownerIds: jest.fn().mockResolvedValue([1, 2]) } as unknown as ScopeService
    await expect(
      maskPhoneFor(scope, user, 'contacts.phone_full', [2], '0900000168'),
    ).resolves.toBe('0900000168')
  })

  it('owner ngoài scope → bị che', async () => {
    const scope = { ownerIds: jest.fn().mockResolvedValue([1]) } as unknown as ScopeService
    await expect(
      maskPhoneFor(scope, user, 'contacts.phone_full', [999], '0900000168'),
    ).resolves.toBe('***168')
  })

  it('makePhoneMasker: 1 lần ownerIds, dùng lại cho nhiều dòng', () => {
    const mask = makePhoneMasker([1, 2])
    expect(mask([2], '0900000168')).toBe('0900000168')
    expect(mask([999], '0900000168')).toBe('***168')
    expect(makePhoneMasker('all')([999], '0900000168')).toBe('0900000168')
  })
})
