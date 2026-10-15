import { test, expect, type Page } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { recordSoft } from '../helpers/manifest'
import { Cleanup, fakePhone, prefix, requireWrite } from '../helpers/data'

/** Khách hàng: tạo (UI) → sửa (UI) → xoá. Dữ liệu `E2E-…` luôn được dọn qua API ở afterAll. */
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

async function pickFirstOption(page: Page, label: RegExp) {
  await page.locator('label').filter({ hasText: label }).locator('xpath=following::button[1]').click()
  await page.getByRole('option').first().click()
}

test('tạo → sửa → xoá khách hàng', async ({ page }) => {
  const name = prefix('khach')
  const phone = fakePhone()
  let id: number | null = null
  cleanup.add('xoá khách (phòng khi test dừng giữa chừng)', async () => {
    if (id) await api.del(`/contacts/${id}`)
  })

  // TẠO qua UI
  await page.goto('/contacts/new')
  await page.fill('input[name="phone"]', phone)
  await page.fill('input[name="full_name"]', name)
  await pickFirstOption(page, /^Nguồn/)
  await page.getByRole('button', { name: 'Lưu' }).click()
  await expect.poll(async () => {
    const r = await api.get<{ data: { id: number; full_name: string }[] }>(`/contacts?limit=50&search=${encodeURIComponent(name)}`)
    id = r.data.find((c) => c.full_name === name)?.id ?? null
    return id
  }, { message: 'Khách vừa tạo phải xuất hiện trong API', timeout: 20_000 }).not.toBeNull()

  recordSoft('contact', id!, name, 'contacts', 'xoá mềm (deleted_at)')

  // XEM trong danh sách (UI)
  await page.goto('/contacts')
  await expect(page.getByText(name).first(), 'Khách mới phải hiện trong danh sách').toBeVisible({ timeout: 20_000 })

  // SỬA qua UI (trang chi tiết → Chỉnh sửa)
  await page.goto(`/contacts/${id}`)
  await page.getByRole('button', { name: 'Chỉnh sửa' }).click()
  const newName = `${name}-sua`
  await page.getByPlaceholder('Nguyễn Văn A').fill(newName)
  await page.getByRole('button', { name: /^Lưu( thay đổi)?$/ }).click()
  await expect.poll(async () => (await api.get<{ full_name: string }>(`/contacts/${id}`)).full_name, { timeout: 15_000 }).toBe(newName)

  // XOÁ
  expect(await api.del(`/contacts/${id}`)).toBeLessThan(300)
  const after = await api.call('GET', `/contacts/${id}`)
  expect(after.status(), 'Khách đã xoá không còn truy cập được').toBeGreaterThanOrEqual(400)
  id = null
})
