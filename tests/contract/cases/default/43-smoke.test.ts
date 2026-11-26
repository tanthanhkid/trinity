import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, seedAdmin, seedUser } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/** Smoke của RBAC (chuyển từ `smoke.e2e-spec.ts`, 4 ca): `/auth/me`, quyền admin, không token, danh mục quyền. */
interface Me {
  permissions: Record<string, unknown>
  isAdmin: boolean
  user: { id: number }
}

describe('smoke RBAC', () => {
  it("GET /auth/me với user có {contacts.view:'team'} → permissions đúng", async () => {
    const u = await seedUser({ label: 'smoke-team', grants: { 'contacts.view': 'team', 'contacts.create': null } })
    const s = await loginSeeded(u)
    const res = await api.get('/auth/me', { token: s.token, ip: freshIp() })
    expect(res.status).toBe(200)
    const b = res.body as Me
    expect(b.permissions).toEqual({ 'contacts.view': 'team', 'contacts.create': true })
    expect(b.isAdmin).toBe(false)
    expect(b.user.id).toBe(u.id)
  })

  it('GET /auth/me với user admin → isAdmin true, mọi quyền scope all', async () => {
    const u = await seedAdmin('smoke-admin')
    const s = await loginSeeded(u)
    const res = await api.get('/auth/me', { token: s.token, ip: freshIp() })
    expect(res.status).toBe(200)
    const b = res.body as Me
    expect(b.isAdmin).toBe(true)
    expect(b.permissions['contacts.view']).toBe('all')
    expect(b.permissions['contacts.create']).toBe(true)
  })

  it('GET /auth/me không token → 401', async () => {
    expect((await api.get('/auth/me', { ip: freshIp() })).status).toBe(401)
  })

  it('GET /rbac/catalog → số quyền, nhóm, scope khớp hợp đồng C04 (mọi user đã đăng nhập đọc được)', async () => {
    const u = await seedUser({ label: 'smoke-catalog', grants: {} })
    const s = await loginSeeded(u)
    const res = await api.get('/rbac/catalog', { token: s.token, ip: freshIp() })
    expect(res.status).toBe(200)
    const b = res.body as { permissions: unknown[]; groups: unknown[]; scopes: unknown[] }
    // Số quyền/nhóm/scope lấy từ `server/contracts/rbac.json` (thêm/bớt quyền thì sinh lại hợp đồng, không sửa số ở đây).
    const c = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../server/contracts/rbac.json'), 'utf8')) as {
      permissions: unknown[]
      permission_groups: unknown[]
      scope_order: unknown[]
    }
    expect(b.permissions).toHaveLength(c.permissions.length)
    expect(b.groups).toHaveLength(13)
    expect(b.scopes).toHaveLength(c.scope_order.length)
    expect(c.scope_order).toHaveLength(4)
  })
})
