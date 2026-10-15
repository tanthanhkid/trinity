import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { Cleanup, prefix, requireWrite } from '../helpers/data'

/** Sản phẩm: tạo (UI) → mở popup chi tiết → sửa (UI) → xoá. */
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

interface Product {
  id: number
  code: string
  name: string
  price: number | null
}

test('tạo, xem chi tiết, sửa sản phẩm', async ({ page }) => {
  const name = prefix('sp')
  const code = `E2E-${Date.now()}`
  let id: number | null = null
  cleanup.add('xoá sản phẩm', async () => {
    if (id) await api.del(`/products/${id}`)
  })

  // TẠO (UI)
  await page.goto('/products')
  await page.getByRole('button', { name: 'Thêm sản phẩm' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.locator('input[name="code"]').fill(code)
  await dlg.locator('input[name="name"]').fill(name)
  await dlg.getByPlaceholder('VD: 500.000').fill('123456')
  await dlg.getByRole('button', { name: 'Tạo sản phẩm' }).click()
  await expect
    .poll(async () => {
      const list = await api.get<Product[]>('/products')
      const p = list.find((x) => x.name === name)
      id = p?.id ?? null
      return p?.price
    }, { message: 'Sản phẩm tạo qua UI phải có trong API với đúng giá', timeout: 20_000 })
    .toBe(123456)

  // CHI TIẾT (popup)
  await page.reload()
  const row = page.locator('tr, [role=row], article, li, div').filter({ hasText: name }).filter({ has: page.getByRole('button', { name: 'Xem chi tiết' }) }).last()
  await row.getByRole('button', { name: 'Xem chi tiết' }).click()
  const detail = page.getByRole('dialog')
  await expect(detail).toBeVisible()
  await expect(detail.getByText(name).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // SỬA (UI)
  await row.getByRole('button', { name: 'Sửa', exact: true }).click()
  const edit = page.getByRole('dialog')
  const newName = `${name}-sua`
  await edit.locator('input[name="name"]').fill(newName)
  await edit.getByRole('button', { name: /Lưu|Cập nhật/ }).first().click()
  await expect
    .poll(async () => (await api.get<Product>(`/products/${id}`)).name, { message: 'Tên sau khi sửa phải được lưu', timeout: 20_000 })
    .toBe(newName)

  expect(await api.del(`/products/${id}`)).toBeLessThan(300)
  id = null
})
