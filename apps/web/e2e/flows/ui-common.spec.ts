import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { recordSoft } from '../helpers/manifest'
import { Cleanup, fakePhone, prefix, requireWrite } from '../helpers/data'

/**
 * Component dùng chung: InlineSelect (chọn board kanban), VnDateTimeInput (Hạn xử lý của thẻ),
 * VnDateInput (ngày sinh khách) — luôn hiển thị `dd/mm/yyyy` DÙ trình duyệt ở locale en-US.
 */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN'), locale: 'en-US' })

const cleanup = new Cleanup()
let api: Api
test.beforeAll(async () => {
  api = await Api.forRole('ADMIN')
})
test.afterAll(async () => {
  await cleanup.run()
  await api.dispose()
})

test('InlineSelect: đổi board kanban qua dropdown', async ({ page }) => {
  const boards = await api.get<{ id: number; name: string }[]>('/kanban/boards')
  test.skip(boards.length < 2, 'Cần ≥ 2 board để kiểm đổi board')
  await page.goto('/kanban')
  const picker = page.getByLabel('Chọn board')
  await expect(picker).toBeVisible()
  const current = (await picker.textContent()) ?? ''
  const other = boards.find((b) => !current.includes(b.name))!
  await picker.click()
  await page.getByRole('option', { name: new RegExp(other.name) }).or(page.getByText(other.name, { exact: false }).last()).first().click()
  await expect(picker).toContainText(other.name)
})

test('VnDateTimeInput: Hạn xử lý hiển thị dd/mm/yyyy HH:mm và lưu đúng giờ VN', async ({ page }) => {
  const boards = await api.get<{ id: number }[]>('/kanban/boards')
  const board = await api.get<{ id: number; columns: { id: number; is_archived: boolean }[] }>(`/kanban/boards/${boards[0].id}`)
  const col = board.columns.find((c) => !c.is_archived)!
  const title = prefix('han')
  const card = await api.post<{ id: number }>('/kanban/cards', { column_id: col.id, title })
  recordSoft('kanban-card', card.id, title, 'kanban_cards', 'xoá mềm (deleted_at)')
  cleanup.add('xoá thẻ', async () => api.del(`/kanban/cards/${card.id}`))

  await page.goto('/kanban')
  await page.getByText(title).first().click()
  const due = page.getByPlaceholder('dd/mm/yyyy HH:mm')
  await due.fill('15/03/2027 09:30')
  await due.blur()
  await expect
    .poll(async () => (await api.get<{ due_at: string | null }>(`/kanban/cards/${card.id}`)).due_at, { timeout: 20_000 })
    .toBe('2027-03-15T02:30:00.000Z') // 09:30 giờ VN (UTC+7)
  await page.reload()
  await page.getByText(title).first().click()
  await expect(page.getByPlaceholder('dd/mm/yyyy HH:mm')).toHaveValue('15/03/2027 09:30')
})

test('VnDateInput: ngày sinh khách nhập/hiển thị dd/mm/yyyy', async ({ page }) => {
  // source_id: lấy từ khách mẫu nếu có, không thì dùng nguồn id=1 (nguồn mặc định của seed).
  const sample = await api.get<{ data: { source?: { id: number } }[] }>('/contacts?limit=1')
  const sourceId = sample.data[0]?.source?.id ?? 1
  const name = prefix('ngay')
  const c = (await api.post<{ contact: { id: number } }>('/contacts', { phone: fakePhone(), full_name: name, source_id: sourceId })).contact
  recordSoft('contact', c.id, name, 'contacts', 'xoá mềm (deleted_at)')
  cleanup.add('xoá khách', async () => api.del(`/contacts/${c.id}`))

  await page.goto(`/contacts/${c.id}`)
  await page.getByRole('button', { name: 'Chỉnh sửa' }).click()
  const birthday = page.getByPlaceholder(/ngày\/tháng\/năm/)
  await birthday.fill('15/03/1990')
  await page.getByRole('button', { name: /^Lưu( thay đổi)?$/ }).click()
  await expect
    .poll(async () => (await api.get<{ birthday: string | null }>(`/contacts/${c.id}`)).birthday ?? '', { timeout: 20_000 })
    .toContain('1990-03-15')
  await page.reload()
  await page.getByRole('button', { name: 'Chỉnh sửa' }).click()
  await expect(page.getByPlaceholder(/ngày\/tháng\/năm/)).toHaveValue('15/03/1990')
})
