import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { recordSoft } from '../helpers/manifest'
import { Cleanup, prefix, requireWrite } from '../helpers/data'

/** Công việc (kanban): tạo thẻ → mở chi tiết → checklist → kéo sang cột khác → xoá. */
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

interface Board {
  id: number
  name: string
  columns: { id: number; name: string; is_archived: boolean }[]
}

test('tạo thẻ, mở chi tiết, checklist, kéo sang cột khác', async ({ page }) => {
  const boards = await api.get<{ id: number; name: string }[]>('/kanban/boards')
  const board = await api.get<Board>(`/kanban/boards/${boards[0].id}`)
  const cols = board.columns.filter((c) => !c.is_archived)
  test.skip(cols.length < 2, 'Board đầu tiên cần ≥ 2 cột để kiểm kéo thả')
  const title = prefix('the')
  let cardId: number | null = null
  cleanup.add('xoá thẻ', async () => {
    if (cardId) await api.del(`/kanban/cards/${cardId}`)
  })

  // TẠO thẻ ở cột đầu (UI)
  await page.goto('/kanban')
  await page.getByRole('button', { name: 'Thêm card' }).first().click()
  await page.getByPlaceholder('Tiêu đề card…').fill(title)
  await page.keyboard.press('Enter')
  // `.first()` có thể trúng nút "Thêm card" ở đầu trang (mở hộp thoại, Enter không gửi) thay vì ô thêm nhanh trong cột.
  const dlg = page.getByRole('dialog')
  if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: 'Thêm card' }).click()
  await expect
    .poll(async () => {
      const r = await api.get<{ cards: { id: number; title: string; column_id: number }[] }>(`/kanban/cards?board_id=${board.id}&limit=100`)
      const c = r.cards.find((x) => x.title === title)
      cardId = c?.id ?? null
      return c?.column_id
    }, { message: 'Thẻ tạo qua UI phải có trong API', timeout: 20_000 })
    .toBe(cols[0].id)
  recordSoft('kanban-card', cardId!, title, 'kanban_cards', 'xoá mềm (deleted_at)')

  // MỞ chi tiết + checklist (UI)
  await page.reload()
  await page.getByText(title).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Thêm mục' }).click()
  const item = `${title}-muc`
  await page.keyboard.type(item)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => {
      const items = await api.get<{ content?: string; title?: string; text?: string }[]>(`/kanban/cards/${cardId}/checklist-items`)
      return items.some((i) => (i.content ?? i.title ?? i.text) === item)
    }, { message: 'Mục checklist phải được lưu', timeout: 20_000 })
    .toBe(true)
  await dialog.getByRole('button', { name: 'Đóng' }).click()

  // KÉO sang cột khác bằng chuột thật (dnd-kit cần di chuyển từng bước nhỏ để kích hoạt sensor)
  await page.reload()
  const card = page.getByText(title).first()
  await expect(card).toBeVisible()
  const target = page.getByText(cols[1].name, { exact: true }).first()
  const from = (await card.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 25 })
  await page.mouse.up()
  await expect
    .poll(async () => (await api.get<{ column_id: number }>(`/kanban/cards/${cardId}`)).column_id, {
      message: `Kéo thẻ sang cột "${cols[1].name}" không đổi cột trong API`,
      timeout: 20_000,
    })
    .toBe(cols[1].id)

  // XOÁ
  expect(await api.del(`/kanban/cards/${cardId}`)).toBeLessThan(300)
  cardId = null
})
