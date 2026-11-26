import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, lockOtherAdmins, q, seedAdmin, seedUser, type SeededUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * Quản trị vai trò + guardrail chống leo thang + "Quản trị cuối cùng" (chuyển từ `roles-admin.e2e-spec.ts`, 20 ca).
 * Một DB dùng chung cả lượt: tên vai trò mang hậu tố riêng để không trùng với ca khác, ca đếm Quản trị khoá những Quản trị còn lại.
 */
const RUN = Date.now().toString(36)
const nm = (n: string): string => `${n} ${RUN}`

const tokenOf = async (u: SeededUser): Promise<string> => (await loginSeeded(u)).token
const call = (method: 'get' | 'post' | 'put' | 'patch' | 'del', path: string, token: string, body?: unknown) =>
  api[method](path, { token, body, ip: freshIp() })
const me = async (token: string) => (await call('get', '/auth/me', token)).body as { permissions: Record<string, unknown>; isAdmin: boolean }
const admin = async (label: string) => {
  const u = await seedAdmin(label)
  return { ...u, token: await tokenOf(u) }
}
const user = async (label: string, grants: Parameters<typeof seedUser>[0]['grants']) => {
  const u = await seedUser({ label, grants })
  return { ...u, token: await tokenOf(u) }
}
const systemRoleId = async (): Promise<number> => (await q<{ id: number }>('SELECT id FROM roles WHERE is_system ORDER BY id LIMIT 1'))[0].id

describe('vòng đời: tạo vai trò → gán user → /auth/me phản ánh NGAY → sửa grants phản ánh NGAY', () => {
  it('chạy đủ chuỗi, kèm danh sách/chi tiết/người giữ/nhật ký', async () => {
    const a = await admin('vt-admin')
    const staff = await user('vt-staff', {})
    const name = nm('Kế toán')
    const created = await call('post', '/roles', a.token, {
      name,
      description: 'Xem khách',
      grants: { 'contacts.view': 'team', 'contacts.create': null },
    })
    expect(created.status).toBe(201)
    const cb = created.body as { id: number; name: string; is_system: boolean; member_count: number; grants: unknown }
    const roleId = cb.id
    expect(cb).toMatchObject({ name, is_system: false, member_count: 0 })
    expect(cb.grants).toEqual({ 'contacts.view': 'team', 'contacts.create': true })

    expect((await me(staff.token)).permissions).toEqual({})
    expect((await call('put', `/users/${staff.id}/roles`, a.token, { roleIds: [roleId] })).status).toBe(200)
    expect((await me(staff.token)).permissions).toEqual({ 'contacts.view': 'team', 'contacts.create': true })

    expect((await call('put', `/roles/${roleId}/grants`, a.token, { grants: { 'contacts.view': 'all' } })).status).toBe(200)
    expect((await me(staff.token)).permissions).toEqual({ 'contacts.view': 'all' })

    const list = (await call('get', '/roles', a.token)).body as { id: number }[]
    expect(list.find((r) => r.id === roleId)).toEqual({ id: roleId, name, description: 'Xem khách', is_system: false, member_count: 1 })
    const detail = await call('get', `/roles/${roleId}`, a.token)
    expect((detail.body as { grants: unknown }).grants).toEqual({ 'contacts.view': 'all' })
    const members = await call('get', `/roles/${roleId}/members`, a.token)
    expect((members.body as { id: number }[]).map((m) => m.id)).toEqual([staff.id])

    expect((await call('put', `/users/${staff.id}/roles`, a.token, { roleIds: [] })).status).toBe(200)
    expect((await me(staff.token)).permissions).toEqual({})

    const audit = await call('get', `/rbac/audit?targetType=role&targetId=${roleId}`, a.token)
    expect(audit.status).toBe(200)
    const rows = (audit.body as { data: { action: string; actor_id: number }[] }).data
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['role.create', 'role.grants', 'user.roles']))
    expect(rows[0].actor_id).toBe(a.id)
  })

  it('đổi tên / mô tả, tên trùng (không phân biệt hoa thường) → 409, nhân bản', async () => {
    const a = await admin('dt-admin')
    const created = await call('post', '/roles', a.token, { name: nm('Nhóm A'), grants: {} })
    expect(created.status).toBe(201)
    const id = (created.body as { id: number }).id
    expect((await call('post', '/roles', a.token, { name: nm('nhóm a'), grants: {} })).status).toBe(409)
    const renamed = await call('patch', `/roles/${id}`, a.token, { name: nm('Nhóm B'), description: 'mô tả' })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ name: nm('Nhóm B'), description: 'mô tả' })
    const clone = await call('post', `/roles/${id}/clone`, a.token)
    expect(clone.status).toBe(201)
    expect((clone.body as { name: string }).name).toBe(`${nm('Nhóm B')} (bản sao)`)
  })

  it('grants sai: khoá lạ / thiếu scope / scope lạ → 400', async () => {
    const a = await admin('gs-admin')
    const post = (grants: Record<string, unknown>) => call('post', '/roles', a.token, { name: nm(`r${Math.random()}`), grants })
    expect((await post({ 'x.y': 'all' })).status).toBe(400)
    expect((await post({ 'contacts.view': null })).status).toBe(400)
    expect((await post({ 'contacts.view': 'everyone' })).status).toBe(400)
    expect((await post({ 'roles.manage': 'all' })).status).toBe(400)
  })
})

describe('quyền truy cập endpoint', () => {
  it('không có roles.manage → 403 trên ghi; GET /roles mở cho users.manage / kanban.boards', async () => {
    const u = await user('qt-none', {})
    expect((await call('get', '/roles', u.token)).status).toBe(403)
    expect((await call('post', '/roles', u.token, { name: nm('x1'), grants: {} })).status).toBe(403)
    expect((await call('get', '/rbac/audit', u.token)).status).toBe(403)
    const k = await user('qt-kanban', { 'kanban.boards': null })
    expect((await call('get', '/roles', k.token)).status).toBe(200)
    expect((await call('get', '/roles/1', k.token)).status).toBe(403)
    const m = await user('qt-users', { 'users.manage': 'own' })
    expect((await call('get', '/roles', m.token)).status).toBe(200)
  })
})

describe('sửa quyền vai trò: quyền mới ⊆ quyền người sửa', () => {
  it('vượt scope / vượt khoá → 403; trong phạm vi → 201', async () => {
    const mgr = await user('sq-mgr', { 'roles.manage': null, 'contacts.view': 'team' })
    const create = (grants: Record<string, unknown>, name: string) => call('post', '/roles', mgr.token, { name: nm(name), grants })
    expect((await create({ 'contacts.view': 'all' }, 'vuot-scope')).status).toBe(403)
    expect((await create({ 'contacts.create': null }, 'vuot-khoa')).status).toBe(403)
    const ok = await create({ 'contacts.view': 'own' }, 'trong-pham-vi')
    expect(ok.status).toBe(201)
    const put = await call('put', `/roles/${(ok.body as { id: number }).id}/grants`, mgr.token, { grants: { 'contacts.view': 'subtree' } })
    expect(put.status).toBe(403)
  })

  it('KHÔNG sửa/xoá được vai trò "to" hơn mình, KHÔNG nhân bản vai trò vượt quyền', async () => {
    const a = await admin('to-admin')
    const big = await call('post', '/roles', a.token, { name: nm('To'), grants: { 'contacts.view': 'all', 'contacts.create': null } })
    expect(big.status).toBe(201)
    const id = (big.body as { id: number }).id
    const mgr = await user('to-mgr', { 'roles.manage': null, 'contacts.view': 'team' })
    expect((await call('patch', `/roles/${id}`, mgr.token, { name: nm('Doi ten') })).status).toBe(403)
    expect((await call('put', `/roles/${id}/grants`, mgr.token, { grants: {} })).status).toBe(403)
    expect((await call('del', `/roles/${id}`, mgr.token)).status).toBe(403)
    expect((await call('post', `/roles/${id}/clone`, mgr.token)).status).toBe(403)
  })

  it('vai trò hệ thống: không sửa quyền / đổi tên (kể cả Quản trị), xoá → 409', async () => {
    const a = await admin('ht-admin')
    const sys = await systemRoleId()
    expect((await call('put', `/roles/${sys}/grants`, a.token, { grants: {} })).status).toBe(403)
    expect((await call('patch', `/roles/${sys}`, a.token, { name: nm('Khac') })).status).toBe(403)
    expect((await call('del', `/roles/${sys}`, a.token)).status).toBe(409)
    const detail = await call('get', `/roles/${sys}`, a.token)
    expect(detail.status).toBe(200)
    expect((detail.body as { grants: Record<string, unknown> }).grants['contacts.view']).toBe('all')
  })

  it('xoá vai trò còn người giữ → 409; hết người → xoá được', async () => {
    const a = await admin('xv-admin')
    const u = await user('xv-user', {})
    const r = await call('post', '/roles', a.token, { name: nm('Tam'), grants: {} })
    const id = (r.body as { id: number }).id
    expect((await call('put', `/users/${u.id}/roles`, a.token, { roleIds: [id] })).status).toBe(200)
    expect((await call('del', `/roles/${id}`, a.token)).status).toBe(409)
    expect((await call('put', `/users/${u.id}/roles`, a.token, { roleIds: [] })).status).toBe(200)
    expect((await call('del', `/roles/${id}`, a.token)).status).toBe(200)
    expect((await call('get', `/roles/${id}`, a.token)).status).toBe(404)
  })
})

describe('gán vai trò cho người', () => {
  async function setup(tag: string) {
    const a = await admin(`${tag}-admin`)
    const mgr = await user(`${tag}-mgr`, { 'users.manage': 'all', 'roles.manage': null, 'contacts.view': 'team' })
    const small = await call('post', '/roles', a.token, { name: nm(`Nho ${tag}`), grants: { 'contacts.view': 'own' } })
    const big = await call('post', '/roles', a.token, { name: nm(`Lon ${tag}`), grants: { 'contacts.view': 'all', 'contacts.create': null } })
    expect([small.status, big.status]).toEqual([201, 201])
    const target = await user(`${tag}-target`, {})
    return { admin: a, mgr, small: (small.body as { id: number }).id, big: (big.body as { id: number }).id, target }
  }
  const put = (token: string, userId: number, roleIds: unknown) => call('put', `/users/${userId}/roles`, token, roleIds === undefined ? {} : { roleIds })

  it('luật 2: gán vai trò quyền ⊆ mình → 200; quyền vượt → 403', async () => {
    const s = await setup('l2a')
    expect((await put(s.mgr.token, s.target.id, [s.small])).status).toBe(200)
    expect((await put(s.mgr.token, s.target.id, [s.big])).status).toBe(403)
    expect((await me(s.target.token)).permissions).toEqual({ 'contacts.view': 'own' })
  })

  it('GET /roles/:id/members: email chỉ hiện với người trong phạm vi users.view (roles.manage không đủ)', async () => {
    const s = await setup('mem')
    expect((await put(s.admin.token, s.target.id, [s.small])).status).toBe(200)
    const noView = await call('get', `/roles/${s.small}/members`, s.mgr.token)
    expect(noView.status).toBe(200)
    const nb = noView.body as { id: number; email: unknown }[]
    expect(nb).toHaveLength(1)
    expect(nb[0]).toMatchObject({ id: s.target.id, email: null })
    const full = await call('get', `/roles/${s.small}/members`, s.admin.token)
    expect(typeof (full.body as { email: unknown }[])[0].email).toBe('string')
  })

  it('luật 2: người thường không gán / không gỡ vai trò Quản trị', async () => {
    const s = await setup('l2b')
    expect((await put(s.mgr.token, s.target.id, [await systemRoleId()])).status).toBe(403)
    const other = await admin('l2b-other')
    expect((await put(s.mgr.token, other.id, [s.small])).status).toBe(403)
    expect((await me(other.token)).isAdmin).toBe(true)
  })

  it('luật 2: người thường KHÔNG sửa được vai trò của người "to" hơn mình', async () => {
    const s = await setup('l2c')
    expect((await put(s.admin.token, s.target.id, [s.big])).status).toBe(200)
    expect((await put(s.mgr.token, s.target.id, [s.small])).status).toBe(403)
    expect((await me(s.target.token)).permissions['contacts.view']).toBe('all')
  })

  it('luật 4: người thường không tự đổi vai trò của chính mình', async () => {
    const s = await setup('l4')
    expect((await put(s.mgr.token, s.mgr.id, [s.small])).status).toBe(403)
    expect((await put(s.mgr.token, s.mgr.id, [])).status).toBe(403)
  })

  it('users.manage scope own: người ngoài phạm vi → 404 (không phải 403)', async () => {
    const s = await setup('own')
    const narrow = await user('own-narrow', { 'users.manage': 'own' })
    expect((await put(narrow.token, s.target.id, [s.small])).status).toBe(404)
  })

  it('roleIds: id không tồn tại → 404; trùng / không phải số → 400; user không tồn tại → 404', async () => {
    const s = await setup('ids')
    expect((await put(s.admin.token, s.target.id, [999999])).status).toBe(404)
    expect((await put(s.admin.token, s.target.id, [s.small, s.small])).status).toBe(400)
    expect((await put(s.admin.token, s.target.id, ['a'])).status).toBe(400)
    expect((await put(s.admin.token, s.target.id, undefined)).status).toBe(400)
    expect((await put(s.admin.token, 987654, [s.small])).status).toBe(404)
  })

  it('Quản trị gán nhiều vai trò → quyền cộng dồn, scope rộng nhất', async () => {
    const s = await setup('multi')
    expect((await put(s.admin.token, s.target.id, [s.small, s.big])).status).toBe(200)
    expect((await me(s.target.token)).permissions).toEqual({ 'contacts.view': 'all', 'contacts.create': true })
  })
})

describe('Quản trị cuối cùng', () => {
  it('Quản trị duy nhất tự gỡ vai trò Quản trị → 409', async () => {
    const a = await admin('qc1')
    const unlock = await lockOtherAdmins([a.id])
    try {
      expect((await call('put', `/users/${a.id}/roles`, a.token, { roleIds: [] })).status).toBe(409)
      expect((await me(a.token)).isAdmin).toBe(true)
    } finally {
      await unlock()
    }
  })

  it('còn Quản trị khác ĐANG HOẠT ĐỘNG → gỡ được; Quản trị khác bị khoá không tính', async () => {
    const a = await admin('qc2a')
    const b = await admin('qc2b')
    const unlock = await lockOtherAdmins([a.id, b.id])
    try {
      await q(`UPDATE users SET status = 'locked' WHERE id = $1`, [b.id])
      await control.flushCache()
      expect((await call('put', `/users/${a.id}/roles`, a.token, { roleIds: [] })).status).toBe(409)
      await q(`UPDATE users SET status = 'active' WHERE id = $1`, [b.id])
      await control.flushCache()
      expect((await call('put', `/users/${a.id}/roles`, a.token, { roleIds: [] })).status).toBe(200)
      // b giờ là Quản trị cuối cùng
      expect((await call('put', `/users/${b.id}/roles`, b.token, { roleIds: [] })).status).toBe(409)
    } finally {
      await unlock()
    }
  })

  it('người thường không khoá / xoá / reset mật khẩu Quản trị → 403', async () => {
    const lone = await admin('qc3-lone')
    const actor = await user('qc3-actor', { 'users.manage': 'all' })
    expect((await call('del', `/users/${lone.id}`, actor.token)).status).toBe(403)
    expect((await call('del', `/users/${lone.id}/permanent`, actor.token)).status).toBe(403)
    expect((await call('patch', `/users/${lone.id}`, actor.token, { status: 'locked' })).status).toBe(403)
    expect((await call('patch', `/users/${lone.id}/reset-password`, actor.token, { password: 'matkhau-moi-123' })).status).toBe(403) // gitleaks:allow
    expect((await q<{ status: string }>('SELECT status FROM users WHERE id = $1', [lone.id]))[0].status).toBe('active')
  })
})

describe('nhật ký', () => {
  it('GET /rbac/audit: phân trang, mới nhất trước, có tên người sửa', async () => {
    const a = await admin('nk-admin')
    const total = async (): Promise<number> => ((await call('get', '/rbac/audit?page=1&limit=1', a.token)).body as { total: number }).total
    const before = await total()
    for (const n of ['L1', 'L2', 'L3']) {
      expect((await call('post', '/roles', a.token, { name: nm(n), grants: {} })).status).toBe(201)
    }
    const res = await call('get', '/rbac/audit?page=1&limit=2', a.token)
    expect(res.status).toBe(200)
    const b = res.body as { total: number; data: { after: { name: string }; actor_name: string }[] }
    expect(b.total).toBe(before + 3)
    expect(b.data).toHaveLength(2)
    expect(b.data[0].after.name).toBe(nm('L3'))
    const self = (await q<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [a.id]))[0]
    expect(b.data[0].actor_name).toBe(self.full_name)
    expect((await call('get', '/rbac/audit?limit=1000', a.token)).status).toBe(400)
  })
})
