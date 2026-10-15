import { test, expect, type Page } from '@playwright/test'
import { hasRole, missingEnvReason, storageStatePath } from '../helpers/roles'
import { currentFrame } from '../helpers/frames'

/**
 * POPUP TRONG KHUNG — read-only (mở rồi đóng bằng Escape, không lưu gì). Ở mỗi khung (390×844, 768×1024, 1440×900) hộp
 * thoại mở từ nút hành động phải nằm TRỌN trong màn hình (không bị cắt trái/phải/trên/dưới), không làm trang tràn ngang,
 * và nội dung dài phải cuộn được bên trong (nút cuối với tới được). Role ADMIN.
 */
const ROLE = 'ADMIN' as const

const DIALOGS: { path: string; button: string; kind?: 'button' | 'link' }[] = [
  { path: '/products', button: 'Thêm sản phẩm' },
  { path: '/settings?tab=roles', button: 'Tạo vai trò' },
  { path: '/management/employees', button: 'Thêm nhân viên' },
  { path: '/management/contracts', button: 'Thêm hợp đồng' },
  { path: '/management/recruitment', button: 'Thêm ứng viên' },
  { path: '/settings?tab=users', button: 'Thêm người dùng' },
]

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
  await page.locator('h1:visible').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(500)
}

test.describe('design · popup nằm trong khung', () => {
  test.skip(!hasRole(ROLE), missingEnvReason(ROLE))
  test.use({ storageState: storageStatePath(ROLE) })

  for (const d of DIALOGS) {
    test(`${d.path} › "${d.button}"`, async ({ page }, testInfo) => {
      const frame = currentFrame(testInfo)
      await page.goto(d.path, { waitUntil: 'domcontentloaded' })
      await settle(page)
      const btn = page.locator('main').getByRole(d.kind ?? 'button', { name: d.button, exact: false }).first()
      await expect(btn, `Không thấy nút "${d.button}" trên ${d.path} ở khung ${frame.label}`).toBeVisible({ timeout: 15_000 })
      await btn.click()
      const dlg = page.getByRole('dialog').first()
      await expect(dlg).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(400) // chờ animation trượt/zoom

      const { box, vw, vh, overflowX } = await page.evaluate(() => {
        const el = document.querySelector('[role=dialog]') as HTMLElement
        const r = el.getBoundingClientRect()
        return {
          box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height },
          vw: window.innerWidth,
          vh: window.innerHeight,
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
        }
      })
      const tol = 1
      expect.soft(box.left, `popup bị cắt bên TRÁI (left=${box.left})`).toBeGreaterThanOrEqual(-tol)
      expect.soft(box.right, `popup bị cắt bên PHẢI (right=${box.right} > ${vw})`).toBeLessThanOrEqual(vw + tol)
      expect.soft(box.top, `popup bị cắt bên TRÊN (top=${box.top})`).toBeGreaterThanOrEqual(-tol)
      expect.soft(box.bottom, `popup bị cắt bên DƯỚI (bottom=${box.bottom} > ${vh})`).toBeLessThanOrEqual(vh + tol)
      expect.soft(overflowX, 'mở popup làm trang tràn ngang').toBe(false)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5_000 })
    })
  }
})
