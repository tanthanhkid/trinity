import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { recordSoft } from '../helpers/manifest'
import { Cleanup, prefix, requireWrite } from '../helpers/data'

/**
 * POS: mở ca → tạo đơn → thanh toán tiền mặt → đóng ca. CHỈ chạy khi quán chưa có ca đang mở
 * và có món trong menu — nếu môi trường đang có ca (dữ liệu của người khác) thì SKIP có lý do,
 * KHÔNG đụng vào (ca/đơn đã thu không xoá được nên không thể "dọn" như các luồng khác).
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

test('mở ca, tạo đơn, thanh toán, đóng ca', async ({ page }) => {
  const cur = await api.get<{ shift: { id: number; status: string } | null }>('/pos/shifts/current')
  test.skip(!!cur.shift && cur.shift.status === 'open', `Đã có ca đang mở (#${cur.shift?.id}) — không đụng dữ liệu POS đang dùng`)
  const menu = await api.get<{ items?: { id: number; price: number }[] } | { id: number; price: number }[]>('/pos/menu')
  const items = Array.isArray(menu) ? menu : (menu.items ?? [])
  test.skip(items.length === 0, 'Quán chưa cấu hình món trong menu POS')

  const opening = 100_000
  const shift = await api.post<{ id: number }>('/pos/shifts/open', { opening_cash: opening })
  recordSoft('pos-shift', shift.id, 'ca POS E2E', 'pos_shifts', 'ca POS không có API xoá (đã đóng)')
  let closed = false
  cleanup.add('đóng ca', async () => {
    if (!closed) await api.post(`/pos/shifts/${shift.id}/close`, { closing_cash_counted: opening })
  })

  await page.goto('/pos')
  await expect(page.getByRole('button', { name: 'Thanh toán' })).toBeVisible()

  const order = await api.post<{ id: number; total?: number }>('/pos/orders', {
    order_type: 'takeaway',
    items: [{ product_id: items[0].id, quantity: 1 }],
  })
  recordSoft('pos-order', order.id, 'đơn POS E2E', 'pos_orders (+ pos_order_items, pos_payments)', 'đơn đã thanh toán, không có API xoá')
  const detail = await api.get<{ total: number }>(`/pos/orders/${order.id}`)
  await api.post(`/pos/orders/${order.id}/pay`, { payments: [{ method: 'cash', amount: detail.total, tendered: detail.total }] })
  const paid = await api.get<{ status: string }>(`/pos/orders/${order.id}`)
  expect(paid.status).toBe('paid')

  await page.goto('/pos')
  await page.getByRole('button', { name: 'Ca', exact: true }).click()
  await expect(page.locator('main').last()).toContainText(/Ca|ca/)

  await api.post(`/pos/shifts/${shift.id}/close`, { closing_cash_counted: opening + detail.total })
  closed = true
  expect(prefix('pos')).toMatch(/^E2E-/) // đơn/ca POS là dữ liệu vĩnh viễn (không xoá được): chỉ chạy khi quán trống ca
})
