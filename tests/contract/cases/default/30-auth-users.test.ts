import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, type Scope } from '../../lib/db.js'
import { api, call, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

/**
 * Chuyển từ `apps/monolith/test/rbac/auth-users.e2e-spec.ts` (37 ca): cùng ma trận quyền, nhưng chỉ qua HTTP tới máy chủ
 * hộp đen; người dùng/vai trò seed bằng SQL (thay `makeUser` của harness) rồi đăng nhập thật để lấy token.
 * Không import mã backend. Mỗi ca tự tạo người dùng riêng nên không phụ thuộc thứ tự và không cần dọn giữa các ca.
 */
afterAll(closeDb)

type Grants = Record<string, Scope | true>
interface U {
  id: number
  token: string
}

/** Tạo người dùng + vai trò riêng với đúng quyền (`true` = quyền không phạm vi), đăng nhập, trả id + token. */
async function user(grants: Grants = {}, opts: { managerId?: number } = {}): Promise<U> {
  const mapped: Record<string, Scope> = {}
  for (const [k, v] of Object.entries(grants)) mapped[k] = v === true ? null : v
  const s = await seedUser({ label: 'au', grants: mapped, managerId: opts.managerId })
  const sess = await loginSeeded(s)
  return { id: s.id, token: sess.token }
}

const ip = (): { ip: string } => ({ ip: freshIp() })
const get = (p: string, u?: U) => api.get(p, { token: u?.token, ...ip() })
const post = (p: string, u: U, body?: unknown) => api.post(p, { token: u.token, body, ...ip() })
const patch = (p: string, u: U, body?: unknown) => api.patch(p, { token: u.token, body, ...ip() })
const put = (p: string, u: U, body?: unknown) => api.put(p, { token: u.token, body, ...ip() })
const del = (p: string, u: U) => api.del(p, { token: u.token, ...ip() })
const ids = (res: { body: unknown }): number[] => ((res.body as { data: { id: number }[] }).data ?? []).map((r) => r.id)

describe('GET /users — Mẫu A (owner = chính user)', () => {
  it('không quyền → 403', async () => {
    const u = await user({})
    expect((await get('/users', u)).status).toBe(403)
  })

  it('scope own → chỉ thấy chính mình', async () => {
    const other = await user()
    const u = await user({ 'users.view': 'own' })
    const res = await get('/users', u)
    expect(res.status).toBe(200)
    expect(ids(res)).toContain(u.id)
    expect(ids(res)).not.toContain(other.id)
  })

  it('scope team → thấy cấp dưới trực tiếp, KHÔNG thấy cháu', async () => {
    const manager = await user({ 'users.view': 'team' })
    const directReport = await user({}, { managerId: manager.id })
    const grandChild = await user({}, { managerId: directReport.id })
    const res = await get('/users', manager)
    expect(res.status).toBe(200)
    expect(ids(res)).toContain(manager.id)
    expect(ids(res)).toContain(directReport.id)
    expect(ids(res)).not.toContain(grandChild.id)
  })

  it('Mẫu C — thiếu users.phone_full → SĐT bị che; có → SĐT thật', async () => {
    const target = await seedUser({ label: 'au-phone', grants: {} })
    await q(`UPDATE users SET phone = '0912345678' WHERE id = $1`, [target.id])
    // Tìm theo email (duy nhất) thay vì đọc 200 dòng đầu: DB dùng chung cả hồ sơ có thể nhiều hơn 200 người dùng.
    const find = async (u: U) => {
      const res = await get(`/users?search=${encodeURIComponent(target.email)}&limit=50`, u)
      expect(res.status).toBe(200)
      return (res.body as { data: { id: number; phone: string }[] }).data.find((r) => r.id === target.id)
    }
    const masked = await user({ 'users.view': 'all' })
    expect((await find(masked))?.phone).toBe('***678')
    const full = await user({ 'users.view': 'all', 'users.phone_full': 'all' })
    expect((await find(full))?.phone).toBe('0912345678')
  })
})

describe('GET /users/export — Mẫu C export', () => {
  it('không có users.export → 403', async () => {
    const u = await user({ 'users.view': 'all' })
    expect((await get('/users/export', u)).status).toBe(403)
  })

  it('có users.export → 200, đúng content-type xlsx', async () => {
    const u = await user({ 'users.export': 'all' })
    const res = await get('/users/export', u)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
  })
})

describe('GET /users/:id — Mẫu B', () => {
  it('ngoài scope own → 404', async () => {
    const other = await user()
    const u = await user({ 'users.view': 'own' })
    expect((await get(`/users/${other.id}`, u)).status).toBe(404)
  })

  it('trong scope → 200', async () => {
    const u = await user({ 'users.view': 'own' })
    const res = await get(`/users/${u.id}`, u)
    expect(res.status).toBe(200)
    expect((res.body as { id: number }).id).toBe(u.id)
  })
})

describe('POST /users — tạo mới', () => {
  it('không có users.manage → 403', async () => {
    const u = await user({})
    const res = await post('/users', u, { email: 'new1@contract.test', full_name: 'New 1', password: 'password123' })
    expect(res.status).toBe(403)
  })

  it('có users.manage → 201, KHÔNG cần role', async () => {
    const u = await user({ 'users.manage': 'all' })
    const email = `new2-${Date.now().toString(36)}@contract.test`
    const res = await post('/users', u, { email, full_name: 'New 2', password: 'password123' })
    expect(res.status).toBe(201)
    expect((res.body as { email: string }).email).toBe(email)
  })
})

describe('PATCH /users/:id — sửa + chống leo thang', () => {
  it('tự sửa chính mình → 403', async () => {
    const u = await user({ 'users.manage': 'all' })
    expect((await patch(`/users/${u.id}`, u, { full_name: 'X' })).status).toBe(403)
  })

  it('target ngoài scope users.manage (own) → 404', async () => {
    const other = await user()
    const u = await user({ 'users.manage': 'own' })
    expect((await patch(`/users/${other.id}`, u, { full_name: 'X' })).status).toBe(404)
  })

  it('target có quyền KHÔNG ⊆ quyền actor → 403', async () => {
    const target = await user({ 'payroll.manage': true })
    const actor = await user({ 'users.manage': 'all' })
    expect((await patch(`/users/${target.id}`, actor, { full_name: 'X' })).status).toBe(403)
  })

  it('trong scope + quyền target ⊆ actor → 200', async () => {
    const target = await user({ 'contacts.view': 'own' })
    const actor = await user({ 'users.manage': 'all', 'contacts.view': 'all' })
    const res = await patch(`/users/${target.id}`, actor, { full_name: 'Đổi tên' })
    expect(res.status).toBe(200)
    expect((res.body as { full_name: string }).full_name).toBe('Đổi tên')
  })
})

describe('PATCH /users/:id/reset-password', () => {
  it('không có users.manage → 403', async () => {
    const target = await user()
    const u = await user({})
    expect((await patch(`/users/${target.id}/reset-password`, u, { password: 'NewPassword123' })).status).toBe(403)
  })

  it('target có quyền cao hơn actor → 403', async () => {
    const target = await user({ 'roles.manage': true })
    const actor = await user({ 'users.manage': 'all' })
    expect((await patch(`/users/${target.id}/reset-password`, actor, { password: 'NewPassword123' })).status).toBe(403)
  })

  it('hợp lệ → 200, KHÔNG trả password trong response', async () => {
    const target = await user()
    const actor = await user({ 'users.manage': 'all' })
    const res = await patch(`/users/${target.id}/reset-password`, actor, { password: 'NewPassword123' })
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('password')
  })
})

describe('DELETE /users/:id/permanent', () => {
  it('ngoài scope → 404', async () => {
    const other = await user()
    const u = await user({ 'users.manage': 'own' })
    expect((await del(`/users/${other.id}/permanent`, u)).status).toBe(404)
  })

  it('trong scope → 200', async () => {
    const target = await user()
    const actor = await user({ 'users.manage': 'all' })
    expect((await del(`/users/${target.id}/permanent`, actor)).status).toBe(200)
  })
})

describe('GET /users/me/pinned-menu — @AuthOnly, không cần quyền nghiệp vụ', () => {
  it('không token → 401', async () => {
    expect((await get('/users/me/pinned-menu')).status).toBe(401)
  })

  it('bất kỳ user đăng nhập nào (grants rỗng) → 200', async () => {
    const u = await user({})
    expect((await get('/users/me/pinned-menu', u)).status).toBe(200)
  })
})

describe('PUT /users/me/pinned-menu — ghim mục bảng tuỳ biến', () => {
  it('ghim/bỏ ghim bảng tuỳ biến (custom_<key>), trả lại đúng; bảng đã xoá thì tự rơi khỏi danh sách', async () => {
    const u = await user({})
    const key = `ghim_${Date.now().toString(36)}`
    const [obj] = await q<{ id: number }>(`INSERT INTO custom_objects (key, label, label_plural, updated_at) VALUES ($1, 'Ghi danh', 'Ghi danh', now()) RETURNING id`, [key])
    const res = await put('/users/me/pinned-menu', u, { keys: ['contacts', `custom_${key}`] })
    expect(res.status).toBe(200)
    expect((res.body as { keys: string[] }).keys).toEqual(['contacts', `custom_${key}`])
    expect(((await get('/users/me/pinned-menu', u)).body as { keys: string[] }).keys).toEqual(['contacts', `custom_${key}`])

    await q(`UPDATE custom_objects SET deleted_at = now() WHERE id = $1`, [obj.id])
    expect(((await get('/users/me/pinned-menu', u)).body as { keys: string[] }).keys).toEqual(['contacts'])

    const cleared = await put('/users/me/pinned-menu', u, { keys: [] })
    expect(cleared.status).toBe(200)
    expect((cleared.body as { keys: string[] }).keys).toEqual([])
  })

  it('bảng không tồn tại: bỏ qua im lặng (200), không lưu khoá ma', async () => {
    const u = await user({})
    const res = await put('/users/me/pinned-menu', u, { keys: ['kanban', 'custom_khong_co_that'] })
    expect(res.status).toBe(200)
    expect((res.body as { keys: string[] }).keys).toEqual(['kanban'])
  })

  it('khoá rác → 400', async () => {
    const u = await user({})
    for (const bad of ['custom_', 'custom_A', 'x:ghi_danh', 'custom_a b', 'bat_ky_gi']) {
      expect((await put('/users/me/pinned-menu', u, { keys: [bad] })).status, bad).toBe(400)
    }
  })
})

describe('PATCH /users/:id/team', () => {
  it('không có users.manage → 403', async () => {
    const target = await user()
    const [team] = await q<{ id: number }>(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Team-${Date.now()}`])
    const u = await user({})
    expect((await patch(`/users/${target.id}/team`, u, { team_id: team.id })).status).toBe(403)
  })

  it('có users.manage, trong scope → 200', async () => {
    const target = await user()
    const [team] = await q<{ id: number }>(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Team-${Date.now()}-2`])
    const actor = await user({ 'users.manage': 'all' })
    const res = await patch(`/users/${target.id}/team`, actor, { team_id: team.id })
    expect(res.status).toBe(200)
    expect((res.body as { team_id: number }).team_id).toBe(team.id)
  })
})

describe('GET/POST /auth/teams — deprecated, đọc @AuthOnly + ghi org.manage', () => {
  it('GET không cần quyền nghiệp vụ (chỉ cần đăng nhập)', async () => {
    const u = await user({})
    expect((await get('/auth/teams', u)).status).toBe(200)
  })

  it('POST không có org.manage → 403', async () => {
    const u = await user({})
    expect((await post('/auth/teams', u, { name: `T-${Date.now()}`, leadUserId: u.id })).status).toBe(403)
  })

  it('POST có org.manage → 201', async () => {
    const u = await user({ 'org.manage': true })
    expect((await post('/auth/teams', u, { name: `T-${Date.now()}`, leadUserId: u.id })).status).toBe(201)
  })
})

describe('API keys — @Can(settings.integrations)', () => {
  it('GET /api-keys không có settings.integrations → 403', async () => {
    const u = await user({})
    expect((await get('/api-keys', u)).status).toBe(403)
  })

  it('POST /api-keys owner KHÔNG có contacts.create → 400', async () => {
    const admin = await user({ 'settings.integrations': true })
    const owner = await user({})
    const res = await post('/api-keys', admin, { name: 'Key test', scopes: ['auth:login'], owner_user_id: owner.id })
    expect(res.status).toBe(400)
  })

  it('POST /api-keys owner CÓ contacts.create → 201', async () => {
    const admin = await user({ 'settings.integrations': true })
    const owner = await user({ 'contacts.create': true })
    const res = await post('/api-keys', admin, { name: 'Key test 2', scopes: ['auth:login'], owner_user_id: owner.id })
    expect(res.status).toBe(201)
    expect((res.body as { plain_key: string }).plain_key).toMatch(/^trinity_live_/)
  })
})

describe('Auth settings — đọc @AuthOnly, ghi settings.integrations', () => {
  it('GET login-wifi-check: bất kỳ user đăng nhập nào → 200', async () => {
    const u = await user({})
    expect((await get('/auth/settings/login-wifi-check', u)).status).toBe(200)
  })

  it('PATCH login-wifi-check không có settings.integrations → 403', async () => {
    const u = await user({})
    // Gửi `enabled: false` (giá trị vô hại): nếu cổng quyền hỏng thì ca đỏ mà không bật kiểm WiFi cho cả hồ sơ.
    expect((await patch('/auth/settings/login-wifi-check', u, { enabled: false })).status).toBe(403)
  })

  it('PATCH login-wifi-check có settings.integrations → 200', async () => {
    const u = await user({ 'settings.integrations': true })
    expect((await patch('/auth/settings/login-wifi-check', u, { enabled: false })).status).toBe(200)
  })
})

describe('Health — @Public, không cần token', () => {
  it('GET /health → 200 không token', async () => {
    expect((await call('GET', '/api/v1/health', ip())).status).toBe(200)
  })
})

describe('Phiên đăng nhập — blacklist dùng CHUNG 1 instance', () => {
  it('POST /auth/logout → access token cũ bị 401 ngay', async () => {
    const u = await user({})
    expect((await get('/auth/me', u)).status).toBe(200)
    expect((await post('/auth/logout', u)).status).toBe(200)
    expect((await get('/auth/me', u)).status).toBe(401)
  })
})
