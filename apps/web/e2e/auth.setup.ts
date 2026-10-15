import fs from 'node:fs'
import { test as setup, expect } from '@playwright/test'
import { AUTH_DIR, ROLES, credentialsFor, missingEnvReason, storageStatePath } from './helpers/roles'

/**
 * Đăng nhập qua UI cho từng role, lưu `storageState` vào `e2e/.auth/` (gitignore —
 * chứa token). Role thiếu env → skip có lý do; spec phụ thuộc sẽ tự skip role đó.
 */
fs.mkdirSync(AUTH_DIR, { recursive: true })

for (const role of ROLES) {
  setup(`đăng nhập ${role}`, async ({ page }) => {
    const cred = credentialsFor(role)
    setup.skip(!cred, missingEnvReason(role))
    fs.rmSync(storageStatePath(role), { force: true })

    await page.goto('/login')
    await page.waitForSelector('input[name="email"]')
    await page.fill('input[name="email"]', cred!.email)
    await page.fill('input[name="password"]', cred!.password)
    // Nút submit bị disable tới khi React hydrate xong (chống rò mật khẩu qua URL).
    const submit = page.locator('button[type="submit"]')
    await expect(submit).toBeEnabled()
    await submit.click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 })
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('trinity_access_token')), { timeout: 15_000 })
      .toBeTruthy()
    await page.context().storageState({ path: storageStatePath(role) })
  })
}
