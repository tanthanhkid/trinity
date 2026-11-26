/**
 * Bảng ca dùng chung TS ↔ Rust (K12): `server/contracts/cases/rbac.json`. Phía TS là chuẩn: spec này tính lại mọi ca bằng
 * `grants.ts` rồi so với cột kết quả trong bảng; Rust chạy cùng đầu vào ở `server/crates/trinity-rbac/tests/shared_cases.rs`.
 * Sinh lại cột kết quả sau khi thêm ca: `UPDATE_RBAC_CASES=1 npx jest grants-cases` (trong packages/rbac).
 */
import * as fs from 'fs'
import * as path from 'path'
import { ALL_PERMISSIONS, PERMISSIONS, Permission } from './catalog'
import { Grants, SCOPE_ORDER, Scope, can, isSubset, mergeGrants, normalizeGrant, scopeOf } from './grants'

const FILE = path.resolve(__dirname, '../../../server/contracts/cases/rbac.json')

const SAMPLES: Grants[] = [
  {},
  { 'contacts.view': 'own' },
  { 'contacts.view': 'team', 'contacts.create': true },
  { 'contacts.view': 'subtree', 'contacts.export': 'team', 'roles.manage': true },
  { 'contacts.view': 'all', 'contacts.export': 'all', 'roles.manage': true, 'payroll.view': 'own' },
  { 'payroll.view': 'team', 'payroll.manage': true, 'contacts.create': true },
  { 'deals.view': 'own', 'deals.manage': 'own', 'kanban.view': 'subtree' },
]

const PERMS: string[] = ['contacts.view', 'contacts.create', 'contacts.export', 'payroll.view', 'roles.manage', 'deals.view', 'x.y', 'extensions.view']
const RAWS: (string | null)[] = [null, 'own', 'team', 'subtree', 'all', 'xyz', '']

type Table = Record<string, unknown[]>

function compute(): Table {
  const normalize = PERMS.flatMap((perm) => RAWS.map((raw) => ({ perm, raw, out: normalizeGrant(perm, raw) })))
  const merge: unknown[] = []
  merge.push({ in: [], out: mergeGrants([]) })
  for (const a of SAMPLES) for (const b of SAMPLES) merge.push({ in: [a, b], out: mergeGrants([a, b]) })
  merge.push({ in: [SAMPLES[2], SAMPLES[3], SAMPLES[4]], out: mergeGrants([SAMPLES[2], SAMPLES[3], SAMPLES[4]]) })
  const mins: (Scope | null)[] = [null, ...SCOPE_ORDER]
  const canCases: unknown[] = []
  const scopeCases: unknown[] = []
  for (const g of SAMPLES) {
    for (const p of PERMS.filter((x) => x in PERMISSIONS) as Permission[]) {
      scopeCases.push({ grants: g, perm: p, out: scopeOf(g, p) })
      for (const min of mins) canCases.push({ grants: g, perm: p, min, out: can(g, p, min ?? undefined) })
    }
  }
  const subset: unknown[] = []
  for (const a of SAMPLES) for (const b of SAMPLES) subset.push({ child: a, parent: b, out: isSubset(a, b) })
  const admin = [{ out: { permissions: ALL_PERMISSIONS.length, scoped: ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].scoped).length } }]
  return { normalize, merge, can: canCases, scope_of: scopeCases, is_subset: subset, admin }
}

describe('bảng ca dùng chung TS ↔ Rust (server/contracts/cases/rbac.json)', () => {
  const fresh = compute()
  const update = process.env.UPDATE_RBAC_CASES === '1'
  if (update) fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`)
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table

  it('có ít nhất 300 ca', () => {
    expect(Object.values(fresh).reduce((s, v) => s + v.length, 0)).toBeGreaterThanOrEqual(300)
  })
  for (const key of Object.keys(fresh)) {
    it(`${key} khớp bản TS`, () => {
      expect(table[key]).toEqual(JSON.parse(JSON.stringify(fresh[key])))
    })
  }
})
