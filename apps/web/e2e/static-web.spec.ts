import { test, expect, type Page } from '@playwright/test'
import { hasRole, missingEnvReason, storageStatePath } from './helpers/roles'
import { Api } from './helpers/api'
import { formatIssues, watchPage } from './helpers/monitor'

/**
 * WEB TĨNH DO RUST PHỤC VỤ (W04, R004 phương án A) — read-only. Chạy bằng `pnpm e2e:static` (E2E_SERVER=rust: Playwright
 * tự khởi động binary với `WEB_DIR=out/`) hoặc trỏ `E2E_BASE_URL` vào instance Rust đang chạy. Kiểm những gì `next start`
 * từng làm hộ mà bản xuất tĩnh phải tự có:
 *
 *  1. luật điều hướng của `proxy.ts` (K18): `/` → `/login`, `/assistant`, `Cache-Control`;
 *  2. URL sâu của 8 route động (mỗi route chỉ có MỘT trang giữ chỗ `_` trong `out/`): tải thẳng URL, URL không bị đổi,
 *     không `pageerror`, không 4xx ở tệp tĩnh/payload (`_next/*`, `__next.*`);
 *  3. điều hướng trong app + nút quay lại + prefetch (không 4xx).
 *
 * Mỗi lần nâng cấp `next` phải chạy lại: tên tệp payload `__next.<route>.$d$param...` là chi tiết nội bộ của App Router.
 * Vỡ ⇒ chuyển sang phương án B (docs/rust/PLAN.md mục 5).
 */

/** 4xx/5xx của tài nguyên web (không tính `/api/`, đã có `watchPage`). */
function watchStatic(page: Page) {
  const bad: string[] = []
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (r.status() < 400 || u.pathname.startsWith('/api/')) return
    bad.push(`${r.status()} ${r.request().method()} ${u.pathname}`)
  })
  return bad
}

const NOT_AN_ID = '987654321' // không có thật: trang giữ chỗ vẫn phải tải, nội dung báo "không tìm thấy"

test.describe('web tĩnh · công khai (chưa đăng nhập)', () => {
  test('`/` chuyển sang /login', async ({ page }) => {
    const res = await page.goto('/')
    expect(new URL(page.url()).pathname).toBe('/login')
    expect(res?.status()).toBe(200)
  })

  test('/login: HTML no-store, không lỗi JS, tệp tĩnh immutable', async ({ page, request }) => {
    const bad = watchStatic(page)
    const watcher = watchPage(page)
    const res = await page.goto('/login', { waitUntil: 'networkidle' })
    expect(res?.headers()['cache-control'] ?? '').toMatch(/no-store/)
    expect(res?.headers()['content-type'] ?? '').toMatch(/text\/html/)
    expect(watcher.issues().pageErrors, formatIssues(watcher.issues(), '/login')).toEqual([])
    expect(bad).toEqual([])
    const asset = await page.evaluate(
      () => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/_next/static/')) ?? null,
    )
    expect(asset, 'trang /login phải tải ít nhất một tệp /_next/static/').not.toBeNull()
    const head = await request.get(asset!)
    expect(head.status()).toBe(200)
    expect(head.headers()['cache-control'] ?? '').toMatch(/immutable/)
  })

  test('/assistant chuyển sang Cài đặt › Kết nối & AI', async ({ request }) => {
    const res = await request.get('/assistant', { maxRedirects: 0 })
    expect([301, 302, 307, 308]).toContain(res.status())
    expect(res.headers()['location'] ?? '').toContain('/settings?tab=integrations')
  })

  test('/api/build-id do Rust trả JSON', async ({ request }) => {
    const res = await request.get('/api/build-id')
    expect(res.status()).toBe(200)
    expect(typeof (await res.json()).buildId).toBe('string')
  })

  test('đường dẫn không có thật: trang not-found, không phải lỗi 5xx', async ({ request }) => {
    const res = await request.get('/khong-co-trang-nay-w04')
    expect(res.status()).toBeLessThan(500)
  })

  // Hai route động công khai (không cần đăng nhập). Token mời không được chuyển sang query (lọt log).
  for (const [name, path] of [
    ['invite/[token]', '/invite/w04-token-gia'],
    ['s/[slug]', '/s/w04-cua-hang-gia'],
  ] as const) {
    test(`URL sâu ${name}: ${path}`, async ({ page }) => {
      const bad = watchStatic(page)
      const watcher = watchPage(page)
      const res = await page.goto(path, { waitUntil: 'networkidle' })
      expect(res?.status(), 'trang giữ chỗ phải trả 200 với mọi giá trị tham số').toBe(200)
      expect(new URL(page.url()).pathname).toBe(path)
      expect(new URL(page.url()).search).toBe('')
      await expect(page.locator('body')).not.toBeEmpty()
      expect(watcher.issues().pageErrors, formatIssues(watcher.issues(), path)).toEqual([])
      expect(bad).toEqual([])
    })
  }
})

test.describe('web tĩnh · đã đăng nhập (ADMIN)', () => {
  test.skip(!hasRole('ADMIN'), missingEnvReason('ADMIN'))
  test.use({ storageState: storageStatePath('ADMIN') })

  /** 6 route động trong (dashboard). `x/[objectKey]/new` là đoạn chữ dưới đoạn động nên đi chung trang `x/_`. */
  const DEEP = [
    '/contacts/:id',
    '/projects/:id',
    '/x/khach-hang-gia',
    '/x/khach-hang-gia/new',
    '/x/khach-hang-gia/987654321',
    '/x/khach-hang-gia/v/view-gia',
  ] as const

  for (const tpl of DEEP) {
    const path = tpl.replace(':id', NOT_AN_ID)
    test(`URL sâu ${tpl}`, async ({ page }) => {
      const bad = watchStatic(page)
      const watcher = watchPage(page)
      const res = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(res?.status(), 'trang giữ chỗ phải trả 200 với mọi giá trị tham số').toBe(200)
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
      await page.locator('h1').first().waitFor({ timeout: 20_000 })
      expect(new URL(page.url()).pathname, 'URL không được bị đổi').toBe(path)
      expect(watcher.issues().pageErrors, formatIssues(watcher.issues(), path)).toEqual([])
      expect(bad, 'tệp tĩnh/payload không được 4xx').toEqual([])
      // Lỗi nghiệp vụ (404 của API vì id/khoá không có thật) không phải điều test này kiểm.
      expect(watcher.issues().failedRequests).toEqual([])
    })
  }

  test('điều hướng trong app + quay lại: /contacts → /contacts/:id → back', async ({ page }) => {
    const api = await Api.forRole('ADMIN')
    const list = await api.get<{ data?: { id: number }[] }>('/contacts?limit=1').catch(() => ({ data: [] }))
    await api.dispose()
    const id = list.data?.[0]?.id
    test.skip(id === undefined, 'Môi trường chưa có khách hàng nào để bấm vào')
    const bad = watchStatic(page)
    const watcher = watchPage(page)
    await page.goto('/contacts', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
    const link = page.locator(`a[href="/contacts/${id}"]`).first()
    await link.waitFor({ timeout: 20_000 })
    await link.click()
    await page.waitForURL(`**/contacts/${id}`)
    await page.locator('h1').first().waitFor({ timeout: 20_000 })
    expect(new URL(page.url()).pathname).toBe(`/contacts/${id}`)
    await page.goBack()
    await page.waitForURL('**/contacts')
    await page.locator('h1').first().waitFor({ timeout: 20_000 })
    // tải lại thẳng URL sâu của khách có thật
    await page.goto(`/contacts/${id}`, { waitUntil: 'domcontentloaded' })
    await page.locator('h1').first().waitFor({ timeout: 20_000 })
    expect(watcher.issues().pageErrors, formatIssues(watcher.issues(), '/contacts')).toEqual([])
    expect(bad, 'prefetch/điều hướng không được 4xx').toEqual([])
  })
})
