import { test, expect, request as pwRequest } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api, BASE_URL } from '../helpers/api'
import { mkUser } from '../seed/lib'
import { Cleanup, prefix, requireWrite } from '../helpers/data'
import { bypassHeaders } from '../helpers/vercel-bypass'

/**
 * Cài đặt > Vai trò: tạo vai trò (UI) → tick quyền (UI) → gán cho user test → `/auth/me`
 * của user đó đổi NGAY (không đăng nhập lại) → gỡ gán → xoá vai trò + user test.
 */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN') })

const cleanup = new Cleanup()
let api: Api
test.beforeAll(async () => {
  api = await Api.forRole('ADMIN')
})
test.afterAll(async () => {
  await cleanup.run()
  await api.dispose()
})

test('tạo vai trò, tick quyền, gán cho user test, /auth/me đổi ngay', async ({ page }) => {
  const roleName = prefix('vaitro')
  let roleId: number | null = null
  let userId: number | null = null
  cleanup.add('xoá user test', async () => {
    if (userId) await api.del(`/users/${userId}/permanent`)
  })
  cleanup.add('xoá vai trò', async () => {
    if (userId) await api.put(`/users/${userId}/roles`, { roleIds: [] }).catch(() => undefined)
    if (roleId) await api.del(`/roles/${roleId}`)
  })

  // TẠO vai trò qua UI
  await page.goto('/settings?tab=roles')
  await page.getByRole('button', { name: 'Tạo vai trò' }).click()
  await page.getByPlaceholder(/Ví dụ: Kế toán/).fill(roleName)
  await page.getByRole('button', { name: 'Tạo', exact: true }).click()
  await expect(page.getByText(roleName).first()).toBeVisible({ timeout: 20_000 })
  const roles = await api.get<{ id: number; name: string }[]>('/roles')
  roleId = roles.find((r) => r.name === roleName)?.id ?? null
  expect(roleId, 'Vai trò vừa tạo phải có trong API').not.toBeNull()

  // TICK quyền qua UI: "Xem khách hàng" + "Tạo/sửa deal"
  await page.locator('input[aria-label="Xem khách hàng"]:not([disabled])').first().check()
  await page.locator('input[aria-label="Tạo/sửa deal"]:not([disabled])').first().check()
  const saveBtn = page.getByRole('button', { name: /^Lưu/ })
  if (await saveBtn.count()) await saveBtn.first().click()
  await expect
    .poll(async () => (await api.get<{ grants: Record<string, unknown> }>(`/roles/${roleId}`)).grants, {
      message: 'Quyền tick trên UI phải được lưu',
      timeout: 20_000,
    })
    .toMatchObject({ 'contacts.view': expect.anything(), 'deals.manage': true })

  // User test + token riêng
  // mkUser ghi manifest cả user lẫn hồ sơ nhân viên đi kèm (POST /users tự tạo) để cleanup xoá luôn.
  const u = await mkUser(api, 'user')
  const { email, password } = u
  userId = u.id
  const anon = await pwRequest.newContext({ extraHTTPHeaders: bypassHeaders() })
  const login = await anon.post(`${BASE_URL}/api/v1/auth/login`, { data: { email, password } })
  expect(login.ok(), `Đăng nhập user test: HTTP ${login.status()}`).toBe(true)
  const token = ((await login.json()) as { access_token: string }).access_token
  const meOf = async () =>
    (await (await anon.get(`${BASE_URL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      permissions: Record<string, unknown>
    }
  expect((await meOf()).permissions['deals.manage'], 'Trước khi gán: chưa có deals.manage').toBeUndefined()

  // GÁN vai trò → /auth/me đổi NGAY (cùng token)
  await api.put(`/users/${userId}/roles`, { roleIds: [roleId] })
  await expect.poll(async () => (await meOf()).permissions['deals.manage'], { message: '/auth/me phải phản ánh quyền mới ngay', timeout: 15_000 }).toBe(true)

  // GỠ → mất quyền ngay
  await api.put(`/users/${userId}/roles`, { roleIds: [] })
  await expect.poll(async () => (await meOf()).permissions['deals.manage'], { timeout: 15_000 }).toBeUndefined()
  await anon.dispose()

  // XOÁ vai trò
  expect(await api.del(`/roles/${roleId}`)).toBeLessThan(300)
  roleId = null
})
