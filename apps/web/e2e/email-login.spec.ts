import { test, expect } from '@playwright/test'
import { FakeSmtp, codeOf, linkOf } from './helpers/fake-smtp'

/**
 * #675 — đăng nhập không mật khẩu bằng email, chạy thật: web tĩnh + binary Rust + Postgres + SMTP giả trong tiến trình.
 * `server/scripts/e2e-rust.sh email-login` (đặt E2E_SMTP_PORT, SMTP_HOST=127.0.0.1, SMTP_SECURITY=none, APP_PUBLIC_URL).
 * Tài khoản: quản trị của `seed` (`E2E_ADMIN_EMAIL`).
 */
const port = Number(process.env.E2E_SMTP_PORT)
const email = (process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase()
const smtp = new FakeSmtp(port)

test.beforeAll(async () => {
  await smtp.start()
})
test.afterAll(async () => {
  await smtp.stop()
})

test('mã 6 số: gửi, dán, vào Tổng quan; dùng lần 2 bị từ chối', async ({ page, request }) => {
  await page.goto('/login')
  await expect(page.getByRole('link', { name: /Tiếp tục với Google/ })).toHaveCount(0) // chưa cấu hình Google ⇒ ẩn nút
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: /Tiếp tục với email/ }).click()
  await expect(page.getByText(/Đã gửi mã tới/)).toBeVisible()
  await expect(page.getByText(/Gửi lại sau \d+ s/)).toBeVisible()
  const mail = await smtp.waitFor(email, 1)
  expect(mail.raw).toMatch(/^Subject: /m)
  const code = codeOf(mail.raw)
  await page.getByLabel('Chữ số 1').click()
  await page.keyboard.type(code)
  await page.waitForURL((u) => u.pathname.startsWith('/dashboard'), { timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('trinity_access_token'))).toBeTruthy()
  // Mã đã dùng: lần 2 bị từ chối.
  const again = await request.post('/api/v1/auth/email/verify', { data: { email, code } })
  expect(again.status()).toBe(400)
})

test('link một lần trong thư: mở là vào, mở lần 2 báo hết hiệu lực', async ({ browser, request }) => {
  const before = smtp.count(email)
  const r = await request.post('/api/v1/auth/email/start', { data: { email } })
  expect(r.status()).toBe(200)
  const mail = await smtp.waitFor(email, before + 1)
  const link = new URL(linkOf(mail.raw))
  const ctx1 = await browser.newContext()
  const p1 = await ctx1.newPage()
  await p1.goto(`${link.pathname}${link.hash}`)
  await p1.waitForURL((u) => u.pathname.startsWith('/dashboard'), { timeout: 30_000 })
  await ctx1.close()
  const ctx2 = await browser.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(`${link.pathname}${link.hash}`)
  await expect(p2.getByText(/đã dùng hoặc đã hết hạn/)).toBeVisible()
  await ctx2.close()
})

test('start trả cùng phản hồi cho email có và không có tài khoản; email lạ không nhận thư', async ({ request }) => {
  const stranger = `khong-ton-tai-${Date.now()}@example.com`
  const a = await (await request.post('/api/v1/auth/email/start', { data: { email } })).json()
  const b = await (await request.post('/api/v1/auth/email/start', { data: { email: stranger } })).json()
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
  expect(a.message).toBe(b.message)
  expect(a.expires_in).toBe(b.expires_in)
  await new Promise((r) => setTimeout(r, 1500))
  expect(smtp.count(stranger)).toBe(0)
})
