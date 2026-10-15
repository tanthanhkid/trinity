import { test, expect, type Page } from '@playwright/test'
import { hasRole, missingEnvReason, storageStatePath } from '../helpers/roles'
import { ROUTES } from '../helpers/routes'

/**
 * CHUẨN "MỘT HÀNH ĐỘNG CHÍNH MỖI MÀN" — read-only.
 *
 * Mỗi trang chính (role ADMIN, thấy đủ nút): đếm phần tử HIỂN THỊ trong `main`, KHÔNG nằm
 * trong `[role=dialog]`, có `background-color` đúng bằng màu của một probe `bg-primary`
 * (nền đặc màu chủ đạo). Kỳ vọng ≤ 1. Lặp lại sau khi bấm từng `[role=tab]` (tối đa 10).
 *
 * Project `design` KHÔNG nằm trong `pnpm e2e` mặc định — chạy bằng `pnpm e2e:design`
 * Danh sách route lấy chung từ `helpers/routes.ts` (bỏ route redirect và route có tham số).
 */
const MAX_TABS = 10
const ROLE = 'ADMIN' as const
const PAGES = ROUTES.filter((r) => !r.redirectTo && !r.dynamic)

/** Chạy trong trình duyệt: trả về nhãn các phần tử nền đặc chủ đạo đang hiện trong `main`. */
async function solidPrimaryElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = document.createElement('button')
    probe.className = 'bg-primary'
    document.body.appendChild(probe)
    const solid = getComputedStyle(probe).backgroundColor
    probe.remove()

    const out: string[] = []
    const nodes = document.querySelectorAll<HTMLElement>(
      'main button, main a, main [role=button], main [role=tab], main label',
    )
    nodes.forEach((el) => {
      if (el.closest('[role=dialog]')) return
      // Ô chọn màu của rich-text-editor: nền = màu người dùng chọn, không phải nút hành động.
      if (el.matches('[data-color-swatch]')) return
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') return
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      if (cs.backgroundColor !== solid) return
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
      out.push(`<${el.tagName.toLowerCase()}> "${text || '(không chữ)'}"`)
    })
    return out
  })
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
  await page.locator('h1:visible').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(600)
}

test.describe('design · một hành động chính mỗi màn', () => {
  test.skip(!hasRole(ROLE), missingEnvReason(ROLE))
  test.use({ storageState: storageStatePath(ROLE) })

  for (const route of PAGES) {
    test(`${route.name} — ${route.path}`, async ({ page }) => {
      // Khung (390/768/1440) do project `design-<khung>` đặt viewport.
      await page.goto(route.path, { waitUntil: 'domcontentloaded' })
      await settle(page)

      const base = await solidPrimaryElements(page)
      expect.soft(base.length, `${route.path}: ${base.length} nút nền đặc chủ đạo (tối đa 1):\n${base.join('\n')}`).toBeLessThanOrEqual(1)

      // Chốt nhãn tab TRƯỚC khi bấm: đổi tab có thể làm số `[role=tab]` trong
      // `main` thay đổi (tab con của panel mới/cũ) ⇒ `nth(i)` trỏ phần tử không
      // còn tồn tại và `innerText()` không timeout sẽ treo tới hết giờ test (POS).
      const labels = (await page.locator('main [role=tab]').allInnerTexts())
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, MAX_TABS)
      for (const label of labels) {
        try {
          await page.locator('main [role=tab]').filter({ hasText: label }).first().click({ timeout: 5_000 })
        } catch {
          continue // tab disabled / bị che / không còn — bỏ qua, không phải lỗi chuẩn
        }
        await page.waitForTimeout(500)
        const found = await solidPrimaryElements(page)
        expect.soft(
          found.length,
          `${route.path} · tab "${label}": ${found.length} nút nền đặc chủ đạo (tối đa 1):\n${found.join('\n')}`,
        ).toBeLessThanOrEqual(1)
      }
    })
  }
})
