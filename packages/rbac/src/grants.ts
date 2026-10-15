import { PERMISSIONS, Permission, isPermission } from './catalog'

export type Scope = 'own' | 'team' | 'subtree' | 'all'
export const SCOPE_ORDER: readonly Scope[] = ['own', 'team', 'subtree', 'all']
export type Grant = Scope | true
export type Grants = Partial<Record<Permission, Grant>>

const rank = (s: Scope): number => SCOPE_ORDER.indexOf(s)
const isScope = (x: unknown): x is Scope => SCOPE_ORDER.includes(x as Scope)

/** Chuẩn hoá 1 dòng role_permissions đọc từ DB. Khoá lạ → null (bỏ qua). */
export function normalizeGrant(p: string, raw: string | null): Grant | null {
  if (!isPermission(p)) return null
  if (!PERMISSIONS[p].scoped) return true
  return isScope(raw) ? raw : 'own'
}

function wider(a: Grant | undefined, b: Grant): Grant {
  if (a === undefined) return b
  if (a === true || b === true) return true
  return rank(a) >= rank(b) ? a : b
}

export function mergeGrants(list: Grants[]): Grants {
  const out: Grants = {}
  for (const g of list) {
    for (const [p, v] of Object.entries(g) as [Permission, Grant][]) out[p] = wider(out[p], v)
  }
  return out
}

export function scopeOf(g: Grants, p: Permission): Scope | null {
  const v = g[p]
  return v === undefined || v === true ? null : v
}

export function can(g: Grants, p: Permission, min?: Scope): boolean {
  const v = g[p]
  if (v === undefined) return false
  if (!min || v === true) return true
  return rank(v) >= rank(min)
}

/** child ⊆ parent: mọi quyền của child parent đều có, scope không rộng hơn. */
export function isSubset(child: Grants, parent: Grants): boolean {
  for (const [p, v] of Object.entries(child) as [Permission, Grant][]) {
    const pv = parent[p]
    if (pv === undefined) return false
    if (v !== true && pv !== true && rank(v) > rank(pv)) return false
  }
  return true
}
