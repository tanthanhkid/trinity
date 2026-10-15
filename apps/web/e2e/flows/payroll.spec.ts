import { test, expect } from '@playwright/test'
import { can } from '@trinity/rbac'
import { ROLES, hasRole, missingEnvReason, storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { watchPage, formatIssues } from '../helpers/monitor'
import { requireWrite } from '../helpers/data'

/**
 * LƯƠNG — XEM phiếu lương theo quyền (không tạo/duyệt phiếu để không đổi dữ liệu lương demo):
 *   mọi người xem được `/payslips/me`; danh sách `/payslips?month=` chỉ khi có `payroll.view` (scoped);
 *   cấu hình KPI chỉ `payroll.manage`; tháng sai định dạng → 400; trang /payroll mở được, không lỗi runtime.
 */
requireWrite()
const month = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7)

for (const role of ROLES) {
  test.describe(`lương · ${role}`, () => {
    test.skip(!hasRole(role), missingEnvReason(role))
    test.use({ storageState: storageStatePath(role) })

    test('phiếu lương theo quyền + trang /payroll', async ({ page }) => {
      const api = await Api.forRole(role)
      const me = await api.me()
      const mine = await api.call('GET', `/payslips/me?month=${month}`)
      expect(mine.status()).toBe(200)
      expect(Array.isArray(await mine.json())).toBe(true)

      const list = await api.call('GET', `/payslips?month=${month}`)
      if (can(me.permissions, 'payroll.view')) {
        expect(list.status()).toBe(200)
        const rows = (await list.json()) as { user_id?: number; employee_id?: number }[]
        expect(Array.isArray(rows)).toBe(true)
        if (me.permissions['payroll.view'] === 'own') for (const r of rows) expect(r.user_id ?? me.user.id, 'scope own chỉ thấy phiếu của mình').toBe(me.user.id)
      } else expect(list.status()).toBe(403)

      const kpi = await api.call('GET', '/kpi/configs')
      expect(kpi.status(), 'KPI config cần payroll.manage').toBe(can(me.permissions, 'payroll.manage') ? 200 : 403)
      expect((await api.call('GET', '/payslips?month=2026-13')).status(), 'tháng sai → 400 (hoặc 403 nếu thiếu quyền)').toBe(can(me.permissions, 'payroll.view') ? 400 : 403)
      await api.dispose()

      const watcher = watchPage(page)
      await page.goto('/payroll?tab=reports')
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
      if (can(me.permissions, 'payroll.view')) await expect(page.getByRole('heading', { name: /Lương/ }).first()).toBeVisible({ timeout: 20_000 })
      else await expect(page.getByText(/Bạn không có quyền truy cập trang này/)).toBeVisible({ timeout: 20_000 })
      expect(formatIssues(watcher.issues(), '/payroll'), `Lỗi runtime/API trên /payroll (role ${role})`).toBe('')
    })
  })
}
