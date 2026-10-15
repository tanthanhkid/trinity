import { mergeGrants, can, scopeOf, isSubset, normalizeGrant } from './grants'

describe('mergeGrants', () => {
  it('hợp quyền, lấy scope rộng nhất', () => {
    const g = mergeGrants([
      { 'contacts.view': 'own', 'contacts.create': true },
      { 'contacts.view': 'subtree', 'contacts.export': 'team' },
    ])
    expect(g).toEqual({ 'contacts.view': 'subtree', 'contacts.create': true, 'contacts.export': 'team' })
  })
  it('rỗng → rỗng', () => expect(mergeGrants([])).toEqual({}))
})

describe('can / scopeOf', () => {
  const g = { 'contacts.view': 'team', 'contacts.create': true } as const
  it('có quyền', () => expect(can(g, 'contacts.view')).toBe(true))
  it('không có quyền', () => expect(can(g, 'contacts.delete')).toBe(false))
  it('đòi scope tối thiểu', () => {
    expect(can(g, 'contacts.view', 'own')).toBe(true)
    expect(can(g, 'contacts.view', 'all')).toBe(false)
  })
  it('scopeOf quyền không scoped → null', () => expect(scopeOf(g, 'contacts.create')).toBeNull())
  it('scopeOf quyền scoped', () => expect(scopeOf(g, 'contacts.view')).toBe('team'))
})

describe('isSubset', () => {
  const admin = { 'contacts.view': 'all', 'contacts.export': 'all', 'roles.manage': true } as const
  it('con hẹp hơn → true', () => expect(isSubset({ 'contacts.view': 'own' }, admin)).toBe(true))
  it('con có quyền cha không có → false', () =>
    expect(isSubset({ 'payroll.view': 'own' }, admin)).toBe(false))
  it('con scope rộng hơn cha → false', () =>
    expect(isSubset({ 'contacts.view': 'all' }, { 'contacts.view': 'team' })).toBe(false))
})

describe('normalizeGrant', () => {
  it('quyền scoped + scope hợp lệ', () => expect(normalizeGrant('contacts.view', 'team')).toBe('team'))
  it('quyền scoped thiếu scope → own (hẹp nhất, fail-closed)', () =>
    expect(normalizeGrant('contacts.view', null)).toBe('own'))
  it('quyền scoped scope rác → own', () => expect(normalizeGrant('contacts.view', 'xyz')).toBe('own'))
  it('quyền không scoped → true bất kể scope', () => expect(normalizeGrant('contacts.create', 'all')).toBe(true))
})
