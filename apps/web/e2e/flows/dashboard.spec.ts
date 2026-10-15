import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { formatIssues, watchPage } from '../helpers/monitor'
import { requireWrite } from '../helpers/data'

/** Tổng quan: bộ lọc Phòng KD / Team / Nhân viên đổi số liệu không phát sinh lỗi. (Không ghi dữ liệu, nhưng chạy cùng nhóm flows.) */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN') })

test('bộ lọc Phòng KD / Team / Nhân viên không gây lỗi', async ({ page }) => {
  const w = watchPage(page)
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  const snapshot = async () => (await page.locator('main').last().innerText()).replace(/\s+/g, ' ')
  const before = await snapshot()
  let changed = false

  for (const label of ['Phòng KD', 'Team', 'Nhân viên']) {
    const trigger = page.getByLabel(label, { exact: true })
    await trigger.click()
    await page.waitForTimeout(400)
    const options = page.locator('[role=option][aria-selected=false]:visible')
    if ((await options.count()) > 0) {
      await options.first().click() // option đầu tiên đang KHÔNG được chọn
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
      await page.waitForTimeout(500)
      if ((await snapshot()) !== before) changed = true
    } else {
      await page.keyboard.press('Escape')
    }
    expect.soft(formatIssues(w.issues(), '/dashboard'), `Lỗi sau khi lọc theo "${label}"`).toBe('')
  }

  await page.getByRole('button', { name: 'Chính tôi' }).click()
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  await page.getByRole('button', { name: 'Đặt lại bộ lọc' }).click()
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  expect.soft(formatIssues(w.issues(), '/dashboard'), 'Lỗi sau "Chính tôi" / "Đặt lại"').toBe('')
  test.info().annotations.push({ type: 'số liệu', description: changed ? 'số liệu đã đổi theo bộ lọc' : 'dữ liệu demo ít — số liệu không đổi giữa các lựa chọn' })
})
