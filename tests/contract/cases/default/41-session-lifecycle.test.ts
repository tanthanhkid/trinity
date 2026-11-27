import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedAdmin, seedUser } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * Vòng đời phiên đăng nhập (chuyển từ `session-lifecycle.e2e-spec.ts`, 6 ca): đăng xuất thu hồi đúng phiên (kể cả sau khi đăng
 * nhập lại), đổi/reset mật khẩu thu hồi mọi phiên, khoá không ghi đè email và mở khoá dùng lại ngay, xoá nhân viên khoá tài khoản liên kết.
 */
const PASSWORD = 'Contract-Pass-123'
const NEW_PASSWORD = 'Contract-Pass-456'
const sleepToNextSecond = (): Promise<void> => new Promise((r) => setTimeout(r, 1100)) // iat của JWT có độ phân giải giây

interface Tokens {
  access_token: string
  refresh_token: string
}
const login = async (email: string, password = PASSWORD): Promise<Tokens> => {
  const res = await api.post('/auth/login', { body: { email, password }, ip: freshIp() })
  expect(res.status).toBe(200)
  return res.body as Tokens
}
const refresh = (rt: string) => api.post('/auth/refresh', { body: { refresh_token: rt }, ip: freshIp() })
const withToken = (method: 'post' | 'patch' | 'del', path: string, token: string, body?: unknown) => api[method](path, { token, body, ip: freshIp() })
const loginUser = () => seedUser({ label: 'sess', grants: {}, password: PASSWORD })
const count = async (sql: string, params: unknown[]): Promise<number> => Number((await q<{ n: string }>(sql, params))[0].n)

describe('vòng đời phiên đăng nhập', () => {
  it('đăng xuất thu hồi refresh token của CHÍNH phiên đó, kể cả sau khi đăng nhập lại; phiên khác không bị ảnh hưởng', async () => {
    const u = await loginUser()
    const a = await login(u.email)
    const b = await login(u.email)
    expect((await refresh(a.refresh_token)).status).toBe(200)

    expect((await withToken('post', '/auth/logout', a.access_token, { refresh_token: a.refresh_token })).status).toBe(200)
    expect(await count('SELECT count(*) AS n FROM revoked_sessions WHERE user_id = $1', [u.id])).toBe(1)

    expect((await refresh(a.refresh_token)).status).toBe(401)
    // Đăng nhập lại KHÔNG làm phiên A sống lại.
    const c = await login(u.email)
    expect((await refresh(a.refresh_token)).status).toBe(401)
    expect((await refresh(b.refresh_token)).status).toBe(200)
    expect((await refresh(c.refresh_token)).status).toBe(200)
  })

  it('refresh xoay vòng giữ cùng id phiên: đăng xuất bằng token mới nhất vẫn chặn token cũ của phiên', async () => {
    const u = await loginUser()
    const a = await login(u.email)
    const rotated = (await refresh(a.refresh_token)).body as Tokens
    expect((await withToken('post', '/auth/logout', rotated.access_token, { refresh_token: rotated.refresh_token })).status).toBe(200)
    expect((await refresh(a.refresh_token)).status).toBe(401)
    expect((await refresh(rotated.refresh_token)).status).toBe(401)
  })

  it('đổi mật khẩu thu hồi MỌI refresh token cũ; phiên đăng nhập sau đó hoạt động', async () => {
    const u = await loginUser()
    const a = await login(u.email)
    const b = await login(u.email)
    await sleepToNextSecond()
    expect((await withToken('patch', '/auth/password', a.access_token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200)
    expect((await refresh(a.refresh_token)).status).toBe(401)
    expect((await refresh(b.refresh_token)).status).toBe(401)
    await sleepToNextSecond()
    const fresh = await login(u.email, NEW_PASSWORD)
    expect((await refresh(fresh.refresh_token)).status).toBe(200)
  })

  it('admin reset mật khẩu thu hồi mọi refresh token cũ của user', async () => {
    const u = await loginUser()
    const a = await login(u.email)
    const admin = await seedAdmin('sess-admin')
    const at = await login(admin.email, admin.password)
    await sleepToNextSecond()
    expect((await withToken('patch', `/users/${u.id}/reset-password`, at.access_token, { password: 'Contract-Pass-789' })).status).toBe(200) // gitleaks:allow
    expect((await refresh(a.refresh_token)).status).toBe(401)
    expect((await q<{ t: unknown }>('SELECT tokens_valid_after AS t FROM users WHERE id = $1', [u.id]))[0].t).not.toBeNull()
  })

  it('khoá không ghi đè email, thu hồi token cũ; mở khoá dùng lại được ngay (đăng nhập bằng email cũ)', async () => {
    const u = await loginUser()
    const a = await login(u.email)
    const admin = await seedAdmin('sess-admin2')
    const at = await login(admin.email, admin.password)
    await sleepToNextSecond()
    expect((await withToken('patch', `/users/${u.id}`, at.access_token, { status: 'locked' })).status).toBe(200)
    expect((await q<{ email: string }>('SELECT email FROM users WHERE id = $1', [u.id]))[0].email).toBe(u.email)
    expect((await refresh(a.refresh_token)).status).toBe(401)
    expect((await api.post('/auth/login', { body: { email: u.email, password: PASSWORD }, ip: freshIp() })).status).toBe(401)

    expect((await withToken('patch', `/users/${u.id}`, at.access_token, { status: 'active' })).status).toBe(200)
    await sleepToNextSecond()
    const again = await login(u.email)
    expect((await refresh(again.refresh_token)).status).toBe(200)
    // Token cấp TRƯỚC lúc khoá không sống lại sau khi mở khoá.
    expect((await refresh(a.refresh_token)).status).toBe(401)
  })

  it('xoá (soft-delete) nhân viên khoá tài khoản đăng nhập liên kết và thu hồi phiên; email giữ nguyên', async () => {
    const u = await loginUser()
    const a = await login(u.email)
    const [emp] = await q<{ id: number }>(`INSERT INTO employees (user_id, position) VALUES ($1, 'sales') RETURNING id`, [u.id])
    const hr = await seedUser({ label: 'sess-hr', grants: { 'employees.manage': 'all', 'employees.view': 'all' } })
    const ht = await loginSeeded(hr)
    await sleepToNextSecond()
    expect((await withToken('del', `/management/employees/${emp.id}`, ht.token)).status).toBe(200)

    const [row] = await q<{ status: string; email: string; deleted_at: unknown }>('SELECT status, email, deleted_at FROM users WHERE id = $1', [u.id])
    expect(row).toMatchObject({ status: 'locked', email: u.email, deleted_at: null })
    expect((await q<{ d: unknown }>('SELECT deleted_at AS d FROM employees WHERE id = $1', [emp.id]))[0].d).not.toBeNull()
    expect((await refresh(a.refresh_token)).status).toBe(401)
    expect((await api.post('/auth/login', { body: { email: u.email, password: PASSWORD }, ip: freshIp() })).status).toBe(401)
  })
})
