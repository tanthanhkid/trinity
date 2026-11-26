import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, type Scope } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * C10 — chuyển từ `apps/monolith/test/rbac/crm-hr.e2e-spec.ts` (29 ca): nhân viên, chấm công, hợp đồng, tuyển dụng, tổ chức.
 * Hộp đen: seed bằng SQL, gọi qua HTTP, không import mã backend.
 */
async function as(label: string, grants: Record<string, Scope>) {
  const user = await seedUser({ label, grants })
  const { token } = await loginSeeded(user)
  const get = (p: string) => api.get(p, { token, ip: freshIp() })
  const send = (m: 'post' | 'patch', p: string, body: unknown) => api[m](p, { token, body, ip: freshIp() })
  return { user, get, send }
}

async function seedEmployee(userId: number): Promise<number> {
  const [e] = await q<{ id: number }>(`INSERT INTO employees (user_id, position, status) VALUES ($1, 'NV', 'active') RETURNING id`, [userId])
  return e.id
}

describe('GET/PATCH /management/employees', () => {
  it('không có quyền employees.view → 403', async () => {
    const u = await as('emp-none', {})
    expect((await u.get('/management/employees')).status).toBe(403)
  })

  it("scope 'own' → chỉ thấy hồ sơ nhân viên của chính mình", async () => {
    const self = await as('emp-own', { 'employees.view': 'own' })
    const other = await seedUser({ label: 'emp-other', grants: {} })
    await seedEmployee(self.user.id)
    await seedEmployee(other.id)
    const res = await self.get('/management/employees')
    expect(res.status).toBe(200)
    const data = (res.body as { data: { user_id: number }[] }).data
    expect(data).toHaveLength(1)
    expect(data[0].user_id).toBe(self.user.id)
  })

  it('theo id ngoài phạm vi → 404 (không 403)', async () => {
    const self = await as('emp-id', { 'employees.view': 'own' })
    const other = await seedUser({ label: 'emp-id-other', grants: {} })
    const otherEmp = await seedEmployee(other.id)
    expect((await self.get(`/management/employees/${otherEmp}`)).status).toBe(404)
  })

  it('không có quyền employees.manage → tạo nhân viên bị 403', async () => {
    const u = await as('emp-create-no', {})
    const res = await u.send('post', '/management/employees', { email: `new-no-${Date.now()}@contract.test`, full_name: 'NV Mới' })
    expect(res.status).toBe(403)
  })

  it('có quyền employees.manage → tạo nhân viên thành công (201)', async () => {
    const u = await as('emp-create-ok', { 'employees.manage': null })
    const res = await u.send('post', '/management/employees', { email: `new-ok-${Date.now()}@contract.test`, full_name: 'NV Mới' })
    expect(res.status).toBe(201)
    expect((res.body as { full_name: string }).full_name).toBe('NV Mới')
  })

  it('không có quyền employees.export → xuất Excel bị 403', async () => {
    const u = await as('emp-export-no', {})
    expect((await u.get('/management/employees/export')).status).toBe(403)
  })

  it('có employees.manage nhưng users.manage KHÔNG phủ target → PATCH 404 (chạm tài khoản liên kết)', async () => {
    const caller = await as('emp-patch', { 'employees.manage': null, 'users.manage': 'own' })
    const target = await seedUser({ label: 'emp-patch-target', grants: {} })
    const targetEmp = await seedEmployee(target.id)
    const res = await caller.send('patch', `/management/employees/${targetEmp}`, { full_name: 'Đổi tên' })
    expect(res.status).toBe(404)
  })
})

describe('GET/PATCH /management/attendance', () => {
  it('không có quyền attendance.view → 403', async () => {
    const u = await as('att-none', {})
    expect((await u.get('/management/attendance')).status).toBe(403)
  })

  it("scope 'own' → chỉ thấy bản ghi chấm công của chính mình", async () => {
    const self = await as('att-own', { 'attendance.view': 'own' })
    const other = await seedUser({ label: 'att-other', grants: {} })
    for (const id of [self.user.id, other.id]) await q(`INSERT INTO attendance_records (user_id, work_date, updated_at) VALUES ($1, now()::date, now())`, [id])
    const res = await self.get('/management/attendance')
    expect(res.status).toBe(200)
    const body = res.body as { data?: { user_id: number }[] } | { user_id: number }[]
    const rows = Array.isArray(body) ? body : (body.data ?? [])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.user_id === self.user.id)).toBe(true)
  })

  it('theo id ngoài phạm vi → 404 (không 403)', async () => {
    const self = await as('att-id', { 'attendance.view': 'own' })
    const other = await seedUser({ label: 'att-id-other', grants: {} })
    const [rec] = await q<{ id: number }>(`INSERT INTO attendance_records (user_id, work_date, updated_at) VALUES ($1, now()::date, now()) RETURNING id`, [other.id])
    expect((await self.get(`/management/attendance/${rec.id}`)).status).toBe(404)
  })

  it('GET settings — AuthOnly, mọi người đã đăng nhập đọc được', async () => {
    const u = await as('att-settings', {})
    expect((await u.get('/management/attendance/settings')).status).toBe(200)
  })

  it('không có quyền attendance.config → sửa cấu hình ca làm bị 403', async () => {
    const u = await as('att-config-no', {})
    expect((await u.send('patch', '/management/attendance/settings', { work_start: '08:30' })).status).toBe(403)
  })
})

describe('GET/POST /management/contracts', () => {
  it('không có quyền contracts.view → 403', async () => {
    const u = await as('ct-view-no', {})
    expect((await u.get('/management/contracts')).status).toBe(403)
  })

  it('có quyền contracts.view → 200', async () => {
    const u = await as('ct-view-ok', { 'contracts.view': 'all' })
    expect((await u.get('/management/contracts')).status).toBe(200)
  })

  it('không có quyền contracts.manage → thêm hợp đồng bị 403', async () => {
    const u = await as('ct-manage-no', {})
    expect((await u.send('post', '/management/contracts', { employee_id: 1, signed_date: '2026-01-01' })).status).toBe(403)
  })

  it('có quyền contracts.manage → thêm hợp đồng thành công (201)', async () => {
    const u = await as('ct-manage-ok', { 'contracts.manage': null })
    const empId = await seedEmployee(u.user.id)
    expect((await u.send('post', '/management/contracts', { employee_id: empId, signed_date: '2026-01-01' })).status).toBe(201)
  })
})

describe('GET/POST /management/recruitment/candidates', () => {
  it('không có quyền recruitment.view → 403', async () => {
    const u = await as('rc-view-no', {})
    expect((await u.get('/management/recruitment/candidates')).status).toBe(403)
  })

  it('có quyền recruitment.view → 200', async () => {
    const u = await as('rc-view-ok', { 'recruitment.view': null })
    expect((await u.get('/management/recruitment/candidates')).status).toBe(200)
  })

  it('không có quyền recruitment.manage → thêm ứng viên bị 403', async () => {
    const u = await as('rc-manage-no', {})
    expect((await u.send('post', '/management/recruitment/candidates', { full_name: 'Ứng viên A' })).status).toBe(403)
  })
})

describe('GET/POST /management/teams', () => {
  it('không có quyền org.manage → 403', async () => {
    const u = await as('tm-no', {})
    expect((await u.get('/management/teams')).status).toBe(403)
  })

  it('có quyền org.manage → 200', async () => {
    const u = await as('tm-ok', { 'org.manage': null })
    expect((await u.get('/management/teams')).status).toBe(200)
  })

  it('for-filter — AuthOnly, mọi người đã đăng nhập dùng được dropdown', async () => {
    const u = await as('tm-filter', {})
    expect((await u.get('/management/teams/for-filter')).status).toBe(200)
  })

  it('không có quyền org.manage → tạo team bị 403', async () => {
    const u = await as('tm-create-no', {})
    expect((await u.send('post', '/management/teams', { name: `Team ${Date.now()}` })).status).toBe(403)
  })
})

describe('GET/POST /management/job-titles', () => {
  const title = () => ({ category: 'Nhân viên', rank_code: `RC${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: 'Chuyên viên', symbol: 'CV', review_cycle_months: 6 })

  it('GET — AuthOnly, mọi người đã đăng nhập đọc được danh mục chức danh', async () => {
    const u = await as('jt-get', {})
    expect((await u.get('/management/job-titles')).status).toBe(200)
  })

  it('không có quyền org.manage → tạo chức danh bị 403', async () => {
    const u = await as('jt-no', {})
    expect((await u.send('post', '/management/job-titles', title())).status).toBe(403)
  })

  it('có quyền org.manage → tạo chức danh thành công (201)', async () => {
    const u = await as('jt-ok', { 'org.manage': null })
    expect((await u.send('post', '/management/job-titles', title())).status).toBe(201)
  })
})

describe('GET/PATCH /settings/departments', () => {
  it('GET — AuthOnly, mọi người đã đăng nhập đọc được', async () => {
    const u = await as('dp-get', {})
    expect((await u.get('/settings/departments')).status).toBe(200)
  })

  it('không có quyền org.manage → sửa danh sách phòng ban bị 403', async () => {
    const u = await as('dp-no', {})
    expect((await u.send('patch', '/settings/departments', { departments: ['Kinh doanh', 'Kế toán'] })).status).toBe(403)
  })

  it('có quyền org.manage → sửa danh sách phòng ban thành công (200)', async () => {
    const u = await as('dp-ok', { 'org.manage': null })
    expect((await u.send('patch', '/settings/departments', { departments: ['Kinh doanh', 'Kế toán'] })).status).toBe(200)
  })
})
