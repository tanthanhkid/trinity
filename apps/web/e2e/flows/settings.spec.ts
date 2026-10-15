import { test, expect, request as pwRequest } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api, BASE_URL } from '../helpers/api'
import { prefix, requireWrite } from '../helpers/data'
import { record, recordSoft, seeded } from '../helpers/manifest'
import { throwawayPassword } from '../seed/lib'
import { bypassHeaders } from '../helpers/vercel-bypass'

/**
 * CÀI ĐẶT — (1) vai trò hẹp → user đăng nhập thấy/được phép đúng (API + UI) và quyền đổi NGAY khi sửa vai trò;
 * (2) tuỳ chọn danh mục (nguồn khách); (3) khoá API thứ 3 (hiện 1 lần, thu hồi); (4) công tắc tính năng tổ chức
 * (tắt `newsfeed` → ẩn menu + chặn URL, BE vẫn phục vụ; luôn khôi phục).
 */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN') })
test.describe.configure({ mode: 'serial' })

let api: Api
test.beforeAll(async () => {
  api = await Api.forRole('ADMIN')
})
test.afterAll(async () => {
  await api.dispose()
})

test('vai trò hẹp: user chỉ thấy theo quyền; sửa quyền có hiệu lực NGAY (không đăng nhập lại)', async ({ browser }) => {
  const narrow = seeded('narrow-user')[0]
  test.skip(!narrow, 'Chưa seed user hẹp')
  const email = String(narrow.meta?.email)
  const roleId = Number(narrow.meta?.role_id)
  const anon = await pwRequest.newContext({ extraHTTPHeaders: bypassHeaders() })
  const login = await anon.post(`${BASE_URL}/api/v1/auth/login`, { data: { email, password: throwawayPassword(email) } })
  expect(login.ok(), `đăng nhập user hẹp: HTTP ${login.status()}`).toBe(true)
  const token = ((await login.json()) as { access_token: string }).access_token
  const get = (url: string) => anon.get(`${BASE_URL}/api/v1${url}`, { headers: { Authorization: `Bearer ${token}` } })

  const me = (await (await get('/auth/me')).json()) as { permissions: Record<string, unknown> }
  expect(Object.keys(me.permissions)).toEqual(['contacts.view'])
  expect(me.permissions['contacts.view']).toBe('own')
  expect((await get('/contacts?limit=5')).status()).toBe(200)
  for (const url of ['/deals?limit=1', '/management/employees?page_size=1', '/payslips?month=2026-10', '/roles', '/api-keys']) {
    expect((await get(url)).status(), `${url} không thuộc vai trò hẹp → 403`).toBe(403)
  }

  // UI: đăng nhập thật bằng trình duyệt riêng — menu chỉ còn mục theo quyền, vào thẳng /payroll bị chặn
  const ctx = await browser.newContext({ locale: 'vi-VN' })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', throwawayPassword(email))
  await expect(page.locator('button[type="submit"]')).toBeEnabled()
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 })
  await page.goto('/dashboard')
  await expect(page.locator('a[href="/contacts"]').first()).toBeVisible({ timeout: 20_000 })
  for (const href of ['/payroll?tab=reports', '/management/employees', '/kanban', '/reports']) await expect(page.locator(`a[href="${href}"]`)).toHaveCount(0)
  await page.goto('/payroll')
  await expect(page.getByText(/Bạn không có quyền truy cập trang này/)).toBeVisible({ timeout: 20_000 })
  await ctx.close()

  // Sửa quyền vai trò → có hiệu lực ngay với CÙNG token
  await api.put(`/roles/${roleId}/grants`, { grants: { 'contacts.view': 'own', 'deals.view': 'own' } })
  await expect.poll(async () => (await get('/deals?limit=1')).status(), { message: 'thêm deals.view → /deals 200 ngay', timeout: 15_000 }).toBe(200)
  await api.put(`/roles/${roleId}/grants`, { grants: { 'contacts.view': 'own' } })
  await expect.poll(async () => (await get('/deals?limit=1')).status(), { message: 'bỏ deals.view → /deals 403 ngay', timeout: 15_000 }).toBe(403)

  // Chống leo thang: user hẹp không tạo được vai trò / gán vai trò
  expect((await anon.post(`${BASE_URL}/api/v1/roles`, { headers: { Authorization: `Bearer ${token}` }, data: { name: 'E2E-leo-thang', grants: { 'contacts.view': 'all' } } })).status()).toBe(403)
  await anon.dispose()
})

test('tuỳ chọn danh mục: tạo nguồn khách, hiện trong danh sách, vô hiệu hoá', async () => {
  const value = `e2e_${Date.now()}`
  const label = prefix('nguon')
  const r = await api.post<{ id: number }>('/settings/options', { group_key: 'contact_source', value, label })
  record({ kind: 'option', id: r.id, label, del: `/settings/options/${r.id}`, soft: { table: 'setting_options', note: 'vô hiệu hoá (is_active=false), không xoá hẳn được qua API' } })
  const list = await api.get<{ data: { id: number; label: string }[] }>('/settings/options?group=contact_source&active=true')
  expect(list.data.some((o) => o.id === r.id)).toBe(true)
  expect((await api.call('POST', '/settings/options', { group_key: 'contact_source', value, label })).status(), 'trùng group+value → 409').toBe(409)
  expect(await api.del(`/settings/options/${r.id}`)).toBeLessThan(300)
  const after = await api.get<{ data: { id: number }[] }>('/settings/options?group=contact_source&active=true')
  expect(after.data.some((o) => o.id === r.id), 'đã vô hiệu hoá → không còn trong danh sách đang dùng').toBe(false)
})

test('khoá API thứ 3: plain_key hiện MỘT lần, danh sách chỉ có tiền tố, thu hồi được', async () => {
  const admin = await api.me()
  const sale = await Api.forRole('SALE')
  const ownerId = (await sale.me()).user.id
  await sale.dispose()
  const name = prefix('khoa-api')
  // Quản trị KHÔNG được làm owner khoá API (cố ý: tránh mint khoá full-access) — chủ khoá phải là user có contacts.create.
  expect((await api.call('POST', '/api-keys', { name, scopes: ['contacts:create'], owner_user_id: admin.user.id })).status(), 'Quản trị làm owner → 400').toBe(400)
  const k = await api.post<{ id: number; plain_key: string; prefix: string; scopes: string[] }>('/api-keys', { name, scopes: ['contacts:create'], owner_user_id: ownerId })
  recordSoft('api-key', k.id, name, 'api_keys', 'thu hồi (revoked_at), không có API xoá hẳn', `/api-keys/${k.id}`)
  expect(k.plain_key.length).toBeGreaterThan(20)
  const list = await api.get<{ id: number; plain_key?: string; prefix: string }[]>('/api-keys')
  const row = list.find((x) => x.id === k.id)!
  expect(row.prefix).toBe(k.prefix)
  expect(JSON.stringify(list), 'danh sách khoá không được lộ plain_key').not.toContain(k.plain_key)
  expect((await api.call('POST', '/api-keys', { name, scopes: ['khong-co-scope'], owner_user_id: ownerId })).status(), 'scope lạ → 400').toBe(400)
  expect(await api.del(`/api-keys/${k.id}`)).toBeLessThan(300)
  const after = (await api.get<{ id: number; revoked_at: string | null }[]>('/api-keys')).find((x) => x.id === k.id)
  expect(after?.revoked_at, 'sau thu hồi phải có revoked_at').toBeTruthy()
})

// Bật/tắt công tắc tổ chức là THAY ĐỔI TOÀN CỤC: chỉ chạy khi không có project đọc chạy song song (pha `flows` của e2e:full,
// hoặc E2E_ISOLATED=1 khi chạy riêng `--project=flows`).
const ISOLATED = process.env.E2E_PHASE === 'flows' || process.env.E2E_ISOLATED === '1'

test('công tắc tính năng: tắt `newsfeed` → ẩn menu + chặn URL (BE vẫn phục vụ); bật lại khôi phục', async ({ page }) => {
  test.skip(!ISOLATED, 'Đổi công tắc tổ chức ảnh hưởng smoke/rbac chạy song song — chạy bằng `pnpm e2e:full` (pha flows) hoặc E2E_ISOLATED=1 với --project=flows')
  const original = await api.get<Record<string, boolean>>('/settings/org-features')
  // Luôn khôi phục kể cả khi test chết giữa chừng (cleanup chạy `pre`).
  record({ kind: 'org-features', id: 'newsfeed', label: 'khôi phục công tắc newsfeed', pre: [{ method: 'PUT', url: '/settings/org-features', data: { newsfeed: original.newsfeed } }] })
  try {
    expect((await api.call('PUT', '/settings/org-features', { khong_co_khoa: true })).status(), 'khoá lạ → 400').toBe(400)
    expect((await api.call('PUT', '/settings/org-features', { newsfeed: 'off' })).status(), 'không phải boolean → 400').toBe(400)
    const after = await api.put<Record<string, boolean>>('/settings/org-features', { newsfeed: false })
    expect(after.newsfeed).toBe(false)
    expect(after.kanban, 'khoá khác không bị đụng').toBe(original.kanban)

    await page.goto('/dashboard')
    await expect(page.locator('a[href="/contacts"]').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('a[href="/newsfeed"]'), 'newsfeed tắt → menu phải ẩn').toHaveCount(0)
    await page.goto('/newsfeed')
    await expect(page.getByText('Tính năng “Bảng tin” đang tắt')).toBeVisible({ timeout: 20_000 })
    expect((await api.call('GET', '/newsfeed?limit=1')).status(), 'BE không dùng công tắc thay quyền').toBe(200)
  } finally {
    await api.put('/settings/org-features', { newsfeed: original.newsfeed })
  }
  await page.goto('/dashboard')
  await expect(page.locator('a[href="/newsfeed"]').first()).toBeVisible({ timeout: 20_000 })
  await page.goto('/newsfeed')
  await expect(page.getByRole('heading', { name: /Bảng tin/ }).first()).toBeVisible({ timeout: 20_000 })
})
