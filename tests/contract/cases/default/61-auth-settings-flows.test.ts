import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, type SeededUser } from '../../lib/db.js'
import { config } from '../../lib/config.js'
import { recordCall } from '../../lib/coverage.js'
import { api, call, freshIp, type Res } from '../../lib/http.js'
import { golden, snap, type Role } from '../../lib/golden.js'
import { loginSeeded } from '../../lib/session.js'
import { makeUser, type U } from '../../lib/users.js'

afterAll(closeDb)

/**
 * C14a — ca thành công và đầu vào sai cho các route của cụm `auth-settings` mà ca sinh (`60-…`) và các file chuyển từ e2e chưa phủ:
 * khoá API + đăng nhập công khai, lời mời nhân viên, ảnh đại diện, cài đặt (âm báo, một phiên, kiểm WiFi đăng nhập, tuỳ chọn) và
 * vòng đời người dùng. Mỗi ca dùng người dùng riêng; không dùng token quản trị gốc để không làm hỏng phiên của file khác.
 */
const ok = <T>(res: Res, status: number | number[], what: string): T => {
  expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status)
  return res.body as T
}
const withToken = (u: U) => ({ token: u.token, ip: freshIp() })

const PERMS = ['settings.integrations', 'settings.features', 'users.manage', 'users.view', 'roles.manage', 'org.manage', 'contacts.catalog']
let admin: U

beforeAll(async () => {
  admin = await makeUser(Object.fromEntries(PERMS.map((p) => [p, p.startsWith('users.') ? ('all' as const) : (true as const)])))
})

describe('khoá API và đăng nhập công khai', () => {
  let owner: SeededUser
  beforeAll(async () => {
    owner = await seedUser({ label: 'keyowner', grants: { 'contacts.create': null } })
  })

  it('tạo, liệt kê, xem, xoay, đăng nhập bằng khoá, xoá', async () => {
    const created = ok<{ id: number }>(
      await api.post('/api-keys', { ...withToken(admin), body: { name: 'Contract key', scopes: ['auth:login'], owner_user_id: owner.id } }),
      201,
      'tạo khoá',
    )
    expect(created.id).toBeTypeOf('number')
    const list = ok<unknown[] | { data: unknown[] }>(await api.get('/api-keys', withToken(admin)), 200, 'danh sách khoá')
    expect(Array.isArray(list) ? list.length : list.data.length).toBeGreaterThan(0)
    ok(await api.get(`/api-keys/${created.id}`, withToken(admin)), 200, 'chi tiết khoá')
    const rotated = ok<{ plain_key?: string }>(await api.post(`/api-keys/${created.id}/rotate`, withToken(admin)), [200, 201], 'xoay khoá')
    const key = rotated.plain_key ?? rotated.key ?? rotated.api_key ?? created.key ?? created.api_key
    expect(key, `khoá gốc không có trong ${JSON.stringify(rotated)}`).toBeTypeOf('string')

    const login = await call('POST', '/api/v1/public/auth/login', { headers: { 'x-api-key': key as string }, body: { email: owner.email, password: owner.password }, ip: freshIp() })
    expect(login.status, JSON.stringify(login.body)).toBe(200)
    const bad = await call('POST', '/api/v1/public/auth/login', { headers: { 'x-api-key': key as string }, body: {}, ip: freshIp() })
    expect(bad.status, JSON.stringify(bad.body)).toBe(400)

    ok(await api.del(`/api-keys/${created.id}`, withToken(admin)), 200, 'xoá khoá')
    const after = ok<{ revoked_at: string | null }>(await api.get(`/api-keys/${created.id}`, withToken(admin)), 200, 'khoá sau khi xoá')
    expect(after.revoked_at, 'xoá khoá là thu hồi (còn dòng, có revoked_at)').not.toBeNull()
    const dead = await call('POST', '/api/v1/public/auth/login', { headers: { 'x-api-key': key as string }, body: { email: owner.email, password: owner.password }, ip: freshIp() })
    expect(dead.status, 'khoá đã thu hồi không đăng nhập được').toBe(401)
  })
})

describe('lời mời nhân viên', () => {
  it('vai trò mời được, tạo, liệt kê, xem trước, nhận lời mời, thu hồi', async () => {
    const roles = ok<{ id: number }[] | { data: { id: number }[] }>(await api.get('/auth/invitations/roles', withToken(admin)), 200, 'vai trò mời được')
    const roleList = Array.isArray(roles) ? roles : roles.data
    expect(roleList.length, 'phải có ít nhất một vai trò mời được').toBeGreaterThan(0)
    const roleId = roleList[0].id

    const mk = async (label: string) => {
      const email = `invite-${label}-${Date.now().toString(36)}@contract.test`
      const body = ok<Record<string, unknown>>(await api.post('/auth/invitations', { ...withToken(admin), body: { email, role_id: roleId } }), 201, 'tạo lời mời')
      const link = String(body.path ?? body.url ?? body.link ?? '')
      const token = (/token=([^&]+)/.exec(link) ?? /\/([^/?]{8,})$/.exec(link))?.[1] ?? String(body.token ?? '')
      expect(token.length, `không lấy được token từ ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(8)
      return { email, token, id: body.id as number | undefined }
    }
    const inv = await mk('accept')
    const listed = ok<unknown[] | { data: unknown[] }>(await api.get('/auth/invitations', withToken(admin)), 200, 'danh sách lời mời')
    expect(Array.isArray(listed) ? listed.length : listed.data.length).toBeGreaterThan(0)

    ok(await api.post('/auth/invitations/preview', { ip: freshIp(), body: { token: inv.token } }), 200, 'xem trước')
    expect((await api.post('/auth/invitations/preview', { ip: freshIp(), body: {} })).status).toBe(400)
    expect((await api.post('/auth/invitations/accept', { ip: freshIp(), body: { token: 'x' } })).status).toBe(400)
    ok(await api.post('/auth/invitations/accept', { ip: freshIp(), body: { token: inv.token, full_name: 'Người được mời', password: 'Contract-Pass-123' } }), 201, 'nhận lời mời')

    const second = await mk('revoke')
    const pending = ok<{ data?: { id: number; email: string }[] } | { id: number; email: string }[]>(await api.get('/auth/invitations', withToken(admin)), 200, 'danh sách')
    const rows = Array.isArray(pending) ? pending : (pending.data ?? [])
    const target = rows.find((r) => r.email === second.email)
    expect(target, 'lời mời vừa tạo phải có trong danh sách').toBeTruthy()
    ok(await api.post(`/auth/invitations/${(target as { id: number }).id}/revoke`, withToken(admin)), 200, 'thu hồi')
  })
})

describe('hồ sơ cá nhân', () => {
  it('sửa họ tên và SĐT của chính mình', async () => {
    const u = await seedUser({ label: 'profile', grants: {} })
    const { token } = await loginSeeded(u)
    ok(await api.patch('/auth/profile', { token, ip: freshIp(), body: { full_name: 'Hồ sơ hợp đồng', phone: '0912345678' } }), 200, 'sửa hồ sơ')
    const me = ok<{ user?: { full_name: string }; full_name?: string }>(await api.get('/auth/me', { token, ip: freshIp() }), 200, 'đọc hồ sơ')
    expect(me.user?.full_name ?? me.full_name).toBe('Hồ sơ hợp đồng')
  })

  it('ảnh đại diện: ảnh hợp lệ → 201, tệp không phải ảnh → 400', async () => {
    const u = await seedUser({ label: 'avatar', grants: {} })
    const { token } = await loginSeeded(u)
    const upload = async (bytes: Uint8Array, type: string, name: string) => {
      const form = new FormData()
      form.append('file', new Blob([bytes], { type }), name)
      const res = await fetch(`${config.baseUrl}/api/v1/auth/profile/avatar`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-real-ip': freshIp() }, body: form })
      recordCall('POST', '/api/v1/auth/profile/avatar', res.status, true)
      return { status: res.status, text: await res.text() }
    }
    // PNG 1x1
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const good = await upload(png, 'image/png', 'a.png')
    expect(good.status, good.text).toBe(201)
    const bad = await upload(new TextEncoder().encode('khong phai anh'), 'text/plain', 'a.txt')
    expect(bad.status, bad.text).toBe(400)
  })

  it('đặt lại mật khẩu của chính mình cần mật khẩu hiện tại', async () => {
    const u = await seedUser({ label: 'selfreset', grants: {} })
    const { token } = await loginSeeded(u)
    expect((await api.post('/auth/reset-password', { token, ip: freshIp(), body: {} })).status).toBe(400)
    const res = await api.post('/auth/reset-password', { token, ip: freshIp(), body: { currentPassword: u.password } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it('đầu vào sai của đăng nhập, làm mới phiên, đăng ký → 400', async () => {
    for (const p of ['/auth/login', '/auth/refresh', '/auth/register']) {
      const res = await api.post(p, { ip: freshIp(), body: {} })
      expect(res.status, `${p}: ${JSON.stringify(res.body)}`).toBe(400)
    }
  })

  it('đăng xuất rồi token cũ bị từ chối', async () => {
    const u = await seedUser({ label: 'logout', grants: {} })
    const { token } = await loginSeeded(u)
    expect((await api.post('/auth/logout', { token, ip: freshIp() })).status).toBe(200)
    expect((await api.get('/auth/me', { token, ip: freshIp() })).status).toBe(401)
  })
})

describe('cài đặt', () => {
  it('âm báo toàn hệ thống: đọc, đổi, giá trị sai → 400', async () => {
    const before = ok<{ sound_id: string }>(await api.get('/settings/notification-sound', withToken(admin)), 200, 'đọc âm báo')
    try {
      ok(await api.patch('/settings/notification-sound', { ...withToken(admin), body: { sound_id: 'chime' } }), 200, 'đổi âm báo')
      expect((await api.patch('/settings/notification-sound', { ...withToken(admin), body: { sound_id: 'khong-co' } })).status).toBe(400)
    } finally {
      await api.patch('/settings/notification-sound', { ...withToken(admin), body: { sound_id: before.sound_id } })
    }
  })

  it('cảnh báo IP văn phòng, một phiên, kiểm WiFi đăng nhập', async () => {
    ok(await api.get('/settings/client-ip/alerts', withToken(admin)), 200, 'cảnh báo IP')
    const single = ok<{ enabled: boolean }>(await api.get('/auth/settings/single-session', withToken(admin)), 200, 'đọc một phiên')
    ok(await api.patch('/auth/settings/single-session', { ...withToken(admin), body: { enabled: single.enabled } }), 200, 'giữ nguyên một phiên')
    const targets = ok<{ items?: { scope_type: string; target_user_id: number }[] }>(await api.get('/auth/settings/login-wifi-check-targets', withToken(admin)), 200, 'đối tượng kiểm WiFi')
    const original = (targets.items ?? []).map((i) => ({ scope_type: i.scope_type, target_user_id: i.target_user_id }))
    try {
      ok(await api.put('/auth/settings/login-wifi-check-targets', { ...withToken(admin), body: { items: [] } }), 200, 'đặt đối tượng kiểm WiFi')
    } finally {
      await api.put('/auth/settings/login-wifi-check-targets', { ...withToken(admin), body: { items: original } })
    }
    ok(await api.get('/auth/settings/login-wifi-check-targets/roster', withToken(admin)), 200, 'danh sách kiểm WiFi')
  })

  it('tuỳ chọn: tạo, sửa, xoá', async () => {
    const created = ok<{ id: number }>(
      await api.post('/settings/options', { ...withToken(admin), body: { group_key: 'contract_group', value: `v${Date.now().toString(36)}`, label: 'Nhãn hợp đồng' } }),
      201,
      'tạo tuỳ chọn',
    )
    ok(await api.patch(`/settings/options/${created.id}`, { ...withToken(admin), body: { label: 'Nhãn đã sửa' } }), 200, 'sửa tuỳ chọn')
    ok(await api.del(`/settings/options/${created.id}`, withToken(admin)), 200, 'xoá tuỳ chọn')
  })
})

describe('vòng đời người dùng', () => {
  it('tạo, xem lịch sử mật khẩu, xoá', async () => {
    const made = ok<{ id: number }>(
      await api.post('/users', { ...withToken(admin), body: { email: `life-${Date.now().toString(36)}@contract.test`, full_name: 'Người dùng vòng đời', password: 'Contract-Pass-123' } }),
      201,
      'tạo người dùng',
    )
    ok(await api.get(`/users/${made.id}/password-history`, withToken(admin)), 200, 'lịch sử mật khẩu')
    ok(await api.del(`/users/${made.id}`, withToken(admin)), 200, 'khoá/xoá người dùng')
  })
})

/** Route đọc người dùng đổi hình dạng theo `users.phone_full` (cột `shape_permissions` của routes.json): golden cho 3 vai. */
describe('danh sách và chi tiết người dùng theo ba vai', () => {
  it('SĐT bị che với vai không có users.phone_full', async () => {
    const target = await seedUser({ label: 'shape-target', grants: {} })
    await q(`UPDATE users SET phone = '0912000333', full_name = 'Người dùng ba vai' WHERE id = $1`, [target.id])
    const leader = await seedUser({ label: 'shape-leader', grants: { 'users.view': 'all', 'users.phone_full': 'all' } })
    const sale = await seedUser({ label: 'shape-sale', grants: { 'users.view': 'all' } })
    // Vai quản trị của ca là người dùng seed có đủ quyền xem + SĐT, KHÔNG dùng tài khoản gốc (ca khác có thể đổi mật khẩu/phiên của nó).
    const adminLike = await seedUser({ label: 'shape-admin', grants: { 'users.view': 'all', 'users.manage': 'all', 'users.phone_full': 'all' } })
    const tokens: [Role, string][] = [
      ['admin', (await loginSeeded(adminLike)).token],
      ['leader', (await loginSeeded(leader)).token],
      ['sale', (await loginSeeded(sale)).token],
    ]
    const phones: Record<string, string | null | undefined> = {}
    for (const [role, token] of tokens) {
      const detail = await api.get(`/users/${target.id}`, { token, ip: freshIp() })
      expect(detail.status, role).toBe(200)
      phones[role] = (detail.body as { phone?: string | null }).phone
      golden('users-detail', role, snap(detail))
      const list = await api.get('/users?search=Ng%C6%B0%E1%BB%9Di%20d%C3%B9ng%20ba%20vai&limit=5', { token, ip: freshIp() })
      expect(list.status, role).toBe(200)
      golden('users-list', role, snap(list))
    }
    expect(phones.leader).toBe('0912000333')
    expect(phones.admin).toBe('0912000333')
    expect(phones.sale).not.toBe('0912000333')
  })
})
