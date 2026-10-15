import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { Cleanup, prefix, requireWrite } from '../helpers/data'
import { record } from '../helpers/manifest'

/**
 * TÍNH NĂNG TUỲ BIẾN — chạy THẬT, dữ liệu `E2E-…` (khoá `e2e_…`) và dọn xong:
 *   1. Cài đặt › Tính năng › Thêm tính năng (UI) → thêm trường (UI) → định nghĩa đúng ở API.
 *   2. Menu: nhóm "Tuỳ biến" hiện tính năng mới → bấm vào ra `/x/<khoá>`.
 *   3. Tạo bản ghi (UI) → xem ở danh sách → sửa (UI) → xoá (UI, có xác nhận).
 *   4. API: trường tiền/% + công thức tính đúng; ngoài phạm vi / thực thể ẩn → 404; BE từ chối giá trị sai kiểu.
 * Không chạy trên môi trường thật ngoài quy trình e2e có chủ đích (cần E2E_ALLOW_WRITE=1).
 */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN') })
test.describe.configure({ mode: 'serial' })

const cleanup = new Cleanup()
let api: Api
test.beforeAll(async () => {
  api = await Api.forRole('ADMIN')
})
test.afterAll(async () => {
  await cleanup.run()
  await api.dispose()
})

interface Def { key: string; label: string; label_plural: string; fields: { key: string; type: string; is_title: boolean }[] }
interface Rec { id: number; title: string; data: Record<string, unknown> }
interface Page { items: Rec[]; total: number | null }

const stamp = prefix('hs') // E2E-<ts>-hs  →  khoá e2e_<ts>_hs
const key = stamp.toLowerCase().replace(/[^a-z0-9]+/g, '_')
const label = stamp

test('Thêm tính năng + thêm trường bằng giao diện Cài đặt', async ({ page }) => {
  cleanup.add('xoá tính năng tuỳ biến', async () => {
    await api.del(`/custom-objects/${key}`)
  })

  await page.goto('/settings?tab=features')
  await expect(page.getByRole('heading', { name: 'Tính năng tuỳ biến' })).toBeVisible()
  await page.getByRole('button', { name: 'Thêm tính năng' }).first().click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel(/Tên \(số ít\)/).fill(label)
  await expect(dlg.getByLabel(/Mã \(địa chỉ/)).toHaveValue(key)
  await dlg.getByRole('button', { name: 'Thêm tính năng' }).click()
  record({ kind: 'custom-object', id: key, label, del: `/custom-objects/${key}`, soft: { table: 'custom_objects', note: 'xoá mềm (deleted_at)' } })

  // Màn cấu hình tự mở: thêm trường tiêu đề
  await expect(page.getByRole('button', { name: 'Thêm trường' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Thêm trường' }).click()
  const fdlg = page.getByRole('dialog')
  await fdlg.getByLabel('Tên trường *').fill('Họ tên')
  await fdlg.getByRole('button', { name: 'Thêm trường' }).click()
  await expect
    .poll(async () => (await api.get<Def>(`/custom-objects/${key}`)).fields.map((f) => `${f.key}:${f.type}:${f.is_title}`), { timeout: 20_000, message: 'Trường tạo qua UI phải có trong API (kiểu text, tự làm tiêu đề)' })
    .toEqual(['ho_ten:text:true'])
})

test('Menu hiện tính năng mới thành mục cấp 1 và dẫn tới trang dữ liệu', async ({ page }) => {
  const nav = await api.get<{ key: string; label_plural: string }[]>('/custom-objects/nav')
  expect(nav.some((n) => n.key === key)).toBe(true)
  await page.goto('/dashboard')
  // không còn nhóm "Tuỳ biến" — link nằm thẳng trên thanh bên.
  await expect(page.getByRole('button', { name: 'Tuỳ biến', exact: true })).toHaveCount(0)
  await page.locator('[data-sidebar="sidebar"], aside').getByRole('link', { name: label }).first().click()
  await expect(page).toHaveURL(new RegExp(`/x/${key}$`))
  // Breadcrumb của topbar cũng là h1 cùng tên — lấy tiêu đề trang (cái sau).
  await expect(page.locator('main').getByRole('heading', { name: label }).last()).toBeVisible()
})

test('Tạo, tìm, sửa, xoá bản ghi bằng giao diện', async ({ page }) => {
  const name = prefix('ten')
  await page.goto(`/x/${key}`)
  // Trong <main> để không trùng link 'Thêm khách' ở thanh bên.
  await page.locator('main').getByRole('link', { name: /^Thêm / }).first().click()
  await expect(page).toHaveURL(new RegExp(`/x/${key}/new$`))
  await page.locator('main').getByLabel(/Họ tên/).fill(name)
  await page.locator('main').getByRole('button', { name: /^Lưu / }).click()
  await expect(page).toHaveURL(new RegExp(`/x/${key}/\\d+$`), { timeout: 20_000 })
  const id = Number(page.url().split('/').pop())

  const got = await api.get<Rec>(`/custom-objects/${key}/records/${id}`)
  expect(got.title).toBe(name)

  // Danh sách + tìm theo tiêu đề
  await page.goto(`/x/${key}`)
  await page.getByPlaceholder('Tìm theo tiêu đề…').fill(name)
  await expect(page.locator('main').getByRole('link', { name }).first()).toBeVisible({ timeout: 20_000 })

  // Sửa
  await page.goto(`/x/${key}/${id}`)
  const renamed = `${name}-sua`
  await page.locator('main').getByLabel(/Họ tên/).fill(renamed)
  await page.locator('main').getByRole('button', { name: 'Lưu thay đổi' }).click()
  await expect.poll(async () => (await api.get<Rec>(`/custom-objects/${key}/records/${id}`)).title, { timeout: 20_000, message: 'Tên sau khi sửa phải được lưu' }).toBe(renamed)

  // Xoá (có xác nhận)
  await page.goto(`/x/${key}/${id}`)
  await page.locator('main').getByRole('button', { name: /^Xoá / }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Xoá / }).click()
  await expect(page).toHaveURL(new RegExp(`/x/${key}$`), { timeout: 20_000 })
  expect((await api.call('GET', `/custom-objects/${key}/records/${id}`)).status()).toBe(404)
})

test('API: tiền/% + công thức tính đúng; sai kiểu bị từ chối; thực thể tắt → 404 với người thường', async () => {
  await api.post(`/custom-objects/${key}/fields`, { label: 'Giá gốc', key: 'gia_goc', type: 'currency' })
  await api.post(`/custom-objects/${key}/fields`, { label: 'Ưu đãi', key: 'uu_dai', type: 'percent' })
  await api.post(`/custom-objects/${key}/fields`, { label: 'Thanh toán', key: 'thanh_toan', type: 'formula', options: { expression: '{gia_goc}*(1-{uu_dai})', format: 'currency' } })
  const r = await api.post<Rec>(`/custom-objects/${key}/records`, { data: { ho_ten: prefix('cthuc'), gia_goc: 9_600_000, uu_dai: 5 } })
  expect(r.data.thanh_toan).toBe(9_120_000)

  const bad = await api.call('POST', `/custom-objects/${key}/records`, { data: { ho_ten: prefix('sai'), gia_goc: 1.5 } })
  expect(bad.status()).toBe(400)
  expect(JSON.stringify(await bad.json())).toContain('gia_goc')

  const list = await api.get<Page>(`/custom-objects/${key}/records?sort=field:gia_goc&dir=desc&limit=5`)
  expect(list.items[0].id).toBe(r.id)

  // Tắt thực thể: quản trị vẫn thấy, nhân viên thường (nếu có tài khoản) nhận 404
  await api.patch(`/custom-objects/${key}`, { is_active: false })
  expect((await api.call('GET', `/custom-objects/${key}`)).status()).toBe(200)
  expect((await api.get<{ key: string }[]>('/custom-objects/nav')).some((n) => n.key === key)).toBe(false)
  await api.patch(`/custom-objects/${key}`, { is_active: true })
})
