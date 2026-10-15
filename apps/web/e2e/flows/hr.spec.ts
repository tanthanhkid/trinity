import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { prefix, requireWrite } from '../helpers/data'
import { record, seeded } from '../helpers/manifest'

/**
 * NHÂN SỰ (nhân viên / hợp đồng / chức danh / tuyển dụng) — tài khoản HR. Dữ liệu seed (`E2E-…`) phải hiện đúng
 * trên giao diện; vòng đời tạo → sửa → xoá của ứng viên/vị trí; khoá nhân viên; hợp đồng chấm dứt.
 */
requireWrite()
test.use({ storageState: storageStatePath('HR') })

let api: Api
test.beforeAll(async () => {
  api = await Api.forRole('HR')
})
test.afterAll(async () => {
  await api.dispose()
})

const need = (kind: string) => {
  const e = seeded(kind)[0]
  test.skip(!e, `Chưa có dữ liệu seed "${kind}"`)
  return e
}

test('Quản lý nhân viên: nhân viên seed tìm được và hiện đúng', async ({ page }) => {
  const emp = need('employee')
  await page.goto('/management/employees')
  await page.getByPlaceholder('Tìm theo tên, email, SĐT...').fill(emp.label)
  await expect(page.getByText(emp.label).first()).toBeVisible({ timeout: 20_000 })
  const r = await api.get<{ data: { id: number; full_name: string; job_title_name: string | null; status: string }[] }>(`/management/employees?page_size=20&search=${encodeURIComponent(emp.label)}`)
  const row = r.data.find((e) => e.id === Number(emp.id))
  expect(row, 'API danh sách phải có nhân viên seed').toBeTruthy()
  expect(row!.job_title_name).toContain('E2E-')
})

test('Hợp đồng: hợp đồng seed hiện theo nhân viên; chấm dứt hợp đồng', async ({ page }) => {
  const emp = need('employee')
  const ct = need('contract')
  await page.goto('/management/contracts')
  await page.getByPlaceholder('Tìm theo mã / tên / email').fill(emp.label)
  await expect(page.getByText(emp.label).first()).toBeVisible({ timeout: 20_000 })
  await api.patch(`/management/contracts/${ct.id}`, { is_terminated: true })
  const got = await api.get<{ is_terminated: boolean }>(`/management/contracts/${ct.id}`)
  expect(got.is_terminated).toBe(true)
})

test('Chức danh: chức danh seed hiện trong Cấu hình chức danh', async ({ page }) => {
  const jt = need('job-title')
  await page.goto('/management/job-titles')
  await expect(page.getByText(jt.label).first()).toBeVisible({ timeout: 20_000 })
})

test('Tuyển dụng: ứng viên seed hiện; đổi giai đoạn; tạo + xoá ứng viên và vị trí', async ({ page }) => {
  const cand = need('candidate')
  await page.goto('/management/recruitment')
  await page.getByPlaceholder('Tìm tên, SĐT...').fill(cand.label)
  await expect(page.getByText(cand.label).first()).toBeVisible({ timeout: 20_000 })

  await api.patch(`/management/recruitment/candidates/${cand.id}`, { stage: 'interview' })
  const list = await api.get<{ data: { id: number; stage: string }[] }>(`/management/recruitment/candidates?page_size=100&search=${encodeURIComponent(cand.label)}`)
  expect(list.data.find((c) => c.id === Number(cand.id))?.stage).toBe('interview')

  // Vòng đời riêng (HR tạo, HR xoá)
  const name = prefix('ungvien-2')
  const c = await api.post<{ id: number }>('/management/recruitment/candidates', { full_name: name, stage: 'applied', phone: '0912345678' })
  record({ kind: 'candidate', id: c.id, label: name, as: 'HR', del: `/management/recruitment/candidates/${c.id}` })
  const recruiter = (await api.me()).user.id
  const posName = prefix('vitri')
  const pos = await api.post<{ id: number }>('/management/recruitment/positions', { job_code: `E2E-${Date.now()}`, department: 'E2E', position_title: posName, headcount: 2, recruiter_id: recruiter, opened_date: '2026-10-01' })
  record({ kind: 'position', id: pos.id, label: posName, as: 'HR', del: `/management/recruitment/positions/${pos.id}` })
  await api.patch(`/management/recruitment/positions/${pos.id}`, { status: 'closed' })
  const positions = await api.get<{ data: { id: number; status: string }[] }>('/management/recruitment/positions?page_size=100')
  expect(positions.data.find((p) => p.id === pos.id)?.status).toBe('closed')
  expect(await api.del(`/management/recruitment/candidates/${c.id}`)).toBeLessThan(300)
  expect(await api.del(`/management/recruitment/positions/${pos.id}`)).toBeLessThan(300)
})

test('Nhân viên: sửa chức vụ và khoá tài khoản (user_status đổi)', async () => {
  const emp = need('employee')
  await api.patch(`/management/employees/${emp.id}`, { position: 'E2E-chuc-vu-moi' })
  const got = await api.get<{ position: string; user_status: string }>(`/management/employees/${emp.id}`)
  expect(got.position).toBe('E2E-chuc-vu-moi')
  await api.patch(`/management/employees/${emp.id}/lock`)
  const locked = await api.get<{ user_status: string; status: string }>(`/management/employees/${emp.id}`)
  expect(locked.user_status, 'sau khoá user_status phải là locked').toBe('locked')
})

test('Thống kê nhân sự + chấm công HR mở được, API trả đúng dạng', async ({ page }) => {
  await page.goto('/management/employees/stats')
  await expect(page.getByRole('heading', { name: /Thống kê nhân viên/ }).first()).toBeVisible({ timeout: 20_000 })
  const s = await api.call('GET', '/management/attendance/settings')
  expect(s.status()).toBe(200)
  expect(await s.json()).toMatchObject({ work_start: expect.any(String), work_end: expect.any(String) })
})
