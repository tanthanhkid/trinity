import type { Grants } from '@trinity/rbac'

/** Cây `users.manager_id` → tập user trong phạm vi (own | team | subtree | all). */
export interface OrgUser {
  id: number
  manager_id: number | null
}

export type ScopeValue = 'own' | 'team' | 'subtree' | 'all' | true | null | undefined

export function scopeOf(grants: Grants, perm: string): ScopeValue {
  return (grants as Record<string, ScopeValue>)[perm]
}

/** `null` = tất cả (scope all). Mảng rỗng = không thấy gì. */
export function ownerIdsFor(scope: ScopeValue, me: number, users: OrgUser[]): Set<number> | null {
  if (scope === undefined) return new Set()
  if (scope === 'all') return null
  const direct = (id: number) => users.filter((u) => u.manager_id === id).map((u) => u.id)
  if (scope === 'team') return new Set([me, ...direct(me)])
  if (scope === 'subtree') {
    const out = new Set<number>([me])
    const stack = [me]
    while (stack.length) for (const c of direct(stack.pop()!)) if (!out.has(c)) { out.add(c); stack.push(c) }
    return out
  }
  return new Set([me]) // 'own' (và quyền không phạm vi coi như của chính mình)
}

export const inScope = (set: Set<number> | null, owner: number): boolean => set === null || set.has(owner)
