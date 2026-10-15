import { test, expect, type Page } from '@playwright/test'
import { hasRole, missingEnvReason, storageStatePath } from '../helpers/roles'
import { ROUTES } from '../helpers/routes'
import { currentFrame } from '../helpers/frames'

/**
 * CHUẨN "BỐ TRÍ NÚT TRÊN ĐIỆN THOẠI" — read-only.
 *
 * Viewport 390×844, cảm ứng. Mỗi route (role ADMIN) kiểm 3 điều, TẤT CẢ dùng `expect.soft`
 * và in danh sách phần tử vi phạm để đọc số liệu sau khi sửa xong:
 *  (a) không tràn ngang trang: `scrollWidth <= innerWidth`;
 *  (b) mọi nút nền đặc `bg-primary` hiển thị trong `main` (ngoài dialog, bỏ `[data-color-swatch]`)
 *      phải có tổ tiên `position: fixed|sticky` HOẶC nằm nửa dưới màn hình đầu (top >= 422px);
 *  (c) số `button`/`[role=button]`/`[role=tab]` hiển thị trong `main` có vùng chạm HIỆU DỤNG (hộp ∪ `::after`/`::before`)
 *      cao < 40 hoặc rộng < 40 (bỏ size `xs`/`icon-xs`) phải = 0.
 * Project `design`, không nằm trong `pnpm e2e` mặc định — chạy `pnpm e2e:design`.
 */
const ROLE = 'ADMIN' as const
const PAGES = ROUTES.filter((r) => !r.redirectTo && !r.dynamic)

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
  await page.locator('h1:visible').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(600)
}

async function overflowX(page: Page) {
  return page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
}

/** (b) nút nền đặc chủ đạo KHÔNG nằm vùng ngón cái. */
async function primaryOutsideThumbZone(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = document.createElement('button')
    probe.className = 'bg-primary'
    document.body.appendChild(probe)
    const solid = getComputedStyle(probe).backgroundColor
    probe.remove()
    const half = window.innerHeight / 2
    const out: string[] = []
    document
      .querySelectorAll<HTMLElement>('main button, main a, main [role=button], main [role=tab], main label')
      .forEach((el) => {
        if (el.closest('[role=dialog]') || el.matches('[data-color-swatch]')) return
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') return
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        if (cs.backgroundColor !== solid) return
        for (let n: HTMLElement | null = el; n; n = n.parentElement) {
          const pos = getComputedStyle(n).position
          if (pos === 'fixed' || pos === 'sticky') return
        }
        if (r.top >= half) return
        const text = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
        out.push(`<${el.tagName.toLowerCase()}> "${text || '(không chữ)'}" top=${Math.round(r.top)}`)
      })
    return out
  })
}

/**
 * (c) vùng chạm HIỆU DỤNG nhỏ hơn 40px. Vùng chạm = hợp của hộp phần tử và hộp `::before`/`::after`
 * định vị tuyệt đối của nó (CSS mở vùng chạm bằng pseudo trong suốt) — `getBoundingClientRect` một mình
 * không thấy phần này. Ngưỡng KHÔNG đổi (40). Pseudo `pointer-events: none` hoặc không `position: absolute|fixed`
 * không được tính.
 */
async function smallTouchTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Box = { l: number; t: number; r: number; b: number }
    const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0)
    function effectiveBox(el: HTMLElement): Box {
      const r = el.getBoundingClientRect()
      const box: Box = { l: r.left, t: r.top, r: r.right, b: r.bottom }
      const ecs = getComputedStyle(el)
      // `top/left` của pseudo tính từ mép padding của phần tử (phần tử là containing block khi đã định vị).
      const originX = r.left + num(ecs.borderLeftWidth)
      const originY = r.top + num(ecs.borderTopWidth)
      for (const which of ['::before', '::after'] as const) {
        const ps = getComputedStyle(el, which)
        if (ps.content === 'none' || ps.content === 'normal') continue
        if (ps.position !== 'absolute' && ps.position !== 'fixed') continue
        if (ps.pointerEvents === 'none' || ps.display === 'none' || ps.visibility === 'hidden') continue
        const w = num(ps.width)
        const h = num(ps.height)
        if (w <= 0 || h <= 0) continue
        let tx = 0
        let ty = 0
        if (ps.transform && ps.transform !== 'none') {
          const m = new DOMMatrixReadOnly(ps.transform)
          tx = m.e
          ty = m.f
        }
        const left = originX + num(ps.left) + tx
        const top = originY + num(ps.top) + ty
        box.l = Math.min(box.l, left)
        box.t = Math.min(box.t, top)
        box.r = Math.max(box.r, left + w)
        box.b = Math.max(box.b, top + h)
      }
      return box
    }
    const out: string[] = []
    document.querySelectorAll<HTMLElement>('main button, main [role=button], main [role=tab]').forEach((el) => {
      if (el.closest('[role=dialog]')) return
      // Nút đang vô hiệu hoá (disabled / aria-disabled) không nhận chạm — WCAG 2.5.8 không áp; `::after` của nó
      // kế thừa `pointer-events: none` từ `disabled:pointer-events-none` nên không được tính vùng chạm.
      if (el.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return
      const size = el.getAttribute('data-size')
      if (size === 'xs' || size === 'icon-xs') return
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') return
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      const b = effectiveBox(el)
      const w = b.r - b.l
      const h = b.b - b.t
      if (h < 40 || w < 40) {
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
        out.push(`<${el.tagName.toLowerCase()}> "${text || '(không chữ)'}" ${Math.round(w)}×${Math.round(h)} (hộp ${Math.round(r.width)}×${Math.round(r.height)})`)
      }
    })
    return out
  })
}

test.describe('design · bố trí nút trên điện thoại', () => {
  test.skip(!hasRole(ROLE), missingEnvReason(ROLE))
  test.use({ storageState: storageStatePath(ROLE) })

  for (const route of PAGES) {
    test(`${route.name} — ${route.path}`, async ({ page }, testInfo) => {
      const frame = currentFrame(testInfo)
      await page.goto(route.path, { waitUntil: 'domcontentloaded' })
      await settle(page)

      const { sw, iw } = await overflowX(page)
      expect.soft(sw, `${route.path}: tràn ngang (scrollWidth ${sw} > innerWidth ${iw})`).toBeLessThanOrEqual(iw)

      // (b) vùng ngón cái chỉ áp cho điện thoại; (c) vùng chạm cho mọi khung cảm ứng.
      const far = frame.key === 'mobile' ? await primaryOutsideThumbZone(page) : []
      expect.soft(far.length, `${route.path}: ${far.length} nút chính ngoài vùng ngón cái:\n${far.join('\n')}`).toBeLessThanOrEqual(0)

      const small = frame.touch ? await smallTouchTargets(page) : []
      console.log(`[thumb-zone] ${frame.key} ${route.path}: vùng chạm <40px = ${small.length}`)
      expect.soft(small.length, `${route.path}: ${small.length} vùng chạm <40px:\n${small.join('\n')}`).toBeLessThanOrEqual(0)
    })
  }
})
