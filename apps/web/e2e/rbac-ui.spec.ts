import { test, expect, type Page } from '@playwright/test'
import { can, isOrgFeatureOn, type OrgFeatures, type Permission } from '@trinity/rbac'
import { ROLES, ROLE_LABEL, hasRole, missingEnvReason, storageStatePath } from './helpers/roles'
import { Api, type MeResponse } from './helpers/api'
import { FORBIDDEN_TEXT, ROUTES, featureOfRoute, featureOffText, featureOn, needAllows, needLabel, parseFeatures } from './helpers/routes'
import { readReportTabs, readSettingsTabs } from './helpers/app-config'
import { menuItems } from '@/components/nav-config'
import { withExtraMenuItems } from '@/components/app-shell/menu-extra'
import { isChildVisible, isItemVisible } from '@/components/nav-visibility'

/**
 * PHÂN QUYỀN GIAO DIỆN (read-only). Kỳ vọng tính từ `permissions` của CHÍNH phiên đó
 * (`/auth/me`) + cấu hình menu/tab của app → không hardcode role nào có gì.
 */

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
  await page.waitForTimeout(500)
}

/** Menu kỳ vọng: cùng pipeline với `ShellSidebar` (extra → removed → lọc quyền). */
function expectedMenu(me: MeResponse, features: OrgFeatures) {
  const base = withExtraMenuItems(menuItems)
  const visibleHrefs = new Set<string>()
  const hiddenHrefs = new Set<string>()
  const add = (href: string | undefined, ok: boolean) => {
    if (!href || /^https?:/.test(href)) return
    ;(ok ? visibleHrefs : hiddenHrefs).add(href)
  }
  for (const item of base) {
    const itemOk = isItemVisible(item, me.permissions, features)
    if (item.children) {
      for (const c of item.children) add(c.href, itemOk && isChildVisible(c, me.permissions))
    } else add(item.href, itemOk)
  }
  // href vừa visible vừa hidden (do 2 mục khác nhau cùng trỏ 1 đích) → coi là visible
  for (const h of visibleHrefs) hiddenHrefs.delete(h)
  return { visibleHrefs, hiddenHrefs }
}

interface Action {
  where: string
  /** quyền cần để THẤY nút */
  perm: Permission
  name: string
  kind?: 'button' | 'link'
  /** trang cần quyền này để vào (nếu role không vào được trang thì bỏ qua) */
  pageNeed?: Permission
}

const ACTIONS: Action[] = [
  { where: '/contacts', perm: 'contacts.create', name: 'Thêm khách hàng', pageNeed: 'contacts.view' },
  { where: '/contacts', perm: 'contacts.export', name: 'Xuất Excel', pageNeed: 'contacts.view' },
  { where: '/products', perm: 'products.manage', name: 'Thêm sản phẩm', pageNeed: 'products.view' },
  { where: '/products', perm: 'products.manage', name: 'Quản lý danh mục', pageNeed: 'products.view' },
  { where: '/kanban', perm: 'kanban.boards', name: 'Cấu hình board', kind: 'link', pageNeed: 'kanban.view' },
  { where: '/newsfeed', perm: 'newsfeed.post', name: 'Đăng bài' },
  { where: '/management/employees', perm: 'employees.manage', name: 'Thêm nhân viên', pageNeed: 'employees.view' },
  { where: '/management/contracts', perm: 'contracts.manage', name: 'Thêm hợp đồng', pageNeed: 'contracts.view' },
  { where: '/settings?tab=users', perm: 'users.manage', name: 'Thêm người dùng', pageNeed: 'users.view' },
  { where: '/settings?tab=users', perm: 'users.export', name: 'Xuất Excel', pageNeed: 'users.view' },
  { where: '/settings?tab=roles', perm: 'roles.manage', name: 'Tạo vai trò', pageNeed: 'roles.manage' },
]

for (const role of ROLES) {
  test.describe(`rbac-ui · ${role} (${ROLE_LABEL[role]})`, () => {
    test.skip(!hasRole(role), missingEnvReason(role))
    test.use({ storageState: storageStatePath(role) })

    let me: MeResponse
    let features: OrgFeatures
    let api: Api
    test.beforeAll(async () => {
      if (!hasRole(role)) return
      api = await Api.forRole(role)
      me = await api.me()
      features = parseFeatures(await api.get('/settings/org-features').catch(() => ({})))
    })
    test.afterAll(async () => {
      await api?.dispose()
    })

    test('menu sidebar khớp quyền của phiên', async ({ page }) => {
      await page.goto('/dashboard')
      await settle(page)
      const { visibleHrefs, hiddenHrefs } = expectedMenu(me, features)
      // mở các nhóm con (Quản lý) để link con vào DOM
      for (const g of ['Quản lý']) {
        const btn = page.locator('[data-sidebar="sidebar"], aside').getByRole('button', { name: g, exact: true })
        if (await btn.count()) await btn.first().click().catch(() => undefined)
      }
      await page.waitForTimeout(400)
      const links = await page
        .locator('[data-sidebar="sidebar"] a[href], aside a[href]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))
      const present = new Set(links)
      const missing = [...visibleHrefs].filter((h) => !present.has(h))
      const leaked = [...hiddenHrefs].filter((h) => present.has(h))
      expect.soft(missing, `Menu THIẾU mục role ${role} có quyền`).toEqual([])
      expect.soft(leaked, `Menu LỘ mục role ${role} không có quyền`).toEqual([])
    })

    for (const a of ACTIONS) {
      test(`nút "${a.name}" @ ${a.where} ↔ ${a.perm}`, async ({ page }) => {
        test.skip(a.pageNeed !== undefined && !can(me.permissions, a.pageNeed), `Role không vào được trang (${a.pageNeed})`)
        const feature = featureOfRoute(a.where.split('?')[0])
        test.skip(!featureOn(features, feature), `Tính năng ${feature} đang tắt — trang hiện màn "đang tắt", không có nút`)
        await page.goto(a.where)
        await settle(page)
        const scope = page.locator('main')
        const loc =
          a.kind === 'link'
            ? scope.getByRole('link', { name: a.name })
            : scope.getByRole('button', { name: a.name, exact: false })
        const should = can(me.permissions, a.perm)
        if (should) await expect(loc.first(), `Role có ${a.perm} nhưng thiếu nút "${a.name}"`).toBeVisible()
        else await expect(loc, `Role KHÔNG có ${a.perm} nhưng vẫn thấy nút "${a.name}"`).toHaveCount(0)
      })
    }

    test('nút Chuyển/Sửa khách trong chi tiết khách ↔ contacts.transfer / contacts.update', async ({ page }) => {
      test.skip(!can(me.permissions, 'contacts.view'), 'Không có contacts.view')
      const r = await api.get<{ data?: { id: number }[] }>('/contacts?limit=1')
      const id = r.data?.[0]?.id
      test.skip(!id, 'Không có khách trong phạm vi')
      await page.goto(`/contacts/${id}`)
      await settle(page)
      const transfer = page.getByRole('button', { name: 'Chuyển khách hàng' })
      if (can(me.permissions, 'contacts.transfer')) await expect(transfer.first()).toBeVisible()
      else await expect(transfer).toHaveCount(0)
      const edit = page.getByRole('button', { name: 'Chỉnh sửa' })
      if (can(me.permissions, 'contacts.update')) await expect(edit.first()).toBeVisible()
      else await expect(edit).toHaveCount(0)
    })

    test('Cài đặt: danh sách tab theo quyền; deep-link tab không quyền không lộ nội dung', async ({ page }) => {
      await page.goto('/settings')
      await settle(page)
      const texts = await page.locator('main button').evaluateAll((bs) => bs.map((b) => (b.textContent ?? '').trim()))
      for (const t of readSettingsTabs()) {
        const permOk = t.permission ? can(me.permissions, t.permission) : t.anyOf ? t.anyOf.some((p) => can(me.permissions, p)) : true
        const ok = !t.hidden && permOk && (!t.feature || isOrgFeatureOn(features, t.feature))
        const shown = texts.some((x) => x.startsWith(t.label + t.description.slice(0, 20)))
        expect.soft(shown, `Tab "${t.label}" (${t.permission ?? 'mở cho mọi người'}): ${ok ? 'phải HIỆN' : 'phải ẨN'}`).toBe(ok)
      }
      if (!can(me.permissions, 'roles.manage')) {
        await page.goto('/settings?tab=roles')
        await settle(page)
        await expect(page.getByRole('button', { name: 'Tạo vai trò' }), 'Deep-link ?tab=roles lộ màn Vai trò').toHaveCount(0)
      }
    })

    test('Báo cáo: không hiện tab thiếu quyền', async ({ page }) => {
      test.skip(!needAllows(me.permissions, ROUTES.find((r) => r.path === '/reports')!.need), 'Role không vào được Báo cáo')
      await page.goto('/reports')
      await settle(page)
      const texts = await page.locator('main button, main [role=tab]').evaluateAll((bs) => bs.map((b) => (b.textContent ?? '').trim()))
      const allowedLabels = new Set(readReportTabs().filter((t) => can(me.permissions, t.permission)).map((t) => t.label))
      for (const t of readReportTabs()) {
        if (allowedLabels.has(t.label)) continue
        expect.soft(texts.includes(t.label), `Tab báo cáo "${t.label}" (${t.permission}) hiện dù thiếu quyền`).toBe(false)
      }
    })

    test('vào thẳng URL trang không quyền → "Không có quyền" (không trắng trang)', async ({ page }) => {
      const denied = ROUTES.filter((r) => r.need && !r.dynamic && !r.redirectTo && !needAllows(me.permissions, r.need))
      test.skip(denied.length === 0, 'Role có đủ quyền cho mọi trang')
      const bad: string[] = []
      for (const r of denied) {
        await page.goto(r.path, { waitUntil: 'domcontentloaded' })
        // Tính năng tắt/khoá → cổng tính năng chặn TRƯỚC cổng quyền: màn "đang tắt" cũng là "không vào được".
        const feature = featureOfRoute(r.path)
        // Chờ ĐÚNG màn chặn (không dừng ở h1 của trang — quyền tải sau h1, cold start serverless vài giây).
        const blocked = feature && !featureOn(features, feature) ? page.getByText(FORBIDDEN_TEXT).or(page.getByText(featureOffText(feature))) : page.getByText(FORBIDDEN_TEXT)
        await blocked.first().waitFor({ timeout: 15_000 }).catch(() => undefined)
        const offShown = !featureOn(features, feature) && (await page.getByText(featureOffText(feature!)).count()) > 0
        if (!offShown && (await page.getByText(FORBIDDEN_TEXT).count()) === 0) bad.push(`${r.path} (cần ${needLabel(r.need)})`)
      }
      expect(bad, 'Trang không hiện "Không có quyền" dù role thiếu quyền').toEqual([])
    })

    test('phạm vi dữ liệu khách: UI = API cùng phiên, mọi dòng nằm trong phạm vi', async ({ page }) => {
      test.skip(!can(me.permissions, 'contacts.view'), 'Không có contacts.view')
      const res = await api.get<{ data: { id: number; assigned_to: number | null }[]; meta?: { next_cursor: string | null } }>(
        '/contacts?limit=200',
      )
      const rows = res.data
      const scope = me.permissions['contacts.view']
      if (scope === 'own') {
        const foreign = rows.filter((c) => c.assigned_to !== me.user.id).map((c) => c.id)
        expect(foreign, 'Role phạm vi "own" nhận được khách của người khác từ API').toEqual([])
      }
      await page.goto('/contacts')
      await settle(page)
      const head = (await page.locator('main h1').first().innerText()).replace(/\s+/g, ' ')
      const m = head.match(/(\d[\d.]*)\s+khách hàng/)
      if (m && !res.meta?.next_cursor) {
        expect(Number(m[1].replace(/\./g, '')), `UI báo ${m[1]} khách ≠ API ${rows.length}`).toBe(rows.length)
      }
    })
  })
}
