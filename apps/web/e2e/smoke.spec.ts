import { test, expect, type Page } from '@playwright/test'
import { ROLES, ROLE_LABEL, hasRole, missingEnvReason, storageStatePath } from './helpers/roles'
import { Api, type MeResponse } from './helpers/api'
import { SESSION_KICKED_MSG, formatIssues, horizontalOverflow, watchPage } from './helpers/monitor'
import { FORBIDDEN_TEXT, ROUTES, featureOfRoute, featureOffText, featureOn, needAllows, needLabel, parseFeatures, type RouteDef } from './helpers/routes'
import type { OrgFeatures } from '@trinity/rbac'

/**
 * SMOKE TOÀN TRANG — read-only, an toàn chạy trên môi trường thật. Mỗi role × mỗi route:
 *  1. mở trang, chờ network idle;
 *  2. không `pageerror`, không console error (trừ allowlist có lý do), không API 4xx/5xx
 *     (trừ allowlist; lỗi đã biết gắn nhãn [ĐÃ BIẾT, đang sửa] nhưng VẪN đỏ);
 *  3. h1 đúng; trang không quyền phải hiện "Bạn không có quyền truy cập trang này"
 *     (không trắng trang, không crash), trang có quyền KHÔNG được hiện câu đó;
 *  4. không tràn ngang ở 1440px và 390px (mobile);
 *  5. chụp ảnh desktop + mobile vào test-results.
 */
const MOBILE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {
    /* trang có polling/socket không bao giờ idle hẳn — đã có waitFor tiêu đề bên dưới */
  })
}

async function resolveContactId(api: Api): Promise<number | null> {
  try {
    const r = await api.get<{ data?: { id: number }[] }>('/contacts?limit=1')
    return r.data?.[0]?.id ?? null
  } catch {
    return null
  }
}

for (const role of ROLES) {
  test.describe(`smoke · ${role} (${ROLE_LABEL[role]})`, () => {
    test.skip(!hasRole(role), missingEnvReason(role))
    test.use({ storageState: storageStatePath(role) })

    let me: MeResponse
    let contactId: number | null = null
    let features: OrgFeatures

    test.beforeAll(async () => {
      if (!hasRole(role)) return
      const api = await Api.forRole(role)
      me = await api.me()
      contactId = await resolveContactId(api)
      features = parseFeatures(await api.get('/settings/org-features').catch(() => ({})))
      await api.dispose()
    })

    for (const route of ROUTES) {
      test(`${route.name} — ${route.path}`, async ({ page }, testInfo) => {
        const path = await resolvePath(route, contactId)
        test.skip(path === null, 'Role này không có khách hàng nào trong phạm vi → bỏ qua trang chi tiết')
        const watcher = watchPage(page)
        const allowed = needAllows(me.permissions, route.need)

        await page.goto(path!, { waitUntil: 'domcontentloaded' })
        await settle(page)
        // Chờ tiêu đề HOẶC khối "không có quyền" xuất hiện (tránh chụp lúc skeleton).
        await page
          .locator('h1')
          .or(page.getByText(FORBIDDEN_TEXT))
          .first()
          .waitFor({ timeout: 20_000 })
          .catch(() => undefined)
        await page.waitForTimeout(600)

        const finalUrl = new URL(page.url())
        const where = `${finalUrl.pathname}${finalUrl.search}`
        await testInfo.attach('desktop', { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' })

        // (0) phiên bị đá → báo rõ, không liệt kê như lỗi app
        const issues = watcher.issues()
        if (issues.unauthorized.length > 0) {
          throw new Error(`${SESSION_KICKED_MSG}\n${[...new Set(issues.unauthorized)].slice(0, 5).join('\n')}`)
        }

        // (2) lỗi runtime
        const problems = formatIssues(issues, finalUrl.pathname)
        expect.soft(problems, `Lỗi runtime/API trên ${where} (role ${role})`).toBe('')

        // (3) tiêu đề / trạng thái quyền
        const h1s = (await page.locator('h1').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
        const forbidden = await page.getByText(FORBIDDEN_TEXT).count()
        const feature = featureOfRoute(route.path)
        if (!featureOn(features, feature)) {
          // Công tắc tổ chức đang TẮT → màn "Tính năng … đang tắt" (children không mount, không phát request).
          await expect.soft(page.getByText(featureOffText(feature!)).first(), `Tính năng ${feature} tắt nhưng ${route.path} không hiện màn "đang tắt"`).toBeVisible()
        } else if (route.redirectTo) {
          expect.soft(where, `Redirect của ${route.path}`).toMatch(route.redirectTo)
        } else if (route.dynamic) {
          // chi tiết khách: chỉ cần có h1 và không "không có quyền" khi role có contacts.view
          expect.soft(forbidden, 'Role có quyền xem khách nhưng thấy "Không có quyền"').toBe(0)
          expect.soft(h1s.length, `Không có h1 trên ${where}`).toBeGreaterThan(0)
        } else if (allowed) {
          expect.soft(forbidden, `Role ${role} CÓ quyền (${needLabel(route.need)}) nhưng thấy "Không có quyền"`).toBe(0)
          expect.soft(h1s.some((t) => route.title.test(t)), `h1 ${JSON.stringify(h1s)} không khớp ${route.title}`).toBe(true)
        } else {
          expect.soft(
            forbidden,
            `Role ${role} KHÔNG có quyền (${needLabel(route.need)}) → trang phải hiện "Bạn không có quyền truy cập trang này" (h1 hiện có: ${JSON.stringify(h1s)})`,
          ).toBeGreaterThan(0)
        }
        const bodyText = (await page.locator('body').innerText()).trim()
        expect.soft(bodyText.length, 'Trang trắng').toBeGreaterThan(20)

        // (4) tràn ngang desktop
        const dOver = await horizontalOverflow(page)
        expect.soft(dOver.over, `Tràn ngang ở 1440px: scrollWidth=${dOver.scroll} > clientWidth=${dOver.client}`).toBe(false)

        // (4)+(5) mobile — chỉ tập trang chính
        if (!route.mobile) return
        await page.setViewportSize(MOBILE)
        await settle(page)
        await page.waitForTimeout(500)
        await testInfo.attach('mobile', { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' })
        const mOver = await horizontalOverflow(page)
        expect.soft(mOver.over, `Tràn ngang ở 390px: scrollWidth=${mOver.scroll} > clientWidth=${mOver.client}`).toBe(false)
        const mIssues = formatIssues(watcher.issues(), finalUrl.pathname)
        expect.soft(mIssues, `Lỗi phát sinh thêm khi thu về 390px trên ${where}`).toBe(problems)
        await page.setViewportSize(DESKTOP)
      })
    }
  })
}

async function resolvePath(route: RouteDef, contactId: number | null): Promise<string | null> {
  if (route.dynamic === 'contact-detail') return contactId === null ? null : `/contacts/${contactId}`
  return route.path
}
